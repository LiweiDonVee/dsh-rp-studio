import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createPolicyStore } from '../src/store.mjs'
import { createLoopHost } from '../src/host.mjs'

class Scope {
  listeners = new Map()
  publicationErrors = []
  on(name, handler, options) {
    const listeners = this.listeners.get(name) ?? []
    if (options?.prepend) listeners.unshift(handler)
    else listeners.push(handler)
    this.listeners.set(name, listeners)
    return () => { const index = listeners.indexOf(handler); if (index >= 0) listeners.splice(index, 1) }
  }
  async waterfall(name, args, initial) {
    const listeners = [...(this.listeners.get(name) ?? [])]
    const next = async index => index < listeners.length ? listeners[index](...args, () => next(index + 1)) : initial
    return next(0)
  }
  async emit(name, ...args) { for (const handler of (this.listeners.get(name) ?? []).slice()) await handler(...args) }
  publish(name, ...args) {
    for (const handler of (this.listeners.get(name) ?? []).slice()) {
      try { void Promise.resolve(handler(...args)).catch(error => this.publicationErrors.push(error)) }
      catch (error) { this.publicationErrors.push(error) }
    }
  }
  count() { return [...this.listeners.values()].reduce((sum, listeners) => sum + listeners.length, 0) }
}

class ReactLoopAgent {
  constructor(ctx, id, preset = 'standard') {
    this.id = id
    this.ctx = new Scope()
    this.status = 'idle'
    this.options = { provider: 'cloud', model: 'original', reasoningEffort: 'high' }
    this.session = {
      id, header: { id, agentPreset: preset }, records: [], config: { ...this.options },
      requestHeader: () => this.session.hasRequestHeader === false ? undefined : ({ tools: [{ name: 'lookup' }], ...this.session.headerMetadata, config: { ...this.session.config } }),
      snapshotEvents: () => this.session.records,
      append: (type, data) => {
        if (this.session.strictPublication && this.session.publishing) throw new Error('session append cannot reenter while another append is being published')
        const event = { type, data, seq: this.session.records.length, time: Date.now() }
        this.session.records.push(event)
        if (type === 'request/header') {
          this.session.hasRequestHeader = true
          this.session.config = { ...data.header.config }
          this.session.headerMetadata = { ...data.header }
        }
        if (type === 'model/selection') this.selected = { ...data }
        if (this.session.strictPublication) {
          this.session.publishing = true
          try { ctx.publish('session/event', this.session, event); this.ctx.publish('session/event', this.session, event) }
          finally { this.session.publishing = false }
        } else {
          void ctx.emit('session/event', this.session, event)
          void this.ctx.emit('session/event', this.session, event)
        }
        return event
      },
    }
    this.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const result = await next()
      const config = this.selected ?? this.session.config
      return { ...result, variables: { ...result.variables, provider: config.provider, model: config.model } }
    })
    this.ctx.on('agent/request', async (_payload, next) => {
      const config = await next()
      if (!this.selected) return config
      const { reasoningEffort: _effort, ...withoutInheritedEffort } = config
      return { ...withoutInheritedEffort, ...this.selected }
    })
  }
  async whenIdle() { if (this.idle) await this.idle }
}

