import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createPresetStore } from '../src/store.mjs';
import * as module from '../src/host.mjs';
const entry = (id, content, extra = {}) => ({ id, name: id, content, role: 'system', order: 0, enabled: true, required: false, locked: false, phase: 'render', ...extra });
const ready = (entries = [entry('style', 'Use quiet prose.')]) => ({ id: 'preset', name: 'Preset', version: 1, status: 'ready', sourceId: null, entries });
const packet = { playerAction: 'Try the gate', resolvedChanges: ['The attempt failed.'], visibleConsequences: ['The gate stays shut.'] };

class Scope {
  listeners = new Map();
  pending = new Set();
  effects = [];
  errors = [];
  on(name, handler) {
    const handlers = this.listeners.get(name) ?? new Set();
    handlers.add(handler); this.listeners.set(name, handlers);
    return () => handlers.delete(handler);
  }
  emit(name, ...args) {
    for (const handler of Array.from(this.listeners.get(name) ?? [])) {
      try {
        const work = Promise.resolve(handler(...args)).catch((error) => this.errors.push(error));
        this.pending.add(work); void work.finally(() => this.pending.delete(work));
      } catch (error) { this.errors.push(error); }
    }
  }
  async flush() { while (this.pending.size) await Promise.all(this.pending); }
  effect(factory) {
    const cleanup = factory();
    if (cleanup !== undefined && cleanup !== null && typeof cleanup !== 'function') throw new TypeError('Invalid effect');
    this.effects.push(cleanup);
    return cleanup;
  }
  async close() { for (const cleanup of this.effects.splice(0).reverse()) await cleanup?.(); }
  count() { return [...this.listeners.values()].reduce((count, handlers) => count + handlers.size, 0); }
}

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'rpls-host-'));
  const store = await createPresetStore({ directory: join(directory, 'presets') });
  if (options.persisted) {
    await store.saveProfile(ready(options.entries), { expectedRevision: 0 });
    await store.bindSession('story', { profileId: 'preset', version: 1, expectedRevision: 1 });
  }
  const ctx = new Scope();
  const ctxTools = new Map();
  const globalTools = new Map();
  const toolScopes = new Map();
  const contexts = new Map();
  const toolProviders = new Set();
  const fetchRoutes = new Map();
  const skillEntries = new Map();
  const peer = { principal: { kind: 'owner' } };
  const calls = [];
  const remoteCalls = [];
  const presentations = [];
  const stages = options.stages ?? [{ commit: true }, 'The gate stays shut.'];
  const agents = new Map();
  const makeAgent = (id, extra = {}) => {
    const scope = { own: id === 'story' ? ctxTools : new Map(), denials: new Set(), mode: options.toolModes?.[id], ...extra };
    const agent = {
      id, options: { provider: 'local', model: 'base', reasoningEffort: 'high' },
      session: { id, header: { id }, requestHeader: () => ({ config: { provider: 'local', model: 'main-header', reasoningEffort: 'high', maxTokens: 500 } }),
        snapshotEvents: () => [], deriveMessages: () => [{ id: 'assistant-1', role: 'assistant', content: [{ type: 'tool-call', name: 'rp_present', id: 'call-1', arguments: '{}' }] }],
        append: () => { throw new Error('Session observers must never append'); },
      },
      ctx: { tools: {
        register: (tool) => { scope.own.set(tool.name, tool); ctx.emit('tools/change'); return () => { scope.own.delete(tool.name); ctx.emit('tools/change'); }; },
        restrict: ({ deny }) => { const denied = new Set(deny); scope.denials.add(denied); ctx.emit('tools/change'); return () => { scope.denials.delete(denied); ctx.emit('tools/change'); }; },
      } },
    };
    toolScopes.set(agent, scope);
    return agent;
  };
  agents.set('story', makeAgent('story'));
  agents.set('code', makeAgent('code'));
  let current = agents.get('story');
  ctx.agents = { get: (id) => agents.get(id), list: () => [...agents.values()], currentInitiator: () => current };
  const effectiveMode = (agent) => {
    const scope = toolScopes.get(agent);
    return scope?.mode ?? (scope?.parent ? effectiveMode(scope.parent) : options.defaultToolMode ?? 'native');
  };
  const visibleTool = (name, agent) => {
    if (name === 'run_code') return effectiveMode(agent) === 'ptc' ? { name: 'run_code' } : undefined;
    const scope = toolScopes.get(agent);
    if (scope?.own.has(name)) return scope.own.get(name);
    if ([...scope?.denials ?? []].some((denied) => denied.has(name))) return undefined;
    return scope?.parent ? visibleTool(name, scope.parent) : globalTools.get(name);
  };
  const schemas = (agent) => {
    const names = new Set(globalTools.keys());
    for (let current = agent; current; current = toolScopes.get(current)?.parent) for (const name of toolScopes.get(current).own.keys()) names.add(name);
    if (effectiveMode(agent) === 'ptc') names.add('run_code');
    return [...names].map((name) => visibleTool(name, agent)).filter(Boolean).map(({ name, parameters = {} }) => ({ name, parameters }));
  };
  ctx.tools = {
    register: (tool) => { globalTools.set(tool.name, tool); ctx.emit('tools/change'); return () => { globalTools.delete(tool.name); ctx.emit('tools/change'); }; },
    get: visibleTool, schemas,
  };
  ctx.systemPrompt = {
    context: (context) => { contexts.set(context.name, context); return () => contexts.delete(context.name); },
    tools: (provider) => { toolProviders.add(provider); return () => toolProviders.delete(provider); },
  };
  ctx.connection = { browserPeer: peer, fetch: { register: (route) => { fetchRoutes.set(route.path, route); return async () => fetchRoutes.delete(route.path); } } };
  const services = { skills: { register: (skill) => { skillEntries.set(skill.name, skill); return () => skillEntries.delete(skill.name); } }, ...options.services };
  ctx.get = (name) => services[name];
  ctx.provide = (name, value) => { services[name] = value; };
  const injections = [];
  ctx.inject = (names, callback) => {
    if (!names.every((name) => services[name])) return;
    const child = new Scope();
    for (const name of names) child[name] = services[name];
    injections.push(child); callback(child);
  };
  ctx.typertGateway = { stream: async (request) => {
    remoteCalls.push(request);
    assert.equal(request.peer, peer);
    assert.equal(request.namespace, 'session'); assert.equal(request.method, 'follow');
    const id = request.args.request.address.sessionId;
    if (id === 'denied') throw Object.assign(new Error('owner denied private data'), { code: 'gateway/forbidden' });
    if (id === 'missing') throw Object.assign(new Error('private path'), { code: 'session/not-found' });
    if (options.remote) return options.remote(request);
    if (!agents.has(id)) agents.set(id, makeAgent(id));
    return (async function* () { yield { type: 'snapshot', header: { id }, records: [], cursor: -1, hasMore: false, projections: { values: options.projections?.[id] ?? {}, asOfSeq: -1 } }; })();
  } };
  ctx.llm = { prepareCall: async (config, signal) => {
    calls.push({ config, signal });
    return { config, stream: async function* (request) {
      calls.at(-1).request = request;
      let stage = stages.shift();
      if (typeof stage === 'function') stage = await stage(request);
      if (stage instanceof Error) throw stage;
      const text = typeof stage === 'string' ? stage : JSON.stringify(stage);
      yield { type: 'text-delta', index: 0, text };
      yield { type: 'block-end', index: 0, block: { type: 'text', text } };
      yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 3, private: 'secret' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    } };
  } };
  ctx.on('rp-last-step/presentation', (event) => presentations.push(event));
  assert.equal(typeof module.createRpLastStepHost, 'function');
  const hostOptions = { directory, store, skillText: '---\nname: adapting-sillytavern-rp-presets\ndescription: Adapt imported RP presets.\n---\nBundled migration instructions.', skillReference: 'Bundled reference.', skillDirectory: join(directory, 'bundled-skill'), ...options.host };
  let host;
  t.after(async () => { await ctx.close(); await host?.close(); for (const child of injections) await child.close(); await ctx.flush(); await rm(directory, { recursive: true, force: true }); });
  if (options.plugin) {
    const result = await module.apply(ctx, hostOptions);
    // Cordis awaits async apply and collects only a function or nullable result.
    ctx.effect(() => result);
    host = services.rpLastStep;
  } else host = await module.createRpLastStepHost(ctx, hostOptions);
  const surface = (agent) => {
    const visible = schemas(agent);
    return effectiveMode(agent) === 'ptc' ? { tools: visible.filter((tool) => tool.name === 'run_code'), sections: [{ name: 'tools:sdk', text: visible.filter((tool) => tool.name !== 'run_code').map((tool) => tool.name).join('\n') }] } : { tools: visible, sections: [] };
  };
  return { ctx, host, store, directory, ctxTools, globalTools, toolScopes, surface, makeAgent, contexts, toolProviders, services, injections, fetchRoutes, skillEntries, agents, calls, remoteCalls, presentations, current: (id) => { current = agents.get(id); } };
}

