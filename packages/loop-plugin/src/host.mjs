import { randomUUID } from 'node:crypto'
import { buildGraph, mergeParticipants, resolvePolicy, validatePolicy, freeze, modelNodeId, projectTraceEvent, tokenMetadata, LoopError } from './core.mjs'
import { createPolicyStore } from './store.mjs'
import { createLoopRoutes } from './routes.mjs'

export const name = 'loop-studio'
export const inject = ['connection', 'typertGateway', 'agents', 'llm']
const TRACE_LIMIT = 256
const routeFields = ['provider', 'model', 'reasoningEffort', 'maxTokens']
const sameConfig = (left, right) => left && right && routeFields.every(key => left[key] === right[key])
const sameRoute = (left, right) => left && right && left.provider === right.provider && left.model === right.model
const routeConfig = value => Object.fromEntries(routeFields.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]))
const headerProposal = header => {
  const config = { ...header.config }
  for (const key of ['reasoningEffort', 'maxTokens']) if (header.adapterDefaults?.[key] === true) delete config[key]
  return config
}

/** DSH rc.2 has no public driver discriminator. Custom drivers stay observe-only. */
function supportedAgent(ctx, agent) {
  return Boolean(ctx.get('agentLoop')) && agent?.constructor?.name === 'ReactLoopAgent'
}