async function fixture(t, ids = ['one', 'two'], options = {}) {
  const ctx = new Scope()
  const agents = new Map(ids.map(id => [id, new ReactLoopAgent(ctx, id)]))
  for (const agent of agents.values()) {
    agent.session.strictPublication = options.strictPublication === true
    if (options.fresh) {
      agent.session.hasRequestHeader = false
      agent.session.config = { provider: 'cloud', model: 'configured' }
      agent.options = {}
    }
  }
  const peer = { principal: { kind: 'owner' } }
  ctx.agents = { list: () => [...agents.values()], get: id => agents.get(id) }
  ctx.connection = { browserPeer: peer }
  const inventories = [{ id: 'standard', name: 'Standard', isDefault: true, rows: [{ entryId: 'tools', moduleName: 'example-tools', enabled: true }] },
    { id: 'custom', name: 'Custom', isDefault: false, rows: [{ entryId: null, moduleName: 'conditional', enabled: 'conditional', condition: 'runtimeFlag' }] }]
  const services = {
    agentLoop: {},
    ...(options.fresh ? { agentDefaultModel: { currentSelection: () => ({ provider: 'cloud', model: 'configured' }) } } : {}),
    agentPresets: { compositionInventory: async () => inventories, inspectCompositions: () => [{ id: 'standard', modules: [{ moduleName: 'example-tools', useHostBase: true }], leakedServices: [] }] },
  }
  ctx.get = name => services[name]
  ctx.llm = {
    listProviders: () => [{ id: 'cloud', name: 'Cloud', apiKey: 'must-not-leak' }, { id: 'local', name: 'Local' }],
    listModels: async provider => [{ provider, id: provider === 'cloud' ? 'fast' : 'quality', name: 'A model' }],
    resolveModelInfo: async (provider, id) => ({ provider, id, name: 'A model', reasoning: { efforts: [{ id: 'low', name: 'Low' }], defaultEffort: 'low' } }),
  }
  const remoteCalls = []
  const coldSessions = new Map()
  ctx.typertGateway = { stream: async request => {
    remoteCalls.push(request)
    assert.equal(request.peer, peer)
    assert.equal(request.namespace, 'session')
    assert.equal(request.method, 'follow')
    const sessionId = request.args.request.address.sessionId
    const session = agents.get(sessionId)?.session ?? coldSessions.get(sessionId)
    if (!session) throw Object.assign(new Error('Missing'), { code: 'session/not-found' })
    return (async function* () { yield { type: 'snapshot', header: session.header,
      records: session.records.map(event => ({ type: 'event', event })), cursor: session.records.length - 1, hasMore: false,
      projections: { values: session.projections ?? {}, asOfSeq: session.records.length - 1 },
    } })()
  } }
  const home = await mkdtemp(join(tmpdir(), 'loop-host-'))
  const store = await createPolicyStore({ home })
  const host = await createLoopHost(ctx, { store })
  t.after(async () => { await host.close(); await rm(home, { recursive: true, force: true }) })
  return { ctx, host, store, agents, remoteCalls, inventories, coldSessions }
}

async function assemble(agent, signal = new AbortController().signal) {
  return agent.ctx.waterfall('system-prompt/assemble', [{ variables: {} }, { agent, signal }], { variables: { provider: 'cloud', model: 'original' }, sections: [], tools: [] })
}
async function request(agent, turn, step) {
  return agent.ctx.waterfall('agent/request', [{ agent, turn, step, signal: new AbortController().signal }], { ...agent.session.config })
}
const policy = routes => ({ enabled: true, routes })
const fast = { provider: 'cloud', model: 'fast' }
const quality = { provider: 'local', model: 'quality', maxTokens: 2048 }

test('existing and newly created agents get isolated assembly and request routes', async t => {
  const { ctx, host, agents } = await fixture(t)
  await host.savePolicy({ sessionId: 'one', scope: 'session', expectedRevision: 0, policy: policy({ 'host.first': fast }) })
  const one = agents.get('one')
  const two = agents.get('two')
  assert.equal((await assemble(one)).variables.model, 'fast')
  assert.equal((await request(one, 1, 1)).model, 'fast')
  assert.equal((await assemble(two)).variables.model, 'original')
  assert.equal((await request(two, 1, 1)).model, 'original')
  const third = new ReactLoopAgent(ctx, 'three')
  agents.set('three', third)
  await ctx.emit('agent/created', { agent: third })
  await host.savePolicy({ sessionId: 'three', scope: 'session', expectedRevision: 1, policy: policy({ 'host.first': quality }) })
  assert.equal((await assemble(third)).variables.provider, 'local')
  assert.deepEqual(await request(third, 1, 1), quality)
})