async function bind(f, profile = ready()) {
  const saved = await f.host.saveProfile({ profile, expectedRevision: (await f.store.snapshot()).revision });
  await f.host.bindSession({ sessionId: 'story', profileId: saved.profileId, version: saved.version, expectedRevision: saved.revision });
}

test('plugin apply provides its service and routes while returning a valid Cordis effect result', async (t) => {
  const f = await fixture(t, { plugin: true });
  assert.equal(f.services.rpLastStep, f.host);
  assert.deepEqual([...f.fetchRoutes.keys()], ['/api/rp-last-step/request', '/api/rp-last-step/events']);
  const response = await f.fetchRoutes.get('/api/rp-last-step/request').fetch(new Request('http://localhost/api/rp-last-step/request', { method: 'POST', body: JSON.stringify({ action: 'state', sessionId: 'story' }) }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).binding, null);
  await f.ctx.close();
  assert.equal(f.fetchRoutes.size, 0);
  assert.equal(f.host.isEnabled('story'), false);
});

test('starts with persisted opt-in bindings and injects only compiled agent/shared modules', async (t) => {
  const f = await fixture(t, { persisted: true, entries: [entry('render', 'RENDER PRIVATE STYLE'), entry('agent', 'AGENT RULE', { phase: 'agent' }), entry('shared', 'Hello {{user}}', { phase: 'shared' })] });
  assert.equal(f.host.isEnabled('story'), true);
  assert.equal(f.host.isEnabled('code'), false);
  assert.equal(f.host.isEnabled('missing'), false);
  assert.equal(f.host.isEnabled('story') instanceof Promise, false);
  assert.deepEqual(JSON.parse(f.contexts.get('rp-last-step-binding').text({})), { contract: 'rp-last-step/v1', enabled: true, profileId: 'preset', version: 1 });
  const context = f.contexts.get('rp-last-step-agent').text({});
  assert.match(context, /AGENT RULE/u); assert.match(context, /Hello 玩家/u); assert.doesNotMatch(context, /RENDER PRIVATE STYLE/u);
  f.current('code');
  assert.equal(f.contexts.get('rp-last-step-binding').text({}), '');
  const profile = await f.host.profile({ profileId: 'preset' });
  assert.equal(profile.profile.version, 1);
  assert.equal(f.remoteCalls.length, 0);
});

