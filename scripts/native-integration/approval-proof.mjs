import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
export const MODEL_STAGES = ['gm', 'revise', 'prepare', 'summarize', 'assembly', 'writer', 'writer-alt']
export const sha = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex')
export const textOf = message => (message?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n')
export function commandBoundary({ sessionId, operationId, name, abort }) {
  let run, done, aborted = false
  const observe = (session, event) => {
    if (session.id !== sessionId || aborted) return
    if (event.type === 'command/run' && event.data.name === name && event.data.source?.kind === 'user') {
      const tokens = String(event.data.args ?? '').trim().split(/\s+/u)
      if (tokens.length === 2 && tokens[0] === operationId && /^[a-f0-9]{64}$/u.test(tokens[1])) run = structuredClone(event)
    }
    if (!run || event.type !== 'command/done' || event.seq <= run.seq || event.data.commandId !== run.data.commandId || event.data.kind !== 'success') return
    let value
    try { value = JSON.parse(event.data.text) } catch { return }
    if (value.schemaVersion !== 1 || value.operationId !== operationId) return
    const valid = name === 'rp-gm-fact-decision' ? value.requestHash === run.data.args.trim().split(/\s+/u)[1] : name === 'rp-gm-fact-regenerate' && typeof value.candidateId === 'string' && /^[a-f0-9]{64}$/u.test(value.payloadHash)
    if (!valid) return
    done = structuredClone(event); aborted = true; abort()
  }
  observe.evidence = () => ({ run, done, aborted })
  return observe
}
export function modelDeltas(before, after) {
  return Object.fromEntries(MODEL_STAGES.map(stage => {
    assert.ok(Number.isSafeInteger(before.counts[stage]) && Number.isSafeInteger(after.counts[stage]), `missing real ${stage} counter`)
    const delta = after.counts[stage] - before.counts[stage]; assert.ok(delta >= 0, `counter decreased: ${stage}`)
    return [stage, delta]
  }))
}
export function zeroModels(deltas) { for (const stage of MODEL_STAGES) assert.equal(deltas[stage], 0, `unexpected ${stage} model work`) }
export function factWorld(database) {
  return database.entries.filter(entry => entry.ref?.sourceKey === '@session' && ['gm.scene', 'gm.facts'].includes(entry.ref.entryId)).map(entry => ({ ref: entry.ref, content: entry.content, version: entry.version }))
}
export const pendingWorld = database => ({ binding: database.binding, entries: database.entries, notes: database.notes })
export function assertReceiptProjection(view, receipt) {
  const projection = view.factReviewProjection, round = view.review.latestRound
  assert.equal(projection?.schemaVersion, 1, 'missing public fact review projection'); assert.ok(Array.isArray(projection.groups))
  assert.ok(receipt?.id && receipt.factRoundId); assert.equal(projection.latestRoundId, round.roundId)
  const selected = projection.groups.filter(group => group.roundId === receipt.factRoundId); assert.equal(selected.length, 1, 'original receipt group missing or duplicated')
  assert.equal(selected[0].activeReceiptId, receipt.id); assert.equal(selected[0].factRevision, receipt.factRevision); assert.deepEqual(selected[0].source, receipt.source)
  if (round.pendingCandidateId) {
    const pending = projection.groups.filter(group => group.roundId === round.roundId); assert.equal(pending.length, 1)
    assert.equal(pending[0].activeReceiptId, null); assert.equal(pending[0].pendingCandidateId, round.pendingCandidateId); assert.deepEqual(pending[0].source, round.source)
  }
  if (Object.hasOwn(view.gm, 'lastFactReceipt')) assert.deepEqual(view.gm.lastFactReceipt, receipt)
  return projection
}
export function durablePending(view) {
  const round = view.review.latestRound
  assert.equal(view.factReviewProjection?.schemaVersion, 1); assert.ok(Array.isArray(view.factReviewProjection.groups))
  return { enabled: view.review.enabled, round: round && Object.fromEntries(['roundId', 'version', 'sessionId', 'turnKey', 'source', 'base', 'capture', 'candidates', 'pendingCandidateId', 'activeReceiptId', 'approvalRequired'].map(key => [key, round[key]])), pendingDecision: view.review.pendingDecision, projection: view.factReviewProjection, world: pendingWorld(view.database), history: view.history }
}
export function successfulToolResults(events, name, afterSeq = -1) {
  const calls = new Map(events.filter(event => event.type === 'tool/call' && event.data.name === name).map(event => [event.data.callId, event]))
  return events.filter(event => event.seq > afterSeq && event.type === 'tool/result' && event.data.message?.isError === false && calls.has(event.data.message.toolCallId)).map(result => ({ result, call: calls.get(result.data.message.toolCallId) }))
}
export function terminalProposal(view, afterSeq) {
  const round = view.review.latestRound, proposals = successfulToolResults(view.snapshot.events, 'rp_propose_turn', afterSeq)
  assert.equal(proposals.length, 1, 'pending must have one successful proposal result')
  const { call, result } = proposals[0]
  assert.equal(round.source.callSeq, call.seq); assert.equal(round.source.callId, call.data.callId)
  assert.equal(result.data.message.source?.kind, 'tool'); assert.equal(result.data.message.source.callId, call.data.callId); assert.deepEqual(result.sourceEventSeqs, [call.seq])
  assert.equal(JSON.parse(textOf(result.data.message)).candidateId, round.pendingCandidateId)
  const request = view.models.requests.find(row => row.model === 'gm' && row.emitted?.callId === call.data.callId)
  assert.ok(request, 'proposal has no recorded real GM stream start')
  assert.equal(view.models.requests.filter(row => row.model === 'gm' && row.index > request.index).length, 0, 'main stream started after terminal proposal, including failed starts')
  assert.equal(view.snapshot.events.filter(row => row.seq > result.seq && row.type === 'request/header').length, 0, 'native request header after terminal result')
  assert.equal(view.snapshot.events.filter(row => row.seq > result.seq && row.type === 'assistant/message' && row.data.message?.source?.kind === 'model').length, 0)
  return { call, result, request, returned: JSON.parse(textOf(result.data.message)) }
}
export function acceptedProse(view, receiptId) {
  const narrative = view.history.records.findLast(record => record.factReceiptId === receiptId)
  assert.ok(narrative?.text?.trim(), 'no actual selected accepted prose for current fact receipt')
  const call = view.snapshot.events.find(event => event.seq === narrative.ref.callSeq), result = view.snapshot.events.find(event => event.seq === narrative.ref.resultSeq)
  assert.equal(call?.type, 'tool/call'); assert.equal(call.data.name, 'rp_present')
  assert.equal(result?.type, 'tool/result'); assert.equal(result.data.message.isError, false)
  assert.equal(result.data.message.toolCallId, call.data.callId); assert.equal(result.data.message.source?.callId, call.data.callId)
  assert.equal(textOf(result.data.message), narrative.text)
  assert.equal(result.data.meta.rpLastStep.record.factReceiptId, receiptId)
  assert.equal(result.surfaceOp, 'append'); assert.deepEqual(result.sourceEventSeqs, [call.seq])
  return narrative
}
export function preservePrefix(actual, expected, { fork = false } = {}) {
  if (!fork) { const header = value => ({ ...value, delegationDepth: value.delegationDepth === undefined ? 0 : value.delegationDepth }); assert.deepEqual(header(actual.header), header(expected.header)); assert.equal(actual.inheritedEventCount, expected.inheritedEventCount) }
  assert.deepEqual(actual.events.slice(0, expected.events.length), expected.events)
  return { events: expected.events.length, sha256: sha(expected.events), inheritedEventCount: actual.inheritedEventCount }
}
export function commandProof(events, operationId, name) {
  const runs = events.filter(event => event.type === 'command/run' && event.data.name === name && event.data.source?.kind === 'user' && String(event.data.args ?? '').trim().split(/\s+/u)[0] === operationId)
  const run = runs.at(-1); assert.ok(run, 'real owner command run missing')
  const done = events.find(event => event.type === 'command/done' && event.data.commandId === run.data.commandId); assert.equal(done?.data.kind, 'success')
  return { run, done }
}
