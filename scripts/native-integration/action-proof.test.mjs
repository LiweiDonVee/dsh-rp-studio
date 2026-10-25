import test from 'node:test'
import assert from 'node:assert/strict'
import { verifyAction } from './action-proof.mjs'

function sample() {
  const before = { gm: { facts: { items: [{ id: 'letter-holder', text: 'held by Lin' }] }, lastFactReceipt: { id: 'old' } }, narratives: [], snapshot: { events: [{ seq: 1, type: 'turn/end' }] }, models: { counts: { gm: 0, writer: 0, 'writer-alt': 0, assembly: 0 } } }
  const ref = { sessionId: 'actual', presentationId: 'present', assistantMessageId: 'assistant', callSeq: 5, resultSeq: 6 }
  const receipt = { id: 'new', kind: 'turn', source: { callId: 'fact-call', callSeq: 3, assistantMessageId: 'fact-assistant' }, stateRefs: [] }
  const after = { gm: { facts: structuredClone(before.gm.facts), lastFactReceipt: receipt }, narratives: [{ ref, factReceiptId: 'new', text: 'Accepted story text' }], snapshot: { events: [{ seq: 1, type: 'turn/end' }, { seq: 2, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'continue' }] } }, { seq: 3, type: 'tool/call', data: { callId: 'fact-call', name: 'rp_commit_turn' } }, { seq: 4, type: 'tool/result', data: { message: { toolCallId: 'fact-call', isError: false } } }, { seq: 5, type: 'tool/call', data: { callId: 'present-call', name: 'rp_present' } }, { seq: 6, type: 'tool/result', data: { message: { toolCallId: 'present-call', isError: false, content: [{ type: 'text', text: 'Accepted story text' }] } } }] }, models: { counts: { gm: 3, writer: 1, 'writer-alt': 0, assembly: 1 } } }
  after.gm.binding = { status: 'active' }
  return { before, after }
}
test('HTTP acceptance and idle with unchanged canonical work cannot prove a successful player action', () => {
  const { before } = sample()
  assert.throws(() => verifyAction(before, structuredClone(before), { text: 'continue' }))
})
test('a new factual receipt without an actual accepted narrative cannot pass a continued action', () => {
  const { before, after } = sample(); after.narratives = []
  assert.throws(() => verifyAction(before, after, { text: 'continue' }))
})
test('a restoring GM cannot be reported as successful resumed play', () => {
  const { before, after } = sample(); after.gm.binding.status = 'restoring'
  assert.throws(() => verifyAction(before, after, { text: 'continue' }))
})
test('accepted action proof checks real result content and dispatch/render increments', () => {
  const { before, after } = sample()
  assert.equal(verifyAction(before, after, { text: 'continue' }).receiptId, 'new')
  after.snapshot.events.at(-1).data.message.content[0].text = 'Old metadata text'
  assert.throws(() => verifyAction(before, after, { text: 'continue' }))
})