test('owner library actions preserve sources and pinned versions without requiring a session', async (t) => {
  const f = await fixture(t);
  const text = '\uFEFF {"name":"Imported","prompts":[{"identifier":"style","content":"Exact source content"}]}\r\n';
  const imported = await f.host.importSillyTavern({ rawText: text, expectedRevision: 0 });
  const profileReply = await f.host.profile({ profileId: imported.profileId });
  const sourceReply = await f.host.source({ sourceId: profileReply.profile.sourceId });
  assert.equal(sourceReply.source.rawText, text);
  assert.equal(f.remoteCalls.length, 0);
  await assert.rejects(f.host.bindSession({ sessionId: 'story', profileId: imported.profileId, version: 1, expectedRevision: 1 }), { code: 'PROFILE_NOT_READY' });
  const changed = { ...profileReply.profile, status: 'ready', entries: profileReply.profile.entries.map((item) => ({ ...item, phase: 'render' })) };
  const saved = await f.host.saveProfile({ profile: changed, expectedRevision: 1 });
  await f.host.bindSession({ sessionId: 'story', profileId: saved.profileId, version: saved.version, expectedRevision: saved.revision });
  assert.equal(f.host.isEnabled('story'), true);
  assert.equal((await f.host.state('story')).binding.version, 2);
  await f.host.saveProfile({ profile: { ...changed, version: saved.version, name: 'Newer' }, expectedRevision: 3 });
  const state = await f.host.state('story');
  assert.deepEqual(state.profiles.map(({ id, name, version, status, sourceId, entryCount }) => ({ id, name, version, status, sourceId, entryCount })), [{ id: imported.profileId, name: 'Newer', version: 3, status: 'ready', sourceId: profileReply.profile.sourceId, entryCount: 1 }]);
  assert.equal(state.binding.profile.name, 'Imported');
  assert.equal(state.binding.version, 2);
  assert.equal(state.revision, 4);
  assert.equal(state.capabilities.migrate, true);
  assert.equal(JSON.stringify(state).includes(text), false);
  await assert.rejects(f.host.saveProfile({ profile: changed, expectedRevision: 2 }), { code: 'REVISION_CONFLICT' });
  assert.equal((await f.host.source({ sourceId: profileReply.profile.sourceId })).source.rawText, text);
});

test('state, bind and agent operations use exact owner Remote follow snapshots and deny inaccessible sessions', async (t) => {
  const f = await fixture(t);
  const created = await f.host.createProfile({ name: 'Empty owner draft', expectedRevision: 0 });
  assert.equal(f.remoteCalls.length, 0);
  assert.equal(created.revision, 1);
  for (const id of ['denied', 'missing']) {
    await assert.rejects(f.host.state(id));
    await assert.rejects(f.host.bindSession({ sessionId: id, profileId: created.profileId, version: 1, expectedRevision: 1 }));
    await assert.rejects(f.host.catalog({ sessionId: id }));
  }
  const state = await f.host.state('cold');
  assert.equal(state.binding, null);
  const call = f.remoteCalls.at(-1);
  assert.deepEqual(call.args, { request: { address: { kind: 'session', sessionId: 'cold' }, maxMessages: 100 } });
  assert.equal(call.signal.aborted, true);
  await assert.rejects(f.host.state(''), { code: 'INVALID_SESSION' });
});

test('unbound native and PTC sessions have no RP schemas or SDK names and bind rejects pure PTC', async (t) => {
  const f = await fixture(t, { defaultToolMode: 'ptc', toolModes: { code: 'native' } });
  for (const id of ['story', 'code']) assert.doesNotMatch(JSON.stringify(f.surface(f.agents.get(id))), /rp_present|rp_last_step/u);
  const saved = await f.host.saveProfile({ profile: ready(), expectedRevision: 0 });
  await assert.rejects(f.host.bindSession({ sessionId: 'story', profileId: saved.profileId, version: saved.version, expectedRevision: 1 }), { code: 'NATIVE_TOOLS_REQUIRED' });
  assert.equal((await f.host.state('story')).binding, null);
  assert.equal((await f.store.snapshot()).revision, 1);
  assert.equal(f.calls.length, 0);
  assert.equal(f.globalTools.size, 0);
  assert.equal(f.ctxTools.size, 0);
  assert.equal(f.host.isEnabled('story'), false);
  const preview = await f.host.preview({ profile: ready(), phase: 'render' });
  assert.equal(preview.blocked, false);
  assert.equal((await f.host.profile({ profileId: 'preset' })).profile.name, 'Preset');
});

test('a native agent within a PTC deployment receives only its own scoped RP tools and cleanup', async (t) => {
  const f = await fixture(t, { defaultToolMode: 'ptc', toolModes: { story: 'native' } });
  await bind(f);
  assert.deepEqual(f.surface(f.agents.get('story')).tools.map((tool) => tool.name), ['rp_last_step_catalog', 'rp_last_step_read', 'rp_last_step_patch', 'rp_present']);
  assert.doesNotMatch(JSON.stringify(f.surface(f.agents.get('code'))), /rp_present|rp_last_step/u);
  assert.equal(f.globalTools.size, 0);
  assert.equal((await f.ctxTools.get('rp_last_step_catalog').execute({}, { agent: f.agents.get('story'), signal: new AbortController().signal })).profileId, 'preset');
  await f.host.close();
  assert.equal(f.ctxTools.size, 0);
  assert.doesNotMatch(JSON.stringify(f.surface(f.agents.get('story'))), /rp_present|rp_last_step/u);
});