test('policy changes during downstream assembly apply only to the following assembly', async t => {
  const { host, agents } = await fixture(t)
  const agent = agents.get('one')
  await host.savePolicy({ sessionId: 'one', scope: 'session', expectedRevision: 0, policy: policy({ 'host.first': fast }) })
  let resume
  const gate = new Promise(resolve => { resume = resolve })
  const dispose = agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => { await gate; return next() })
  const assembling = assemble(agent)
  await host.savePolicy({ sessionId: 'one', scope: 'session', expectedRevision: 1, policy: policy({ 'host.first': quality }) })
  resume()
  assert.equal((await assembling).variables.model, 'fast')
  assert.equal((await request(agent, 1, 1)).model, 'fast')
  dispose()
  assert.equal((await assemble(agent)).variables.model, 'quality')
  assert.equal((await request(agent, 1, 1)).model, 'quality')
})

test('continuations select their own frozen route and clear inherited effort on a route change', async t => {
  const { host, ctx, agents } = await fixture(t)
  const agent = agents.get('one')
  await host.savePolicy({ sessionId: 'one', scope: 'session', expectedRevision: 0, policy: policy({ 'host.first': fast, 'host.continuation': quality }) })
  await ctx.emit('session/event', agent.session, { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } })
  assert.equal((await assemble(agent)).variables.model, 'fast')
  assert.deepEqual(await request(agent, 1, 1), fast)
  await ctx.emit('session/event', agent.session, { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } })
  await ctx.emit('session/event', agent.session, { type: 'step/end', seq: 2, time: 3, data: { turn: 1, step: 1 } })
  assert.equal((await assemble(agent)).variables.model, 'quality')
  assert.deepEqual(await request(agent, 1, 2), quality)
})

test('request without a matching assembly never applies a policy snapshot', async t => {
  const { host, agents } = await fixture(t)
  await host.savePolicy({ sessionId: 'one', scope: 'session', expectedRevision: 0, policy: policy({ 'host.first': fast }) })
  assert.equal((await request(agents.get('one'), 1, 1)).model, 'original')
})

test('disabled takeover restores implicit host selection and output cap', async t => {
  const { host, agents } = await fixture(t)
  const agent = agents.get('one')
  await host.savePolicy({ sessionId: 'one', scope: 'session', expectedRevision: 0, policy: policy({ 'host.first': quality }) })
  await assemble(agent)
  const overridden = await request(agent, 1, 1)
  agent.session.append('request/header', { header: { config: overridden }, reason: 'change' })
  await host.savePolicy({ sessionId: 'one', scope: 'session', expectedRevision: 1, policy: { enabled: false, routes: {} } })
  const restored = await assemble(agent)
  assert.equal(restored.variables.model, 'original')
  assert.deepEqual(await request(agent, 2, 1), { provider: 'cloud', model: 'original', reasoningEffort: 'high' })
})

test('unload releases listeners and restores the next implicit request without a global selection write', async t => {
  const { host, agents } = await fixture(t)
  const agent = agents.get('one')
  await host.savePolicy({ sessionId: 'one', scope: 'session', expectedRevision: 0, policy: policy({ 'host.first': quality }) })
  await assemble(agent)
  agent.session.append('request/header', { header: { config: await request(agent, 1, 1) }, reason: 'change' })
  await host.close()
  assert.equal(agent.ctx.count(), 2)
  assert.equal((await assemble(agent)).variables.model, 'original')
  assert.deepEqual(await request(agent, 2, 1), { provider: 'cloud', model: 'original', reasoningEffort: 'high' })
  assert.equal(agent.session.requestHeader().tools[0].name, 'lookup')
})

