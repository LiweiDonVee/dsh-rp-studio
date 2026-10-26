import test from 'node:test'
import assert from 'node:assert/strict'
import * as proof from './action-proof.mjs'
const { verifyAction, verifyColdBeforeAction, verifyRetryGuard } = proof

function sample() {
  const before = { gm: { facts: { items: [{ id: 'letter-holder', text: 'held by Lin' }] }, lastFactReceipt: { id: 'old' } }, narratives: [], snapshot: { events: [{ seq: 1, type: 'turn/end' }] }, models: { counts: { gm: 0, writer: 0, 'writer-alt': 0, assembly: 0 } } }
  const ref = { sessionId: 'actual', presentationId: 'present', assistantMessageId: 'assistant', callSeq: 5, resultSeq: 6 }
  const receipt = { id: 'new', kind: 'turn', source: { callId: 'fact-call', callSeq: 3, assistantMessageId: 'fact-assistant' }, stateRefs: [] }
  const after = { gm: { facts: structuredClone(before.gm.facts), lastFactReceipt: receipt }, narratives: [{ ref, factReceiptId: 'new', text: 'Accepted story text' }], snapshot: { events: [{ seq: 1, type: 'turn/end' }, { seq: 2, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'continue' }] } }, { seq: 3, type: 'tool/call', data: { callId: 'fact-call', name: 'rp_commit_turn' } }, { seq: 4, type: 'tool/result', data: { message: { toolCallId: 'fact-call', isError: false } } }, { seq: 5, type: 'tool/call', data: { callId: 'present-call', name: 'rp_present' } }, { seq: 6, type: 'tool/result', data: { message: { toolCallId: 'present-call', isError: false, content: [{ type: 'text', text: 'Accepted story text' }] } } }] }, models: { counts: { gm: 3, writer: 1, 'writer-alt': 0, assembly: 1 } } }
  after.gm.binding = { status: 'active' }
  before.models.total = 0; before.models.counts.prepare = 0; before.models.counts.summarize = 0
  return { before, after }
}
test('HTTP acceptance and idle with unchanged canonical work cannot prove a successful player action', () => {
  const { before } = sample()
  assert.throws(() => verifyAction(before, structuredClone(before), { text: 'continue' }))
})
test('fresh cold action cannot absorb work performed while the UI was opening into its baseline', () => {
  const { before } = sample(), baseline = { snapshot: structuredClone(before.snapshot), receiptId: before.gm.lastFactReceipt.id }
  verifyColdBeforeAction(before, baseline)
  for (const mutate of [value => value.models.counts.gm++, value => value.gm.lastFactReceipt.id = 'new-before-click', value => value.snapshot.events.push({ seq: 2, type: 'tool/call' })]) {
    const value = structuredClone(before); mutate(value)
    assert.throws(() => verifyColdBeforeAction(value, baseline))
  }
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

const oldGuard = 'Only rp_present with the selected failed presentation rewriteOf is permitted for this retry request'
const currentGuard = 'Only the exact selected rp_present operation is permitted for this owner request'
function retryRejection(text = currentGuard) {
  return { attempt: { seq: 8, type: 'tool/call', data: { name: 'rp_present', callId: 'wrong-rewrite-call', arguments: '{"rewriteOf":"not-the-selected-failed-presentation"}' } }, rejection: { seq: 9, type: 'tool/result', sourceEventSeqs: [8], data: { message: { source: { kind: 'tool', callId: 'wrong-rewrite-call' }, toolCallId: 'wrong-rewrite-call', isError: true, content: [{ type: 'text', text: `Error: ${text}` }] } } } }
}
for (const text of [oldGuard, currentGuard]) test(`invalid retry proof accepts the exact reviewed executor guard wording: ${text}`, () => {
  assert.equal(typeof verifyRetryGuard, 'function')
  const { attempt, rejection } = retryRejection(text)
  const proof = verifyRetryGuard(attempt, rejection, 'selected-failed-id')
  assert.equal(proof.callSeq, 8)
  assert.equal(proof.resultSeq, 9)
})
test('invalid retry proof cannot use another tool, the selected ID, a foreign result or an unrelated failure', () => {
  assert.equal(typeof verifyRetryGuard, 'function')
  for (const mutate of [
    value => { value.attempt.data.name = 'rp_gm_state' },
    value => { value.attempt.data.arguments = '{"rewriteOf":"selected-failed-id"}' },
    value => { value.rejection.data.message.source.callId = 'another-call' },
    value => { value.rejection.sourceEventSeqs = [] },
    value => { value.rejection.data.message.isError = false },
    value => { value.rejection.data.message.content[0].text = 'READ_ONLY: entry is locked' },
    value => { value.rejection.data.message.content[0].text = 'Only another operation is permitted' },
  ]) {
    const value = retryRejection(); mutate(value)
    assert.throws(() => verifyRetryGuard(value.attempt, value.rejection, 'selected-failed-id'))
  }
})
