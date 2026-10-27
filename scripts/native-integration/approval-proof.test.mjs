import test from 'node:test'
import assert from 'node:assert/strict'
import * as proof from './approval-proof.mjs'

test('public command observer aborts only the exact session operation successful done with bound output', () => {
  assert.equal(typeof proof.commandBoundary, 'function')
  const session = { id: 'story' }, hash = 'a'.repeat(64); let aborted = 0
  const observer = proof.commandBoundary({ sessionId: 'story', operationId: 'operation', name: 'rp-gm-fact-decision', abort: () => aborted++ })
  const run = { seq: 8, type: 'command/run', data: { commandId: 'actual-command', name: 'rp-gm-fact-decision', source: { kind: 'user' }, args: ` operation ${hash}` } }
  const done = { seq: 9, type: 'command/done', data: { commandId: 'actual-command', kind: 'success', text: JSON.stringify({ schemaVersion: 1, operationId: 'operation', requestHash: hash }) } }
  observer({ id: 'foreign' }, run); observer(session, done); assert.equal(aborted, 0)
  observer(session, run)
  observer(session, { ...done, data: { ...done.data, kind: 'error' } }); assert.equal(aborted, 0)
  observer(session, { ...done, data: { ...done.data, text: JSON.stringify({ schemaVersion: 1, operationId: 'other', requestHash: hash }) } }); assert.equal(aborted, 0)
  observer(session, done); assert.equal(aborted, 1)
  assert.deepEqual(observer.evidence(), { run, done, aborted: true })
})
test('generation boundary needs real candidate output and does not confuse decision command identity', () => {
  assert.equal(typeof proof.commandBoundary, 'function')
  let aborted = 0
  const observer = proof.commandBoundary({ sessionId: 'story', operationId: 'generation', name: 'rp-gm-fact-regenerate', abort: () => aborted++ })
  const run = { seq: 2, type: 'command/run', data: { commandId: 'g', name: 'rp-gm-fact-regenerate', source: { kind: 'user' }, args: `generation ${'a'.repeat(64)}` } }
  observer({ id: 'story' }, run)
  const done = { seq: 3, type: 'command/done', data: { commandId: 'g', kind: 'success', text: '{"schemaVersion":1,"operationId":"generation","candidateId":"candidate","payloadHash":"' + 'b'.repeat(64) + '"}' } }
  observer({ id: 'story' }, done); assert.equal(aborted, 1)
})
test('zero model recovery rejects an omitted stage and every real nonzero stage', () => {
  assert.equal(typeof proof.modelDeltas, 'function')
  const counts = { gm: 2, revise: 1, prepare: 1, summarize: 0, assembly: 1, writer: 1, 'writer-alt': 0 }
  assert.deepEqual(proof.modelDeltas({ counts }, { counts }), { gm: 0, revise: 0, prepare: 0, summarize: 0, assembly: 0, writer: 0, 'writer-alt': 0 })
  assert.doesNotThrow(() => proof.zeroModels(proof.modelDeltas({ counts }, { counts })))
  assert.throws(() => proof.modelDeltas({ counts }, { counts: { gm: 2 } }))
  assert.throws(() => proof.zeroModels({ ...Object.fromEntries(Object.keys(counts).map(key => [key, 0])), gm: 1 }))
})
test('a dispatched or failed presentation cannot substitute for canonical accepted prose', () => {
  assert.equal(typeof proof.acceptedProse, 'function')
  assert.throws(() => proof.acceptedProse({ snapshot: { events: [] }, history: { records: [] } }, 'receipt'))
  assert.throws(() => proof.acceptedProse({ snapshot: { events: [] }, history: { records: [{ factReceiptId: 'receipt', text: 'fake status', ref: { callSeq: 2, resultSeq: 3 } }] } }, 'receipt'))
})
