import test from 'node:test'
import assert from 'node:assert/strict'
import * as fixture from './approval-model.mjs'
const human = text => ({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })
async function collect(iterator) { const values = []; for await (const value of iterator) values.push(value); return values }
const callFrom = events => events.find(event => event.type === 'block-end' && event.block.type === 'tool-call')?.block
test('approval model derives proposal and next-state facts from actual gm state and retains fixed evidence tools', async () => {
  assert.equal(typeof fixture.createApprovalModels, 'function')
  const model = fixture.createApprovalModels(), state = { revision: 8, scene: { schemaVersion: 1, title: 'Dock', location: 'Quay', presentActorIds: [] }, facts: { schemaVersion: 1, items: [{ id: 'native-marker', text: 'CURRENT_REGENERATED' }] }, review: { enabled: true }, lastFactReceipt: { id: 'current-receipt' } }
  const messages = [human('NATIVE_APPROVAL_NEXT'), { role: 'assistant', content: [{ type: 'tool-call', id: 'state', name: 'rp_gm_state', arguments: '{}' }] }, { role: 'tool', toolCallId: 'state', content: [{ type: 'text', text: JSON.stringify(state) }] }]
  const call = callFrom(await collect(model.stream('gm', { messages })))
  assert.equal(call.name, 'rp_propose_turn'); assert.equal(JSON.parse(call.arguments).expectedRevision, 8)
  assert.equal(JSON.parse(call.arguments).facts.items.find(item => item.id === 'native-marker').text, 'CURRENT_REGENERATED')
  assert.equal(model.stats().observedStates.at(-1).receiptId, 'current-receipt')
})
test('fact revise uses only captured base and evidence and returns no operations or native fake results', async () => {
  assert.equal(typeof fixture.createApprovalModels, 'function')
  const model = fixture.createApprovalModels(), input = { schemaVersion: 1, base: { scene: { schemaVersion: 1, title: 'Base', location: 'Quay', presentActorIds: [] }, facts: { schemaVersion: 1, items: [{ id: 'old', text: 'CAPTURED' }] } }, capture: { playerInput: { text: 'Wait' }, observations: [{ text: 'ACTUAL_TOOL_EVIDENCE' }] }, instruction: 'FACT_REVISION_A', fixedWorkPolicy: 'Do not replay tools' }
  const events = await collect(model.stream('revise', { messages: [{ role: 'user', content: [{ type: 'text', text: JSON.stringify(input) }] }] }))
  const value = JSON.parse(events.find(event => event.type === 'block-end').block.text)
  assert.equal(value.scene.title, 'Base'); assert.equal(value.facts.items.find(item => item.id === 'native-marker').text, 'FACT_REVISION_A')
  assert.deepEqual(Object.keys(value).sort(), ['facts', 'packet', 'scene', 'summary'])
  assert.equal(model.stats().requests.at(-1).input.capture.observations[0].text, 'ACTUAL_TOOL_EVIDENCE')
  assert.ok(events.every(event => !['tool/result', 'session/event'].includes(event.type)))
})
test('a failed main request after a terminal proposal is recorded even before it emits assistant output', async () => {
  const model = fixture.createApprovalModels()
  const messages = [human('NATIVE_APPROVAL_PENDING'), { role: 'assistant', content: [{ type: 'tool-call', id: 'proposal', name: 'rp_propose_turn', arguments: '{}' }] }, { role: 'tool', toolCallId: 'proposal', content: [{ type: 'text', text: '{"candidateId":"candidate"}' }] }]
  await assert.rejects(collect(model.stream('gm', { messages })), /MAIN_RAN_AFTER_TERMINAL_PROPOSAL/u)
  assert.equal(model.stats().counts.gm, 1)
  assert.equal(model.stats().requests[0].index, 1)
  assert.match(model.stats().requests[0].error, /MAIN_RAN_AFTER_TERMINAL_PROPOSAL/u)
})