test('persisted PTC bindings fail activation before contexts or model calls while migration stays available', async (t) => {
  const f = await fixture(t, { persisted: true, defaultToolMode: 'ptc', stages: [{ updates: [], additions: [], report: { summary: 'Owner review draft' } }] });
  assert.equal(f.host.isEnabled('story'), false);
  const agent = f.agents.get('story');
  assert.throws(() => { for (const provider of f.toolProviders) provider({ agent, scope: agent }); }, { code: 'NATIVE_TOOLS_REQUIRED' });
  assert.equal(f.calls.length, 0);
  assert.equal(f.ctxTools.size, 0);
  assert.doesNotMatch(JSON.stringify(f.surface(agent)), /rp_present|rp_last_step/u);
  const migrated = await f.host.migrate({ sessionId: 'story', profileId: 'preset', version: 1, expectedRevision: 2 });
  assert.equal(migrated.version, 2);
  assert.equal(f.calls.length, 1);
  assert.equal((await f.host.profile({ profileId: 'preset' })).profile.status, 'draft');
});

test('unbound PTC descendants mask inherited RP tools and scopes follow agent lifecycle', async (t) => {
  const f = await fixture(t);
  const parent = f.agents.get('story');
  const child = f.makeAgent('child', { parent, mode: 'ptc' });
  f.agents.set('child', child);
  f.ctx.emit('agent/created', { agent: child });
  await bind(f);
  assert.doesNotMatch(JSON.stringify(f.surface(child)), /rp_present|rp_last_step/u);
  assert.equal(f.toolScopes.get(child).denials.size, 1);
  for (const name of ['rp_last_step_catalog', 'rp_last_step_read', 'rp_last_step_patch', 'rp_present']) assert.equal(f.ctx.tools.get(name, child), undefined);
  const own = f.toolScopes.get(parent).own;
  f.agents.delete('story');
  f.ctx.emit('agent/disposed', { agent: parent });
  assert.equal(own.size, 0);
  await f.host.close();
  assert.equal(f.toolScopes.get(child).denials.size, 0);
});

test('agent reads are selected, lock-checked patches refresh the cache and conflicts preserve the overlay', async (t) => {
  const f = await fixture(t);
  await bind(f, ready([entry('style', 'SECRET MODULE BODY'), entry('agent', 'Before', { phase: 'agent' }), entry('locked', 'Owner fixed', { locked: true }), entry('required', 'Required', { required: true })]));
  const catalog = await f.host.catalog({ sessionId: 'story' });
  assert.equal(catalog.revision, 2);
  assert.equal(catalog.entries.length, 4);
  assert.doesNotMatch(JSON.stringify(catalog), /SECRET MODULE BODY|Owner fixed/u);
  assert.deepEqual((await f.host.read({ sessionId: 'story', entryIds: ['style'] })).entries.map((item) => item.content), ['SECRET MODULE BODY']);
  await assert.rejects(f.host.read({ sessionId: 'story', entryIds: ['absent'] }), { code: 'UNKNOWN_ENTRY' });
  await assert.rejects(f.host.patch({ sessionId: 'story', expectedRevision: 2, operations: [{ op: 'replace', entryId: 'locked', content: 'Bypass' }] }), { code: 'ENTRY_LOCKED' });
  await assert.rejects(f.host.patch({ sessionId: 'story', expectedRevision: 2, operations: [{ op: 'disable', entryId: 'required' }] }), { code: 'ENTRY_REQUIRED' });
  const patched = await f.host.patch({ sessionId: 'story', expectedRevision: 2, operations: [{ op: 'replace', entryId: 'agent', content: 'After' }] });
  assert.equal(patched.revision, 3);
  assert.match(f.host.agentContext('story'), /After/u);
  await assert.rejects(f.host.patch({ sessionId: 'story', expectedRevision: 2, operations: [{ op: 'disable', entryId: 'style' }] }), { code: 'REVISION_CONFLICT' });
  assert.equal((await f.host.profile({ profileId: 'preset' })).profile.entries[1].content, 'Before');
});

test('required agent diagnostics block assembly and preview permits owner draft review', async (t) => {
  const f = await fixture(t);
  await bind(f, ready([entry('rules', '{{unknown}}', { phase: 'agent', required: true })]));
  assert.throws(() => f.host.agentContext('story'), { code: 'COMPILE_BLOCKED' });
  const draft = { ...ready([entry('draft', 'Hello {{user}}', { phase: 'agent' })]), status: 'draft' };
  const preview = await f.host.preview({ profile: draft, phase: 'agent', variables: { user: 'Reader' } });
  assert.equal(preview.blocked, false);
  assert.equal(preview.text, 'Hello Reader');
});

test('admission refresh keeps schemas and context on one frozen binding until the next assembly', async (t) => {
  const f = await fixture(t);
  const agent = f.agents.get('story');
  agent.status = 'running';
  const context = { agent, scope: agent, signal: new AbortController().signal };
  for (const provider of f.toolProviders) provider(context);
  const filter = [...f.ctx.listeners.get('system-prompt/assemble')][0];
  const assembly = { sections: [], contexts: [], variables: {}, tools: [{ name: 'lookup' }, ...[...f.ctxTools.keys()].map((name) => ({ name }))] };
  let release;
  let entered;
  const waiting = new Promise((resolve) => { release = resolve; });
  const reached = new Promise((resolve) => { entered = resolve; });
  const pending = filter(assembly, context, async () => { entered(); await waiting; return assembly; });
  await reached;
  await bind(f, ready([entry('agent', 'BEFORE OWNER EDIT', { phase: 'agent' })]));
  assert.equal(f.host.isEnabled('story'), false);
  assert.equal((await f.host.state('story')).binding.profileId, 'preset');
  release();
  assert.deepEqual((await pending).tools, [{ name: 'lookup' }]);
  const refresh = { agent, scope: agent, signal: context.signal };
  assert.equal(f.contexts.get('rp-last-step-binding').text(refresh), '');
  assert.equal(f.contexts.get('rp-last-step-agent').text(refresh), '');

  const second = { agent, scope: agent, signal: context.signal };
  for (const provider of f.toolProviders) provider(second);
  const nextAssembly = { ...assembly, tools: [{ name: 'lookup' }, ...f.surface(agent).tools] };
  assert.equal((await filter(nextAssembly, second, async () => nextAssembly)).tools.length, 5);
  assert.equal(f.host.isEnabled('story'), true);
  assert.match(f.contexts.get('rp-last-step-agent').text(second), /BEFORE OWNER EDIT/u);
  await f.host.patch({ sessionId: 'story', expectedRevision: 2, operations: [{ op: 'replace', entryId: 'agent', content: 'AFTER OWNER EDIT' }] });
  assert.match(f.host.agentContext('story'), /AFTER OWNER EDIT/u);
  assert.match(f.contexts.get('rp-last-step-agent').text({ agent, scope: agent, signal: context.signal }), /BEFORE OWNER EDIT/u);
  const third = { agent, scope: agent, signal: context.signal };
  for (const provider of f.toolProviders) provider(third);
  assert.match(f.contexts.get('rp-last-step-agent').text(third), /AFTER OWNER EDIT/u);
});

