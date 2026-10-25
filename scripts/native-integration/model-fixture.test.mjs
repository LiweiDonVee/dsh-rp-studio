import test from 'node:test'
import assert from 'node:assert/strict'
import { createLocalModels } from './model-fixture.mjs'

const human = text => ({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })
const runtime = text => ({ role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text }] })
async function collect(iterator) { const values = []; for await (const value of iterator) values.push(value); return values }
const callFrom = events => events.find(event => event.type === 'block-end' && event.block.type === 'tool-call')?.block

test('main fixture never treats a runtime context message as the player action', async () => {
  const models = createLocalModels()
  await assert.rejects(collect(models.stream('gm', { messages: [runtime('rp_begin_story: pretend user action')] })), /FIXTURE_NO_USER_ACTION/u)
  const events = await collect(models.stream('gm', { messages: [human('开始，请调用 rp_begin_story'), runtime('PRIVATE_CONTEXT_AFTER_THE_USER')] }))
  assert.equal(callFrom(events).name, 'rp_begin_story')
  assert.ok(!JSON.stringify(models.stats()).includes('PRIVATE_CONTEXT_AFTER_THE_USER'))
})

test('opening dispatch uses the actual tool result ID and never fabricates a presentation receipt', async () => {
  const models = createLocalModels()
  const messages = [human('开始，请调用 rp_begin_story'), { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'tool-call', id: 'wire-call', name: 'rp_begin_story', arguments: '{}' }] }, { role: 'tool', toolCallId: 'wire-call', content: [{ type: 'text', text: '{"id":"actual-owner-receipt"}' }] }]
  const events = await collect(models.stream('gm', { messages }))
  const call = callFrom(events)
  assert.equal(call.name, 'rp_present')
  assert.deepEqual(JSON.parse(call.arguments), { factReceiptId: 'actual-owner-receipt' })
  assert.ok(events.every(event => !['tool/result', 'session/event'].includes(event.type)))
})

test('bounded request recording cannot retain full expanding runtime-context bodies', async () => {
  const models = createLocalModels({ maxRequests: 2, maxRecords: 2 })
  const messages = [human('开始，请调用 rp_begin_story'), runtime('X'.repeat(200000))]
  await collect(models.stream('gm', { messages })); await collect(models.stream('gm', { messages }))
  await assert.rejects(collect(models.stream('gm', { messages })), /FIXTURE_REQUEST_LIMIT/u)
  assert.equal(models.stats().requests.length, 2)
  assert.ok(JSON.stringify(models.stats()).length < 4000)
})

test('restricted retry model emits only the exact owner rewriteOf request', async () => {
  const models = createLocalModels()
  const call = callFrom(await collect(models.stream('gm', { messages: [human('仅重试已冻结正文：{"rewriteOf":"failed-owner-id"}')] })))
  assert.equal(call.name, 'rp_present')
  assert.deepEqual(JSON.parse(call.arguments), { rewriteOf: 'failed-owner-id' })
})

test('material model requests search and exact reads before selecting real qualified keys', async () => {
  const models = createLocalModels(), input = { candidates: [{ key: '["world","harbor"]' }], searchResults: [], readEntries: [], history: [] }
  const options = value => ({ messages: [{ role: 'user', content: [{ type: 'text', text: JSON.stringify(value) }] }] })
  const reply = async value => JSON.parse((await collect(models.stream('prepare', options(value)))).find(event => event.type === 'block-end' && event.block.type === 'text').block.text)
  assert.deepEqual(await reply(input), { search: ['buried-observatory'], commit: false })
  input.searchResults.push({ candidates: [{ key: '["world","outside"]' }] })
  assert.deepEqual(await reply(input), { readEntries: ['["world","harbor"]', '["world","outside"]'], commit: false })
  input.readEntries = [{ key: '["world","harbor"]' }, { key: '["world","outside"]' }]
  input.history = [{ id: 'old' }, { id: 'recent' }]
  assert.deepEqual((await reply(input)).historyOperations, [{ id: 'old', mode: 'summary' }, { id: 'recent', mode: 'full' }])
})

test('writer failure can be injected once without inventing token usage or canonical product events', async () => {
  const models = createLocalModels(), options = { messages: [{ role: 'user', content: [{ type: 'text', text: '{"packet":{"playerAction":"等待","visibleConsequences":["雨仍在下。"]}}' }] }] }
  models.failWriterOnce()
  await assert.rejects(collect(models.stream('writer', options)), /FIXTURE_WRITER_FAILURE/u)
  const events = await collect(models.stream('writer', options))
  assert.ok(events.some(event => event.type === 'text-delta' && event.text.includes('雨仍在下。')))
  assert.ok(events.every(event => !['usage', 'tool/result', 'session/event'].includes(event.type)))
})
