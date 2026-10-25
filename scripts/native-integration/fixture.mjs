// Test-only owner-authenticated probe. All product services remain installed tgz owners.
import { createLocalModels, MODELS } from './model-fixture.mjs'
import { SERVICES } from './requirements.mjs'
export const name = 'studio-native-probe'
export const inject = ['llm', 'agents', 'connection', 'typertGateway', 'agentPresets', 'sessionQuery', 'sessionPersistence']
export function apply(ctx) {
  const local = createLocalModels(), disposers = []
  const adapter = {
    providerInfo: id => ({ id, name: 'Studio native local test provider' }), providerRetryPolicy: () => undefined,
    imageRequestPricing: () => undefined, imageRequestTarget: (_provider, _model, value) => value,
    listModels: async provider => MODELS.map(id => ({ provider, id, name: id })),
    resolveModel: async (provider, id) => { if (provider !== 'studio-native-local' || !MODELS.includes(id)) throw new Error('FIXTURE_UNKNOWN_MODEL'); return { provider, id, name: id } },
    async prepareCall(provider, id) { return { model: await this.resolveModel(provider, id), stream: options => local.stream(id, options) } },
  }
  disposers.push(ctx.llm.registerAdapter(['studio-native-local'], adapter))
  const invoke = (method, request, signal) => ctx.typertGateway.invoke({ namespace: 'session', method, args: { request }, peer: ctx.connection.browserPeer, signal })
  async function snapshot(sessionId) {
    const view = await ctx.sessionQuery.observeSession(sessionId)
    try {
      if (!Number.isSafeInteger(view.inheritedEventCount) || view.inheritedEventCount < 0 || view.inheritedEventCount > view.events.length) throw new Error('EXPORT_SOURCE_METADATA_MISSING')
      if (view.events.length > 2000) throw new Error('FIXTURE_EVENT_LIMIT')
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
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['action', 'sessionId', 'text'].includes(key))) throw new Error('FIXTURE_INVALID_REQUEST')
      let result
      if (input.action === 'ready') result = await ready(request.signal)
      else if (input.action === 'models') result = local.stats()
      else if (input.action === 'failWriterOnce') { local.failWriterOnce(); result = { armed: true } }
      else if (input.action === 'flush') { await ctx.sessionPersistence.flush(); result = { flushed: true } }
      else if (input.action === 'snapshot') result = await snapshot(input.sessionId)
      else if (input.action === 'idle') { await ctx.agents.get(input.sessionId)?.whenIdle(); result = await snapshot(input.sessionId) }
      else if (input.action === 'prompt') {
        if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 4000) throw new Error('FIXTURE_INVALID_PROMPT')
        result = await invoke('prompt', { sessionId: input.sessionId, requestId: crypto.randomUUID(), mode: 'queue', content: [{ type: 'text', text: input.text }] }, request.signal)
      } else throw new Error('FIXTURE_UNKNOWN_ACTION')
      return Response.json({ ok: true, result })
    } catch (error) { return Response.json({ ok: false, error: { code: error.code ?? 'FIXTURE_ERROR', message: String(error.message).slice(0, 600) } }, { status: 503 }) }
  } }))
  ctx.effect(() => async () => { for (const dispose of disposers.splice(0).reverse()) await dispose?.() }, 'Studio native probe')
}