test('terminal presentation remains rendered until an accepted canonical rp_present result commits it', async (t) => {
  const f = await fixture(t);
  await bind(f);
  const tool = f.ctxTools.get('rp_present');
  let conclusions = 0;
  const value = await tool.execute({ packet }, { agent: f.agents.get('story'), callId: 'call-1', rootCallId: 'call-1', signal: new AbortController().signal, concludeTurn: () => conclusions++ });
  assert.equal(value.status, 'rendered');
  assert.equal(conclusions, 1);
  assert.deepEqual(f.calls.map(({ config }) => config.model), ['main-header', 'main-header']);
  assert.equal((await f.host.state('story')).presentations[0].status, 'rendered');
  assert.equal(f.presentations.some((event) => event.status === 'complete'), false);
  const meta = tool.output.presentationMeta({}, value);
  f.ctx.emit('session/event', f.agents.get('story').session, { type: 'tool/call', seq: 10, data: { callId: 'call-1', name: 'rp_present', arguments: '{}' } });
  f.ctx.emit('session/event', f.agents.get('story').session, { type: 'tool/result', seq: 11, data: { message: { role: 'tool', source: { kind: 'tool', callId: 'call-1' }, toolCallId: 'call-1', isError: false, content: tool.output.render({}, value) }, meta } });
  await f.ctx.flush();
  assert.equal((await f.host.state('story')).presentations[0].status, 'complete');
  assert.equal(f.presentations.at(-1).seq, 11);
  assert.equal(f.ctx.errors.length, 0);
  assert.doesNotMatch(JSON.stringify(f.presentations), /playerAction|resolvedChanges|system|prompts|usage/u);
  assert.equal(f.calls[1].request.messages[0].content[0].text.includes('The attempt failed.'), true);
  assert.equal(f.calls[1].request.tools, undefined);
});

test('a completed bound main request without canonical presentation emits one safe failure', async (t) => {
  const f = await fixture(t);
  await bind(f);
  const agent = f.agents.get('story');
  agent.status = 'running';
  f.ctx.emit('session/event', agent.session, { type: 'turn/start', seq: 1, data: { turn: 1 } });
  for (const provider of f.toolProviders) provider({ agent, scope: agent });
  f.ctx.emit('agent/assistant-stream', { agent, frame: { type: 'start', attemptId: 'main-1', revision: 1, turn: 1, step: 1 } });
  f.ctx.emit('session/event', agent.session, { type: 'assistant/message', seq: 2, data: { turn: 1, step: 1, message: { id: 'main', role: 'assistant', source: { kind: 'model', provider: 'local', model: 'main' }, content: [{ type: 'text', text: 'PRIVATE MAIN TEXT token=secret' }] }, stream: [] } });
  const end = { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'completed' } } };
  f.ctx.emit('session/event', agent.session, end);
  f.ctx.emit('session/event', agent.session, end);
  await f.ctx.flush();
  assert.deepEqual(f.presentations, [{ sessionId: 'story', stageId: 'rp-last-step.render', status: 'failed', code: 'PRESENTATION_REQUIRED' }]);
  assert.equal(f.calls.length, 0);
  assert.doesNotMatch(JSON.stringify(f.presentations), /PRIVATE|secret|token=/u);
});

