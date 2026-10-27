import test from 'node:test'
import assert from 'node:assert/strict'
import * as proof from './approval-proof.mjs'

const counts = () => Object.fromEntries(proof.MODEL_STAGES.map(stage => [stage, 0]))
const operationHash = 'd'.repeat(64)
function writerViews() {
  const receipt = { id: 'facts', factRoundId: 'round', factRevision: 3 }, input = { packet: { visibleConsequences: ['CURRENT_FACTS'] }, modules: [{ role: 'system', content: 'CURRENT_FACTS' }], context: { history: [{ id: 'earlier', content: 'EARLIER_LEGAL_BODY', source: { presentationId: 'earlier' } }] }, story: { facts: 'CURRENT_FACTS' }, recentProse: ['EARLIER_LEGAL_BODY'] }
  const material = { factReceiptRef: 'facts', packet: input.packet, compiled: { messages: input.modules }, contextPreparation: { materials: input.context, historyProjection: { schemaVersion: 1, projectionKey: 'actual', selectedPresentationIds: ['earlier'], activeFactReceiptIds: ['facts'] } }, storySnapshot: input.story, models: { render: { provider: 'studio-native-local', model: 'writer' } } }
  const ref = { sessionId: 'story', presentationId: 'old', callSeq: 1, resultSeq: 2 }, old = { text: 'OLD_CURRENT_BODY', factReceiptId: 'facts', ref }
  const oldCall = { seq: 1, type: 'tool/call', data: { name: 'rp_present', callId: 'old-call', arguments: '{"factReceiptId":"facts"}' } }, oldResult = { seq: 2, type: 'tool/result', surfaceOp: 'append', sourceEventSeqs: [1], data: { message: { isError: false, source: { kind: 'tool', callId: 'old-call' }, toolCallId: 'old-call', content: [{ type: 'text', text: old.text }] }, meta: { rpLastStep: { record: { factReceiptId: 'facts' } } } } }
  const before = { gm: { lastFactReceipt: receipt }, database: { revision: 7, entries: [{ ref: { sourceKey: 'world', entryId: '0' }, content: 'work', mode: 'required', readOnly: false, version: 1 }], notes: [], binding: {} }, factReview: { rounds: [], decisions: [] }, factReviewProjection: { groups: [] }, history: { records: [old] }, canonical: { records: [old] }, snapshot: { header: { id: 'story' }, inheritedEventCount: 0, events: [oldCall, oldResult] }, models: { counts: counts(), requests: [] } }
  const after = structuredClone(before), ownerOperation = { schemaVersion: 1, kind: 'regenerate-prose', operationId: 'writer-operation', requestHash: operationHash }
  const run = { seq: 3, type: 'command/run', data: { commandId: 'actual-writer', name: 'rp_regenerate_prose', source: { kind: 'user' }, args: ` writer-operation ${operationHash} dispatch-token` } }, call = { seq: 4, type: 'tool/call', data: { name: 'rp_present', callId: 'new-call', arguments: '{"regenerateOf":"old"}' } }
  const narrative = { text: 'NEW_CURRENT_BODY', factReceiptId: 'facts', ref: { sessionId: 'story', presentationId: 'new', callSeq: 4, resultSeq: 5 }, narrativeVersion: { schemaVersion: 1, groupId: 'round', kind: 'writer-regeneration', basePresentationId: 'old', factRoundId: 'round', factRevision: 3 } }
  const result = { seq: 5, type: 'tool/result', surfaceOp: 'append', sourceEventSeqs: [4], data: { message: { isError: false, source: { kind: 'tool', callId: 'new-call' }, toolCallId: 'new-call', content: [{ type: 'text', text: narrative.text }] }, meta: { rpLastStep: { record: { factReceiptId: 'facts', ownerOperation } } } } }, done = { seq: 6, type: 'command/done', data: { commandId: 'actual-writer', kind: 'success' } }
  after.history.records = [narrative]; after.canonical.records.push(narrative); after.snapshot.events.push(run, call, result, done); after.models.counts.gm = 1; after.models.counts['writer-alt'] = 1
  after.models.requests.push({ model: 'writer-alt', tools: [], input: structuredClone({ ...input, instruction: 'CHANGE_EXPRESSION_ONLY' }) })
  return { before, after, originalMaterial: material, material: { ...structuredClone(material), models: { render: { provider: 'studio-native-local', model: 'writer-alt' } }, ownerOperation }, originalInput: input, result: { status: 'complete', presentationId: 'new' }, operationId: 'writer-operation', instruction: 'CHANGE_EXPRESSION_ONLY', model: 'writer-alt', basedOn: ref }
}
test('a scope test patch uses the real catalog revision and qualified tool id rather than an owner-only ref', () => {
  assert.equal(typeof proof.validOwnerPatch, 'function')
  const database = writerViews().before.database, catalog = { revision: 7, entries: database.entries }
  const armed = proof.validOwnerPatch(database, catalog)
  assert.deepEqual(armed.args, { expectedRevision: 7, operations: [{ op: 'update', id: '["world","0"]', patch: { content: 'NATIVE_FORBIDDEN_SCOPE' } }] })
  for (const mutate of [value => value.entries[0].readOnly = true, value => value.entries[0].mode = 'disabled', value => value.revision++]) { const changed = structuredClone(database); mutate(changed); assert.throws(() => proof.validOwnerPatch(changed, catalog)) }
})
test('authorNote GET is the public record while setAuthorNote keeps its explicit note wrapper', () => {
  assert.equal(typeof proof.authorNoteRecord, 'function')
  const record = { text: 'PUBLIC_AUTHOR_NOTE', version: 2, status: 'consumed' }, setResult = { revision: 8, note: { ...record, status: 'pending' } }
  assert.deepEqual(proof.authorNoteRecord(record), record)
  assert.deepEqual(proof.authorNoteRecord(setResult.note), setResult.note)
  for (const invalid of [setResult, null, { ...record, text: undefined }, { ...record, version: '2' }, { ...record, status: 'complete' }]) assert.throws(() => proof.authorNoteRecord(invalid))
})
test('writer regeneration requires canonical append, frozen composition and the actual changed render route with dispatch costs', () => {
  assert.equal(typeof proof.writerRevision, 'function')
  const fixture = writerViews(); assert.equal(proof.writerRevision(fixture.before, fixture.after, fixture).narrative.ref.presentationId, 'new')
  for (const mutate of [value => value.after.database.entries[0].version++, value => value.after.models.counts.prepare++, value => value.material.compiled.messages.push({ content: 'changed composition' }), value => value.material.models.render.model = 'writer', value => value.after.snapshot.events[0].data.callId = 'changed source', value => value.after.models.requests[0].input.context.history[0].content = 'different context', value => value.after.history.records[0].narrativeVersion.factRevision++]) { const changed = structuredClone(fixture); mutate(changed); assert.throws(() => proof.writerRevision(changed.before, changed.after, changed)) }
})
test('scope denial must be the real executor guard for a valid patch and cannot be a coincidental DB policy failure', () => {
  assert.equal(typeof proof.writerScopeDenial, 'function')
  const { before } = writerViews(), armed = proof.validOwnerPatch(before.database, { revision: 7, entries: before.database.entries }), after = structuredClone(before)
  after.models.counts.gm = 1
  const run = { seq: 3, type: 'command/run', data: { commandId: 'denied-owner', name: 'rp_regenerate_prose', source: { kind: 'user' }, args: `denied-operation ${operationHash} dispatch-token` } }, call = { seq: 4, type: 'tool/call', data: { name: 'rp_db_patch', callId: 'actual-patch', arguments: JSON.stringify(armed.args) } }
  const rejection = { seq: 5, type: 'tool/result', sourceEventSeqs: [4], data: { message: { isError: true, source: { kind: 'tool', callId: 'actual-patch' }, toolCallId: 'actual-patch', content: [{ type: 'text', text: 'Error: Only the exact selected rp_present operation is permitted for this owner request' }] } } }, done = { seq: 6, type: 'command/done', data: { commandId: 'denied-owner', kind: 'error' } }
  after.snapshot.events.push(run, call, rejection, done)
  assert.equal(proof.writerScopeDenial(before, after, armed, 'denied-operation').call.seq, 4)
  for (const mutate of [value => value.snapshot.events[4].data.message.content[0].text = 'READ_ONLY', value => value.snapshot.events[4].data.message.source.callId = 'unrelated', value => value.database.entries[0].content = 'NATIVE_FORBIDDEN_SCOPE', value => value.models.counts['writer-alt']++, value => value.snapshot.events[3].data.arguments = '{"expectedRevision":0,"operations":[]}']) { const changed = structuredClone(after); mutate(changed); assert.throws(() => proof.writerScopeDenial(before, changed, armed, 'denied-operation')) }
})
test('effective input audit excludes superseded material only for the revised group while allowing earlier legitimate history', () => {
  assert.equal(typeof proof.effectiveMaterialAudit, 'function')
  const { material } = writerViews(), records = [{ factReceiptId: 'prior-facts', text: 'SUPERSEDED_BODY', ref: { presentationId: 'superseded' }, narrativeVersion: { factRoundId: 'round' } }, { factReceiptId: 'facts', text: 'CURRENT_BODY', ref: { presentationId: 'new' }, narrativeVersion: { factRoundId: 'round' } }]
  const view = { gm: { lastFactReceipt: { id: 'facts', factRoundId: 'round', candidateId: 'current' }, facts: { items: [{ id: 'native-marker', text: 'CURRENT_FACTS' }] } }, review: { latestRound: { roundId: 'round', candidates: [{ id: 'old', payload: { summary: 'SUPERSEDED_SUMMARY', facts: { items: [{ id: 'native-marker', text: 'SUPERSEDED_FACTS' }] } } }, { id: 'current', payload: {} }] } }, canonical: { records } }
  const requests = ['prepare', 'assembly', 'writer'].map(model => ({ model, input: { packet: { current: 'CURRENT_FACTS' }, history: 'EARLIER_LEGAL_BODY' } }))
  assert.equal(proof.effectiveMaterialAudit(view, material, requests).superseded.length, 1)
  for (const mutate of [value => value.material.contextPreparation.materials.history[0].content = 'SUPERSEDED_BODY', value => value.requests[0].input.summary = 'SUPERSEDED_SUMMARY', value => value.material.contextPreparation.historyProjection.selectedPresentationIds.push('superseded'), value => value.requests[1].input.packet.current = 'SUPERSEDED_FACTS']) { const changed = structuredClone({ view, material, requests }); mutate(changed); assert.throws(() => proof.effectiveMaterialAudit(changed.view, changed.material, changed.requests)) }
})
