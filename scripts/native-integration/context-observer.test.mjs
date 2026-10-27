import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import * as contexts from './contexts.mjs'
import { closeOwnedResources } from './host.mjs'

function deferred() { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
function fixture(options = {}) {
  assert.equal(typeof contexts.observeNativeContext, 'function')
  const page = new EventEmitter(), httpErrors = []
  const observer = contexts.observeNativeContext({ name: 'home-a', home: '/synthetic/home-a', httpErrors, ...options })
  observer.evidence.hostPid = 123
  observer.attach(page)
  const request = (action = 'reviewState', sessionId = 'synthetic-story') => ({ method: () => 'POST', url: () => 'http://local/api/rp-studio/actions?token=synthetic-secret&view=rp', postDataJSON: () => ({ action, sessionId }), failure: () => ({ errorText: 'net::ERR_CONNECTION_CLOSED' }) })
  const response = (input, text, status = 200) => ({ request: () => input, url: input.url, status: () => status, text })
  return { page, observer, httpErrors, request, response }
}

test('delayed successful bodies settle with their original request and process metadata', async () => {
  const f = fixture(), body = deferred(), request = f.request('capabilities')
  f.page.emit('request', request)
  f.page.emit('response', f.response(request, () => body.promise))
  let settled = false
  const waiting = f.observer.settle().then(() => { settled = true })
  await Promise.resolve()
  assert.equal(settled, false)
  body.resolve('{"story":{"generic":true}}')
  await waiting
  assert.deepEqual(f.httpErrors, [])
  const [read] = f.observer.evidence.reads
  assert.equal(read.action, 'capabilities'); assert.equal(read.sessionId, 'synthetic-story')
  assert.equal(read.home, 'home-a'); assert.equal(read.hostPid, 123)
  assert.equal(typeof read.requestId, 'string'); assert.ok(read.requestId.length)
  assert.equal(read.url, 'http://local/api/rp-studio/actions?token=[REDACTED]&view=rp')
  assert.equal(read.status, 200); assert.equal(read.body, '{"story":{"generic":true}}')
  assert.equal(read.bodyReadStatus, 'recorded'); assert.equal(read.bodyTruncated, false)
  assert.match(read.requestStarted.time, /Z$/u); assert.match(read.responseReceived.time, /Z$/u)
  assert.ok(read.responseReceived.monotonicMs >= read.requestStarted.monotonicMs)
})

for (const synchronous of [false, true]) test(`body read ${synchronous ? 'throw' : 'rejection'} retains HTTP error metadata and the exact redacted failure`, async () => {
  const f = fixture(), request = f.request('reviewState')
  f.page.emit('request', request)
  const text = () => { const error = new Error('body unavailable after page close Bearer synthetic-key'); if (synchronous) throw error; return Promise.reject(error) }
  f.page.emit('response', f.response(request, text, 503))
  await f.observer.settle()
  assert.equal(f.httpErrors.length, 1)
  assert.equal(f.httpErrors[0].status, 503); assert.equal(f.httpErrors[0].method, 'POST')
  assert.deepEqual(f.httpErrors[0].input, { action: 'reviewState', sessionId: 'synthetic-story' })
  const [read] = f.observer.evidence.reads
  assert.equal(read.bodyReadStatus, 'failed')
  assert.equal(read.bodyReadError, 'body unavailable after page close Bearer [REDACTED]')
  assert.equal(read.body, undefined)
  assert.equal(f.httpErrors[0].requestId, read.requestId)
  assert.equal(f.httpErrors[0].bodyReadError, read.bodyReadError)
})

test('stored bodies are bounded, marked as truncated, and redacted before evidence is settled', async () => {
  const f = fixture({ bodyLimit: 80 }), request = f.request('storyHistory')
  f.page.emit('request', request)
  f.page.emit('response', f.response(request, async () => `Bearer synthetic-key ${'x'.repeat(200)}`))
  await f.observer.settle()
  const [read] = f.observer.evidence.reads
  assert.equal(read.body.length, 80); assert.equal(read.bodyTruncated, true)
  assert.equal(read.bodyReadStatus, 'recorded'); assert.match(read.body, /^Bearer \[REDACTED\]/u)
  assert.equal(JSON.stringify(f.observer.evidence).includes('synthetic-secret'), false)
})

test('a stalled body becomes an explicit bounded read failure and a late result cannot overwrite it', async () => {
  const f = fixture({ bodyTimeoutMs: 1 }), body = deferred(), request = f.request('presentationSummaries')
  f.page.emit('request', request)
  f.page.emit('response', f.response(request, () => body.promise))
  await f.observer.settle()
  const [read] = f.observer.evidence.reads
  assert.equal(read.bodyReadStatus, 'failed'); assert.match(read.bodyReadError, /NATIVE_RESPONSE_BODY_TIMEOUT/u)
  body.resolve('late body')
  await Promise.resolve()
  assert.equal(read.body, undefined); assert.equal(read.bodyReadStatus, 'failed')
})

test('failed requests without responses retain their request IDs separately and unrelated successful traffic is excluded', async () => {
  const f = fixture(), request = f.request(), unrelated = f.request('authorNote')
  f.page.emit('request', request); f.page.emit('request', unrelated)
  f.page.emit('requestfailed', request)
  f.page.emit('response', f.response(unrelated, async () => 'unrelated body'))
  await f.observer.settle()
  assert.equal(f.observer.evidence.reads.length, 1)
  const [failed] = f.observer.evidence.requestFailures
  assert.equal(failed.requestId, f.observer.evidence.reads[0].requestId)
  assert.equal(failed.error, 'net::ERR_CONNECTION_CLOSED')
  assert.equal(f.observer.evidence.reads[0].status, undefined)
})

test('cleanup observations preserve the original parallel ordering and both failures on the request clock', async () => {
  const f = fixture(), browserClose = deferred()
  const closing = closeOwnedResources({ close: () => browserClose.promise }, { close() { throw new Error('host failed') } }, f.observer.record)
  await new Promise(done => setImmediate(done))
  assert.ok(f.observer.evidence.lifecycle.some(row => row.event === 'host-close-invoked'))
  assert.equal(f.observer.evidence.lifecycle.some(row => row.event === 'browser-close-settled'), false)
  browserClose.resolve(Promise.reject(new Error('browser failed')))
  const errors = await closing
  assert.deepEqual(errors.map(row => row.resource), ['browser', 'host'])
  assert.deepEqual(errors.map(row => row.message), ['browser failed', 'host failed'])
  const events = f.observer.evidence.lifecycle
  assert.equal(events[0].event, 'close-requested')
  assert.ok(events.every((row, index) => index === 0 || row.monotonicMs >= events[index - 1].monotonicMs))
  assert.equal(events.filter(row => row.event.endsWith('-close-settled') && row.status === 'failed').length, 2)
})

test('startup finalization settles pending bodies before reporting while retaining original browser and cleanup errors', async () => {
  const f = fixture(), body = deferred(), request = f.request(), original = new Error('page bootstrap failed')
  f.page.emit('request', request); f.page.emit('response', f.response(request, () => body.promise, 503))
  let persisted = false
  const finalizing = contexts.closeFailedContext(original, { name: 'home-a', installed: { installed: [], version: 'rc.3' }, errors: ['original console error', 'original page error'], observer: f.observer,
    browser: { close() { throw new Error('browser failed') } }, host: { child: { pid: 123 }, close() { throw new Error('host failed') } },
    persistObservations: async () => { assert.equal(f.observer.evidence.reads[0].body, 'synthetic refusal'); persisted = true },
  })
  await new Promise(done => setImmediate(done))
  assert.equal(persisted, false)
  body.resolve('synthetic refusal')
  const result = await finalizing
  assert.equal(result, original); assert.equal(persisted, true)
  assert.deepEqual(result.nativeStartup.browserErrors, ['original console error', 'original page error'])
  assert.deepEqual(result.nativeStartup.cleanupErrors.map(row => row.resource), ['browser', 'host'])
  assert.equal(result.nativeStartup.observations.reads[0].body, 'synthetic refusal')
})
