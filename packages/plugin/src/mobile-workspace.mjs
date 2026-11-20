import { createHash } from 'node:crypto'
import { canReadStory, selectedHistory, validNarrativeRef } from './turn-reading.mjs'

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const id = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 256
const revision = value => Number.isSafeInteger(value) && value >= 0
const positive = value => revision(value) && value > 0
const refFields = ['sessionId', 'presentationId', 'assistantMessageId', 'callSeq', 'baseResultSeq', 'resultSeq']
const refKey = value => JSON.stringify(refFields.map(key => value[key]))
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const fail = () => { throw Object.assign(new Error('移动工作区的所属服务投影无效，请刷新所属插件。'), { code: 'MOBILE_WORKSPACE_UNAVAILABLE', status: 503 }) }
const requireValue = value => { if (!value) fail() }

export const canReadMobileWorkspace = (gm, lastStep) => gm?.apiVersion === 1 && typeof gm.storyState === 'function' && gm.capabilities?.storyState !== false && canReadStory(lastStep)
export function validMobileWorkspaceInput(input) {
  if (!id(input.sessionId) || input.knownProjectionKey !== undefined && !id(input.knownProjectionKey)) return false
  if (input.retainedRefs === undefined) return true
  return Array.isArray(input.retainedRefs) && input.retainedRefs.length <= 128
    && input.retainedRefs.every(ref => validNarrativeRef(ref) && ref.sessionId === input.sessionId)
    && new Set(input.retainedRefs.map(refKey)).size === input.retainedRefs.length
}

function text(value, max, state) {
  requireValue(typeof value === 'string')
  if (value.length > max) state.truncated = true
  return value.slice(0, max)
}
function identity(value, fields) {
  const result = {}
  for (const field of fields) if (value?.[field] !== undefined && value[field] !== null) {
    requireValue(id(value[field]))
    result[field] = value[field]
  }
  return result
}
function asset(value, state) {
  requireValue(object(value) && id(value.assetId) && positive(value.version))
  return { assetId: value.assetId, version: value.version, name: text(value.name, 160, state) }
}
function sceneSummary(value, state) {
  requireValue(object(value) && value.schemaVersion === 1 && Array.isArray(value.presentActorIds) && value.presentActorIds.every(id)
    && new Set(value.presentActorIds).size === value.presentActorIds.length)
  if (value.presentActorIds.length > 32) state.truncated = true
  return { schemaVersion: 1, title: text(value.title, 200, state), location: text(value.location, 200, state),
    ...(value.time === undefined ? {} : { time: text(value.time, 120, state) }), presentActorIds: value.presentActorIds.slice(0, 32) }
}
function reviewSummary(value, sessionId) {
  if (value === undefined || value === null) return { known: false, projectionKey: digest({ known: false }) }
  requireValue(object(value) && revision(value.revision) && revision(value.databaseRevision) && typeof value.enabled === 'boolean')
  const result = { known: true, revision: value.revision, databaseRevision: value.databaseRevision, enabled: value.enabled }
  if (value.latestRound !== null && value.latestRound !== undefined) {
    const round = value.latestRound
    requireValue(object(round) && id(round.roundId) && revision(round.version) && Array.isArray(round.candidates) && (round.sessionId === undefined || round.sessionId === sessionId))
    result.latestRound = { ...identity(round, ['roundId', 'status', 'pendingCandidateId', 'activeReceiptId']), version: round.version,
      ...(round.factRevision === undefined ? {} : { factRevision: round.factRevision }), candidateCount: round.candidates.length }
    requireValue(round.factRevision === undefined || revision(round.factRevision))
    for (const field of ['latest', 'canRegenerate', 'approvalRequired']) if (round[field] !== undefined) {
      requireValue(typeof round[field] === 'boolean'); result.latestRound[field] = round[field]
    }
    Object.assign(result.latestRound, identity(round, ['blockCode']))
  }
  if (value.pendingDecision !== null && value.pendingDecision !== undefined) {
    requireValue(object(value.pendingDecision) && id(value.pendingDecision.operationId) && id(value.pendingDecision.status)
      && (value.pendingDecision.sessionId === undefined || value.pendingDecision.sessionId === sessionId))
    result.pendingDecision = identity(value.pendingDecision, ['operationId', 'roundId', 'candidateId', 'status', 'action', 'factReceiptId'])
  }
  if (value.generation !== null && value.generation !== undefined) {
    requireValue(object(value.generation) && ['id', 'operationId', 'roundId', 'status'].every(field => id(value.generation[field]))
      && (value.generation.sessionId === undefined || value.generation.sessionId === sessionId))
    result.generation = identity(value.generation, ['id', 'operationId', 'roundId', 'status', 'candidateId'])
  }
  return { ...result, projectionKey: digest(result) }
}
function gmSummary(value, sessionId) {
  requireValue(object(value) && object(value.binding) && value.binding.schemaVersion === 1 && value.binding.sessionId === sessionId
    && ['id', 'sessionId', 'launchId', 'status'].every(key => id(value.binding[key])) && object(value.binding.opening) && id(value.binding.opening.id))
  const state = { truncated: false }, binding = value.binding
  const result = { binding: { schemaVersion: 1, ...identity(binding, ['id', 'sessionId', 'launchId', 'status', 'parentSessionId']),
    title: text(binding.title, 200, state), character: asset(binding.character, state), persona: asset(binding.persona, state), opening: { id: binding.opening.id } },
  scene: sceneSummary(value.scene, state) }
  if (binding.profile !== undefined) {
    requireValue(object(binding.profile) && id(binding.profile.profileId) && positive(binding.profile.version))
    result.binding.profile = { profileId: binding.profile.profileId, version: binding.profile.version }
  }
  requireValue(object(value.facts) && value.facts.schemaVersion === 1 && Array.isArray(value.facts.items)
    && value.facts.items.every(item => object(item) && id(item.id) && typeof item.text === 'string') && new Set(value.facts.items.map(item => item.id)).size === value.facts.items.length)
  const items = value.facts.items.slice(0, 12), factState = { truncated: value.facts.items.length > 12 }
  result.facts = { schemaVersion: 1, items: items.map(item => ({ id: item.id, text: text(item.text, 500, factState) })), totalCount: value.facts.items.length, truncated: factState.truncated }
  result.review = reviewSummary(value.review, sessionId)
  result.reading = identity(value.reading, ['openingRequestId', 'openingFactReceiptId'])
  if (value.lastFactReceipt !== undefined && value.lastFactReceipt !== null) {
    const receipt = value.lastFactReceipt
    requireValue(object(receipt) && id(receipt.id) && id(receipt.kind) && (receipt.sessionId === undefined || receipt.sessionId === sessionId))
    result.lastFactReceipt = { ...identity(receipt, ['id', 'kind', 'factRoundId']), ...(receipt.factRevision === undefined ? {} : { factRevision: receipt.factRevision }) }
    requireValue(receipt.factRevision === undefined || revision(receipt.factRevision))
  }
  result.capabilities = { rollback: value.capabilities?.rollback === true && result.review.known, fork: value.capabilities?.fork === true && result.review.known,
    autoplay: false, factReview: value.capabilities?.factReview === true && result.review.known, factRegeneration: value.capabilities?.factRegeneration === true && result.review.known }
  result.truncated = state.truncated || factState.truncated
  return result
}
async function activeOperations(owner, input, separateSignal = false) {
  if (typeof owner?.operations !== 'function') return []
  const value = separateSignal ? await owner.operations({ sessionId: input.sessionId }, input.signal) : await owner.operations({ sessionId: input.sessionId, signal: input.signal })
  requireValue(object(value) && value.schemaVersion === 1 && Array.isArray(value.operations))
  const active = []
  for (const operation of value.operations) {
    requireValue(object(operation) && operation.sessionId === input.sessionId && ['operationId', 'kind', 'status'].every(key => id(operation[key])) && positive(operation.revision))
    if (['accepted', 'running', 'cancelling'].includes(operation.status)) active.push({ ...identity(operation, ['operationId', 'sessionId', 'kind', 'status']), revision: operation.revision })
  }
  requireValue(active.length <= 16 && new Set(active.map(operation => operation.operationId)).size === active.length)
  return active.sort((left, right) => left.operationId.localeCompare(right.operationId))
}

