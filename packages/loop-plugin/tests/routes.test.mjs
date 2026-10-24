import test from 'node:test'
import assert from 'node:assert/strict'
import { createLoopRoutes } from '../src/routes.mjs'

function fixture() {
  const listeners = new Set()
  const calls = []
  const service = {
    async inspect(sessionId, signal) { calls.push({ action: 'inspect', sessionId, signal }); return { revision: 4, selectedPresetId: 'standard', graph: { nodes: [] } } },
    async savePolicy(input, signal) { calls.push({ action: 'savePolicy', input, signal }); return { revision: 5 } },
    async resetPolicy(input, signal) { calls.push({ action: 'resetPolicy', input, signal }); return { revision: 6 } },
    async authorize(sessionId, signal) { calls.push({ action: 'authorize', sessionId, signal }) },
    subscribe(sessionId, listener) { listeners.add(listener); return () => listeners.delete(listener) },
  }
  const routes = createLoopRoutes(service)
  const post = body => new Request('http://host/api/loop-studio/request', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
  const emit = event => { for (const listener of listeners) listener(event) }
  return { routes, calls, service, listeners, post, emit }
}

test('request dispatcher forwards only inspect, savePolicy and resetPolicy DTOs', async () => {
  const { routes, calls, post } = fixture()
  assert.deepEqual(await (await routes.request(post({ action: 'inspect', sessionId: 'one' }))).json(), { revision: 4, selectedPresetId: 'standard', graph: { nodes: [] } })
  const policy = { enabled: true, routes: { 'host.first': { provider: 'cloud', model: 'fast' } } }
  assert.deepEqual(await (await routes.request(post({ action: 'savePolicy', sessionId: 'one', scope: 'preset', presetId: 'standard', expectedRevision: 4, policy }))).json(), { revision: 5 })
  assert.deepEqual(calls[1].input, { sessionId: 'one', scope: 'preset', presetId: 'standard', expectedRevision: 4, policy })
  assert.deepEqual(await (await routes.request(post({ action: 'resetPolicy', sessionId: 'one', scope: 'session', expectedRevision: 5 }))).json(), { revision: 6 })
  routes.close()
})

test('unknown actions and proxy fields never reach a host operation', async () => {
  const { routes, calls, post } = fixture()
  const response = await routes.request(post({ action: 'invoke', sessionId: 'one', namespace: 'session', method: 'prompt', args: {} }))
  assert.equal(response.status, 400)
  assert.equal((await response.json()).error.code, 'bad-request')
  const disguised = await routes.request(post({ action: 'inspect', sessionId: 'one', path: '/api/other', method: 'POST' }))
  assert.equal(disguised.status, 400)
  assert.equal(calls.length, 0)
})

test('revision failures retain status without exposing internal error details', async () => {
  const { routes, service, post } = fixture()
  service.savePolicy = async () => { throw Object.assign(new Error('Reload before saving.'), { code: 'revision-conflict', status: 409, details: { key: 'secret' } }) }
  const response = await routes.request(post({ action: 'savePolicy', sessionId: 'one', scope: 'session', expectedRevision: 4, policy: { enabled: false, routes: {} } }))
  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), { error: { code: 'revision-conflict', message: 'Reload before saving.' } })
})

test('SSE authorizes through owner session read and removes subscription on request abort', async () => {
  const { routes, calls, listeners, emit } = fixture()
  const abort = new AbortController()
  const response = await routes.events(new Request('http://host/api/loop-studio/events?sessionId=one', { signal: abort.signal }))
  assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8')
  assert.equal(calls[0].action, 'authorize')
  assert.equal(listeners.size, 1)
  const reader = response.body.getReader()
  assert.match(new TextDecoder().decode((await reader.read()).value), /event: connected/u)
  emit({ type: 'changed', sessionId: 'one', prompt: 'secret' })
  const frame = new TextDecoder().decode((await reader.read()).value)
  assert.match(frame, /event: changed/u)
  assert.equal(frame.includes('secret'), false)
  abort.abort()
  assert.equal(listeners.size, 0)
  assert.equal((await reader.read()).done, true)
})

test('SSE body cancellation and plugin close release all subscriptions', async () => {
  const { routes, listeners } = fixture()
  const first = await routes.events(new Request('http://host/api/loop-studio/events?sessionId=one'))
  await first.body.cancel()
  assert.equal(listeners.size, 0)
  const second = await routes.events(new Request('http://host/api/loop-studio/events?sessionId=two'))
  assert.equal(listeners.size, 1)
  routes.close()
  assert.equal(listeners.size, 0)
  assert.match(await second.text(), /event: connected/u)
  assert.equal((await routes.events(new Request('http://host/api/loop-studio/events?sessionId=two'))).status, 503)
})

test('a slow SSE consumer cannot retain an unbounded event queue', async () => {
  const { routes, listeners, emit } = fixture()
  const response = await routes.events(new Request('http://host/api/loop-studio/events?sessionId=one'))
  for (let i = 0; i < 1000; i += 1) emit({ type: 'changed', sessionId: 'one' })
  assert.equal(listeners.size, 0)
  assert.ok((await response.arrayBuffer()).byteLength <= 16_384)
})

test('a rejected session never acquires an SSE subscription', async () => {
  const { routes, service, listeners } = fixture()
  service.authorize = async () => { throw Object.assign(new Error('private details'), { code: 'session/not-found' }) }
  const response = await routes.events(new Request('http://host/api/loop-studio/events?sessionId=missing'))
  assert.equal(response.status, 404)
  assert.equal(listeners.size, 0)
  assert.equal((await response.text()).includes('private details'), false)
})