test('unload preserves a later explicit host model selection', async t => {
  const { host, ctx, agents } = await fixture(t)
  const agent = agents.get('one')
  await host.savePolicy({ sessionId: 'one', scope: 'session', expectedRevision: 0, policy: policy({ 'host.first': fast }) })
  await assemble(agent)
  agent.session.append('request/header', { header: { config: await request(agent, 1, 1) }, reason: 'change' })
  agent.selected = { provider: 'local', model: 'quality', reasoningEffort: 'low' }
  await ctx.emit('session/event', agent.session, { type: 'model/selection', seq: 10, time: 10, data: agent.selected })
  await host.close()
  assert.equal((await assemble(agent)).variables.model, 'quality')
  assert.equal((await request(agent, 2, 1)).reasoningEffort, 'low')
})

test('inspection uses owner Remote reads, composition rows and model reasoning metadata', async t => {
  const { host, remoteCalls } = await fixture(t)
  const inspected = await host.inspect('one')
  assert.equal(inspected.selectedPresetId, 'standard')
  assert.deepEqual(inspected.composition, [{ entryId: 'tools', moduleName: 'example-tools', enabled: true }])
  assert.equal(inspected.routingCapability, 'supported')
  assert.equal(inspected.models[0].reasoning.efforts[0].id, 'low')
  assert.equal(JSON.stringify(inspected).includes('must-not-leak'), false)
  assert.ok(remoteCalls.every(call => call.signal.aborted))
})

test('unknown drivers are inspectable but cannot claim host node routing', async t => {
  const { ctx, host, agents } = await fixture(t)
  const unknown = new ReactLoopAgent(ctx, 'unknown', 'custom')
  Object.setPrototypeOf(unknown, { constructor: { name: 'OtherDriver' } })
  agents.set('unknown', unknown)
  await ctx.emit('agent/created', { agent: unknown })
  const inspected = await host.inspect('unknown')
  assert.equal(inspected.routingCapability, 'unknown-driver')
  assert.ok(inspected.graph.nodes.every(node => node.control === 'observe'))
  await assert.rejects(host.savePolicy({ sessionId: 'unknown', scope: 'session', expectedRevision: 0, policy: policy({ 'host.first': fast }) }), { code: 'unsupported-node' })
})

test('participant routes and trace are optional, namespaced and metadata-only', async t => {
  const { host } = await fixture(t)
  const dispose = host.registerParticipant({ id: 'example', nodes: [{ id: 'review', label: 'Review', kind: 'model', control: 'route' }] })
  await host.savePolicy({ sessionId: 'one', scope: 'session', expectedRevision: 0, policy: policy({ 'example.review': quality }) })
  assert.deepEqual(host.resolveRoute({ sessionId: 'one', nodeId: 'example.review' }), quality)
  host.recordTrace({ sessionId: 'one', nodeId: 'example.review', type: 'model', provider: 'local', model: 'quality', status: 'completed', prompt: 'secret', arguments: 'secret' })
  const inspected = await host.inspect('one')
  assert.equal(inspected.trace.at(-1).nodeId, 'example.review')
  assert.equal(JSON.stringify(inspected.trace).includes('secret'), false)
  dispose()
  assert.equal(host.resolveRoute({ sessionId: 'one', nodeId: 'example.review' }), null)
})

test('running unload returns before idle and restores its owned header after quiescence', async t => {
  const { host, agents } = await fixture(t)
  const agent = agents.get('one')
  await host.savePolicy({ sessionId: 'one', scope: 'session', expectedRevision: 0, policy: policy({ 'host.first': quality }) })
  await assemble(agent)
  const frozen = await request(agent, 1, 1)
  agent.session.append('request/header', { header: { config: frozen }, reason: 'change' })
  let idle
  agent.status = 'running'
  agent.idle = new Promise(resolve => { idle = resolve })
  await host.close()
  assert.equal(agent.ctx.count(), 2)
  assert.equal(agent.session.config.model, 'quality')
  agent.status = 'idle'
  idle()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(agent.session.config, { provider: 'cloud', model: 'original', reasoningEffort: 'high' })
  assert.deepEqual(frozen, quality)
})

