import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createNativeTransport } from '../src/transport.mjs'

test('unary calls use the host owner peer and preserve named Remote arguments', async () => {
  const peer = { principal: { kind: 'owner' } }
  const calls = []
  const ctx = { connection: { browserPeer: peer }, typertGateway: { invoke: async request => { calls.push(request); return { presets: [] } } }, on() { return () => {} } }
  const transport = createNativeTransport(ctx)
  assert.deepEqual(await transport.call('agentPresets/list', {}), { presets: [] })
  assert.equal(calls[0].peer, peer)
  assert.equal(calls[0].namespace, 'agentPresets')
  assert.equal(calls[0].method, 'list')
  assert.deepEqual(calls[0].args, {})
  transport.stop()
})

test('stream disposal aborts the host invocation and prevents stale session delivery', async () => {
  let invocation
  let emit
  const received = []
  const ctx = { connection: { browserPeer: {} }, typertGateway: {
    stream: async request => { invocation = request; return { async *[Symbol.asyncIterator]() { yield await new Promise(resolve => { emit = resolve }) } } },
  }, on() { return () => {} } }
  const transport = createNativeTransport(ctx)
  const close = transport.open('session/follow', { request: { address: { sessionId: 'a' } } }, value => received.push(value), error => { throw error })
  await new Promise(resolve => setImmediate(resolve))
  close()
  assert.equal(invocation.signal.aborted, true)
  emit({ type: 'snapshot' })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(received, [])
  transport.stop()
})

test('native status notifications are unsubscribed on unload without owning approval waterfalls', () => {
  const listeners = new Map()
  const ctx = { connection: { browserPeer: {} }, typertGateway: {}, on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name) } }
  const frames = []
  const transport = createNativeTransport(ctx)
  transport.open('$events', {}, frame => frames.push(frame), () => {})
  listeners.get('api-session/status')('one', true)
  assert.deepEqual(frames.at(-1), { type: 'emit', event: 'api-session/status', args: ['one', true] })
  assert.equal(listeners.has('interaction/request'), false)
  transport.stop()
  assert.equal(listeners.size, 0)
})
