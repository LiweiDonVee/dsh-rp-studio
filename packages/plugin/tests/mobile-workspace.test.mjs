import test from 'node:test'
import assert from 'node:assert/strict'
import { createStudioActions } from '../src/actions.mjs'

const post = input => new Request('http://local/api/rp-studio/actions', { method: 'POST', body: JSON.stringify(input) })
const ref = number => ({ sessionId: 'story', presentationId: `p-${number}`, assistantMessageId: `a-${number}`, callSeq: number * 10, baseResultSeq: number * 10 + 1, resultSeq: number * 10 + 2 })
const record = number => ({ id: `record-${number}`, ref: ref(number), action: `Action ${number}`, text: `FULL PUBLIC ${number}: ` + 'x'.repeat(2000), compiled: 'PRIVATE_COMPILED' })
function fixture(count = 24) {
  const calls = [], history = { schemaVersion: 1, projectionKey: 'key-1', records: Array.from({ length: count }, (_, index) => record(index + 1)), folded: ['PRIVATE_FOLDED'] }
  const rawGm = {
    binding: { schemaVersion: 1, id: 'binding', sessionId: 'story', launchId: 'launch', title: 'The gate', status: 'active',
      character: { assetId: 'hero', version: 1, name: 'Hero', description: 'PRIVATE_CHARACTER_BODY' }, persona: { assetId: 'user', version: 1, name: 'Player', description: 'PRIVATE_PERSONA_BODY' },
      opening: { id: 'opening', text: 'PRIVATE_OPENING_BODY' }, profile: { profileId: 'writer', version: 2 }, examples: 'PRIVATE_EXAMPLES' },
    scene: { schemaVersion: 1, title: 'Gate', location: 'Town', time: 'Noon', presentActorIds: ['hero'] },
    facts: { schemaVersion: 1, items: Array.from({ length: 20 }, (_, index) => ({ id: `fact-${index}`, text: 'Fact ' + 'x'.repeat(700) })) },
    review: { revision: 7, databaseRevision: 80, enabled: true,
      latestRound: { roundId: 'round', version: 3, status: 'staged', factRevision: 2, activeReceiptId: 'fact-receipt', pendingCandidateId: 'candidate', candidates: [{ payload: 'PRIVATE_CANDIDATE' }] },
      pendingDecision: { operationId: 'decision', roundId: 'round', candidateId: 'candidate', status: 'recorded', action: 'approve', request: 'PRIVATE_REQUEST' },
      generation: { id: 'job', operationId: 'generation', roundId: 'round', status: 'running', model: 'PRIVATE_MODEL' } },
    lastFactReceipt: { id: 'fact-receipt', sessionId: 'story', kind: 'turn', factRoundId: 'round', factRevision: 2, packet: 'PRIVATE_PACKET' },
    reading: { openingRequestId: 'opening-request', openingFactReceiptId: 'opening-fact' },
    capabilities: { fork: true, rollback: true, factReview: true, factRegeneration: true, autoplay: true },
  }
  const operations = { schemaVersion: 1, operations: [
    { operationId: 'active', sessionId: 'story', kind: 'regenerateFacts', status: 'running', revision: 2, input: 'PRIVATE_INPUT', result: 'PRIVATE_RESULT' },
    { operationId: 'old', sessionId: 'story', kind: 'regenerateFacts', status: 'complete', revision: 3, result: 'PRIVATE_OLD_RESULT' },
  ] }
  const services = {
    rpGM: { apiVersion: 1, storyState: async input => { calls.push(['gmState', input]); return structuredClone(rawGm) }, operations: async input => { calls.push(['gmOperations', input]); return structuredClone(operations) } },
    rpLastStep: { apiVersion: 1, capabilities: { narrativeRevisions: 1 }, storyHistory: async input => { calls.push(['storyHistory', input]); return structuredClone(history) },
      operations: async (input, signal) => { calls.push(['lastOperations', { ...input, signal }]); return structuredClone(operations) },
      narratives: () => { throw new Error('Full archive excluded') }, drafts: () => { throw new Error('Full drafts excluded') }, material: () => { throw new Error('Frozen bodies excluded') }, presentationSummaries: () => { throw new Error('Presentation receipts excluded') } },
  }
  const route = createStudioActions({ getService: name => services[name], authorize: async (sessionId, signal) => { calls.push(['authorize', { sessionId, signal }]) } })
  const read = async (extra = {}) => {
    const response = await route.request(post({ action: 'mobileWorkspace', sessionId: 'story', ...extra }))
    assert.equal(response.status, 200, await response.clone().text())
    return response.json()
  }
  return { calls, history, rawGm, operations, services, route, read }
}