test('deferred unload cannot overwrite a host configuration committed after close', async t => {
  const { host, agents } = await fixture(t)
  const agent = agents.get('one')
  await host.savePolicy({ sessionId: 'one', scope: 'session', expectedRevision: 0, policy: policy({ 'host.first': quality }) })
  await assemble(agent)
  agent.session.append('request/header', { header: { config: await request(agent, 1, 1) }, reason: 'change' })
  let idle
  agent.status = 'running'
  agent.idle = new Promise(resolve => { idle = resolve })
  await host.close()
  agent.session.append('request/header', { header: { config: { provider: 'cloud', model: 'user-choice' } }, reason: 'change' })
  agent.status = 'idle'
  idle()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(agent.session.config, { provider: 'cloud', model: 'user-choice' })
})

test('stream start is an invocation while a prepared header alone is not', async t => {
  const { host, agents } = await fixture(t)
  const agent = agents.get('one')
  agent.session.append('request/header', { header: { config: { provider: 'cloud', model: 'original' } }, reason: 'change' })
  assert.equal((await host.inspect('one')).trace.filter(row => row.type === 'request').length, 0)
  await agent.ctx.emit('agent/assistant-stream', { agent, frame: { type: 'start', attemptId: 'attempt', revision: 1, turn: 1, step: 1 } })
  await agent.ctx.emit('agent/assistant-stream', { agent, frame: { type: 'chunk', attemptId: 'attempt', revision: 1, index: 0, time: 20, chunk: { type: 'reasoning-delta', text: 'secret' } } })
  await agent.ctx.emit('agent/assistant-stream', { agent, frame: { type: 'end', attemptId: 'attempt', revision: 1, index: 1, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 1 } } })
  const rows = (await host.inspect('one')).trace.filter(row => row.type === 'request')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].status, 'completed')
  assert.ok(rows[0].durationMs >= 0)
  assert.equal(JSON.stringify(rows).includes('secret'), false)
})

test('removing an agent releases scoped listeners without disturbing a replacement', async t => {
  const { host, ctx, agents } = await fixture(t)
  const old = agents.get('one')
  await ctx.emit('agent/disposed', { agent: old })
  assert.equal(old.ctx.count(), 2)
  const replacement = new ReactLoopAgent(ctx, 'one')
  agents.set('one', replacement)
  await ctx.emit('agent/created', { agent: replacement })
  await ctx.emit('agent/disposed', { agent: old })
  await host.savePolicy({ sessionId: 'one', scope: 'session', expectedRevision: 0, policy: policy({ 'host.first': fast }) })
  assert.equal((await assemble(replacement)).variables.model, 'fast')
})

test('unload recognizes its own route after DSH materializes model defaults', async t => {
  const { host, agents } = await fixture(t)
  const agent = agents.get('one')
  await host.savePolicy({ sessionId: 'one', scope: 'session', expectedRevision: 0, policy: policy({ 'host.first': fast }) })
  await assemble(agent)
  const proposal = await request(agent, 1, 1)
  agent.session.append('request/header', { reason: 'change', header: {
    config: { ...proposal, reasoningEffort: 'low', maxTokens: 4096 }, adapterDefaults: { reasoningEffort: true, maxTokens: true },
  } })
  await host.close()
  assert.deepEqual(agent.session.config, { provider: 'cloud', model: 'original', reasoningEffort: 'high' })
})

test('preset defaults apply to both sessions while an explicit session disable wins', async t => {
  const { host, agents } = await fixture(t)
  await host.savePolicy({ sessionId: 'one', presetId: 'standard', scope: 'preset', expectedRevision: 0, policy: policy({ 'host.first': fast }) })
  assert.equal((await assemble(agents.get('one'))).variables.model, 'fast')
  assert.equal((await assemble(agents.get('two'))).variables.model, 'fast')
  await host.savePolicy({ sessionId: 'one', scope: 'session', expectedRevision: 1, policy: { enabled: false, routes: {} } })
  assert.equal((await assemble(agents.get('one'))).variables.model, 'original')
  assert.equal((await assemble(agents.get('two'))).variables.model, 'fast')
  await host.resetPolicy({ sessionId: 'one', scope: 'session', expectedRevision: 2 })
  assert.equal((await assemble(agents.get('one'))).variables.model, 'fast')
})