test('no-request, cancellation, error, unbound and migration-only turns do not report missing presentation', async (t) => {
  const f = await fixture(t, { stages: [{ updates: [], additions: [], report: { summary: 'Owner migration review' } }] });
  await bind(f);
  const agent = f.agents.get('story');
  agent.status = 'running';
  let turn = 0;
  for (const [request, reason] of [
    [false, { kind: 'completed' }],
    [true, { kind: 'aborted', reason: { kind: 'legacy' } }],
    [true, { kind: 'error', error: { code: 'MODEL_FAILED', message: 'private' } }],
    [true, { kind: 'blocked' }],
    [true, { kind: 'max-tokens' }],
  ]) {
    turn++;
    f.ctx.emit('session/event', agent.session, { type: 'turn/start', data: { turn } });
    for (const provider of f.toolProviders) provider({ agent, scope: agent });
    if (request) f.ctx.emit('agent/assistant-stream', { agent, frame: { type: 'start', attemptId: `main-${turn}`, revision: turn, turn, step: 1 } });
    f.ctx.emit('session/event', agent.session, { type: 'turn/end', data: { turn, reason } });
  }
  const unbound = f.agents.get('code');
  f.current('code'); unbound.status = 'running';
  f.ctx.emit('session/event', unbound.session, { type: 'turn/start', data: { turn: 1 } });
  for (const provider of f.toolProviders) provider({ agent: unbound, scope: unbound });
  f.ctx.emit('agent/assistant-stream', { agent: unbound, frame: { type: 'start', attemptId: 'code-1', revision: 1, turn: 1, step: 1 } });
  f.ctx.emit('session/event', unbound.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  f.current('story');
  f.ctx.emit('session/event', agent.session, { type: 'turn/start', data: { turn: 6 } });
  await f.host.migrate({ sessionId: 'story', profileId: 'preset', version: 1, expectedRevision: 2 });
  f.ctx.emit('session/event', agent.session, { type: 'turn/end', data: { turn: 6, reason: { kind: 'completed' } } });
  await f.ctx.flush();
  assert.equal(f.presentations.some((event) => event.code === 'PRESENTATION_REQUIRED'), false);
  assert.equal(f.calls.length, 1);
});

test('accepted canonical metadata is marked before asynchronous receipt commit can lag behind turn end', async (t) => {
  const f = await fixture(t);
  await bind(f);
  const agent = f.agents.get('story');
  agent.status = 'running';
  f.ctx.emit('session/event', agent.session, { type: 'turn/start', seq: 1, data: { turn: 1 } });
  for (const provider of f.toolProviders) provider({ agent, scope: agent });
  f.ctx.emit('agent/assistant-stream', { agent, frame: { type: 'start', attemptId: 'main-1', revision: 1, turn: 1, step: 1 } });
  const tool = f.ctxTools.get('rp_present');
  const value = await tool.execute({ packet }, { agent, callId: 'call-1', rootCallId: 'call-1', signal: new AbortController().signal, concludeTurn: () => {} });
  f.ctx.emit('session/event', agent.session, { type: 'tool/call', seq: 2, data: { turn: 1, step: 1, callId: 'call-1', name: 'rp_present', arguments: '{}' } });
  f.ctx.emit('session/event', agent.session, { type: 'tool/result', seq: 3, data: { turn: 1, step: 1, message: { id: 'result-1', role: 'tool', source: { kind: 'tool', callId: 'call-1' }, toolCallId: 'call-1', isError: false, content: tool.output.render({}, value) }, meta: tool.output.presentationMeta({}, value) } });
  f.ctx.emit('session/event', agent.session, { type: 'turn/end', seq: 4, data: { turn: 1, reason: { kind: 'completed' } } });
  assert.equal(f.presentations.some((event) => event.code === 'PRESENTATION_REQUIRED'), false);
  await f.ctx.flush();
  assert.equal(f.presentations.some((event) => event.code === 'PRESENTATION_REQUIRED'), false);
  assert.equal((await f.host.state('story')).presentations[0].status, 'complete');
});

test('unowned or failed canonical metadata cannot mask a missing presentation', async (t) => {
  const f = await fixture(t);
  await bind(f);
  const agent = f.agents.get('story');
  agent.status = 'running';
  for (const [turn, isError] of [[1, false], [2, true]]) {
    f.ctx.emit('session/event', agent.session, { type: 'turn/start', data: { turn } });
    for (const provider of f.toolProviders) provider({ agent, scope: agent });
    f.ctx.emit('agent/assistant-stream', { agent, frame: { type: 'start', attemptId: `main-${turn}`, revision: turn, turn, step: 1 } });
    f.ctx.emit('session/event', agent.session, { type: 'tool/call', data: { turn, step: 1, callId: 'guessed', name: 'rp_present' } });
    f.ctx.emit('session/event', agent.session, { type: 'tool/result', data: { turn, step: 1, message: { id: 'foreign', role: 'tool', source: { kind: 'tool', callId: 'guessed' }, toolCallId: 'guessed', isError, content: [] }, meta: { rpLastStep: { schemaVersion: 1, record: { id: '00000000-0000-4000-8000-000000000001', text: 'Foreign', status: 'complete' } } } } });
    f.ctx.emit('session/event', agent.session, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } });
  }
  await f.ctx.flush();
  assert.equal(f.presentations.filter((event) => event.code === 'PRESENTATION_REQUIRED').length, 2);
  assert.equal(f.calls.length, 0);
});

test('failed tool acceptance, wrong tool metadata and other-session receipts never become complete', async (t) => {
  const f = await fixture(t);
  await bind(f);
  const value = await f.host.present({ sessionId: 'story', packet, contextKey: '["story","assistant-1","call-1"]', callId: 'call-1' });
  const meta = { rpLastStep: { schemaVersion: 1, record: { ...value, status: 'complete' } } };
  const publish = (sessionId, callId, toolName, isError, payload = meta) => {
    f.ctx.emit('session/event', f.agents.get(sessionId).session, { type: 'tool/call', seq: 1, data: { callId, name: toolName } });
    f.ctx.emit('session/event', f.agents.get(sessionId).session, { type: 'tool/result', seq: 2, data: { message: { role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId, isError }, meta: payload } });
  };
  publish('story', 'wrong', 'lookup', false);
  publish('code', 'foreign', 'rp_present', false);
  publish('story', 'wrong-version', 'rp_present', false, { rpLastStep: { schemaVersion: 2, record: { ...value, status: 'complete' } } });
  await f.ctx.flush();
  assert.equal((await f.host.state('story')).presentations[0].status, 'rendered');
  publish('story', 'call-1', 'rp_present', true);
  await f.ctx.flush();
  assert.equal((await f.host.state('story')).presentations[0].status, 'failed');
  assert.equal(f.presentations.some((event) => event.status === 'complete'), false);
  assert.equal(f.ctx.errors.length, 0);
});

