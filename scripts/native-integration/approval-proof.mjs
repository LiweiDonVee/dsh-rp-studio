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
  if (!fork) { const header = value => ({ ...value, delegationDepth: value.delegationDepth ?? 0 }); assert.deepEqual(header(actual.header), header(expected.header)); assert.equal(actual.inheritedEventCount, expected.inheritedEventCount) }
  assert.deepEqual(actual.events.slice(0, expected.events.length), expected.events)
  return { events: expected.events.length, sha256: sha(expected.events), inheritedEventCount: actual.inheritedEventCount }
}
export function commandProof(events, operationId, name) {
  const runs = events.filter(event => event.type === 'command/run' && event.data.name === name && event.data.source?.kind === 'user' && String(event.data.args ?? '').trim().split(/\s+/u)[0] === operationId)
  const run = runs.at(-1); assert.ok(run, 'real owner command run missing')
  const done = events.find(event => event.type === 'command/done' && event.data.commandId === run.data.commandId); assert.equal(done?.data.kind, 'success')
  return { run, done }
}