test('deferred unload skips restoration when the user selects another model after close', async t => {
  const { host, agents } = await fixture(t)
  const agent = agents.get('one')
  await host.savePolicy({ sessionId: 'one', scope: 'session', expectedRevision: 0, policy: policy({ 'host.first': quality }) })
  await assemble(agent)
  agent.session.append('request/header', { header: { config: await request(agent, 1, 1) }, reason: 'change' })
  let idle
  agent.status = 'running'
  agent.idle = new Promise(resolve => { idle = resolve })
  await host.close()
  agent.session.append('model/selection', { provider: 'cloud', model: 'user-choice' })
  const count = agent.session.records.length
  agent.status = 'idle'
  idle()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(agent.session.records.length, count)
  assert.equal((await assemble(agent)).variables.model, 'user-choice')
})

test('cold Remote history wrappers replay reported model and tool metadata', async t => {
  const { host, coldSessions } = await fixture(t)
  coldSessions.set('cold', { header: { id: 'cold', agentPreset: 'standard' }, records: [
    { type: 'turn/start', seq: 0, time: 10, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: 20, data: { turn: 1, step: 1 } },
    { type: 'request/header', seq: 2, time: 30, data: { header: { config: { provider: 'local', model: 'quality' }, tools: [{ description: 'secret' }] }, reason: 'initial' } },
    { type: 'assistant/message', seq: 3, time: 40, data: { turn: 1, step: 1,
      message: { source: { provider: 'local', model: 'quality' }, content: [{ type: 'reasoning', text: 'secret' }] },
      stream: [{ type: 'reasoning', text: 'secret' }], usage: { inputTokens: 12, outputTokens: 5 },
    } },
    { type: 'tool/call', seq: 4, time: 50, data: { turn: 1, step: 1, callId: 'call', name: 'lookup', arguments: 'secret' } },
    { type: 'tool/result', seq: 5, time: 60, data: { turn: 1, step: 1, message: { toolCallId: 'call', content: [{ type: 'text', text: 'secret' }] } } },
  ] })
  const inspected = await host.inspect('cold')
  const model = inspected.trace.find(row => row.type === 'assistant/message')
  assert.equal(model?.model, 'quality')
  assert.deepEqual(model.tokens, { inputTokens: 12, outputTokens: 5 })
  assert.equal(inspected.trace.find(row => row.type === 'tool/result').toolName, 'lookup')
  assert.equal(inspected.trace.filter(row => row.type === 'request').length, 0)
  assert.equal(JSON.stringify(inspected.trace).includes('secret'), false)
})

test('cold inspection prefers current preset projection over its creation header', async t => {
  const { host, store, coldSessions } = await fixture(t)
  coldSessions.set('cold', { header: { id: 'cold', agentPreset: 'standard' }, projections: { agentPreset: 'custom' }, records: [] })
  await store.savePolicy({ scope: 'preset', presetId: 'custom', expectedRevision: 0, policy: policy({ 'host.first': fast }) })
  const inspected = await host.inspect('cold')
  assert.equal(inspected.selectedPresetId, 'custom')
  assert.deepEqual(inspected.composition, [{ entryId: null, moduleName: 'conditional', enabled: 'conditional', condition: 'runtimeFlag' }])
  assert.equal(inspected.effectivePolicy.routes['host.first'].model, 'fast')
})

