import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { createNativeRoutes } from '../src/routes.mjs'

function fixture() {
  const state = { created: 0, closed: 0, subscribers: 0, checked: [], calls: [] }
  const routes = createNativeRoutes(async () => {
    state.created++
    return { app: { async inject(request) { state.calls.push(request); return { statusCode: 200, headers: { 'content-type': 'application/json' }, rawPayload: Buffer.from('{"ok":true}') } } },
      service: { async session(id) { state.checked.push(id); if (id !== 'rp-one') throw Object.assign(new Error('not RP'), { statusCode: 409, apiError: { code: 'card-unavailable', message: '不是 RP 会话' } }) }, subscribe() { state.subscribers++; return () => state.subscribers-- } },
      async close() { state.closed++ },
    }
  })
  return { routes, state }
}
function post(body) { return new Request('http://localhost/api/rp-studio/request', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) }

test('native route shares one runtime and preserves the existing application response', async () => {
  const { routes, state } = fixture()
  const result = await Promise.all([routes.request(post({ method: 'GET', path: '/api/v1/cards' })), routes.request(post({ method: 'GET', path: '/api/v1/sessions' }))])
  assert.equal(state.created, 1)
  assert.equal(result[0].status, 200)
  assert.deepEqual(await result[0].json(), { ok: true })
  assert.equal(state.calls[1].url, '/api/v1/sessions')
  await routes.close()
  assert.equal(state.closed, 1)
})

test('native bridge cannot proxy arbitrary URLs or inject an infinite SSE request', async () => {
  const { routes, state } = fixture()
  for (const path of ['https://example.com', '/api/session/list', '/api/v1/../session/list', '/api/v1/sessions/rp-one/events', '/api/v1/sessions/%2e%2e/health']) {
    assert.equal((await routes.request(post({ method: 'GET', path }))).status, 400, path)
  }
  assert.equal(state.created, 0)
  await routes.close()
})

test('SSE verifies RP ownership, releases subscriptions on abort and closes on unload', async () => {
  const { routes, state } = fixture()
  const rejected = await routes.events(new Request('http://localhost/api/rp-studio/events?sessionId=other'))
  assert.equal(rejected.status, 409)
  assert.equal(state.subscribers, 0)
  const controller = new AbortController()
  const response = await routes.events(new Request('http://localhost/api/rp-studio/events?sessionId=rp-one', { signal: controller.signal }))
  assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8')
  assert.equal(state.subscribers, 1)
  controller.abort()
  assert.equal(state.subscribers, 0)
  await routes.events(new Request('http://localhost/api/rp-studio/events?sessionId=rp-one'))
  await routes.close()
  assert.equal(state.subscribers, 0)
  assert.equal(state.closed, 1)
  assert.equal((await routes.request(post({ method: 'GET', path: '/api/v1/cards' })) ).status, 503)
})

test('browser cancellation closes the SSE subscriber without closing an already cancelled controller', async () => {
  const { routes, state } = fixture()
  const response = await routes.events(new Request('http://localhost/api/rp-studio/events?sessionId=rp-one'))
  await assert.doesNotReject(response.body.cancel())
  assert.equal(state.subscribers, 0)
  await routes.close()
})