test('fresh aggregate reads each owner once and returns full recent public prose plus bounded state only', async () => {
  const f = fixture(), before = structuredClone({ gm: f.rawGm, history: f.history, operations: f.operations }), value = await f.read()
  assert.deepEqual(f.calls.map(([name]) => name), ['authorize', 'gmState', 'storyHistory', 'gmOperations', 'lastOperations'])
  assert.ok(f.calls.every(([, input]) => input.sessionId === 'story' && input.signal instanceof AbortSignal && !Object.hasOwn(input, 'agent')))
  assert.equal(value.schemaVersion, 1); assert.equal(value.sessionId, 'story')
  assert.equal(value.history.changed, true); assert.equal(value.history.totalCount, 24); assert.equal(value.history.startIndex, 16)
  assert.equal(value.history.records.length, 8); assert.equal(value.history.records[0].text, f.history.records[16].text)
  assert.deepEqual(value.history.latestRef, ref(24)); assert.equal(value.history.hasOlder, true)
  assert.deepEqual(value.history.nextBefore, { projectionKey: 'key-1', callSeq: 170, presentationId: 'p-17' })
  assert.equal(value.gm.facts.items.length, 12); assert.equal(value.gm.facts.totalCount, 20); assert.equal(value.gm.facts.items[0].text.length, 500); assert.equal(value.gm.truncated, true)
  assert.equal(value.gm.review.latestRound.pendingCandidateId, 'candidate'); assert.equal(value.gm.review.known, true)
  assert.equal(value.gm.capabilities.fork, false)
  assert.equal(value.gm.review.generation.operationId, 'generation'); assert.equal(value.operations.gm.length, 1)
  assert.deepEqual(value.gm.reading, { openingRequestId: 'opening-request', openingFactReceiptId: 'opening-fact' })
  assert.deepEqual(value.gm.lastFactReceipt, { id: 'fact-receipt', kind: 'turn', factRoundId: 'round', factRevision: 2 })
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE/u)
  assert.deepEqual({ gm: f.rawGm, history: f.history, operations: f.operations }, before)
})

test('unchanged key omits prose bytes, reads remain idempotent and review version invalidates independently', async () => {
  const f = fixture(1000), first = await f.read(), unchanged = await f.read({ knownProjectionKey: 'key-1' }), repeated = await f.read({ knownProjectionKey: 'key-1' })
  assert.deepEqual(unchanged, repeated); assert.equal(unchanged.history.changed, false); assert.deepEqual(unchanged.history.records, [])
  assert.ok(Buffer.byteLength(JSON.stringify(unchanged)) < 12_000)
  assert.ok(Buffer.byteLength(JSON.stringify(first)) < 32_000)
  assert.ok(Buffer.byteLength(JSON.stringify(f.history)) > 2_000_000)
  f.rawGm.review.latestRound.version++; f.rawGm.review.latestRound.pendingCandidateId = 'new-candidate'
  const changedReview = await f.read({ knownProjectionKey: 'key-1' })
  assert.notEqual(changedReview.gm.review.projectionKey, unchanged.gm.review.projectionKey)
  assert.equal(changedReview.history.changed, false); assert.equal(changedReview.history.records.length, 0)
})

