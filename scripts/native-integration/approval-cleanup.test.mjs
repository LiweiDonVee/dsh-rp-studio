import test from 'node:test'
import assert from 'node:assert/strict'
import * as contexts from './contexts.mjs'
test('failed counter and failed close are both retained, and restart cannot open the same home', async () => {
  assert.equal(typeof contexts.finishNativeContext, 'function')
  assert.equal(typeof contexts.restartNativeContext, 'function')
  const segment = {}; let closes = 0, opens = 0
  const context = { name: 'home', installed: {}, probe: async () => { throw new Error('COUNTER_FAILURE') }, close: async () => { closes++; throw new Error('STOP_FAILURE') } }
  await assert.rejects(contexts.restartNativeContext(context, () => contexts.finishNativeContext(context, segment), async () => { opens++ }), /finalization failed/u)
  assert.equal(closes, 1); assert.equal(opens, 0)
  assert.match(segment.counterError, /COUNTER_FAILURE/u); assert.match(segment.cleanupError, /STOP_FAILURE/u)
})
test('HTTP error observation preserves non-JSON POST metadata without throwing', () => {
  assert.equal(typeof contexts.observeHttpError, 'function')
  const request = { method: () => 'POST', postDataJSON: () => { throw new Error('not JSON') } }
  assert.doesNotThrow(() => contexts.observeHttpError({ status: () => 503, url: () => 'http://local/request', request: () => request }))
})