for (const originalCap of [undefined, 512]) {
  test(`disable restores output cap ${originalCap ?? 'absence'} after a host model switch`, async t => {
    const { host, agents } = await fixture(t)
    const agent = agents.get('one')
    if (originalCap !== undefined) agent.session.config.maxTokens = originalCap
    await host.savePolicy({ sessionId: 'one', scope: 'session', expectedRevision: 0, policy: policy({ 'host.first': quality }) })
    await assemble(agent)
    agent.session.append('request/header', { header: { config: await request(agent, 1, 1) }, reason: 'change' })
    agent.session.append('model/selection', { provider: 'cloud', model: 'user-choice' })
    await host.savePolicy({ sessionId: 'one', scope: 'session', expectedRevision: 1, policy: { enabled: false, routes: {} } })
    assert.equal((await assemble(agent)).variables.model, 'user-choice')
    assert.deepEqual(await request(agent, 2, 1), { provider: 'cloud', model: 'user-choice',
      ...(originalCap === undefined ? {} : { maxTokens: originalCap }),
    })
  })
}

test('disable preserves a foreign output cap changed after takeover', async t => {
  const { host, agents } = await fixture(t)
  const agent = agents.get('one')
  await host.savePolicy({ sessionId: 'one', scope: 'session', expectedRevision: 0, policy: policy({ 'host.first': quality }) })
  await assemble(agent)
  agent.session.append('request/header', { header: { config: await request(agent, 1, 1) }, reason: 'change' })
  agent.ctx.on('agent/request', async (_payload, next) => ({ ...await next(), maxTokens: 8192 }))
  await host.savePolicy({ sessionId: 'one', scope: 'session', expectedRevision: 1, policy: { enabled: false, routes: {} } })
  await assemble(agent)
  assert.deepEqual(await request(agent, 2, 1), { provider: 'cloud', model: 'original', reasoningEffort: 'high', maxTokens: 8192 })
})

test('unload drains an assembled route into its matching request before restoring later steps', async t => {
  const { host, agents } = await fixture(t)
  const agent = agents.get('one')
  await host.savePolicy({ sessionId: 'one', scope: 'session', expectedRevision: 0, policy: policy({ 'host.first': quality }) })
  let idle
  agent.status = 'running'
  agent.idle = new Promise(resolve => { idle = resolve })
  agent.session.append('turn/start', { turn: 1 })
  const assembled = await assemble(agent)
  await host.close()
  agent.session.append('step/start', { turn: 1, step: 1 })
  const drained = await request(agent, 1, 1)
  assert.deepEqual(drained, quality)
  assert.equal(assembled.variables.provider, drained.provider)
  assert.equal(assembled.variables.model, drained.model)
  agent.session.append('request/header', { header: { config: drained }, reason: 'change' })
  assert.deepEqual(await request(agent, 1, 1), quality)
  agent.session.append('step/end', { turn: 1, step: 1 })
  assert.equal((await assemble(agent)).variables.model, 'original')
  assert.equal((await request(agent, 1, 2)).model, 'original')
  assert.equal(agent.ctx.count(), 2)
  agent.status = 'idle'
  idle()
})

test('a rejected assembled step releases its unload drain without routing a later turn', async t => {
  const { host, agents } = await fixture(t)
  const agent = agents.get('one')
  await host.savePolicy({ sessionId: 'one', scope: 'session', expectedRevision: 0, policy: policy({ 'host.first': quality }) })
  let idle
  agent.status = 'running'
  agent.idle = new Promise(resolve => { idle = resolve })
  agent.session.append('turn/start', { turn: 1 })
  await assemble(agent)
  await host.close()
  assert.equal(agent.ctx.listeners.get('agent/request').length, 2)
  agent.session.append('turn/end', { turn: 1, reason: { kind: 'blocked' } })
  assert.equal(agent.ctx.count(), 2)
  assert.equal((await request(agent, 2, 1)).model, 'original')
  assert.equal(agent.session.records.filter(event => event.type === 'request/header').length, 0)
  agent.status = 'idle'
  idle()
})

