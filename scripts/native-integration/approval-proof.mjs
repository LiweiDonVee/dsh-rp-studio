import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
export const MODEL_STAGES = ['gm', 'revise', 'prepare', 'summarize', 'assembly', 'writer', 'writer-alt']
export const sha = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex')
export function ownerRequestHash(value) {
  const ordered = item => Array.isArray(item) ? item.map(ordered) : item && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort().map(key => [key, ordered(item[key])])) : item
  return sha(ordered(value))
}
export const textOf = message => (message?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n')
export function commandBoundary({ sessionId, operationId, name, requestHash, abort }) {
  let run, done, aborted = false
  const observe = (session, event) => {
    if (session.id !== sessionId || aborted) return
    if (event.type === 'command/run' && event.data.name === name && event.data.source?.kind === 'user') {
      const tokens = String(event.data.args ?? '').trim().split(/\s+/u)
      if (tokens.length === 2 && tokens[0] === operationId && /^[a-f0-9]{64}$/u.test(tokens[1]) && (requestHash === undefined || tokens[1] === requestHash)) run = structuredClone(event)
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
  const tokens = String(run.data.args ?? '').trim().split(/\s+/u); assert.equal(tokens.length, 2); assert.match(tokens[1], /^[a-f0-9]{64}$/u)
  const done = events.find(event => event.seq > run.seq && event.type === 'command/done' && event.data.commandId === run.data.commandId); assert.equal(done?.data.kind, 'success')
  const output = JSON.parse(done.data.text); assert.equal(output.schemaVersion, 1); assert.equal(output.operationId, operationId)
  if (name === 'rp-gm-fact-decision') assert.equal(output.requestHash, tokens[1])
  else { assert.equal(name, 'rp-gm-fact-regenerate'); assert.ok(output.candidateId); assert.match(output.payloadHash, /^[a-f0-9]{64}$/u) }
  return { run, done }
}
export function generatedCandidate(before, after, { operationId, instruction, marker }) {
  const deltas = modelDeltas(before.models, after.models); assert.equal(deltas.revise, 1); zeroModels({ ...deltas, revise: 0 })
  assert.deepEqual(pendingWorld(after.database), pendingWorld(before.database)); assert.deepEqual(after.gm.lastFactReceipt, before.gm.lastFactReceipt); assert.deepEqual(after.history.records, before.history.records)
  const round = after.review.latestRound, original = before.review.latestRound
  assert.equal(round.roundId, original.roundId); assert.deepEqual(round.base, original.base); assert.deepEqual(round.capture, original.capture); assert.deepEqual(round.source, original.source)
  for (const candidate of original.candidates) assert.deepEqual(round.candidates.find(row => row.id === candidate.id), candidate)
  const candidate = round.candidates.find(row => row.operationId === operationId)
  assert.ok(candidate?.generationConfirmed); assert.equal(candidate.id, round.pendingCandidateId); assert.notEqual(candidate.id, original.pendingCandidateId)
  assert.ok(candidate.payload.facts.items.some(row => row.id === 'native-marker' && row.text === marker))
  const requests = after.models.requests.slice(before.models.requests.length); assert.equal(requests.length, 1)
  const request = requests[0]; assert.equal(request.model, 'revise'); assert.deepEqual(request.tools, []); assert.deepEqual(request.input.base, original.base); assert.deepEqual(request.input.capture, original.capture)
  assert.equal(request.input.instruction, instruction)
  assert.equal(after.snapshot.events.slice(before.snapshot.events.length).filter(row => row.type === 'tool/call').length, 0, 'fact generation repeated a native tool')
  return { candidate, request, deltas }
}
export function approvedWithoutPresentation(before, after, result, operationId) {
  zeroModels(modelDeltas(before.models, after.models))
  assert.equal(result.operationId, operationId); assert.equal(result.status, 'approved'); assert.equal(result.presentation.status, 'not-requested')
  const receipt = after.gm.lastFactReceipt, prior = before.gm.lastFactReceipt, round = after.review.latestRound, intent = after.review.pendingDecision
  assert.equal(receipt.id, result.factReceiptId); assert.notEqual(receipt.id, prior.id); assert.equal(receipt.factRoundId, round.roundId); assert.equal(result.roundId, round.roundId)
  assert.ok(Number.isSafeInteger(prior.factRevision)); assert.equal(receipt.factRevision, prior.factRevision + 1)
  assert.equal(round.activeReceiptId, receipt.id); assert.equal(round.pendingCandidateId, null)
  assert.equal(intent?.status, 'applied'); assert.equal(intent.operationId, operationId); assert.equal(intent.factReceiptId, receipt.id)
  const stored = after.factReview.decisions.find(row => row.operationId === operationId)
  assert.equal(stored?.status, 'applied'); assert.equal(stored.factReceiptId, receipt.id)
  assert.equal(after.history.records.some(row => row.factReceiptId === prior.id || row.factReceiptId === receipt.id), false, 'superseded or unwritten body selected')
  return { receipt, intent, deltas: modelDeltas(before.models, after.models) }
}
export function stagedGeneration(before, after, { operationId, instruction, marker }) {
  const round = after.review.latestRound, original = before.review.latestRound, job = after.review.generation, deltas = modelDeltas(before.models, after.models)
  assert.equal(deltas.revise, 1); assert.equal(round.roundId, original.roundId); assert.deepEqual(round.base, original.base); assert.deepEqual(round.capture, original.capture); assert.deepEqual(round.source, original.source)
  for (const candidate of original.candidates) assert.deepEqual(round.candidates.find(row => row.id === candidate.id), candidate)
  const candidate = round.candidates.find(row => row.operationId === operationId)
  assert.ok(candidate, 'no public staged candidate for the original generation'); assert.equal(job?.operationId, operationId); assert.equal(job.roundId, round.roundId); assert.equal(job.candidateId, candidate.id)
  assert.ok(candidate.payload.facts.items.some(row => row.id === 'native-marker' && row.text === marker))
  const requests = after.models.requests.slice(before.models.requests.length).filter(row => row.model === 'revise'); assert.equal(requests.length, 1)
  const request = requests[0]; assert.deepEqual(request.tools, []); assert.deepEqual(request.input.base, original.base); assert.deepEqual(request.input.capture, original.capture); assert.equal(request.input.instruction, instruction)
  assert.ok(after.snapshot.events.slice(before.snapshot.events.length).filter(row => row.type === 'tool/call').every(row => row.data.name === 'rp_present'), 'generation repeated fact/evidence tools')
  return { candidate, job, request, deltas }
}
const FIXED_OPERATION = { op: 'note', ref: { sourceKey: 'world', entryId: '0' }, text: 'NATIVE_FIXED_ONCE' }
function fixedOccurrences(view) {
  assert.ok(Array.isArray(view.database.changes), 'missing public effective changes')
  const ids = new Set(), occurrences = []
  for (const change of view.database.changes) {
    assert.ok(typeof change.id === 'string' && !ids.has(change.id), 'missing or duplicated public change ID'); ids.add(change.id); assert.ok(Array.isArray(change.operations))
    for (const [operationIndex, operation] of change.operations.entries()) if (isDeepStrictEqual(operation, FIXED_OPERATION)) occurrences.push({ changeId: change.id, operationIndex, operation })
  }
  return occurrences
}
export function fixedOperationAudit(before, after, command) {
  const receipt = after.gm.lastFactReceipt, round = after.review.latestRound
  assert.ok(typeof receipt.changeId === 'string' && receipt.changeId); assert.equal(receipt.factRoundId, round.roundId); assert.deepEqual(receipt.source, round.source)
  const changes = after.database.changes.filter(change => change.id === receipt.changeId); assert.equal(changes.length, 1)
  const change = changes[0], tokens = command.run.data.args.trim().split(/\s+/u)
  const decisionSource = { sessionId: receipt.sessionId, commandId: command.run.data.commandId, runSeq: command.run.seq, doneSeq: command.done.seq, requestHash: tokens[1] }
  assert.equal(change.anchor, round.source.assistantMessageId); assert.deepEqual(receipt.decisionSource, decisionSource)
  const occurrences = fixedOccurrences(after), selected = occurrences.filter(row => row.changeId === receipt.changeId)
  assert.equal(selected.length, 1, 'accepted change must apply the exact fixed operation once'); assert.equal(occurrences.length, fixedOccurrences(before).length + 1)
  return structuredClone({ ...selected[0], change })
}
export function assertFixedOperationRetained(before, after, audit) {
  const prior = fixedOccurrences(before), current = fixedOccurrences(after)
  assert.ok(prior.some(row => row.changeId === audit.changeId && row.operationIndex === audit.operationIndex && isDeepStrictEqual(row.operation, audit.operation)), 'original fixed operation was already missing')
  assert.deepEqual(current, prior, 'fixed operation disappeared, changed or replayed')
  assert.deepEqual(after.database.changes.find(change => change.id === audit.changeId), audit.change, 'original fixed operation source changed')
}
export function validOwnerPatch(database, catalog) {
  assert.ok(Number.isSafeInteger(database.revision)); assert.equal(catalog.revision, database.revision)
  const previous = database.entries.find(row => row.ref.sourceKey === 'world' && row.ref.entryId === '0'), entry = catalog.entries.find(row => row.ref.sourceKey === 'world' && row.ref.entryId === '0')
  assert.ok(previous && entry, 'real catalog patch target missing'); assert.equal(previous.readOnly, false); assert.notEqual(previous.mode, 'disabled'); assert.notEqual(entry.readOnly, true); assert.notEqual(entry.mode, 'disabled')
  const args = { expectedRevision: catalog.revision, operations: [{ op: 'update', id: JSON.stringify([entry.ref.sourceKey, entry.ref.entryId]), patch: { content: 'NATIVE_FORBIDDEN_SCOPE' } }] }
  return structuredClone({ args, previous, catalogEntry: entry, catalogRevision: catalog.revision })
}
function unchangedWriterFacts(before, after) {
  assert.deepEqual(pendingWorld(after.database), pendingWorld(before.database)); assert.deepEqual(after.gm.lastFactReceipt, before.gm.lastFactReceipt)
  assert.deepEqual(after.gm.scene, before.gm.scene); assert.deepEqual(after.gm.facts, before.gm.facts)
  assert.deepEqual(after.factReview.rounds, before.factReview.rounds); assert.deepEqual(after.factReview.decisions, before.factReview.decisions); assert.deepEqual(after.factReviewProjection, before.factReviewProjection)
}
function writerCommand(events, operationId, kind) {
  const run = events.findLast(row => row.type === 'command/run' && row.data.name === 'rp_regenerate_prose' && row.data.source?.kind === 'user' && row.data.args.trim().split(/\s+/u)[0] === operationId)
  assert.ok(run, 'real writer owner command missing'); const tokens = run.data.args.trim().split(/\s+/u)
  assert.equal(tokens.length, 3); assert.match(tokens[1], /^[a-f0-9]{64}$/u)
  const done = events.find(row => row.seq > run.seq && row.type === 'command/done' && row.data.commandId === run.data.commandId)
  assert.equal(done?.data.kind, kind); return { run, done, requestHash: tokens[1] }
}
export function writerRevision(before, after, { result, originalMaterial, material, originalInput, operationId, instruction, model, basedOn }) {
  const deltas = modelDeltas(before.models, after.models); assert.ok(deltas.gm > 0); assert.equal(deltas[model], 1); zeroModels({ ...deltas, gm: 0, [model]: 0 })
  unchangedWriterFacts(before, after); preservePrefix(after.snapshot, before.snapshot)
  const narrative = acceptedProse(after, before.gm.lastFactReceipt.id), command = writerCommand(after.snapshot.events, operationId, 'success')
  assert.equal(result.status, 'complete'); assert.equal(result.presentationId, narrative.ref.presentationId); assert.ok(command.done.seq > narrative.ref.resultSeq)
  assert.equal(narrative.narrativeVersion.kind, 'writer-regeneration'); assert.equal(narrative.narrativeVersion.basePresentationId, basedOn.presentationId); assert.equal(narrative.narrativeVersion.factRoundId, before.gm.lastFactReceipt.factRoundId); assert.equal(narrative.narrativeVersion.factRevision, before.gm.lastFactReceipt.factRevision)
  for (const key of ['packet', 'contextPreparation', 'compiled', 'storySnapshot', 'factReceiptRef']) assert.deepEqual(material[key] ?? null, originalMaterial[key] ?? null, `changed frozen ${key}`)
  assert.equal(material.models.render.model, model); assert.equal(material.ownerOperation.operationId, operationId); assert.equal(material.ownerOperation.requestHash, command.requestHash)
  const resultEvent = after.snapshot.events.find(row => row.seq === narrative.ref.resultSeq)
  assert.deepEqual(resultEvent.data.meta.rpLastStep.record.ownerOperation, material.ownerOperation)
  const newCalls = after.snapshot.events.slice(before.snapshot.events.length).filter(row => row.type === 'tool/call')
  assert.equal(newCalls.length, 1); assert.equal(newCalls[0].data.name, 'rp_present'); assert.deepEqual(JSON.parse(newCalls[0].data.arguments), { regenerateOf: basedOn.presentationId })
  for (const record of before.canonical.records) assert.deepEqual(after.canonical.records.find(row => row.ref.presentationId === record.ref.presentationId && row.ref.resultSeq === record.ref.resultSeq), record)
  assert.equal(after.canonical.records.length, before.canonical.records.length + 1); assert.equal(after.history.records.some(row => row.ref.presentationId === basedOn.presentationId), false)
  const requests = after.models.requests.slice(before.models.requests.length).filter(row => row.model === model); assert.equal(requests.length, 1)
  const request = requests[0]; assert.equal(request.input.instruction, instruction); assert.deepEqual(request.tools, [])
  for (const key of ['packet', 'modules', 'context', 'story', 'recentProse']) assert.deepEqual(request.input[key] ?? null, originalInput[key] ?? null, `writer rebuilt frozen ${key}`)
  return { narrative, command, request, deltas }
}
export function writerScopeDenial(before, after, armed, operationId) {
  unchangedWriterFacts(before, after); preservePrefix(after.snapshot, before.snapshot); assert.deepEqual(after.history, before.history); assert.deepEqual(after.canonical, before.canonical)
  const deltas = modelDeltas(before.models, after.models); assert.ok(deltas.gm > 0); zeroModels({ ...deltas, gm: 0 }); assert.equal(armed.args.expectedRevision, before.database.revision)
  const calls = after.snapshot.events.slice(before.snapshot.events.length).filter(row => row.type === 'tool/call'); assert.equal(calls.length, 1)
  const call = calls[0]; assert.equal(call.data.name, 'rp_db_patch'); assert.deepEqual(JSON.parse(call.data.arguments), armed.args)
  const rejection = after.snapshot.events.find(row => row.seq > call.seq && row.type === 'tool/result' && row.data.message?.toolCallId === call.data.callId)
  assert.equal(rejection?.data.message.isError, true); assert.deepEqual(rejection.sourceEventSeqs, [call.seq]); assert.equal(rejection.data.message.source?.kind, 'tool'); assert.equal(rejection.data.message.source.callId, call.data.callId)
  assert.match(textOf(rejection.data.message), /^(?:Error: )?Only the exact selected rp_present operation is permitted for this owner request$/u)
  const command = writerCommand(after.snapshot.events, operationId, 'error'); assert.ok(command.run.seq < call.seq && command.done.seq > rejection.seq)
  return { call, rejection, command, deltas, target: armed.previous }
}
export function effectiveMaterialAudit(view, material, requests) {
  const receipt = view.gm.lastFactReceipt, marker = view.gm.facts.items.find(row => row.id === 'native-marker')?.text
  assert.ok(marker); assert.equal(material.factReceiptRef, receipt.id)
  const superseded = view.canonical.records.filter(row => row.narrativeVersion?.factRoundId === receipt.factRoundId && row.factReceiptId !== receipt.id)
  assert.ok(superseded.length, 'no actual superseded same-round narrative to audit')
  const obsoleteCandidates = view.review.latestRound.candidates.filter(row => row.id !== receipt.candidateId)
  const forbidden = [...superseded.map(row => row.text), ...obsoleteCandidates.flatMap(row => [row.payload.summary, row.payload.facts.items.find(item => item.id === 'native-marker')?.text])].filter(value => typeof value === 'string' && value && value !== marker)
  const strings = value => typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(strings) : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : []
  const projection = material.contextPreparation?.historyProjection; assert.ok(projection?.activeFactReceiptIds.includes(receipt.id))
  for (const record of superseded) assert.equal(projection.selectedPresentationIds.includes(record.ref.presentationId), false)
  const stages = requests.filter(row => ['prepare', 'summarize', 'assembly', 'writer', 'writer-alt'].includes(row.model))
  for (const stage of ['prepare', 'assembly']) assert.ok(stages.some(row => row.model === stage), `no actual ${stage} input`)
  assert.ok(stages.some(row => ['writer', 'writer-alt'].includes(row.model)))
  for (const row of stages) {
    const values = strings(row.input); for (const old of forbidden) assert.equal(values.some(value => value.includes(old)), false, `${row.model} selected superseded material`)
    if (row.model !== 'summarize') assert.ok(values.some(value => value.includes(marker)), `${row.model} omitted selected facts`)
  }
  for (const old of forbidden) assert.equal(strings(material).some(value => value.includes(old)), false, 'material audit selected superseded content')
  return { receiptId: receipt.id, marker, superseded, forbidden, projection, requests: stages }
}