test('Loop Studio routes are frozen for every stage and trace records contain only model metadata', async (t) => {
  const participants = [];
  const routes = { migrate: { provider: 'local', model: 'migrator' }, assemble: { provider: 'local', model: 'assembler', reasoningEffort: 'low' }, render: { provider: 'local', model: 'writer', maxTokens: 123 } };
  const selected = [];
  const traces = [];
  let unregistered = 0;
  const studio = {
    registerParticipant: (participant) => { participants.push(participant); return () => unregistered++; },
    resolveRoute: ({ sessionId, nodeId }) => { selected.push({ sessionId, nodeId }); return routes[nodeId.split('.').at(-1)]; },
    recordTrace: (trace) => traces.push(trace),
  };
  const f = await fixture(t, { services: { loopStudio: studio }, stages: [() => { routes.render = { provider: 'cloud', model: 'late-edit' }; return { commit: true }; }, 'The gate stays shut.'] });
  await bind(f);
  await f.host.present({ sessionId: 'story', packet, contextKey: 'turn-1' });
  assert.deepEqual(selected.map((value) => value.nodeId), ['rp-last-step.migrate', 'rp-last-step.assemble', 'rp-last-step.render']);
  assert.deepEqual(f.calls.map(({ config }) => config), [{ provider: 'local', model: 'assembler', reasoningEffort: 'low', maxTokens: 500 }, { provider: 'local', model: 'writer', maxTokens: 123 }]);
  assert.equal(participants[0].id, 'rp-last-step');
  assert.equal(participants[0].nodes.every((node) => node.control === 'route' && node.kind === 'model'), true);
  assert.equal(participants[0].edges.some((edge) => edge.label.includes('可选')), true);
  assert.doesNotMatch(JSON.stringify(traces), /playerAction|SECRET|messages|system|private/u);
  assert.equal(traces.some((trace) => trace.model === 'writer' && trace.tokens?.outputTokens === 3), true);
  await f.host.close();
  assert.equal(unregistered, 1);
});

test('configured stage route failures do not silently fall back to another model', async (t) => {
  const f = await fixture(t, { services: { loopStudio: { registerParticipant: () => () => {}, resolveRoute: () => { throw new Error('private unavailable local route'); } } } });
  await bind(f);
  await assert.rejects(f.host.present({ sessionId: 'story', packet, contextKey: 'turn-1' }), { code: 'MODEL_ROUTE_UNAVAILABLE' });
  assert.equal(f.calls.length, 0);
  assert.equal(f.presentations.at(-1).status, 'failed');
  assert.doesNotMatch(JSON.stringify(f.presentations), /private unavailable/u);
});

test('owner migration uses the authenticated pending model selection ahead of an older request header', async (t) => {
  const f = await fixture(t, {
    projections: { story: { modelSelection: { next: { provider: 'local', model: 'pending-local', reasoningEffort: 'low' }, lastUsed: { provider: 'cloud', model: 'old-cloud', reasoningEffort: 'high' } } } },
    stages: [{ updates: [], additions: [], report: { summary: 'Owner review' } }],
  });
  const agent = f.agents.get('story');
  const prior = { config: { provider: 'cloud', model: 'old-cloud', reasoningEffort: 'high' } };
  agent.session.requestHeader = () => prior;
  const saved = await f.host.saveProfile({ profile: ready(), expectedRevision: 0 });
  await f.host.migrate({ sessionId: 'story', profileId: saved.profileId, version: saved.version, expectedRevision: saved.revision });
  assert.deepEqual(f.calls.map((call) => call.config), [{ provider: 'local', model: 'pending-local', reasoningEffort: 'low' }]);
  assert.deepEqual(agent.session.requestHeader(), prior);
});

test('cold owner migration uses stored next or lastUsed selection without an active agent or global fallback', async (t) => {
  for (const [next, lastUsed, expected] of [
    [{ provider: 'local', model: 'cold-next' }, { provider: 'cloud', model: 'old-cloud', reasoningEffort: 'high' }, { provider: 'local', model: 'cold-next' }],
    [null, { provider: 'local', model: 'cold-last-used', reasoningEffort: 'medium' }, { provider: 'local', model: 'cold-last-used', reasoningEffort: 'medium' }],
  ]) {
    const f = await fixture(t, {
      services: { agentDefaultModel: { currentSelection: () => { throw new Error('Stored session selection must be sufficient'); } } },
      remote: async (request) => (async function* () { yield { type: 'snapshot', header: { id: request.args.request.address.sessionId }, records: [], cursor: -1, hasMore: false, projections: { values: { modelSelection: { next, lastUsed } }, asOfSeq: -1 } }; })(),
      stages: [{ updates: [], additions: [], report: { summary: 'Cold owner review' } }],
    });
    const saved = await f.host.saveProfile({ profile: ready(), expectedRevision: 0 });
    await f.host.migrate({ sessionId: 'cold', profileId: saved.profileId, version: saved.version, expectedRevision: saved.revision });
    assert.equal(f.agents.has('cold'), false);
    assert.deepEqual(f.calls.map((call) => call.config), [expected]);
  }
});

test('explicit Loop migration stage routing wins over a pending session model selection', async (t) => {
  const f = await fixture(t, {
    projections: { story: { modelSelection: { next: { provider: 'local', model: 'pending-local' }, lastUsed: null } } },
    services: { loopStudio: { registerParticipant: () => () => {}, resolveRoute: ({ nodeId }) => nodeId === 'rp-last-step.migrate' ? { provider: 'local', model: 'explicit-migrator', reasoningEffort: 'high' } : null } },
    stages: [{ updates: [], additions: [], report: { summary: 'Explicit route review' } }],
  });
  const saved = await f.host.saveProfile({ profile: ready(), expectedRevision: 0 });
  await f.host.migrate({ sessionId: 'story', profileId: saved.profileId, version: saved.version, expectedRevision: saved.revision });
  assert.deepEqual(f.calls.map((call) => call.config), [{ provider: 'local', model: 'explicit-migrator', reasoningEffort: 'high', maxTokens: 500 }]);
});

