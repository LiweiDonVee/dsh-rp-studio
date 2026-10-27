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
test('an expected public request hash rejects a same-operation run with different raw args', () => {
  let aborted = 0
  const requestHash = 'a'.repeat(64), observer = proof.commandBoundary({ sessionId: 'story', operationId: 'decision', name: 'rp-gm-fact-decision', requestHash, abort: () => aborted++ })
  const run = { seq: 2, type: 'command/run', data: { commandId: 'wrong', name: 'rp-gm-fact-decision', source: { kind: 'user' }, args: `decision ${'b'.repeat(64)}` } }
  observer({ id: 'story' }, run)
  observer({ id: 'story' }, { seq: 3, type: 'command/done', data: { commandId: 'wrong', kind: 'success', text: JSON.stringify({ schemaVersion: 1, operationId: 'decision', requestHash: 'b'.repeat(64) }) } })
  assert.equal(aborted, 0)
})
test('owner proof rejects malformed hashes, mismatched done output and a placeholder success', () => {
  const run = { seq: 2, type: 'command/run', data: { commandId: 'real', name: 'rp-gm-fact-decision', source: { kind: 'user' }, args: `decision ${'a'.repeat(64)}` } }
  const done = { seq: 3, type: 'command/done', data: { commandId: 'real', kind: 'success', text: JSON.stringify({ schemaVersion: 1, operationId: 'decision', requestHash: 'a'.repeat(64) }) } }
  assert.deepEqual(proof.commandProof([run, done], 'decision', 'rp-gm-fact-decision'), { run, done })
  for (const changed of [
    [{ ...run, data: { ...run.data, args: 'decision invalid' } }, done],
    [run, { ...done, data: { ...done.data, text: '{"status":"approved"}' } }],
    [run, { ...done, data: { ...done.data, text: JSON.stringify({ schemaVersion: 1, operationId: 'decision', requestHash: 'b'.repeat(64) }) } }],
  ]) assert.throws(() => proof.commandProof(changed, 'decision', 'rp-gm-fact-decision'))
})
test('tool-free generation evidence catches repeated tools and mutated writable entries', () => {
  assert.equal(typeof proof.generatedCandidate, 'function')
  const counts = Object.fromEntries(proof.MODEL_STAGES.map(stage => [stage, 0]))
  const round = { roundId: 'round', source: { callSeq: 4 }, base: { scene: { title: 'captured base' }, facts: { items: [] } }, capture: { playerInput: { seq: 1, messageId: 'player', text: 'Actual player action' }, observations: [{ callSeq: 2, resultSeq: 3, toolName: 'rp_db_read', text: 'Actual evidence' }] }, candidates: [{ id: 'original', payload: { facts: { items: [] } } }], pendingCandidateId: 'original' }
  const before = { review: { latestRound: round }, gm: { lastFactReceipt: { id: 'old' } }, database: { entries: [{ ref: { sourceKey: 'world', entryId: '0' }, content: 'fixed work', version: 1 }], notes: [], binding: { sources: ['world'] } }, history: { records: [] }, snapshot: { events: [{ seq: 1 }] }, models: { counts, requests: [] } }
  const after = structuredClone(before), candidate = { id: 'generated', operationId: 'generation', generationConfirmed: true, payloadHash: 'b'.repeat(64), payload: { facts: { items: [{ id: 'native-marker', text: 'NEW_FACTS' }] } } }
  after.review.latestRound.candidates.push(candidate); after.review.latestRound.pendingCandidateId = candidate.id
  after.models.counts.revise = 1; after.models.requests.push({ model: 'revise', tools: [], input: { base: round.base, capture: round.capture, instruction: 'NEW_FACTS' } })
  assert.equal(proof.generatedCandidate(before, after, { operationId: 'generation', instruction: 'NEW_FACTS', marker: 'NEW_FACTS' }).candidate.id, 'generated')
  for (const mutate of [value => value.database.entries[0].version++, value => value.snapshot.events.push({ seq: 2, type: 'tool/call', data: { name: 'rp_db_read' } }), value => value.models.counts.gm++, value => value.models.requests[0].input.capture.playerInput.text = 'invented']) {
    const changed = structuredClone(after); mutate(changed)
    assert.throws(() => proof.generatedCandidate(before, changed, { operationId: 'generation', instruction: 'NEW_FACTS', marker: 'NEW_FACTS' }))
  }
})
test('owner request hashing recursively sorts objects without reordering arrays', () => {
  assert.equal(typeof proof.ownerRequestHash, 'function')
  assert.equal(proof.ownerRequestHash({ z: [{ b: 2, a: 1 }, false], a: 'x' }), proof.sha('{"a":"x","z":[{"a":1,"b":2},false]}'))
  assert.notEqual(proof.ownerRequestHash({ a: [1, 2] }), proof.ownerRequestHash({ a: [2, 1] }))
})
test('settlement proof requires original applied identity, a new receipt and folded old prose with every model stage zero', () => {
  assert.equal(typeof proof.approvedWithoutPresentation, 'function')
  const counts = Object.fromEntries(proof.MODEL_STAGES.map(stage => [stage, 0])), old = { id: 'old', factRoundId: 'round', factRevision: 1 }, receipt = { id: 'new', factRoundId: 'round', factRevision: 2 }
  const before = { gm: { lastFactReceipt: old }, models: { counts }, history: { records: [{ factReceiptId: 'old' }] } }
  const applied = { operationId: 'original', roundId: 'round', status: 'applied', factReceiptId: 'new' }, result = { operationId: 'original', roundId: 'round', status: 'approved', factReceiptId: 'new', presentation: { status: 'not-requested' } }
  const after = { gm: { lastFactReceipt: receipt }, review: { latestRound: { roundId: 'round', activeReceiptId: 'new', pendingCandidateId: null }, pendingDecision: applied }, factReview: { decisions: [applied] }, models: { counts: { ...counts } }, history: { records: [] } }
  assert.doesNotThrow(() => proof.approvedWithoutPresentation(before, after, result, 'original'))
  for (const mutate of [value => value.models.counts.gm++, value => value.models.counts.prepare++, value => value.review.pendingDecision.operationId = 'new-operation', value => value.gm.lastFactReceipt.factRevision++, value => value.history.records.push({ factReceiptId: 'old' })]) {
    const changed = structuredClone(after); mutate(changed)
    assert.throws(() => proof.approvedWithoutPresentation(before, changed, result, 'original'))
  }
  assert.throws(() => proof.approvedWithoutPresentation(before, after, { ...result, presentation: { status: 'complete' } }, 'original'))
})
test('generation interruption evidence requires the staged candidate and original public durable job, without pretending it is confirmed', () => {
  assert.equal(typeof proof.stagedGeneration, 'function')
  const counts = Object.fromEntries(proof.MODEL_STAGES.map(stage => [stage, 0])), round = { roundId: 'round', source: { callSeq: 2 }, base: { scene: { title: 'Frozen base' }, facts: { items: [] } }, capture: { playerInput: { text: 'Original action' } }, candidates: [] }
  const before = { review: { latestRound: round }, snapshot: { events: [] }, models: { counts, requests: [] } }, after = structuredClone(before)
  const candidate = { id: 'staged', operationId: 'original-generation', generationConfirmed: false, payloadHash: 'c'.repeat(64), payload: { facts: { items: [{ id: 'native-marker', text: 'STAGED_FACTS' }] } } }
  after.review.latestRound.candidates.push(candidate); after.review.generation = { operationId: 'original-generation', roundId: 'round', candidateId: 'staged', status: 'interrupted' }
  after.models.counts.revise = 1; after.models.requests.push({ model: 'revise', tools: [], input: { base: round.base, capture: round.capture, instruction: 'STAGED_FACTS' } })
  assert.equal(proof.stagedGeneration(before, after, { operationId: 'original-generation', instruction: 'STAGED_FACTS', marker: 'STAGED_FACTS' }).candidate.generationConfirmed, false)
  for (const mutate of [value => value.review.generation.operationId = 'invented', value => value.review.generation.candidateId = 'other', value => value.review.latestRound.candidates[0].operationId = 'other', value => value.models.requests[0].input.base.scene.title = 'Current UI state', value => value.snapshot.events.push({ type: 'tool/call', data: { name: 'rp_db_read' } })]) {
    const changed = structuredClone(after); mutate(changed)
    assert.throws(() => proof.stagedGeneration(before, changed, { operationId: 'original-generation', instruction: 'STAGED_FACTS', marker: 'STAGED_FACTS' }))
  }
})
test('fixed work is proven once by the receipt-bound public change even after temporary current notes disappear', () => {
  assert.equal(typeof proof.fixedOperationAudit, 'function')
  const operation = { op: 'note', ref: { sourceKey: 'world', entryId: '0' }, text: 'NATIVE_FIXED_ONCE' }, hash = 'a'.repeat(64)
  const command = { run: { seq: 5, data: { commandId: 'approval', args: `approve-op ${hash}` } }, done: { seq: 6 } }, source = { assistantMessageId: 'original-round', callSeq: 2 }, decisionSource = { sessionId: 'story', commandId: 'approval', runSeq: 5, doneSeq: 6, requestHash: hash }
  const before = { database: { notes: [], changes: [] } }, change = { id: 'actual-change', anchor: 'original-round', operations: [{ op: 'update', ref: { sourceKey: '@session', entryId: 'gm.facts' }, patch: { content: 'facts' } }, operation] }
  const after = { gm: { lastFactReceipt: { id: 'receipt', sessionId: 'story', factRoundId: 'round', changeId: 'actual-change', source, decisionSource } }, review: { latestRound: { roundId: 'round', source } }, database: { notes: [], changes: [change] } }
  const audit = proof.fixedOperationAudit(before, after, command)
  assert.equal(audit.changeId, 'actual-change'); assert.equal(audit.operationIndex, 1); assert.deepEqual(audit.operation, operation)
  for (const mutate of [value => value.database.changes = [], value => value.database.changes[0].operations.push(operation), value => value.database.changes[0].operations[1].text = 'NATIVE_FIXED_ONCE altered', value => value.database.changes[0].anchor = 'unrelated', value => value.gm.lastFactReceipt.decisionSource.commandId = 'wrong', value => value.gm.lastFactReceipt.changeId = null]) {
    const changed = structuredClone(after); mutate(changed)
    assert.throws(() => proof.fixedOperationAudit(before, changed, command))
  }
})
test('later fact revisions can append structured state operations but cannot replace or repeat the retained fixed operation', () => {
  assert.equal(typeof proof.assertFixedOperationRetained, 'function')
  const operation = { op: 'note', ref: { sourceKey: 'world', entryId: '0' }, text: 'NATIVE_FIXED_ONCE' }, change = { id: 'original', anchor: 'source', operations: [operation] }
  const before = { database: { notes: [{ text: 'temporary' }], changes: [change] } }, after = structuredClone(before)
  after.database.notes = []; after.database.changes.push({ id: 'revision', operations: [{ op: 'update', ref: { sourceKey: '@session', entryId: 'gm.facts' }, patch: { content: 'new facts' } }] })
  const audit = { changeId: 'original', operationIndex: 0, operation, change }
  assert.doesNotThrow(() => proof.assertFixedOperationRetained(before, after, audit))
  for (const mutate of [value => value.database.changes[1].operations.push(operation), value => value.database.changes[0].operations[0].ref.entryId = 'other', value => value.database.changes[0].id = 'replacement', value => value.database.changes[0].anchor = 'changed']) {
    const changed = structuredClone(after); mutate(changed)
    assert.throws(() => proof.assertFixedOperationRetained(before, changed, audit))
  }
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
test('cold prefix permits only absent depth and numeric zero equivalence, rejecting null and strings', () => {
  const base = { header: { id: 'story' }, events: [{ seq: 1 }], inheritedEventCount: 0 }
  assert.doesNotThrow(() => proof.preservePrefix({ ...base, header: { id: 'story', delegationDepth: 0 } }, base))
  for (const delegationDepth of [null, '0', 1]) assert.throws(() => proof.preservePrefix({ ...base, header: { id: 'story', delegationDepth } }, base))
})
test('pending world proof includes writable entries and bindings as well as registered fact entries', () => {
  assert.equal(typeof proof.pendingWorld, 'function')
  const database = { revision: 2, entries: [{ ref: { sourceKey: '@session', entryId: 'gm.facts' }, content: 'facts', version: 1 }, { ref: { sourceKey: 'world', entryId: '0' }, content: 'work', version: 1 }], notes: [], binding: { sources: [{ key: 'world' }] } }
  for (const mutate of [next => next.entries[1].content = 'changed', next => next.entries[1].version++, next => next.binding.sources = [], next => next.notes.push('fixed work')]) {
    const changed = structuredClone(database); mutate(changed)
    assert.notDeepEqual(proof.pendingWorld(changed), proof.pendingWorld(database))
  }
  assert.deepEqual(proof.pendingWorld({ ...database, revision: 3 }), proof.pendingWorld(database))
})
test('terminal proof rejects a real extra request/header even without another assistant', () => {
  assert.equal(typeof proof.terminalProposal, 'function')
  const call = { seq: 3, type: 'tool/call', data: { callId: 'propose-call', name: 'rp_propose_turn', turn: 1 } }, result = { seq: 4, type: 'tool/result', sourceEventSeqs: [3], data: { message: { toolCallId: 'propose-call', source: { kind: 'tool', callId: 'propose-call' }, isError: false, content: [{ type: 'text', text: '{"candidateId":"candidate"}' }] } } }
  const view = { snapshot: { events: [call, result, { seq: 5, type: 'request/header', data: { header: { config: { model: 'gm' } } } }, { seq: 6, type: 'turn/end', data: { turn: 1 } }] }, review: { latestRound: { source: { callSeq: 3, callId: 'propose-call' }, pendingCandidateId: 'candidate' } }, models: { requests: [{ model: 'gm', index: 1, emitted: { callId: 'propose-call' } }] } }
  assert.throws(() => proof.terminalProposal(view, -1))
  view.snapshot.events.splice(2, 1)
  view.models.requests.push({ model: 'gm', index: 2, error: 'MAIN_RAN_AFTER_TERMINAL_PROPOSAL' })
  assert.throws(() => proof.terminalProposal(view, -1))
  view.models.requests.pop()
  assert.equal(proof.terminalProposal(view, -1).result.seq, 4)
})
test('cold durable proof detects same-ID candidate payload or captured evidence changes', () => {
  const view = { review: { enabled: true, latestRound: { roundId: 'round', pendingCandidateId: 'candidate', candidates: [{ id: 'candidate', payload: { facts: 'exact' } }], base: { facts: 'base' }, capture: { playerInput: 'real input' } }, pendingDecision: null }, factReviewProjection: { schemaVersion: 1, groups: [{ activeReceiptId: 'receipt' }] }, gm: { lastFactReceipt: { id: 'receipt' } }, database: { entries: [], notes: [], binding: { sources: [] } }, history: { records: [{ id: 'selected' }] } }
  for (const mutate of [value => value.review.latestRound.candidates[0].payload.facts = 'lost edit', value => value.review.latestRound.capture.playerInput = 'different', value => value.factReviewProjection.groups[0].activeReceiptId = 'other', value => value.history.records = []]) {
    const changed = structuredClone(view); mutate(changed)
    assert.notDeepEqual(proof.durablePending(changed), proof.durablePending(view))
  }
})
test('cold durable proof anchors the full Database projection to the original receipt without filling the optional GM field', () => {
  assert.equal(typeof proof.assertReceiptProjection, 'function')
  const source = { assistantMessageId: 'original', callId: 'commit', callSeq: 4, turnStartSeq: 1 }, pendingSource = { assistantMessageId: 'pending', callId: 'proposal', callSeq: 9, turnStartSeq: 6 }
  const receipt = { id: 'baseline', factRoundId: 'baseline-round', factRevision: 1, source }
  const projection = { schemaVersion: 1, latestRoundId: 'pending', groups: [{ roundId: 'baseline-round', activeReceiptId: 'baseline', factRevision: 1, source, pendingCandidateId: null }, { roundId: 'pending', activeReceiptId: null, factRevision: null, source: pendingSource, pendingCandidateId: 'candidate' }] }
  const live = { review: { enabled: true, latestRound: { roundId: 'pending', pendingCandidateId: 'candidate', activeReceiptId: null, source: pendingSource, candidates: [{ id: 'candidate', payload: { facts: 'pending only' } }] }, pendingDecision: null }, factReviewProjection: projection, gm: { lastFactReceipt: receipt }, database: { entries: [], notes: [], binding: { sources: [] } }, history: { records: [{ factReceiptId: 'baseline' }] } }
  const cold = structuredClone(live); delete cold.gm.lastFactReceipt
  proof.assertReceiptProjection(live, receipt); proof.assertReceiptProjection(cold, receipt)
  assert.deepEqual(proof.durablePending(cold), proof.durablePending(live))
  assert.equal(Object.hasOwn(cold.gm, 'lastFactReceipt'), false)
  for (const mutate of [value => delete value.factReviewProjection, value => value.factReviewProjection.groups.shift(), value => value.factReviewProjection.groups[0].activeReceiptId = 'other', value => value.factReviewProjection.groups[0].factRevision++, value => value.factReviewProjection.groups[0].source.callSeq++, value => value.factReviewProjection.groups[1].activeReceiptId = 'invented', value => value.gm.lastFactReceipt = { ...receipt, id: 'changed-carrier' }]) {
    const changed = structuredClone(cold); mutate(changed)
    assert.throws(() => proof.assertReceiptProjection(changed, receipt))
  }
  const changedProjection = structuredClone(cold); changedProjection.factReviewProjection.groups[0].pendingCandidateId = 'changed'
  assert.notDeepEqual(proof.durablePending(changedProjection), proof.durablePending(live))
})
test('baseline suffix counting retains every actual successful commit, excluding error results and earlier calls', () => {
  const events = [{ seq: 1, type: 'tool/call', data: { name: 'rp_commit_turn', callId: 'old' } }, { seq: 2, type: 'tool/result', data: { message: { toolCallId: 'old', isError: false } } }, { seq: 3, type: 'tool/call', data: { name: 'rp_commit_turn', callId: 'first' } }, { seq: 4, type: 'tool/result', data: { message: { toolCallId: 'first', isError: false } } }, { seq: 5, type: 'tool/call', data: { name: 'rp_commit_turn', callId: 'second' } }, { seq: 6, type: 'tool/result', data: { message: { toolCallId: 'second', isError: false } } }]
  assert.equal(proof.successfulToolResults(events, 'rp_commit_turn', 2).length, 2)
  events.at(-1).data.message.isError = true
  assert.equal(proof.successfulToolResults(events, 'rp_commit_turn', 2).length, 1)
})
