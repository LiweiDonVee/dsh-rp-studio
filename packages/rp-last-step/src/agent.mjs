import { PresetError } from './core.mjs';
import { normalizeDirectionPacket } from './presenter.mjs';

export const TOOL_NAMES = Object.freeze(['rp_last_step_catalog', 'rp_last_step_read', 'rp_last_step_patch', 'rp_present']);
const toolNames = new Set(TOOL_NAMES);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const string = { type: 'string' };
const strings = { type: 'array', items: string };
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const jsonOutput = {
  schema: { type: 'object' },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
};

// The public registry exposes the reserved transport only in effective PTC
// scopes, including modes inherited from a standing preset.
export function usesNativeTools(ctx, agent) {
  return ctx.tools.get('run_code', agent) === undefined;
}

export function requireNativeTools(ctx, agent) {
  if (!usesNativeTools(ctx, agent)) throw new PresetError('NATIVE_TOOLS_REQUIRED', 'RP final presentation requires native tool presentation. Preset migration and preview remain available.', 409);
}

function argumentsFor(input, allowed) {
  if (!object(input) || Object.keys(input).some((key) => !allowed.includes(key))) {
    throw new PresetError('INVALID_TOOL_ARGUMENTS', 'Unexpected RP tool arguments');
  }
}

function caller(service, exec) {
  const agent = exec.agent;
  const sessionId = agent?.session?.id;
  if (typeof sessionId !== 'string' || !sessionId || typeof agent.session.deriveMessages !== 'function') {
    throw new PresetError('AGENT_REQUIRED', 'RP tools require the calling agent session', 403);
  }
  exec.signal.throwIfAborted();
  if (!service.isEnabled(sessionId)) throw new PresetError('BINDING_NOT_FOUND', 'Bind a ready RP profile to this session first', 409);
  return { agent, sessionId, signal: exec.signal };
}

function terminalContext(exec, sessionId) {
  const messages = exec.agent.session.deriveMessages();
  const message = messages.findLast((item) => item.role === 'assistant');
  const calls = message?.content?.filter((item) => item.type === 'tool-call') ?? [];
  if (exec.parent !== undefined || exec.callId !== exec.rootCallId || typeof exec.callId !== 'string'
    || typeof message?.id !== 'string' || !message.id || calls.length !== 1
    || calls[0].id !== exec.callId || calls[0].name !== 'rp_present') {
    throw new PresetError('PRESENTATION_NOT_TERMINAL', 'rp_present must be the sole direct tool call after all simulation and other tools have finished', 409);
  }
  return JSON.stringify([sessionId, message.id, exec.callId]);
}