/** A passive, session-authorized projection. Deliberate detail pages retain their full owner routes. */
export async function mobileWorkspace({ gm, lastStep }, input) {
  if (!canReadMobileWorkspace(gm, lastStep)) throw Object.assign(new Error('所需 RP 服务或方法不可用，请检查插件版本。'), { code: 'CAPABILITY_UNAVAILABLE', status: 503 })
  const [rawGm, history, gmOperations, lastOperations] = await Promise.all([
    gm.storyState({ sessionId: input.sessionId, signal: input.signal }), selectedHistory(lastStep, input),
    activeOperations(gm, input), activeOperations(lastStep, input, true),
  ])
  input.signal?.throwIfAborted()
  const changed = input.knownProjectionKey !== history.projectionKey
  const startIndex = Math.max(0, history.records.length - 8), tail = history.records.slice(startIndex)
  const retained = new Set((input.retainedRefs ?? []).map(refKey))
  const summary = gmSummary(rawGm, input.sessionId), review = summary.review
  const pending = !review.known || !!review.latestRound?.pendingCandidateId || ['recorded', 'interrupted'].includes(review.pendingDecision?.status) || review.generation?.status === 'running'
  const completed = summary.binding.status === 'active' && !!summary.lastFactReceipt?.id && history.records.at(-1)?.factReceiptId === summary.lastFactReceipt.id
  const busy = gmOperations.length > 0 || lastOperations.length > 0
  // The explicit action capability still checks the live Agent before dispatch.
  summary.capabilities.fork &&= completed && !pending && !busy
  summary.capabilities.rollback &&= completed && !pending && !busy
  return { schemaVersion: 1, sessionId: input.sessionId, gm: summary,
    history: { projectionKey: history.projectionKey, totalCount: history.records.length, latestRef: history.records.at(-1)?.ref ?? null, changed,
      records: changed ? tail : [], startIndex, hasOlder: startIndex > 0,
      nextBefore: startIndex > 0 ? { projectionKey: history.projectionKey, callSeq: tail[0].ref.callSeq, presentationId: tail[0].ref.presentationId } : null,
      retained: history.records.flatMap((record, index) => retained.has(refKey(record.ref)) ? [{ ref: record.ref, index }] : []) },
    operations: { gm: gmOperations, lastStep: lastOperations } }
}