let hostFixtureId = 0
async function nativeHostFixture(failReady = false) {
  const state = { enabled: true, bindingAvailable: true, stopped: 0, transportStopped: 0, appClosed: 0, productClosed: 0, deltas: [], errors: [] }
  const key = `__rpStudioHostFixture${hostFixtureId++}`
  const stubs = {
    buildApp: () => ({ ready: async () => { if (failReady) throw new Error('synthetic startup failure') }, close: async () => { state.appClosed++ }, inject: async () => ({ statusCode: 200, headers: {}, rawPayload: Buffer.from('{}') }) }),
    createDshClient: options => options,
    SessionService: class {
      constructor(options) { state.options = options }
      async start() {}
      stop() { state.stopped++ }
      publishPresentationDelta(...args) { state.deltas.push(args) }
      publishPresentationError(...args) { state.errors.push(args) }
    },
    ProductService: class { async start() {} async close() { state.productClosed++ } },
    loadDefaultProductStore: async () => ({}),
    createNativeTransport: () => ({ stop() { state.transportStopped++ } }),
  }
  const imports = new Map([
    ['../../../apps/gateway/src/app.js', 'buildApp'], ['../../../apps/gateway/src/dsh/client.js', 'createDshClient'],
    ['../../../apps/gateway/src/session-service.js', 'SessionService'], ['../../../apps/gateway/src/product-service.js', 'ProductService'],
    ['../../../apps/gateway/src/local-data-adapter.js', 'loadDefaultProductStore'], ['./transport.mjs', 'createNativeTransport'],
  ])
  globalThis[key] = stubs
  let host
  try {
    const bundled = await build({ entryPoints: [fileURLToPath(new URL('../src/host.ts', import.meta.url))], bundle: true, write: false, format: 'esm', platform: 'node', plugins: [{
      name: 'synthetic-native-runtime', setup(builder) {
        builder.onResolve({ filter: /.*/ }, args => imports.has(args.path) ? { path: args.path, namespace: 'synthetic' } : undefined)
        builder.onLoad({ filter: /.*/, namespace: 'synthetic' }, args => ({ contents: `export const ${imports.get(args.path)} = globalThis[${JSON.stringify(key)}].${imports.get(args.path)};`, loader: 'js' }))
      },
    }] })
    host = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`)
  } finally { delete globalThis[key] }
  const listeners = new Map()
  const effects = []
  const routes = []
  host.apply({
    connection: { fetch: { register(route) { routes.push(route) } } },
    get(name) { return name === 'rpLastStep' && state.bindingAvailable ? { isEnabled: id => state.enabled && id === 'rp-one' } : undefined },
    on(name, callback) { listeners.set(name, callback); return () => listeners.delete(name) },
    effect(fn) { effects.push(fn()) },
  })
  return { state, listeners, start: () => routes.find(route => route.path.endsWith('/request')).fetch(post({ method: 'GET', path: '/api/v1/cards' })), close: async () => { for (const cleanup of effects.reverse()) await cleanup?.() } }
}

test('native host lazily owns the safe writer listener and optional binding cache, then disposes on close', async () => {
  const host = await nativeHostFixture()
  assert.equal(host.listeners.size, 0)
  assert.equal((await host.start()).status, 200)
  assert.equal(host.state.options.isPresentationSession('rp-one'), true)
  host.state.enabled = false
  assert.equal(host.state.options.isPresentationSession('rp-one'), false)
  host.state.bindingAvailable = false
  assert.equal(host.state.options.isPresentationSession('rp-one'), false)
  const emit = host.listeners.get('rp-last-step/presentation')
  emit({ sessionId: 'rp-one', presentationId: 'writer', stageId: 'rp-last-step.render', status: 'rendering', delta: '星光。', private: 'PRIVATE_CANARY' })
  emit({ sessionId: 'rp-one', presentationId: 'writer', stageId: 'rp-last-step.assemble', status: 'assembling', delta: 'PRIVATE_CANARY' })
  emit({ sessionId: 'rp-one', presentationId: 'writer', stageId: 'rp-last-step.render', status: 'complete', text: 'PRIVATE_CANARY' })
  emit({ sessionId: 'rp-one', presentationId: 'writer', stageId: 'rp-last-step.render', status: 'failed', code: 'PRIVATE_CANARY', error: 'PRIVATE_CANARY' })
  emit({ sessionId: 'rp-one', presentationId: 'writer', stageId: 'rp-last-step.render', status: 'cancelled' })
  assert.deepEqual(host.state.deltas, [['rp-one', 'writer', '星光。']])
  assert.deepEqual(host.state.errors, [['rp-one', 'failed'], ['rp-one', 'cancelled']])
  await host.close()
  assert.equal(host.listeners.size, 0)
  assert.equal(host.state.stopped, 1)
})

test('native startup failure releases its presentation listener and runtime resources', async () => {
  const host = await nativeHostFixture(true)
  assert.equal((await host.start()).status, 400)
  assert.equal(host.listeners.size, 0)
  assert.equal(host.state.stopped, 1)
  assert.equal(host.state.transportStopped, 1)
  assert.equal(host.state.appClosed, 1)
  assert.equal(host.state.productClosed, 1)
  await host.close()
})
