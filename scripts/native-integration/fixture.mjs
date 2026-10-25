// Test-only owner-authenticated probe. All product services remain installed tgz owners.
import { createLocalModels, MODELS } from './model-fixture.mjs'
import { SERVICES } from './requirements.mjs'
export const name = 'studio-native-probe'
export const inject = ['llm', 'agents', 'connection', 'typertGateway', 'agentPresets', 'sessionQuery', 'sessionPersistence']
export function apply(ctx) {
  const local = createLocalModels({ maxRequests: 192, maxRecords: 96 }), disposers = []
  let metadataPause
  async function modelCatalogPause() {
    if (!metadataPause || !ctx.agents.get(metadataPause.sessionId)) return
    const binding = await ctx.get('rpGM')?.binding({ sessionId: metadataPause.sessionId })
    if (binding?.status !== 'restoring') return
    if (!metadataPause.entered) {
      metadataPause.entered = true; metadataPause.bindingStatus = binding.status; metadataPause.actualAgentId = ctx.agents.get(metadataPause.sessionId).id
      metadataPause.promise = new Promise(done => { metadataPause.release = done; metadataPause.timer = setTimeout(() => { metadataPause.timedOut = true; done() }, 15000) })
    }
    await metadataPause.promise
  }
  const adapter = {
    providerInfo: id => ({ id, name: 'Studio native local test provider' }), providerRetryPolicy: () => undefined,
    imageRequestPricing: () => undefined, imageRequestTarget: (_provider, _model, value) => value,
    listModels: async provider => { await modelCatalogPause(); return MODELS.map(id => ({ provider, id, name: id })) },
    resolveModel: async (provider, id) => { if (provider !== 'studio-native-local' || !MODELS.includes(id)) throw new Error('FIXTURE_UNKNOWN_MODEL'); return { provider, id, name: id } },
    async prepareCall(provider, id) { return { model: await this.resolveModel(provider, id), stream: options => local.stream(id, options) } },
  }
  disposers.push(ctx.llm.registerAdapter(['studio-native-local'], adapter))
  const invoke = (method, request, signal) => ctx.typertGateway.invoke({ namespace: 'session', method, args: { request }, peer: ctx.connection.browserPeer, signal })
  async function snapshot(sessionId) {
    const view = await ctx.sessionQuery.observeSession(sessionId)
    try {
      if (!Number.isSafeInteger(view.inheritedEventCount) || view.inheritedEventCount < 0 || view.inheritedEventCount > view.events.length) throw new Error('EXPORT_SOURCE_METADATA_MISSING')
      if (view.events.length > 6000) throw new Error('FIXTURE_EVENT_LIMIT')
      return { header: view.header, events: view.events, inheritedEventCount: view.inheritedEventCount, live: !!ctx.agents.get(sessionId), models: local.stats() }
    } finally { view[Symbol.dispose]() }
  }
  async function ready(signal) {
    const services = {}
    for (const [name, definition] of Object.entries(SERVICES)) {
      const service = ctx.get(definition.key)
      services[name] = { available: !!service, apiVersion: typeof service?.apiVersion === 'number' ? service.apiVersion : null, methods: Object.fromEntries(definition.methods.map(method => [method, typeof service?.[method] === 'function'])) }
    }
    let storyKitCapabilities = {}, storyKitError
    const storyKit = ctx.get('rpStoryKit')
    if (typeof storyKit?.state === 'function') try { storyKitCapabilities = (await storyKit.state({ signal })).capabilities } catch (error) { storyKitError = { code: error.code, message: String(error.message).slice(0, 300) } }
    return { services, storyKitCapabilities, ...(storyKitError ? { storyKitError } : {}), gmPreset: (await ctx.agentPresets.list()).filter(preset => preset.id === 'rp-gm'), models: local.stats() }
  }
  disposers.push(ctx.connection.fetch.register({ path: '/api/studio-native-probe', methods: ['POST'], requestBody: 'buffered', fetch: async request => {
    try {
      const input = await request.json()
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['action', 'sessionId', 'sessionIds', 'text', 'style', 'renderModel', 'mode'].includes(key))) throw new Error('FIXTURE_INVALID_REQUEST')
      let result
      if (input.action === 'ready') result = await ready(request.signal)
      else if (input.action === 'witness') {
        if (!Array.isArray(input.sessionIds) || !input.sessionIds.length || input.sessionIds.length > 16 || input.sessionIds.some(id => typeof id !== 'string' || !id.trim())) throw new Error('FIXTURE_INVALID_SESSION_SET')
        const sessions = []
        for (const sessionId of [...input.sessionIds].sort()) {
          if (!await ctx.sessionPersistence.stat(sessionId, { signal: request.signal })) { sessions.push({ sessionId, exists: false }); continue }
          const observed = await snapshot(sessionId), gm = await ctx.get('rpGM').binding({ sessionId, signal: request.signal }), database = await ctx.get('rpDatabase').effectiveV2({ sessionId, signal: request.signal }), lastStep = await ctx.get('rpLastStep').state(sessionId, request.signal)
          sessions.push({ sessionId, exists: true, header: observed.header, events: observed.events, inheritedEventCount: observed.inheritedEventCount, live: observed.live, gm, databaseBinding: database.binding, lastStepBinding: lastStep.binding })
        }
        const present = sessions.filter(row => row.exists).map(row => row.sessionId), revisions = {}
        const audit = present.length ? (await ctx.get('rpStoryKit').exportState({ sessionIds: present, signal: request.signal })).payload.journalAudit : null
        for (const name of ['rpDatabase', 'rpContext', 'rpLastStep', 'rpGM', 'rpStoryKit']) revisions[name] = await ctx.get(name).contentRevision({ signal: request.signal })
        const models = local.stats(); result = { sessions, revisions, audit, modelCounts: models.counts, modelTotal: models.total }
      }
      else if (input.action === 'models') result = local.stats()
      else if (input.action === 'failWriterOnce') { local.failWriterOnce(); result = { armed: true } }
      else if (input.action === 'failAssemblyOnce') { local.failAssemblyOnce(); result = { armed: true } }
      else if (input.action === 'armConflict') { local.armConflict(); result = { armed: true } }
      else if (input.action === 'armMaterialGuard') { local.armMaterialGuard(); result = { armed: true } }
      else if (input.action === 'retryMode') { local.retryMode(input.mode); result = { mode: input.mode } }
      else if (input.action === 'style') {
        if (!['B', 'C', 'D'].includes(input.style)) throw new Error('FIXTURE_STYLE_INVALID')
        result = await ctx.get('rpLastStep').ensureBuiltinProfile({ key: `studio-native.style.${input.style}.v1`, profile: { name: `Public synthetic style ${input.style}`, entries: [{ id: 'narration', name: 'Public synthetic prose', content: `Preserve accepted facts and player agency. Synthetic style ${input.style}.`, phase: 'render', role: 'system', required: true, locked: true }] } })
      }
      else if (input.action === 'routes' || input.action === 'loop') {
        const loop = ctx.get('loopStudio'), view = await loop.inspect(input.sessionId, request.signal)
        if (input.action === 'loop') result = view
        else {
          if (!['writer', 'writer-alt'].includes(input.renderModel ?? 'writer')) throw new Error('FIXTURE_ROUTE_INVALID')
          const models = { 'rp-context.prepare': 'prepare', 'rp-context.summarize': 'summarize', 'rp-last-step.assemble': 'assembly', 'rp-last-step.render': input.renderModel ?? 'writer' }
          for (const id of ['host.first', 'host.continuation']) if (view.graph?.nodes?.some(node => node.id === id && node.control === 'route')) models[id] = 'gm'
          for (const id of Object.keys(models)) if (!view.graph?.nodes?.some(node => node.id === id && node.control === 'route')) throw new Error(`LOOP_NODE_VALIDATION:${id}`)
          result = await loop.savePolicy({ sessionId: input.sessionId, scope: 'session', expectedRevision: view.revision, policy: { enabled: true, routes: Object.fromEntries(Object.entries(models).map(([id, model]) => [id, { provider: 'studio-native-local', model }])) } }, request.signal)
        }
      }
      else if (input.action === 'resume') {
        if (!ctx.agents.get(input.sessionId)) {
          const handle = await ctx.agents.resume({ resumeSessionId: input.sessionId, agentOptions: { provider: 'studio-native-local', model: 'gm' }, setup: async scope => { await ctx.agentPresets.mount(scope, 'rp-gm') }, signal: request.signal })
          disposers.push(() => handle.dispose())
        }
        result = await snapshot(input.sessionId)
      }
      else if (input.action === 'contextAudit' || input.action === 'storyKitAudit') result = await ctx.get(input.action === 'contextAudit' ? 'rpContext' : 'rpStoryKit').exportState({ sessionIds: input.sessionIds, signal: request.signal })
      else if (input.action === 'revisions') {
        result = {}
        for (const name of ['rpDatabase', 'rpContext', 'rpLastStep', 'rpGM', 'rpStoryKit']) result[name] = await ctx.get(name).contentRevision({ signal: request.signal })
      }
      else if (input.action === 'editWorking') {
        const database = ctx.get('rpDatabase'), before = await database.effectiveV2({ sessionId: input.sessionId, signal: request.signal })
        result = await database.patchV2({ sessionId: input.sessionId, agent: ctx.agents.get(input.sessionId), expectedRevision: before.revision, operations: [{ op: 'update', ref: { sourceKey: 'world', entryId: '0' }, patch: { content: input.text } }], signal: request.signal })
      }
      else if (input.action === 'armMetadataPause') { metadataPause = { sessionId: input.sessionId, entered: false, timedOut: false }; result = { armed: true } }
      else if (input.action === 'metadataPause') result = metadataPause ? { sessionId: metadataPause.sessionId, entered: metadataPause.entered, timedOut: metadataPause.timedOut, bindingStatus: metadataPause.bindingStatus, actualAgentId: metadataPause.actualAgentId } : null
      else if (input.action === 'releaseMetadataPause') { if (metadataPause?.timer) clearTimeout(metadataPause.timer); metadataPause?.release?.(); result = { released: true } }
      else if (input.action === 'flush') { await ctx.sessionPersistence.flush(); result = { flushed: true } }
      else if (input.action === 'snapshot') result = await snapshot(input.sessionId)
      else if (input.action === 'idle') { await ctx.agents.get(input.sessionId)?.whenIdle(); result = await snapshot(input.sessionId) }
      else if (input.action === 'prompt') {
        if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 4000) throw new Error('FIXTURE_INVALID_PROMPT')
        result = await invoke('prompt', { sessionId: input.sessionId, requestId: crypto.randomUUID(), mode: 'queue', content: [{ type: 'text', text: input.text }] }, request.signal)
      } else throw new Error('FIXTURE_UNKNOWN_ACTION')
      return Response.json({ ok: true, result })
    } catch (error) { console.error('STUDIO_NATIVE_PROBE_ERROR', String(error.stack ?? error.message).slice(0, 3000)); return Response.json({ ok: false, error: { code: error.code ?? 'FIXTURE_ERROR', message: String(error.message).slice(0, 600) } }, { status: 503 }) }
  } }))
  ctx.effect(() => async () => { if (metadataPause?.timer) clearTimeout(metadataPause.timer); metadataPause?.release?.(); for (const dispose of disposers.splice(0).reverse()) await dispose?.() }, 'Studio native probe')
}
