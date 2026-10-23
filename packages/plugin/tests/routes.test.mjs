import { test } from 'node:test'
import assert from 'node:assert/strict'
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