test('fresh migration with no stored selection or request header inherits the valid read-only global default', async (t) => {
  const f = await fixture(t, {
    services: { agentDefaultModel: { currentSelection: () => ({ provider: 'local', model: 'configured-default', reasoningEffort: 'low' }) } },
    stages: [{ updates: [], additions: [], report: { summary: 'Fresh owner review' } }],
  });
  const agent = f.agents.get('story');
  agent.options = {};
  agent.session.requestHeader = () => undefined;
  const saved = await f.host.saveProfile({ profile: ready(), expectedRevision: 0 });
  await f.host.migrate({ sessionId: 'story', profileId: saved.profileId, version: saved.version, expectedRevision: saved.revision });
  assert.deepEqual(f.calls.map((call) => call.config), [{ provider: 'local', model: 'configured-default', reasoningEffort: 'low' }]);
});

test('presentation continues to inherit the current actual main header despite a pending next model selection', async (t) => {
  const f = await fixture(t, { projections: { story: { modelSelection: { next: { provider: 'local', model: 'pending-local' }, lastUsed: { provider: 'cloud', model: 'actual-main' } } } } });
  f.agents.get('story').session.requestHeader = () => ({ config: { provider: 'cloud', model: 'actual-main', reasoningEffort: 'high' } });
  await bind(f);
  await f.host.present({ sessionId: 'story', contextKey: 'main-current', packet });
  assert.deepEqual(f.calls.map((call) => call.config), [{ provider: 'cloud', model: 'actual-main', reasoningEffort: 'high' }, { provider: 'cloud', model: 'actual-main', reasoningEffort: 'high' }]);
});

test('session failures before receipt creation expose only safe errors and never conclude the turn', async (t) => {
  const f = await fixture(t, { persisted: true, remote: async () => { throw new Error('private source path token=secret'); } });
  let conclusions = 0;
  await assert.rejects(f.ctxTools.get('rp_present').execute({ packet }, {
    agent: f.agents.get('story'), callId: 'call-1', rootCallId: 'call-1', signal: new AbortController().signal, concludeTurn: () => conclusions++,
  }), (error) => error.code === 'SESSION_UNAVAILABLE' && !/private|secret|token=/u.test(error.message));
  assert.equal(conclusions, 0);
  assert.equal(f.calls.length, 0);
  assert.equal(f.presentations.at(-1).status, 'failed');
  assert.doesNotMatch(JSON.stringify(f.presentations), /private|secret|token=/u);
});

test('an isolated writer failure publishes one terminal failure and preserves the resolved tools', async (t) => {
  const f = await fixture(t, { stages: [{ commit: true }, new Error('provider token=secret')] });
  await bind(f);
  await assert.rejects(f.host.present({ sessionId: 'story', packet, contextKey: 'turn-1' }), { code: 'MODEL_CALL_FAILED' });
  assert.equal(f.presentations.filter((event) => event.status === 'failed').length, 1);
  assert.equal((await f.host.state('story')).presentations[0].status, 'failed');
  assert.equal(f.calls.length, 2);
  assert.doesNotMatch(JSON.stringify(f.presentations), /provider token|secret/u);
});

test('optional Loop Studio unloading stops observers while preserving already frozen stage selections', async (t) => {
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  let started;
  const entered = new Promise((resolve) => { started = resolve; });
  let unregistered = 0;
  const studio = { registerParticipant: () => () => unregistered++, resolveRoute: ({ nodeId }) => ({ provider: 'local', model: nodeId.split('.').at(-1) }), recordTrace: () => {} };
  const f = await fixture(t, { services: { loopStudio: studio }, stages: [async () => { started(); await waiting; return { commit: true }; }, 'Still selected.'] });
  await bind(f);
  const pending = f.host.present({ sessionId: 'story', packet, contextKey: 'turn-1' });
  await entered;
  await f.injections.find((child) => child.loopStudio).close();
  release();
  assert.equal((await pending).text, 'Still selected.');
  assert.deepEqual(f.calls.map(({ config }) => config.model), ['assemble', 'render']);
  assert.equal(unregistered, 1);
});

test('registers the bundled standard skill body and resource base and releases it on unload', async (t) => {
  const f = await fixture(t);
  const skill = f.skillEntries.get('adapting-sillytavern-rp-presets');
  assert.equal(skill.source, 'bundled');
  assert.equal(skill.content, 'Bundled migration instructions.');
  assert.equal(skill.description, 'Adapt imported RP presets.');
  assert.deepEqual(skill.resourceBase, { kind: 'directory', path: join(f.directory, 'bundled-skill') });
  await f.host.close();
  assert.equal(f.skillEntries.size, 0);
  assert.equal(f.ctxTools.size, 0);
  assert.equal(f.contexts.size, 0);
  assert.equal(f.host.isEnabled('story'), false);
});

test('unload aborts pending Remote follows and isolated model work and releases listeners', { timeout: 2000 }, async (t) => {
  let readSignal;
  const f = await fixture(t, { remote: async (request) => {
    readSignal = request.signal;
    return { [Symbol.asyncIterator]: () => ({ next: () => new Promise((resolve, reject) => { request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }); }), return: async () => ({ done: true }) }) };
  } });
  const pending = f.host.state('story');
  while (!readSignal) await new Promise((resolve) => setImmediate(resolve));
  await f.host.close();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(readSignal.aborted, true);
  assert.equal(f.ctx.count(), 1);
  await assert.rejects(f.host.state('story'), { code: 'UNAVAILABLE' });

  let started;
  const entered = new Promise((resolve) => { started = resolve; });
  const g = await fixture(t, { stages: [async (request) => { started(request.signal); return new Promise((resolve, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true })); }] });
  await bind(g);
  const presentation = g.host.present({ sessionId: 'story', packet, contextKey: 'turn-1' });
  const signal = await entered;
  await g.host.close();
  await assert.rejects(presentation, { name: 'AbortError' });
  assert.equal(signal.aborted, true);
  assert.equal(g.ctx.count(), 1);
});