/** Internal helper: this module is not a second Cordis/client plugin. */
export function registerRpLastStepAgent(ctx, service) {
  const disposers = [];
  const definitions = [];
  const scopes = new Map();
  let stopped = false;
  let syncing = false;
  const add = (tool) => definitions.push(tool);
  const bound = (agent) => (service.hasBinding?.(agent.session.id) ?? service.isEnabled(agent.session.id)) && usesNativeTools(ctx, agent);
  const release = (record) => {
    for (const dispose of record.tools.splice(0).reverse()) dispose();
    record.restriction?.(); record.restriction = undefined;
  };
  function sync(subject) {
    if (stopped || syncing) return;
    syncing = true;
    try {
      const agents = ctx.agents.list();
      if (subject && !agents.includes(subject)) agents.push(subject);
      for (const [agent, record] of scopes) if (!agents.includes(agent)) { release(record); scopes.delete(agent); }
      for (const agent of agents) {
        let record = scopes.get(agent);
        if (!record) { record = { tools: [], restriction: undefined }; scopes.set(agent, record); }
        if (bound(agent)) {
          record.restriction?.(); record.restriction = undefined;
          if (!record.tools.length) {
            try { for (const tool of definitions) record.tools.push(agent.ctx.tools.register(tool)); }
            catch (error) { release(record); throw error; }
          }
        } else if (record.tools.length) {
          for (const dispose of record.tools.splice(0).reverse()) dispose();
        }
      }
      // Scoped capabilities are inherited. An unbound descendant must mask a
      // bound parent's RP tools in both native schemas and the generated SDK.
      for (const agent of agents) {
        const record = scopes.get(agent);
        if (bound(agent) || record.restriction) continue;
        const inherited = TOOL_NAMES.filter((name) => ctx.tools.get(name, agent) !== undefined);
        if (inherited.length) record.restriction = agent.ctx.tools.restrict({ deny: inherited });
      }
    } finally { syncing = false; }
  }
  try {
    add({
      name: 'rp_last_step_catalog',
      description: 'Inspect the current session RP module catalog, owner locks and revision without loading module bodies.',
      parameters: schema({}), output: jsonOutput,
      async execute(args, exec) {
        argumentsFor(args, []);
        return service.catalog(caller(service, exec));
      },
    });
    add({
      name: 'rp_last_step_read',
      description: 'Read selected RP modules in the current bound session and its current overlay.',
      parameters: schema({ entryIds: strings }, ['entryIds']), output: jsonOutput,
      async execute(args, exec) {
        argumentsFor(args, ['entryIds']);
        if (!Array.isArray(args.entryIds) || args.entryIds.some((id) => typeof id !== 'string' || !id.trim())) {
          throw new PresetError('INVALID_TOOL_ARGUMENTS', 'entryIds must contain module ids');
        }
        return service.read({ ...caller(service, exec), entryIds: args.entryIds });
      },
    });
    add({
      name: 'rp_last_step_patch',
      description: 'Apply permission-checked operations to this session overlay using the captured catalog revision. Source modules and owner policy remain immutable.',
      parameters: schema({ expectedRevision: { type: 'integer' }, operations: { type: 'array', items: { type: 'object' } } }, ['expectedRevision', 'operations']),
      output: jsonOutput,
      async execute(args, exec) {
        argumentsFor(args, ['expectedRevision', 'operations']);
        if (!Number.isSafeInteger(args.expectedRevision) || args.expectedRevision < 0) throw new PresetError('EXPECTED_REVISION_REQUIRED', 'A nonnegative expectedRevision is required');
        if (!Array.isArray(args.operations)) throw new PresetError('INVALID_TOOL_ARGUMENTS', 'operations must be an array');
        return service.patch({ ...caller(service, exec), expectedRevision: args.expectedRevision, operations: args.operations });
      },
    });
    add({
      name: 'rp_present',
      description: 'After all simulation and tool results are resolved, submit only player-visible facts for isolated final prose. Call this alone in a new tool-call message; successful presentation ends the turn.',
      parameters: schema({ packet: schema({
        playerAction: string, sceneInstruction: string, resolvedChanges: strings, visibleConsequences: strings,
        openHooks: strings, proseConstraints: strings, publicFactRefs: strings, variables: { type: 'object' },
      }, ['playerAction']) }, ['packet']),
      output: {
        schema: { type: 'object', properties: { id: string, status: { type: 'string', enum: ['rendered', 'complete'] }, text: string }, required: ['id', 'status', 'text'] },
        render: (_args, value) => [{ type: 'text', text: value.text }],
        presentationMeta: (_args, value) => ({ rpLastStep: { schemaVersion: 1, record: { ...value, status: 'complete' } } }),
      },
      async execute(args, exec) {
        argumentsFor(args, ['packet']);
        const input = caller(service, exec);
        const contextKey = terminalContext(exec, input.sessionId);
        const packet = normalizeDirectionPacket(args.packet);
        const result = await service.present({ ...input, packet, contextKey, callId: exec.callId });
        exec.signal.throwIfAborted();
        exec.concludeTurn();
        return result;
      },
    });

    sync();
    disposers.push(ctx.on('agent/created', ({ agent }) => sync(agent)));
    disposers.push(ctx.on('agent/disposed', ({ agent }) => { const record = scopes.get(agent); if (record) { release(record); scopes.delete(agent); } }));
    disposers.push(ctx.on('tools/change', () => sync()));

    const snapshots = new WeakMap();
    const accepted = new WeakMap();
    const currentAgent = (context) => {
      const agent = ctx.agents.currentInitiator();
      return context?.agent && context.agent !== agent ? undefined : agent;
    };
    const capture = (agent) => {
      const id = agent?.session?.id;
      if (agent && (service.hasBinding?.(id) ?? service.isEnabled(id))) requireNativeTools(ctx, agent);
      return service.contextSnapshot?.(id) ?? {
        enabled: service.isEnabled(id), bindingMarker: service.bindingMarker(id), agentContext: service.agentContext(id),
      };
    };
    const snapshot = (context) => {
      const agent = currentAgent(context);
      const entry = accepted.get(context);
      return (entry?.agent === agent ? entry?.value : undefined) ?? (agent && snapshots.get(agent)) ?? capture(agent);
    };
    // Tool providers run before dynamic context providers, and are not rerun by
    // refreshContext. Keep the accepted request's contexts on the same snapshot.
    disposers.push(ctx.systemPrompt.tools((context) => {
      const agent = currentAgent(context);
      const value = capture(agent);
      accepted.set(context, { agent, value });
      if (agent) { snapshots.set(agent, value); service.admitContext?.(agent, value); }
      return { schemas: [] };
    }));
    for (const entry of [
      { name: 'rp-last-step-binding', order: 300, text: (context) => snapshot(context).bindingMarker },
      { name: 'rp-last-step-workflow', order: 301, text: (context) => snapshot(context).enabled ? 'Resolve simulation and all tool results before final presentation. Preserve player control and authoritative outcomes. Manage only the bound session overlay through rp_last_step_catalog/read/patch; owner locks and required modules are enforced. Finish with rp_present as the sole direct tool call in a new assistant message, using only public facts and explicit variables. Wait for success; do not echo the resulting prose.' : '' },
      { name: 'rp-last-step-agent', order: 302, text: (context) => snapshot(context).agentContext },
    ]) disposers.push(ctx.systemPrompt.context({ ...entry, required: true, interpolate: false }));

    disposers.push(ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      const { enabled } = snapshot(context);
      const result = await next();
      return enabled ? result : { ...result, tools: result.tools.filter((tool) => !toolNames.has(tool.name)) };
    }));
  } catch (error) {
    stopped = true;
    for (const record of scopes.values()) release(record);
    for (const dispose of disposers.reverse()) dispose();
    throw error;
  }
  const dispose = () => {
    if (stopped) return;
    stopped = true;
    for (const record of scopes.values()) release(record);
    scopes.clear();
    for (const cleanup of disposers.splice(0).reverse()) cleanup();
  };
  dispose.sync = sync;
  return dispose;
}