test('changed effective projection validates exact retained refs with ordinals so replacement gaps remain visible', async () => {
  const f = fixture(), refs = structuredClone(f.history.records.slice(0, 16).map(row => row.ref))
  f.history.projectionKey = 'key-2'; f.history.records[4].ref.resultSeq++; f.history.records[4].text = 'New adopted text'
  f.history.records.push(record(25))
  const changed = await f.read({ knownProjectionKey: 'key-1', retainedRefs: refs })
  assert.equal(changed.history.changed, true); assert.equal(changed.history.retained.length, 15)
  assert.equal(changed.history.retained.some(item => item.index === 4), false)
  assert.deepEqual(changed.history.retained[4], { ref: ref(6), index: 5 })
  assert.equal(changed.history.startIndex, 17); assert.equal(changed.history.records.at(-1).text, f.history.records.at(-1).text)
  assert.equal(changed.history.totalCount, 25)
})

test('input validation caps retained windows and rejects cross-session and forged context before authorization', async () => {
  const f = fixture()
  for (const extra of [{ retainedRefs: Array.from({ length: 129 }, (_, i) => ref(i)) }, { retainedRefs: [ref(1), ref(1)] }, { retainedRefs: [{ ...ref(1), sessionId: 'other' }] },
    { retainedRefs: [{ ...ref(1), private: true }] }, { retainedRefs: [{ ...ref(1), resultSeq: 0 }] }, { knownProjectionKey: '' }, { agent: {} }, { limit: 100 }]) {
    assert.equal((await f.route.request(post({ action: 'mobileWorkspace', sessionId: 'story', ...extra }))).status, 400)
  }
  assert.equal(f.calls.length, 0)
})

test('missing/gated review is explicitly unknown and cannot unlock fact or branch writes', async () => {
  const f = fixture(0); delete f.rawGm.review
  const value = await f.read()
  assert.equal(value.gm.review.known, false); assert.equal(value.gm.capabilities.fork, false); assert.equal(value.gm.capabilities.factReview, false)
  assert.deepEqual(value.history.records, []); assert.equal(value.history.latestRef, null); assert.equal(value.history.hasOlder, false); assert.equal(value.history.nextBefore, null)
})

test('compact branch availability requires no pending work and the latest selected exact fact receipt', async () => {
  const f = fixture(); f.rawGm.review.latestRound.pendingCandidateId = null; f.rawGm.review.pendingDecision = null; f.rawGm.review.generation.status = 'complete'
  f.operations.operations = []; f.history.records.at(-1).factReceiptId = 'fact-receipt'
  assert.equal((await f.read()).gm.capabilities.fork, true)
  f.history.records.at(-1).factReceiptId = 'old-fact'
  assert.equal((await f.read()).gm.capabilities.fork, false)
  f.history.records.at(-1).factReceiptId = 'fact-receipt'; delete f.rawGm.review
  assert.equal((await f.read()).gm.capabilities.fork, false)
})

test('malformed owner scope/schema and unavailable selected projection fail explicitly without archive fallback', async () => {
  for (const change of [f => { f.rawGm.binding.sessionId = 'other' }, f => { f.rawGm.review.databaseRevision = -1 }, f => { f.history.records[0].ref.sessionId = 'other' },
    f => { f.operations.operations[0].sessionId = 'other' }, f => { f.services.rpLastStep.capabilities.narrativeRevisions = 0 }]) {
    const f = fixture(); change(f)
    const response = await f.route.request(post({ action: 'mobileWorkspace', sessionId: 'story' }))
    assert.equal(response.status, 503)
  }
  const route = createStudioActions({ getService: () => { throw new Error('Owner read before authorization') }, authorize: async () => { throw Object.assign(new Error('Denied'), { apiError: { code: 'forbidden', message: 'Denied' }, statusCode: 403 }) } })
  assert.equal((await route.request(post({ action: 'mobileWorkspace', sessionId: 'story' }))).status, 403)
})