/** Connect public DSH registries and scoped waterfalls to the independent kernel. */
export async function createLoopHost(ctx, options = {}) {
  const store = options.store ?? await createPolicyStore()
  let stopped = false
  const attached = new Map()
  const participants = new Map()
  const traces = new Map()
  const sessions = new Map()
  const subscribers = new Map()
  const reads = new Set()
  const disposers = []

  function active() { if (stopped) throw new LoopError('unavailable', 'Loop Studio has been unloaded.', 503) }
  function changed(sessionId) {
    for (const listener of subscribers.get(sessionId) ?? []) listener({ type: 'changed', sessionId })
  }
  function changedAll() { for (const sessionId of subscribers.keys()) changed(sessionId) }
  function graphFor(presetId, supported) { return mergeParticipants(buildGraph({ presetId: presetId ?? 'unassigned', supported }), [...participants.values()]) }
  function presetFor(agent) {
    const inspection = ctx.get('agentPresets')?.inspectCompositions?.(agent.ctx)?.[0]
    return inspection?.id ?? agent.session.header?.agentPreset
  }
  function stateFor(sessionId) {
    let state = traces.get(sessionId)
    if (!state) {
      state = { records: new Map(), tools: new Map(), turn: undefined, step: 0 }
      traces.set(sessionId, state)
    }
    return state
  }
  function retain(sessionId, trace) {
    if (!trace) return
    const state = stateFor(sessionId)
    state.records.set(trace.id, freeze(trace))
    while (state.records.size > TRACE_LIMIT) state.records.delete(state.records.keys().next().value)
  }
  function observe(sessionId, event, presetId) {
    const state = stateFor(sessionId)
    if (event.type === 'turn/start') { state.turn = event.data.turn; state.step = 0 }
    if (event.type === 'step/start') { state.turn = event.data.turn; state.step = event.data.step }
    if (event.type === 'tool/call') state.tools.set(event.data.callId, event.data.name)
    const toolName = event.type === 'tool/result' ? state.tools.get(event.data.message?.toolCallId ?? event.data.message?.callId) : undefined
    const trace = projectTraceEvent(event, { sessionId, graphId: buildGraph({ presetId: presetId ?? 'unassigned' }).id,
      turn: state.turn, step: state.step || undefined, toolName })
    retain(sessionId, trace)
    if (event.type === 'tool/result') state.tools.delete(event.data.message?.toolCallId ?? event.data.message?.callId)
    return trace
  }

  function baseline(record, config) {
    const underlying = { ...config }
    if (record.lastApplied) {
      for (const key of record.ownedFields) {
        // Route identity and its effort belong together. Output limits remain
        // independently inherited by DSH even after a host model selection.
        if (key !== 'maxTokens' && !sameRoute(config, record.lastApplied)) continue
        if (config[key] !== record.lastApplied[key]) continue
        if (record.original[key] === undefined) delete underlying[key]
        else underlying[key] = record.original[key]
      }
    }
    record.original = routeConfig(underlying)
    return underlying
  }

  function attach(agent) {
    if (stopped || !agent || attached.get(agent.id)?.agent === agent) return
    attached.get(agent.id)?.dispose()
    const supported = supportedAgent(ctx, agent)
    const currentHeader = agent.session.requestHeader?.()
    const record = { agent, supported, presetId: presetFor(agent), snapshot: null, snapshotSignal: null,
      pending: false, stepOpen: false, draining: null, lastApplied: null, ownedFields: new Set(),
      original: routeConfig(currentHeader ? headerProposal(currentHeader) : { ...ctx.get('agentDefaultModel')?.currentSelection?.(), ...agent.options }),
      disposers: [],
    }
    record.stopRequest = () => { record.disposeRequest?.(); record.disposeRequest = null }
    record.dispose = keepRequest => {
      for (const dispose of record.disposers.splice(0)) dispose()
      if (!keepRequest) record.stopRequest()
    }
    attached.set(agent.id, record)
    sessions.set(agent.id, { presetId: record.presetId })
    // Acquisition is already scoped to this live Agent. Only metadata leaves
    // the public snapshot reader; browser reads go through owner Remote.
    for (const event of agent.session.snapshotEvents?.() ?? []) observe(agent.id, event, record.presetId)
    if (!supported) return
    record.disposers.push(agent.ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      if (stopped || (context.agent && context.agent !== agent)) return next()
      const position = stateFor(agent.id)
      const nodeId = modelNodeId(position.step + 1)
      const { policies } = store.read({ sessionId: agent.id, presetId: record.presetId })
      // Capture before delegating: downstream async work cannot split policy
      // edits across prompt variables and the following request configuration.
      const snapshot = freeze({ nodeId, turn: position.turn, step: position.step + 1,
        route: resolvePolicy(policies.preset, policies.session).routes[nodeId] ?? null })
      const result = await next()
      if (stopped) return result
      const inherited = { provider: result.variables?.provider, model: result.variables?.model }
      if (inherited.provider && inherited.model && !sameRoute(inherited, record.lastApplied)) record.original = { ...record.original, ...inherited }
      record.snapshot = snapshot
      record.snapshotSignal = context.signal
      record.pending = true
      const selected = snapshot.route ?? (record.lastApplied ? record.original : null)
      return selected ? { ...result, variables: { ...result.variables, provider: selected.provider, model: selected.model } } : result
    }, { prepend: true }))
    record.disposeRequest = agent.ctx.on('agent/request', async (payload, next) => {
      const snapshot = record.snapshot
      const result = await next()
      if (!snapshot || snapshot.step !== payload.step || (snapshot.turn !== undefined && snapshot.turn !== payload.turn)
        || payload.signal.aborted || record.snapshotSignal?.aborted || (stopped && record.draining !== snapshot)) return result
      record.pending = false
      const underlying = baseline(record, result)
      if (!snapshot.route) return underlying
      const selected = snapshot.route
      const proposed = { ...underlying, ...selected }
      record.ownedFields = new Set(Object.keys(selected))
      if (!sameRoute(underlying, selected)) {
        record.ownedFields.add('reasoningEffort')
        if (selected.reasoningEffort === undefined) delete proposed.reasoningEffort
      }
      record.lastApplied = routeConfig(proposed)
      return proposed
    }, { prepend: true })
    record.disposers.push(agent.ctx.on('agent/assistant-stream', ({ frame }) => {
      if (stopped || frame.type === 'chunk') return
      const id = `${agent.id}:attempt:${frame.attemptId}`
      if (frame.type === 'end') {
        const previous = stateFor(agent.id).records.get(id)
        if (!previous) return
        retain(agent.id, { ...previous, durationMs: Math.max(0, Date.now() - previous.timestamp),
          status: frame.outcome.kind === 'abandoned' ? 'abandoned' : frame.outcome.eventType === 'assistant/message' ? 'completed' : 'settled',
          ...(frame.outcome.seq === undefined ? {} : { seq: frame.outcome.seq }),
        })
        changed(agent.id)
        return
      }
      const config = agent.session.requestHeader?.()?.config
      retain(agent.id, { id, type: 'request', nodeId: modelNodeId(frame.step),
        sessionId: agent.id, graphId: graphFor(record.presetId, true).id, graphSchemaVersion: 1,
        timestamp: Date.now(), turn: frame.turn, step: frame.step, status: 'running',
        ...(config?.provider ? { provider: config.provider, model: config.model } : {}),
      })
      changed(agent.id)
    }))
  }

  disposers.push(ctx.on('agent/created', ({ agent }) => attach(agent)))
  disposers.push(ctx.on('agent/disposed', ({ agent }) => {
    const record = attached.get(agent.id)
    if (record?.agent !== agent) return
    record.dispose()
    attached.delete(agent.id)
    changed(agent.id)
  }))
  disposers.push(ctx.on('agent/status', ({ agent }) => changed(agent.id)))
  disposers.push(ctx.on('session/event', (session, event) => {
    const record = attached.get(session.id)
    if (record && record.agent.session !== session) return
    if (record && (event.type === 'turn/start' || event.type === 'turn/end' || event.type === 'step/end')) {
      record.snapshot = null
      record.snapshotSignal = null
      record.pending = false
      record.stepOpen = false
    }
    if (record && event.type === 'step/start') record.stepOpen = true
    if (event.type === 'agent-preset/selected' && record) record.presetId = event.data.agentPreset
    if (event.type === 'model/selection' && record) {
      const { reasoningEffort: _effort, ...original } = record.original
      record.original = { ...original, ...routeConfig(event.data) }
    }
    if (observe(session.id, event, record?.presetId ?? sessions.get(session.id)?.presetId)) changed(session.id)
  }))
  for (const agent of ctx.agents.list()) attach(agent)

  async function readSession(sessionId, signal) {
    active()
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 256) throw new LoopError('bad-request', 'A sessionId is required.')
    const lifetime = new AbortController()
    reads.add(lifetime)
    const combined = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal
    let iterator
    try {
      combined.throwIfAborted()
      const stream = await ctx.typertGateway.stream({ namespace: 'session', method: 'follow',
        args: { request: { address: { kind: 'session', sessionId }, maxMessages: 100 } },
        peer: ctx.connection.browserPeer, signal: combined })
      iterator = stream[Symbol.asyncIterator]()
      const first = await iterator.next()
      combined.throwIfAborted()
      if (first.done || first.value.type !== 'snapshot' || first.value.header?.id !== sessionId) throw new LoopError('not-found', 'Session is unavailable.', 404)
      const snapshot = first.value
      const presetId = attached.get(sessionId)?.presetId ?? snapshot.projections?.values?.agentPreset ?? snapshot.header.agentPreset
      sessions.set(sessionId, { presetId })
      for (const record of snapshot.records) if (record.type === 'event') observe(sessionId, record.event, presetId)
      return { presetId }
    } finally {
      lifetime.abort()
      reads.delete(lifetime)
      await iterator?.return?.()
    }
  }

  async function inventory(diagnostics) {
    const registry = ctx.get('agentPresets')
    if (!registry?.compositionInventory) { diagnostics.push('The host does not expose a preset composition registry.'); return [] }
    try { return await registry.compositionInventory() }
    catch { diagnostics.push('Preset composition is temporarily unavailable.'); return [] }
  }
  async function modelCatalog(diagnostics, signal) {
    const models = []
    for (const provider of ctx.llm.listProviders()) {
      try {
        for (const model of await ctx.llm.listModels(provider.id)) {
          signal?.throwIfAborted()
          let reasoning
          try { reasoning = (await ctx.llm.resolveModelInfo(provider.id, model.id, signal)).reasoning }
          catch { diagnostics.push(`Reasoning metadata unavailable for ${provider.id}/${model.id}.`) }
          models.push({ provider: provider.id, id: model.id, name: model.name,
            ...(reasoning ? { reasoning: { efforts: reasoning.efforts.map(effort => ({ id: effort.id, name: effort.name,
              ...(effort.description === undefined ? {} : { description: effort.description }),
            })), ...(reasoning.defaultEffort === undefined ? {} : { defaultEffort: reasoning.defaultEffort }) } } : {}),
          })
        }
      } catch { diagnostics.push(`Model catalog unavailable for ${provider.id}.`) }
    }
    signal?.throwIfAborted()
    return models
  }

  const service = {
    async inspect(sessionId, signal) {
      const diagnostics = []
      const session = await readSession(sessionId, signal)
      const [compositions, models] = await Promise.all([inventory(diagnostics), modelCatalog(diagnostics, signal)])
      active()
      const selectedPresetId = session.presetId ?? compositions.find(preset => preset.isDefault)?.id ?? null
      sessions.set(sessionId, { presetId: selectedPresetId })
      const selected = compositions.find(preset => preset.id === selectedPresetId)
      const supported = attached.get(sessionId)?.supported === true
      if (!supported) diagnostics.push('The active driver is not recognized by the DSH 0.2.1-rc.2 main-loop adapter. Host stages are observe-only.')
      if (selected?.broken) diagnostics.push('The selected preset reports a composition error.')
      const { revision, policies } = store.read({ sessionId, presetId: selectedPresetId })
      return { revision, selectedPresetId,
        presets: compositions.map(preset => ({ id: preset.id, ...(preset.name ? { name: preset.name } : {}), isDefault: preset.isDefault,
          ...(preset.broken ? { broken: 'Preset composition unavailable.' } : {}),
        })),
        composition: (selected?.rows ?? []).map(row => ({ entryId: row.entryId, moduleName: row.moduleName, enabled: row.enabled,
          ...(row.condition === undefined ? {} : { condition: row.condition }), ...(row.fiberState === undefined ? {} : { fiberState: row.fiberState }),
        })),
        graph: graphFor(selectedPresetId, supported), policies, effectivePolicy: resolvePolicy(policies.preset, policies.session), models,
        trace: [...stateFor(sessionId).records.values()].sort((a, b) => a.timestamp - b.timestamp || (a.seq ?? 0) - (b.seq ?? 0)),
        running: attached.get(sessionId)?.agent.status === 'running', routingCapability: supported ? 'supported' : 'unknown-driver', diagnostics,
      }
    },
    authorize: readSession,
    async savePolicy(input, signal) {
      active()
      const session = await readSession(input.sessionId, signal)
      const presetId = input.presetId ?? session.presetId
      if (input.scope === 'preset' && !(await inventory([])).some(preset => preset.id === presetId)) throw new LoopError('bad-request', 'Unknown preset policy scope.')
      const policy = validatePolicy(input.policy)
      const graph = graphFor(presetId, attached.get(input.sessionId)?.supported === true)
      for (const nodeId of Object.keys(policy.routes)) {
        if (!graph.nodes.some(node => node.id === nodeId && node.control === 'route')) throw new LoopError('unsupported-node', 'The selected node cannot be routed by this adapter.')
      }
      signal?.throwIfAborted()
      const result = await store.savePolicy({ ...input, presetId, policy })
      if (input.scope === 'preset') changedAll()
      else changed(input.sessionId)
      return result
    },
    async resetPolicy(input, signal) {
      const session = await readSession(input.sessionId, signal)
      const result = await store.resetPolicy({ ...input, presetId: input.presetId ?? session.presetId })
      if (input.scope === 'preset') changedAll()
      else changed(input.sessionId)
      return result
    },
    subscribe(sessionId, listener) {
      active()
      const listeners = subscribers.get(sessionId) ?? new Set()
      listeners.add(listener)
      subscribers.set(sessionId, listeners)
      return () => { listeners.delete(listener); if (!listeners.size) subscribers.delete(sessionId) }
    },
    /** Register local stage ids under participant.id; return its unregister disposer. */
    registerParticipant(participant) {
      active()
      if (participants.has(participant.id)) throw new LoopError('bad-request', 'Participant is already registered.')
      const detached = structuredClone(participant)
      mergeParticipants(buildGraph({}), [...participants.values(), detached])
      participants.set(participant.id, freeze(detached))
      changedAll()
      return () => { if (participants.delete(participant.id)) changedAll() }
    },
    /** Freeze a registered model stage route at the participant's assembly boundary. */
    resolveRoute({ sessionId, nodeId }) {
      active()
      const presetId = attached.get(sessionId)?.presetId ?? sessions.get(sessionId)?.presetId
      if (!attached.has(sessionId) && !sessions.has(sessionId)) return null
      if (!graphFor(presetId, attached.get(sessionId)?.supported === true).nodes.some(node => node.id === nodeId && node.control === 'route')) return null
      const { policies } = store.read({ sessionId, presetId })
      return resolvePolicy(policies.preset, policies.session).routes[nodeId] ?? null
    },
    /** Only metadata for registered participant-owned stages can cross this seam. */
    recordTrace(input) {
      active()
      const presetId = attached.get(input.sessionId)?.presetId ?? sessions.get(input.sessionId)?.presetId
      const graph = graphFor(presetId, attached.get(input.sessionId)?.supported === true)
      const node = graph.nodes.find(node => node.id === input.nodeId && node.source !== 'host')
      if (!node || (!attached.has(input.sessionId) && !sessions.has(input.sessionId))) throw new LoopError('bad-request', 'Unknown participant stage or session.')
      const trace = { id: randomUUID(), type: 'participant', nodeId: node.id, sessionId: input.sessionId,
        graphId: graph.id, graphSchemaVersion: graph.schemaVersion, timestamp: Number.isFinite(input.timestamp) ? input.timestamp : Date.now() }
      for (const key of ['provider', 'model', 'toolName', 'status']) if (typeof input[key] === 'string' && input[key].length <= 256) trace[key] = input[key]
      for (const key of ['turn', 'step', 'seq', 'durationMs']) if (Number.isFinite(input[key]) && input[key] >= 0) trace[key] = input[key]
      const tokens = tokenMetadata(input.tokens)
      if (tokens) trace.tokens = tokens
      retain(input.sessionId, trace)
      changed(input.sessionId)
      return trace.id
    },
    async close() {
      if (stopped) return
      stopped = true
      for (const lifetime of reads) lifetime.abort()
      for (const dispose of disposers.splice(0)) dispose()
      const records = [...attached.values()]
      subscribers.clear()
      participants.clear()
      for (const record of records) {
        const closeSeq = record.agent.session.snapshotEvents?.().at(-1)?.seq ?? -1
        const restore = () => {
          const { agent } = record
          if (!record.lastApplied) return
          if (ctx.agents.get(agent.id) !== agent) return
          if (agent.session.snapshotEvents?.().some(event => event.seq > closeSeq && event.type === 'model/selection')) return
          const header = agent.session.requestHeader?.()
          if (!header || !sameConfig(headerProposal(header), record.lastApplied)) return
          const { adapterDefaults: _defaults, ...remaining } = header
          agent.session.append('request/header', { reason: 'change', header: { ...remaining, config: { ...record.original } } })
        }
        const restoreAfterPublication = () => {
          if (!record.lastApplied) return
          // Session observers cannot append reentrantly. A continuation may
          // assemble synchronously before the next microtask, so gate that one
          // assembly before native model-selection takes its own snapshot.
          let disposeBeforeAssembly = () => {}
          const finishRestore = () => { disposeBeforeAssembly(); restore() }
          disposeBeforeAssembly = record.agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
            finishRestore()
            return next()
          }, { prepend: true })
          void Promise.resolve().then(finishRestore).catch(() => {})
        }
        const snapshot = record.snapshot
        if (record.agent.status === 'running' && snapshot && (record.pending || record.stepOpen) && !record.snapshotSignal?.aborted) {
          // A completed assembly is already bound to this step. Keep only its
          // request route (including same-step retries), with lifecycle cleanup.
          // New assembly admissions and trace observers stop immediately.
          record.draining = snapshot
          record.dispose(true)
          let disposeBoundary = () => {}
          const signal = record.snapshotSignal
          const finish = () => {
            disposeBoundary()
            signal?.removeEventListener('abort', finish)
            record.draining = null
            record.snapshot = null
            record.snapshotSignal = null
            record.stopRequest()
          }
          disposeBoundary = record.agent.ctx.on('session/event', (session, event) => {
            if (session !== record.agent.session) return
            const sameTurn = snapshot.turn === undefined || event.data.turn === snapshot.turn
            if ((event.type === 'step/end' && sameTurn && event.data.step === snapshot.step)
              || (event.type === 'turn/end' && sameTurn)
              || (event.type === 'turn/start' && snapshot.turn !== undefined && event.data.turn !== snapshot.turn)) {
              finish()
              // The frozen step has ended; restore the logged future baseline
              // before the next step assembles, without adding a model call.
              restoreAfterPublication()
            }
          })
          signal?.addEventListener('abort', finish, { once: true })
          void record.agent.whenIdle().then(() => { finish(); restore() }).catch(finish)
          continue
        }
        record.dispose()
        // Never deadlock if an agent tool unloads this plugin. Frozen work is
        // left intact; a running agent's baseline is restored once it is idle.
        if (record.agent.status === 'running') void record.agent.whenIdle().then(restore).catch(() => {})
        else restore()
      }
      attached.clear()
      sessions.clear()
      traces.clear()
    },
  }
  return service
}

export async function apply(ctx) {
  const service = await createLoopHost(ctx)
  const routes = createLoopRoutes(service)
  ctx.provide('loopStudio', service)
  ctx.connection.fetch.register({ path: '/api/loop-studio/request', methods: ['POST'], requestBody: 'buffered', fetch: request => routes.request(request) })
  ctx.connection.fetch.register({ path: '/api/loop-studio/events', methods: ['GET'], requestBody: 'buffered', fetch: request => routes.events(request) })
  ctx.effect(() => async () => { await routes.close(); await service.close() }, 'Loop Studio runtime')
}
