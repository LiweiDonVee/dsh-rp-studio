import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
const textOf = message => (message?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n')
const successfulFacts = events => {
  const calls = new Map(events.filter(event => event.type === 'tool/call').map(event => [event.data.callId, event.data.name]))
  return events.filter(event => event.type === 'tool/result' && event.data.message?.isError !== true && calls.get(event.data.message?.toolCallId) === 'rp_commit_turn').length
}
export function verifyRetryGuard(attempt, rejection, selectedId) {
  assert.equal(attempt?.type, 'tool/call'); assert.equal(attempt.data.name, 'rp_present')
  const args = JSON.parse(attempt.data.arguments)
  assert.deepEqual(args, { rewriteOf: 'not-the-selected-failed-presentation' }); assert.notEqual(args.rewriteOf, selectedId)
  assert.equal(rejection?.type, 'tool/result'); assert.ok(rejection.seq > attempt.seq)
  const message = rejection.data.message
  assert.equal(message.toolCallId, attempt.data.callId); assert.equal(message.source?.kind, 'tool'); assert.equal(message.source.callId, attempt.data.callId)
  assert.deepEqual(rejection.sourceEventSeqs, [attempt.seq]); assert.equal(message.isError, true)
  const text = textOf(message)
  assert.match(text, /^(?:Error: )?(?:Only rp_present with the selected failed presentation rewriteOf is permitted for this retry request|Only the exact selected rp_present operation is permitted for this owner request)$/u)
  return { callSeq: attempt.seq, resultSeq: rejection.seq, selectedId, wrongRewriteOf: args.rewriteOf, guardMessage: text }
}
export function verifyColdBeforeAction(before, baseline) {
  assert.equal(before.models.total, 0)
  for (const stage of ['gm', 'prepare', 'summarize', 'assembly', 'writer', 'writer-alt']) assert.equal(before.models.counts[stage], 0, `historical ${stage} work ran before click`)
  assert.equal(before.gm.lastFactReceipt?.id, baseline.receiptId)
  assert.deepEqual(before.snapshot.header, baseline.snapshot.header); assert.equal(before.snapshot.inheritedEventCount, baseline.snapshot.inheritedEventCount)
  assert.deepEqual(before.snapshot.events.slice(0, baseline.snapshot.events.length), baseline.snapshot.events)
  assert.ok(before.snapshot.events.slice(baseline.snapshot.events.length).every(event => event.type === 'session/end-seed'), 'canonical work ran while opening the cold UI')
  return { receiptId: baseline.receiptId, prefixHash: createHash('sha256').update(JSON.stringify(baseline.snapshot.events)).digest('hex'), modelCounts: before.models.counts }
}
export function verifyAction(before, after, { text, fact = 'new', presentation = 'accepted', failureStage, facts } = {}) {
  const receipt = after.gm.lastFactReceipt, previous = before.gm.lastFactReceipt, priorSeq = before.snapshot.events.at(-1)?.seq ?? -1
  assert.equal(after.gm.binding?.status, 'active', 'GM did not admit active play')
  assert.ok(after.snapshot.events.some(event => event.seq > priorSeq && event.type === 'user/message' && ['user', 'user-rpc'].includes(event.data.source?.kind) && textOf(event.data) === text), 'actual user action missing')
  assert.ok(after.models.counts.gm > before.models.counts.gm, 'main dispatch did not execute')
  assert.deepEqual(after.gm.facts, facts ?? before.gm.facts, 'unexpected accepted facts')
  if (fact === 'new') {
    assert.ok(receipt?.id && receipt.id !== previous?.id, 'no new accepted factual receipt')
    assert.equal(receipt.kind, 'turn'); assert.ok(receipt.source.callSeq > priorSeq)
    const call = after.snapshot.events.find(event => event.seq === receipt.source.callSeq)
    assert.equal(call?.type, 'tool/call'); assert.equal(call.data.name, 'rp_commit_turn'); assert.equal(call.data.callId, receipt.source.callId)
    assert.equal(successfulFacts(after.snapshot.events), successfulFacts(before.snapshot.events) + 1)
  } else {
    assert.equal(fact, 'same'); assert.equal(receipt?.id, previous?.id)
    assert.equal(successfulFacts(after.snapshot.events), successfulFacts(before.snapshot.events))
  }
  const deltas = Object.fromEntries(Object.keys(after.models.counts).map(key => [key, after.models.counts[key] - (before.models.counts[key] ?? 0)]))
  if (presentation === 'failed') {
    assert.deepEqual(after.narratives, before.narratives, 'failed presentation changed accepted prose')
    assert.equal(deltas[failureStage], 1, 'intended failure stage did not execute once')
    const calls = new Map(after.snapshot.events.filter(event => event.type === 'tool/call').map(event => [event.data.callId, event.data.name]))
    assert.ok(after.snapshot.events.some(event => event.seq > priorSeq && event.type === 'tool/result' && event.data.message?.isError === true && calls.get(event.data.message.toolCallId) === 'rp_present'))
    return { action: text, receiptId: receipt.id, presentation: 'failed', failureStage, deltas }
  }
  assert.equal(presentation, 'accepted')
  const narrative = after.narratives.at(-1)
  assert.ok(narrative?.text?.trim() && narrative.ref.callSeq > priorSeq, 'no newly accepted narrative')
  assert.equal(after.narratives.length, before.narratives.length + 1)
  assert.equal(narrative.factReceiptId, receipt.id)
  const call = after.snapshot.events.find(event => event.seq === narrative.ref.callSeq), result = after.snapshot.events.find(event => event.seq === narrative.ref.resultSeq)
  assert.equal(call?.type, 'tool/call'); assert.equal(call.data.name, 'rp_present')
  assert.equal(result?.type, 'tool/result'); assert.notEqual(result.data.message.isError, true); assert.equal(result.data.message.toolCallId, call.data.callId)
  assert.equal(textOf(result.data.message), narrative.text, 'accepted content differs from effective prose')
  assert.ok((deltas.writer ?? 0) + (deltas['writer-alt'] ?? 0) > 0, 'writer did not execute')
  return { action: text, receiptId: receipt.id, previousReceiptId: previous?.id, narrative: narrative.ref, bodyHash: createHash('sha256').update(narrative.text).digest('hex'), factStateRefs: receipt.stateRefs, deltas }
}