test('aborting an assembled step releases its unload drain before another turn', async t => {
  const { host, agents } = await fixture(t)
  const agent = agents.get('one')
  await host.savePolicy({ sessionId: 'one', scope: 'session', expectedRevision: 0, policy: policy({ 'host.first': quality }) })
  let idle
  agent.status = 'running'
  agent.idle = new Promise(resolve => { idle = resolve })
  agent.session.append('turn/start', { turn: 1 })
  const abort = new AbortController()
  await assemble(agent, abort.signal)
  await host.close()
  assert.equal(agent.ctx.listeners.get('agent/request').length, 2)
  abort.abort()
  assert.equal(agent.ctx.count(), 2)
  assert.equal((await request(agent, 2, 1)).model, 'original')
  agent.status = 'idle'
  idle()
})

test('an unused unload drain releases its request listener when the agent becomes idle', async t => {
  const { host, agents } = await fixture(t)
  const agent = agents.get('one')
  await host.savePolicy({ sessionId: 'one', scope: 'session', expectedRevision: 0, policy: policy({ 'host.first': quality }) })
  let idle
  agent.status = 'running'
  agent.idle = new Promise(resolve => { idle = resolve })
  agent.session.append('turn/start', { turn: 1 })
  await assemble(agent)
  await host.close()
  assert.equal(agent.ctx.listeners.get('agent/request').length, 2)
  agent.status = 'idle'
  idle()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(agent.ctx.count(), 2)
  assert.equal((await request(agent, 2, 1)).model, 'original')
})

test('unload while a matching request awaits downstream retains its assembled route', async t => {
  const { host, agents } = await fixture(t)
  const agent = agents.get('one')
  await host.savePolicy({ sessionId: 'one', scope: 'session', expectedRevision: 0, policy: policy({ 'host.first': quality }) })
  let idle
  agent.status = 'running'
  agent.idle = new Promise(resolve => { idle = resolve })
  agent.session.append('turn/start', { turn: 1 })
  await assemble(agent)
  agent.session.append('step/start', { turn: 1, step: 1 })
  let release
  let entered
  const waiting = new Promise(resolve => { release = resolve })
  const inside = new Promise(resolve => { entered = resolve })
  const stopWaiting = agent.ctx.on('agent/request', async (_payload, next) => { entered(); await waiting; return next() })
  const pending = request(agent, 1, 1)
  await inside
  await host.close()
  release()
  const config = await pending
  assert.deepEqual(config, quality)
  stopWaiting()
  agent.session.append('request/header', { header: { config }, reason: 'change' })
  agent.session.append('step/end', { turn: 1, step: 1 })
  await Promise.resolve()
  assert.equal(agent.ctx.count(), 2)
  agent.status = 'idle'
  idle()
})

test('fresh implicit unload restores before continuation without reentering Session publication', async t => {
  const { host, agents, ctx } = await fixture(t, ['one'], { fresh: true, strictPublication: true })
  const agent = agents.get('one')
  assert.equal(agent.session.requestHeader(), undefined)
  await host.savePolicy({ sessionId: 'one', scope: 'session', expectedRevision: 0,
    policy: policy({ 'host.first': fast, 'host.continuation': quality }),
  })
  let idle
  agent.status = 'running'
  agent.idle = new Promise(resolve => { idle = resolve })
  agent.session.append('turn/start', { turn: 1 })
  const firstAssembly = await assemble(agent)
  await host.close()
  agent.session.append('step/start', { turn: 1, step: 1 })
  const firstRequest = await request(agent, 1, 1)
  assert.deepEqual(firstRequest, fast)
  assert.equal(firstAssembly.variables.model, firstRequest.model)
  agent.session.append('request/header', { header: { config: firstRequest }, reason: 'initial' })
  agent.session.append('step/end', { turn: 1, step: 1 })
  // The real driver starts the next assembly synchronously after publication.
  const nextAssembly = await assemble(agent)
  assert.equal(nextAssembly.variables.model, 'configured')
  assert.deepEqual(await request(agent, 1, 2), { provider: 'cloud', model: 'configured' })
  assert.deepEqual(ctx.publicationErrors, [])
  assert.deepEqual(agent.ctx.publicationErrors, [])
  assert.equal(agent.ctx.count(), 2)
  agent.status = 'idle'
  idle()
})
