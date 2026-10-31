import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from './umbrella-fixture.mjs'

function fixture() {
  let adapter, route
  const ctx = {
    effect: setup => setup(),
    llm: { registerAdapter(providers, value) { assert.deepEqual(providers, ['rp-umbrella-local']); adapter = value; return () => {} } },
    connection: { fetch: { register(value) { route = value.fetch; return () => {} } } },
  }
  apply(ctx)
  return { adapter, request: async input => (await (await route(new Request('http://127.0.0.1/api/rp-umbrella-native-probe', { method: 'POST', body: JSON.stringify(input) }))).json()) }
}
const textOf = chunks => chunks.filter(row => row.type === 'text-delta').map(row => row.text).join('')
const collect = async iterable => { const output = []; for await (const item of iterable) output.push(item); return output }

test('the local fixture emits one exact queued call and never supplies an owner receipt', async () => {
  const { adapter, request } = fixture(), model = await adapter.prepareCall('rp-umbrella-local', 'umbrella')
  const args = { operation: 'assets.createPersona', input: { persona: { name: '合成', description: 'no owner is installed in this fixture self-test' }, expectedRevision: 8 } }
  assert.equal((await request({ action: 'enqueue', name: 'rp_companion_apply', arguments: args })).ok, true)
  const first = await collect(model.stream({ messages: [], tools: [] }))
  const call = first.find(row => row.type === 'block-end').block
  assert.equal(call.type, 'tool-call'); assert.equal(call.name, 'rp_companion_apply'); assert.deepEqual(JSON.parse(call.arguments), args)
  assert.equal(first.at(-1).reason.kind, 'tool-calls')
  const second = await collect(model.stream({ messages: [], tools: [] }))
  assert.equal(second.some(row => row.type === 'tool-call-delta'), false)
  assert.match(textOf(second), /真实工具读回/u)
  assert.equal((await request({ action: 'models' })).result.queued, 0)
})

test('actual presentation callers put migration instructions in options.system', async () => {
  const { adapter } = fixture(), model = await adapter.prepareCall('rp-umbrella-local', 'umbrella')
  const output = await collect(model.stream({ system: 'RP_LAST_STEP_MIGRATE\nSynthetic migration caller', messages: [{ role: 'user', content: [{ type: 'text', text: '{"profile":{"entries":[{"id":"writer","enabled":true,"phase":"unclassified","required":true},{"id":"simulation","enabled":true,"locked":true,"phase":"agent"}]}}' }] }] }))
  const draft = JSON.parse(textOf(output))
  assert.deepEqual(draft.updates, [{ id: 'writer', phase: 'render' }]); assert.deepEqual(draft.additions, [])
  assert.match(draft.report.summary, /human review/u)
  assert.equal(draft.status, undefined)
  await assert.rejects(adapter.prepareCall('external-paid-provider', 'model'), /UMBRELLA_UNKNOWN_MODEL/u)
})
