import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PresetError, compileProfile, createProfile, emptyOverlay, importSillyTavern } from './core.mjs';
import { createPresetStore } from './store.mjs';
import { createReceiptStore } from './receipts.mjs';
import { createModelCaller, resolveModelConfig } from './models.mjs';
import { createPresenter } from './presenter.mjs';
import { registerRpLastStepAgent, requireNativeTools, usesNativeTools } from './agent.mjs';
import { createRpLastStepRoutes } from './routes.mjs';

export const name = 'rp-last-step';
export const inject = ['connection', 'typertGateway', 'agents', 'llm', 'tools', 'systemPrompt'];
const skillName = 'adapting-sillytavern-rp-presets';
const stages = ['migrate', 'assemble', 'render'];
const routeFields = ['provider', 'model', 'reasoningEffort', 'maxTokens'];
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const copy = (value) => structuredClone(value);
const routeConfig = (value) => Object.fromEntries(routeFields.filter((key) => value?.[key] !== undefined).map((key) => [key, value[key]]));
const callKey = (sessionId, callId) => JSON.stringify([sessionId, callId]);

function freeze(value) {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function sessionId(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 256) throw new PresetError('INVALID_SESSION', 'A session id is required');
}
function skillBody(text) {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text);
  const fields = {};
  for (const line of match?.[1].split(/\r?\n/u) ?? []) {
    const field = /^(name|description):\s*(.*?)\s*$/u.exec(line);
    if (field) fields[field[1]] = field[2].replace(/^(['"])(.*)\1$/u, '$2');
  }
  return { content: (match ? text.slice(match[0].length) : text).trim(), description: fields.description ?? 'Adapt SillyTavern RP presets into owner-reviewed agent and presentation modules.' };
}
function entriesFor(binding) {
  return [...binding.profile.entries, ...binding.overlay.additions].map((entry) => {
    const patch = Object.hasOwn(binding.overlay.entries, entry.id) ? binding.overlay.entries[entry.id] : {};
    return { ...entry, ...patch, fills: { ...entry.fills, ...patch.fills } };
  }).sort((left, right) => left.order - right.order);
}
function publicEntry(entry, body = false) {
  const result = {};
  for (const key of ['id', 'name', 'role', 'order', 'enabled', 'phase', 'required', 'locked', 'marker']) if (entry[key] !== undefined) result[key] = copy(entry[key]);
  if (body) { result.content = entry.content; if (Object.keys(entry.fills).length) result.fills = copy(entry.fills); }
  return result;
}

export const LOOP_PARTICIPANT = freeze({
  id: 'rp-last-step',
  nodes: [
    { id: 'migrate', label: 'RP 预设迁移', kind: 'model', control: 'route', description: '按配套 skill 生成供用户审阅的迁移草稿。' },
    { id: 'assemble', label: 'RP 模块热组装', kind: 'model', control: 'route', description: '模拟与工具完成后按权限组装最终呈现模块。' },
    { id: 'render', label: 'RP 最终正文', kind: 'model', control: 'route', description: '独立模型仅依据公开方向包和呈现模块生成正文。' },
  ],
  edges: [
    { id: 'submit', from: 'host.tools', to: 'assemble', label: 'RP 提交，可选' },
    { id: 'assembled', from: 'assemble', to: 'render', label: '编译通过' },
    { id: 'presented', from: 'render', to: 'host.end', label: '正文已提交' },
  ],
});

/** Public adapters only: preset state, isolated presentation and owner Remote reads. */
export async function createRpLastStepHost(ctx, options = {}) {
  const directory = options.directory ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'app-data', 'rp-last-step');
  const store = options.store ?? await createPresetStore({ directory: join(directory, 'presets') });
  const receipts = options.receipts ?? await createReceiptStore({ directory: join(directory, 'presentations') });
  const skillDirectory = options.skillDirectory ?? fileURLToPath(new URL('./skills/adapting-sillytavern-rp-presets/', import.meta.url));
  let skillText;
  let skillReference;
  try {
    [skillText, skillReference] = await Promise.all([
      options.skillText === undefined ? readFile(join(skillDirectory, 'SKILL.md'), 'utf8') : options.skillText,
      options.skillReference === undefined ? readFile(join(skillDirectory, 'references', 'adaptation-guide.md'), 'utf8') : options.skillReference,
    ]);
  } catch { throw new PresetError('MIGRATION_SKILL_UNAVAILABLE', 'The bundled preset adaptation skill is unavailable', 503); }
  if (typeof skillText !== 'string' || typeof skillReference !== 'string') throw new TypeError('skillText and skillReference must be strings');
  const skill = skillBody(skillText);
  let stopped = false;
  let loopStudio;
  let agentAdapter;
  const bindings = new Map();
  const admissions = new Map();
  const operations = new Set();
  const reads = new Set();
  const subscribers = new Map();
  const disposers = [];
  const optionalDisposers = new Set();
  const pendingCalls = new Map();
  const presentations = new Map();
  const turns = new Map();

  function active() { if (stopped) throw new PresetError('UNAVAILABLE', 'RP presentation has been unloaded', 503); }
  async function run(signal, work) {
    active();
    const lifetime = new AbortController();
    operations.add(lifetime);
    const combined = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
    try { combined.throwIfAborted(); const value = await work(combined); combined.throwIfAborted(); return value; }
    finally { operations.delete(lifetime); }
  }
  async function refreshBindings() {
    const snapshot = await store.snapshot();
    const loaded = await Promise.all(Object.keys(snapshot.bindings).map(async (id) => [id, await store.binding(id)]));
    bindings.clear();
    for (const [id, binding] of loaded) if (binding?.profile.status === 'ready') bindings.set(id, freeze(binding));
    agentAdapter?.sync();
    return snapshot;
  }
  await refreshBindings();

  function notify(session, event) {
    for (const listener of subscribers.get(session) ?? []) { try { listener(copy(event)); } catch { /* One UI observer does not own runtime progress. */ } }
  }
  function changed(session) {
    if (session) notify(session, { type: 'changed', sessionId: session });
    else for (const id of subscribers.keys()) notify(id, { type: 'changed', sessionId: id });
  }
  async function readSession(id, signal) {
    active(); sessionId(id);
    const lifetime = new AbortController();
    reads.add(lifetime);
    const combined = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
    let iterator;
    try {
      combined.throwIfAborted();
      const stream = await ctx.typertGateway.stream({ namespace: 'session', method: 'follow', args: { request: { address: { kind: 'session', sessionId: id }, maxMessages: 100 } }, peer: ctx.connection.browserPeer, signal: combined });
      iterator = stream[Symbol.asyncIterator]();
      combined.throwIfAborted();
      const first = await iterator.next();
      combined.throwIfAborted();
      if (first.done || first.value?.type !== 'snapshot' || first.value.header?.id !== id || !Array.isArray(first.value.records)) throw new PresetError('SESSION_NOT_FOUND', 'Session is unavailable', 404);
      return first.value;
    } catch (error) {
      if (combined.aborted) combined.throwIfAborted();
      if (error instanceof PresetError) throw error;
      if (['gateway/forbidden', 'gateway/access-denied'].includes(error?.code)) throw new PresetError('FORBIDDEN', 'Session access was denied', 403);
      if (['session/not-found', 'session-query/not-found'].includes(error?.code)) throw new PresetError('SESSION_NOT_FOUND', 'Session is unavailable', 404);
      if (error?.name === 'AbortError' || error?.code === 'gateway/cancelled') throw new DOMException('The request was cancelled', 'AbortError');
      throw new PresetError('SESSION_UNAVAILABLE', 'The owner session could not be read', 503);
    } finally {
      lifetime.abort(); reads.delete(lifetime);
      try { await iterator?.return?.(); } catch { /* Closing the reader cannot replace its accepted result or safe error. */ }
    }
  }
  function baseFor(id, supplied) {
    const agent = ctx.agents.get(id);
    if (supplied && supplied !== agent) throw new PresetError('AGENT_MISMATCH', 'The caller does not own this live session', 403);
    const header = agent?.session.requestHeader?.();
    if (header) {
      const config = routeConfig(header.config);
      for (const key of ['reasoningEffort', 'maxTokens']) if (header.adapterDefaults?.[key] === true) delete config[key];
      return resolveModelConfig(config);
    }
    return resolveModelConfig({ ...routeConfig(ctx.get?.('agentDefaultModel')?.currentSelection?.()), ...routeConfig(agent?.options) });
  }
  function migrationBaseFor(id, snapshot) {
    const projection = snapshot.projections?.values?.modelSelection;
    const selection = projection?.next ?? projection?.lastUsed;
    if (selection === undefined || selection === null) return baseFor(id);
    // Owner migration follows the next selected route, even before a new main
    // request persists it. Cold selections need no live Agent or global model.
    const selected = resolveModelConfig(routeConfig(selection));
    const header = ctx.agents.get(id)?.session.requestHeader?.();
    const maxTokens = header?.adapterDefaults?.maxTokens === true ? undefined : header?.config?.maxTokens;
    return resolveModelConfig({ ...selected, ...(maxTokens === undefined ? {} : { maxTokens }) });
  }
  async function resolveModels({ sessionId: id }) {
    const studio = loopStudio;
    if (!studio) return {};
    try {
      const values = await Promise.all(stages.map(async (stage) => [stage, copy(await studio.resolveRoute({ sessionId: id, nodeId: `rp-last-step.${stage}` }) ?? {})]));
      return Object.fromEntries(values);
    } catch { throw new PresetError('MODEL_ROUTE_UNAVAILABLE', 'The selected presentation stage route is unavailable', 503); }
  }
  function trace(value) { try { loopStudio?.recordTrace?.(value); } catch { /* Optional metadata observer. */ } }
  const modelCaller = createModelCaller(ctx);
  const callModel = async (input) => {
    const started = Date.now();
    trace({ sessionId: input.sessionId, nodeId: input.stageId, ...routeConfig(input.config), status: 'running' });
    try {
      const value = await modelCaller(input);
      trace({ sessionId: input.sessionId, nodeId: input.stageId, ...routeConfig(value.config), status: 'completed', durationMs: Date.now() - started, tokens: value.usage });
      return value;
    } catch (error) {
      trace({ sessionId: input.sessionId, nodeId: input.stageId, ...routeConfig(input.config), status: error?.name === 'AbortError' ? 'cancelled' : 'failed', durationMs: Date.now() - started });
      throw error;
    }
  };
  async function publish(event) {
    if (stopped) return;
    if (event.delta === undefined && ['rendering', 'rendered'].includes(event.status)) await refreshBindings();
    if (stopped) return;
    try { ctx.emit('rp-last-step/presentation', event); } catch { /* Public progress listeners are observers. */ }
    notify(event.sessionId, { ...event, type: 'stage' });
  }
  const presenter = createPresenter({ store, receipts, callModel, resolveModels, publish, skillText: skill.content, skillReference,
    ...(options.maxAssemblySteps === undefined ? {} : { maxAssemblySteps: options.maxAssemblySteps }),
    ...(options.maxMigrationAttempts === undefined ? {} : { maxMigrationAttempts: options.maxMigrationAttempts }),
  });
  async function bound(id, signal) {
    await readSession(id, signal);
    await refreshBindings();
    const binding = bindings.get(id);
    if (!binding) throw new PresetError('BINDING_NOT_FOUND', 'Bind a ready RP profile to this session first', 409);
    requireNativeTools(ctx, ctx.agents.get(id));
    return binding;
  }
  async function mutation(signal, work, id) {
    return run(signal, async (combined) => { const result = await work(combined); await refreshBindings(); changed(id); return result; });
  }
  const service = {
    isEnabled(id) {
      if (stopped) return false;
      const admitted = admissions.get(id);
      const agent = ctx.agents.get(id);
      const enabled = admitted?.agent === agent && agent?.status === 'running' ? admitted.enabled : bindings.has(id);
      return enabled && usesNativeTools(ctx, agent);
    },
    hasBinding: (id) => !stopped && bindings.has(id),
    bindingMarker(id) {
      const binding = stopped ? undefined : bindings.get(id);
      return binding && usesNativeTools(ctx, ctx.agents.get(id)) ? JSON.stringify({ contract: 'rp-last-step/v1', enabled: true, profileId: binding.profileId, version: binding.version }) : '';
    },
    agentContext(id) {
      const binding = stopped ? undefined : bindings.get(id);
      if (!binding) return '';
      requireNativeTools(ctx, ctx.agents.get(id));
      const compiled = compileProfile(binding.profile, binding.overlay, { phase: 'agent', variables: { user: '玩家' } });
      if (compiled.blocked) {
        const error = new PresetError('COMPILE_BLOCKED', 'Required RP agent modules need owner review before the agent can run', 409);
        error.diagnostics = compiled.diagnostics;
        throw error;
      }
      return compiled.text;
    },
    contextSnapshot(id) {
      if (!stopped && bindings.has(id)) requireNativeTools(ctx, ctx.agents.get(id));
      return freeze({ enabled: !stopped && bindings.has(id), bindingMarker: service.bindingMarker(id), agentContext: service.agentContext(id) });
    },
    admitContext(agent, snapshot) {
      if (!stopped && ctx.agents.get(agent.session.id) === agent) admissions.set(agent.session.id, { agent, enabled: snapshot.enabled });
    },
    authorize: (id, signal) => run(signal, (combined) => readSession(id, combined).then(() => ({}))),
    state(id, signal) {
      return run(signal, async (combined) => {
        await readSession(id, combined);
        const snapshot = await refreshBindings();
        return { revision: snapshot.revision, profiles: snapshot.profiles.map((profile) => ({ id: profile.id, name: profile.name, version: profile.version, status: profile.status, sourceId: profile.sourceId, entryCount: profile.entries.length })),
          binding: copy(bindings.get(id) ?? null), presentations: await presenter.state(id), capabilities: { migrate: Boolean(skill.content) } };
      });
    },
    profile(input, signal) {
      const captured = copy(input);
      return run(signal, async () => { const profile = await store.profile(captured.profileId, captured.version); if (!profile) throw new PresetError('PROFILE_NOT_FOUND', 'Profile version is unavailable', 404); return { revision: (await store.snapshot()).revision, profile }; });
    },
    source(input, signal) {
      const captured = copy(input);
      return run(signal, async () => { const source = await store.source(captured.sourceId); if (!source) throw new PresetError('SOURCE_NOT_FOUND', 'Original source is unavailable', 404); return { source }; });
    },
    createProfile(input, signal) {
      const captured = copy(input);
      return mutation(signal, () => store.saveProfile(createProfile({ name: captured.name }), { expectedRevision: captured.expectedRevision }));
    },
    importSillyTavern(input, signal) {
      const captured = copy(input);
      return mutation(signal, async () => {
        const { diagnostics } = importSillyTavern(captured.rawText, { name: captured.name, orderCharacterId: captured.orderCharacterId });
        return { ...await store.importSource(captured.rawText, captured), diagnostics };
      });
    },
    saveProfile(input, signal) {
      const captured = copy(input);
      return mutation(signal, () => store.saveProfile(captured.profile, { expectedRevision: captured.expectedRevision }));
    },
    bindSession(input, signal) {
      const captured = copy(input);
      return mutation(signal, async (combined) => { await readSession(captured.sessionId, combined); requireNativeTools(ctx, ctx.agents.get(captured.sessionId)); combined.throwIfAborted(); return store.bindSession(captured.sessionId, captured); }, captured.sessionId);
    },
    preview(input, signal) {
      const captured = copy(input);
      return run(signal, () => compileProfile(captured.profile, emptyOverlay(), { phase: captured.phase, variables: captured.variables ?? {}, allowDraft: true }));
    },
    migrate(input, signal) {
      const captured = copy(input);
      return mutation(signal, async (combined) => {
        const snapshot = await readSession(captured.sessionId, combined);
        return presenter.migrate({ ...captured, baseModel: migrationBaseFor(captured.sessionId, snapshot), signal: combined });
      });
    },
    catalog(input) {
      const captured = { sessionId: input.sessionId, signal: input.signal };
      return run(captured.signal, async (combined) => { const binding = await bound(captured.sessionId, combined); return { revision: (await store.snapshot()).revision, profileId: binding.profileId, version: binding.version, entries: entriesFor(binding).map((entry) => publicEntry(entry)) }; });
    },
    read(input) {
      const captured = { sessionId: input.sessionId, entryIds: copy(input.entryIds), signal: input.signal };
      return run(captured.signal, async (combined) => {
        if (!Array.isArray(captured.entryIds) || captured.entryIds.some((id) => typeof id !== 'string' || !id.trim())) throw new PresetError('INVALID_TOOL_ARGUMENTS', 'entryIds must contain module ids');
        const binding = await bound(captured.sessionId, combined);
        const entries = entriesFor(binding);
        const selected = [...new Set(captured.entryIds)].map((id) => { const entry = entries.find((item) => item.id === id); if (!entry) throw new PresetError('UNKNOWN_ENTRY', 'The selected module is unavailable', 404); return publicEntry(entry, true); });
        return { revision: (await store.snapshot()).revision, entries: selected };
      });
    },
    patch(input) {
      const captured = { sessionId: input.sessionId, expectedRevision: input.expectedRevision, operations: copy(input.operations) };
      return mutation(input.signal, async (combined) => { await bound(captured.sessionId, combined); combined.throwIfAborted(); return store.applyOperations(captured.sessionId, captured.operations, { expectedRevision: captured.expectedRevision }); }, captured.sessionId);
    },
    present(input) {
      const captured = { sessionId: input.sessionId, contextKey: input.contextKey, packet: copy(input.packet), callId: input.callId };
      return run(input.signal, async (combined) => {
        try {
          await bound(captured.sessionId, combined);
          const result = await presenter.present({ sessionId: captured.sessionId, contextKey: captured.contextKey, packet: captured.packet, baseModel: baseFor(captured.sessionId, input.agent), signal: combined });
          if (captured.callId) presentations.set(callKey(captured.sessionId, captured.callId), result.id);
          return result;
        } catch (error) {
          const receipt = await receipts.findByContextKey(captured.sessionId, captured.contextKey);
          if (receipt && !['failed', 'cancelled', 'complete'].includes(receipt.status)) await presenter.fail({ sessionId: captured.sessionId, presentationId: receipt.id, error });
          // Validation and route errors can precede receipt creation.
          if (!stopped && !receipt) await publish({ sessionId: captured.sessionId, stageId: 'rp-last-step.render', status: error?.name === 'AbortError' ? 'cancelled' : 'failed', code: error instanceof PresetError ? error.code : 'PRESENTATION_FAILED' });
          throw error;
        } finally { await refreshBindings(); changed(captured.sessionId); }
      });
    },
    commit: (input) => presenter.commit(input),
    fail: (input) => presenter.fail(input),
    subscribe(id, listener) {
      active(); sessionId(id);
      const listeners = subscribers.get(id) ?? new Set();
      listeners.add(listener); subscribers.set(id, listeners);
      return () => { listeners.delete(listener); if (!listeners.size) subscribers.delete(id); };
    },
    async close() {
      if (stopped) return;
      stopped = true;
      for (const controller of [...reads, ...operations]) controller.abort();
      for (const dispose of disposers.splice(0).reverse()) await dispose();
      for (const dispose of optionalDisposers) await dispose();
      subscribers.clear(); bindings.clear(); admissions.clear(); pendingCalls.clear(); presentations.clear(); turns.clear();
    },
  };

  agentAdapter = registerRpLastStepAgent(ctx, service);
  disposers.push(agentAdapter);
  disposers.push(ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    if (stopped || frame.type !== 'start' || ctx.agents.get(agent.session.id) !== agent) return;
    const id = agent.session.id;
    let turn = turns.get(id);
    if (turn?.session !== agent.session || turn.turn !== frame.turn) {
      turn = { session: agent.session, turn: frame.turn, requested: false, required: false, accepted: false };
      turns.set(id, turn);
    }
    turn.requested = true;
    if (service.isEnabled(id)) turn.required = true;
  }));
  disposers.push(ctx.on('session/event', async (session, event) => {
    if (stopped) return;
    const id = session.id;
    if (event.type === 'turn/start') {
      admissions.delete(id);
      turns.set(id, { session, turn: event.data.turn, requested: false, required: false, accepted: false });
      return;
    }
    if (event.type === 'turn/end') {
      const turn = turns.get(id);
      turns.delete(id); admissions.delete(id);
      if (turn?.session === session && turn.turn === event.data.turn && event.data.reason?.kind === 'completed'
        && turn.requested && turn.required && !turn.accepted) {
        await publish({ sessionId: id, stageId: 'rp-last-step.render', status: 'failed', code: 'PRESENTATION_REQUIRED' });
      }
      return;
    }
    if (event.type === 'tool/call') {
      if (event.data.name === 'rp_present') pendingCalls.set(callKey(id, event.data.callId), true);
      return;
    }
    if (event.type !== 'tool/result') return;
    const message = event.data.message;
    if (message?.source?.kind !== 'tool' || typeof message.source.callId !== 'string'
      || (message.toolCallId !== undefined && message.toolCallId !== message.source.callId)) return;
    const key = callKey(id, message.source.callId);
    if (!pendingCalls.delete(key)) return;
    const presentationId = presentations.get(key);
    presentations.delete(key);
    const envelope = event.data.meta?.rpLastStep;
    const record = envelope?.record;
    const accepted = message.isError !== true && envelope?.schemaVersion === 1 && object(record)
      && typeof record.id === 'string' && uuid.test(record.id) && record.status === 'complete' && typeof record.text === 'string'
      && (!presentationId || record.id === presentationId);
    const turn = turns.get(id);
    // Canonical acceptance precedes asynchronous receipt bookkeeping. Only a
    // record returned by this session's presentation call can satisfy its turn.
    if (accepted && record.id === presentationId && turn?.session === session && turn.turn === event.data.turn) turn.accepted = true;
    // Start after canonical publication; observers never append session events.
    await Promise.resolve();
    try {
      if (event.data.message?.isError === true) {
        if (presentationId) await presenter.fail({ sessionId: id, presentationId, error: new PresetError('TOOL_RESULT_REJECTED', 'The presentation tool result was not accepted', 409) });
        return;
      }
      if (!accepted) return;
      await presenter.commit({ sessionId: id, presentationId: record.id, seq: event.seq });
    } catch { /* Foreign, stale or rejected canonical metadata cannot complete a receipt. */ }
  }));
  disposers.push(ctx.on('agent/disposed', ({ agent }) => {
    if (admissions.get(agent.session.id)?.agent === agent) admissions.delete(agent.session.id);
    if (turns.get(agent.session.id)?.session === agent.session) turns.delete(agent.session.id);
  }));
  disposers.push(ctx.on('tools/result', async (exec, result) => {
    if (stopped || exec.name !== 'rp_present' || result.isError !== true) return;
    const id = exec.agent?.session?.id;
    const presentationId = presentations.get(callKey(id, exec.callId));
    if (!presentationId) return;
    try { await presenter.fail({ sessionId: id, presentationId, error: new PresetError('TOOL_RESULT_REJECTED', 'The presentation tool result was not accepted', 409) }); }
    catch { /* Error normalization does not expose provider details. */ }
  }));

  function optional(names, install) {
    const register = (child) => {
      if (stopped) return;
      const mount = () => {
        const cleanup = install(child);
        let disposed = false;
        const dispose = () => { if (disposed) return; disposed = true; optionalDisposers.delete(dispose); cleanup?.(); };
        optionalDisposers.add(dispose);
        return dispose;
      };
      if (typeof child.effect === 'function') child.effect(mount, 'RP last-step optional integration');
      else mount();
    };
    if (typeof ctx.inject === 'function') ctx.inject(names, register);
    else if (names.every((name) => ctx.get?.(name))) register(Object.fromEntries(names.map((name) => [name, ctx.get(name)])));
  }
  optional(['skills'], (child) => child.skills.register({ name: skillName, description: skill.description, content: skill.content, source: 'bundled', resourceBase: { kind: 'directory', path: skillDirectory } }));
  optional(['loopStudio'], (child) => {
    const studio = child.loopStudio;
    const unregister = studio.registerParticipant(copy(LOOP_PARTICIPANT));
    loopStudio = studio;
    return () => { unregister(); if (loopStudio === studio) loopStudio = undefined; };
  });
  return service;
}

export async function apply(ctx, options = {}) {
  const service = await createRpLastStepHost(ctx, options);
  const routes = createRpLastStepRoutes(service);
  ctx.provide('rpLastStep', service);
  const unregister = [
    ctx.connection.fetch.register({ path: '/api/rp-last-step/request', methods: ['POST'], requestBody: 'buffered', fetch: (request) => routes.request(request) }),
    ctx.connection.fetch.register({ path: '/api/rp-last-step/events', methods: ['GET'], requestBody: 'buffered', fetch: (request) => routes.events(request) }),
  ];
  ctx.effect(() => async () => { routes.close(); await service.close(); for (const dispose of unregister) await dispose(); }, 'RP last-step runtime');
}
