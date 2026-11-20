const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const id = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 256
const revision = value => Number.isSafeInteger(value) && value >= 0
const exact = (value, fields) => object(value) && Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key))
const refFields = ['sessionId', 'presentationId', 'assistantMessageId', 'callSeq', 'baseResultSeq', 'resultSeq']
const cursorFields = ['projectionKey', 'callSeq', 'presentationId']
const pickRef = value => Object.fromEntries(refFields.map(key => [key, value[key]]))
const sameRef = (left, right) => refFields.every(key => left[key] === right[key])
const fail = (code, message, status = 400) => { throw Object.assign(new Error(message), { code, status }) }

export const validNarrativeRef = value => exact(value, refFields) && refFields.every(key => key.endsWith('Seq') ? revision(value[key]) : id(value[key])) && value.callSeq < value.baseResultSeq && value.baseResultSeq <= value.resultSeq
export const validReadingCursor = value => exact(value, cursorFields) && id(value.projectionKey) && id(value.presentationId) && revision(value.callSeq)
export const validReadingLimit = value => Number.isSafeInteger(value) && value > 0
export const canReadStory = owner => owner?.apiVersion === 1 && owner.capabilities?.narrativeRevisions === 1 && owner.capabilities?.storyHistory !== false && typeof owner.storyHistory === 'function'
export const canReadTurnDetails = owner => canReadStory(owner) && owner.capabilities?.material !== false && typeof owner.material === 'function'

function reference(value, strings, numbers = []) {
  if (!object(value)) return undefined
  const result = Object.fromEntries(strings.filter(key => id(value[key])).map(key => [key, value[key]]))
  for (const key of numbers) if (revision(value[key])) result[key] = value[key]
  return Object.keys(result).length ? result : undefined
}
function narrativeVersion(value) {
  if (!object(value) || value.schemaVersion !== 1 || !id(value.groupId) || !['original', 'writer-regeneration'].includes(value.kind)) return undefined
  return { schemaVersion: 1, groupId: value.groupId, kind: value.kind, ...reference(value, ['basePresentationId', 'factRoundId'], ['factRevision']) }
}
function publicRecord(record) {
  const actionSource = reference(record.actionSource, ['messageId', 'requestId'], ['seq'])
  const version = narrativeVersion(record.narrativeVersion)
  return {
    id: record.id, ref: pickRef(record.ref), ...(revision(record.turn) ? { turn: record.turn } : {}), action: record.action, text: record.text,
    ...(actionSource ? { actionSource } : {}), ...(id(record.factReceiptId) ? { factReceiptId: record.factReceiptId } : {}),
    ...(typeof record.createdAt === 'string' && record.createdAt.length <= 80 ? { createdAt: record.createdAt } : {}), ...(version ? { narrativeVersion: version } : {}),
  }
}

// Read only the owner's selected effective history. Canonical archives, drafts and
// folded versions are deliberately not a fallback when that projection is absent.
export async function selectedHistory(owner, { sessionId, signal }) {
  if (!id(sessionId)) fail('INVALID_REQUEST', '需要明确的故事会话。')
  if (!canReadStory(owner)) fail('CAPABILITY_UNAVAILABLE', 'LastStep 未提供兼容的有效正文读取。', 503)
  signal?.throwIfAborted()
  const value = await owner.storyHistory({ sessionId, signal })
  signal?.throwIfAborted()
  if (!object(value) || value.schemaVersion !== 1 || !id(value.projectionKey) || !Array.isArray(value.records)
    || value.records.some(record => !object(record) || !validNarrativeRef(record.ref) || record.ref.sessionId !== sessionId || typeof record.id !== 'string' || !record.id || record.id.length > 1024 || typeof record.action !== 'string' || typeof record.text !== 'string')) {
    fail('EFFECTIVE_HISTORY_UNAVAILABLE', '有效正文投影无效，请刷新所属服务。', 503)
  }
  const records = value.records.map(publicRecord).sort((a, b) => a.ref.callSeq - b.ref.callSeq || a.ref.presentationId.localeCompare(b.ref.presentationId))
  if (new Set(records.map(record => JSON.stringify([record.ref.callSeq, record.ref.presentationId]))).size !== records.length) fail('EFFECTIVE_HISTORY_UNAVAILABLE', '有效正文引用重复。', 503)
  return { projectionKey: value.projectionKey, records }
}

export async function readingPage(owner, input) {
  if (input.before !== undefined && !validReadingCursor(input.before) || input.limit !== undefined && !validReadingLimit(input.limit)) fail('INVALID_REQUEST', '正文分页参数无效。')
  const history = await selectedHistory(owner, input)
  const { records, projectionKey } = history
  let end = records.length
  if (input.before !== undefined) {
    if (input.before.projectionKey !== projectionKey) fail('STALE_READING', '正文版本已变化，请重新载入阅读。', 409)
    end = records.findIndex(record => record.ref.callSeq === input.before.callSeq && record.ref.presentationId === input.before.presentationId)
    if (end < 0) fail('STALE_READING', '阅读位置已失效，请重新载入阅读。', 409)
  }
  const start = Math.max(0, end - Math.min(input.limit ?? 8, 20))
  const page = records.slice(start, end)
  return { schemaVersion: 1, projectionKey, records: page, hasOlder: start > 0, nextBefore: start > 0 ? { projectionKey, callSeq: page[0].ref.callSeq, presentationId: page[0].ref.presentationId } : null, totalCount: records.length }
}

function bounded(value, max, state) {
  if (typeof value !== 'string') return undefined
  if (value.length > max) state.truncated = true
  return value.slice(0, max)
}
function publicChanges(material) {
  const packet = object(material?.packet) ? material.packet : null, state = { truncated: false }
  const result = { source: 'frozen-packet', available: !!packet }
  for (const key of ['resolvedChanges', 'visibleConsequences', 'openHooks', 'publicFactRefs']) {
    const items = Array.isArray(packet?.[key]) ? packet[key] : []
    if (items.length > 20 || items.some(item => typeof item !== 'string')) state.truncated = true
    result[key] = items.slice(0, 20).filter(item => typeof item === 'string').map(item => bounded(item, 500, state))
  }
  if (id(material?.factReceiptRef)) result.factReceiptRef = material.factReceiptRef
  return { ...result, truncated: state.truncated }
}
function frozenContext(material) {
  const prepared = material?.contextPreparation, materials = prepared?.materials
  const available = object(materials) && Array.isArray(materials.entries) && Array.isArray(materials.history)
  const state = { truncated: false }, entries = [], history = []
  if (available) {
    for (const entry of materials.entries.slice(0, 32)) {
      if (!object(entry)) { state.truncated = true; continue }
      const item = reference(entry, ['id', 'key'], ['version']) ?? {}
      const ref = reference(entry.ref, ['sourceKey', 'databaseId', 'entryId'], ['databaseVersion', 'version'])
      if (typeof entry.title === 'string') item.title = bounded(entry.title, 160, state)
      if (['auto', 'required', 'disabled'].includes(entry.mode)) item.mode = entry.mode
      if (typeof entry.readOnly === 'boolean') item.readOnly = entry.readOnly
      if (ref) item.ref = ref
      if (Object.keys(item).length) entries.push(item)
      else state.truncated = true
    }
    for (const item of materials.history.slice(0, 32)) {
      const source = reference(item?.source, ['sessionId', 'assistantMessageId', 'callId', 'presentationId'], ['callSeq', 'baseResultSeq', 'resultSeq'])
      if (typeof item?.id !== 'string' || !item.id || item.id.length > 1024 || !['full', 'summary', 'index'].includes(item.mode) || !source) { state.truncated = true; continue }
      history.push({ id: item.id, mode: item.mode, source })
    }
    if (materials.entries.length > 32 || materials.history.length > 32) state.truncated = true
  }
  return { available, entries, history, entriesCount: available ? materials.entries.length : 0, historyCount: available ? materials.history.length : 0, truncated: state.truncated }
}
function modelConfigs(value, stages) {
  const result = {}
  for (const stage of stages) {
    const config = value?.[stage]
    if (!id(config?.provider) || !id(config.model)) continue
    result[stage] = { provider: config.provider, model: config.model, ...(id(config.reasoningEffort) ? { reasoningEffort: config.reasoningEffort } : {}), ...(Number.isSafeInteger(config.maxTokens) && config.maxTokens > 0 ? { maxTokens: config.maxTokens } : {}) }
  }
  return result
}
function provenance(material) {
  const prepared = material?.contextPreparation
  return {
    ...(['prepared', 'assembling', 'rendering', 'rendered', 'complete', 'failed', 'cancelled'].includes(material?.status) ? { status: material.status } : {}),
    models: modelConfigs(material?.models, ['assemble', 'render']), contextModels: modelConfigs(prepared?.models, ['prepare', 'summarize']),
    ...(revision(prepared?.steps) ? { steps: prepared.steps } : {}), ...(revision(prepared?.materials?.chars) ? { chars: prepared.materials.chars } : {}),
  }
}
function selectedRecord(history, ref) {
  const record = history.records.find(item => sameRef(item.ref, ref))
  if (!record) fail('NARRATIVE_CONFLICT', '所选正文已不在当前有效历史中，请刷新后重新选择。', 409)
  return record
}

async function selectedTurn(owner, input) {
  if (!validNarrativeRef(input.basedOn) || input.basedOn.sessionId !== input.sessionId) fail('INVALID_REQUEST', '需要该故事的完整正文引用。')
  if (!canReadTurnDetails(owner)) fail('CAPABILITY_UNAVAILABLE', 'LastStep 未提供兼容的冻结回合材料读取。', 503)
  const first = await selectedHistory(owner, input)
  const selected = selectedRecord(first, input.basedOn)
  let material
  try { material = await owner.material({ sessionId: input.sessionId, presentationId: input.basedOn.presentationId, signal: input.signal }) }
  catch (error) { if (error?.code !== 'RECEIPT_NOT_FOUND') throw error }
  input.signal?.throwIfAborted()
  if (material !== undefined && (!object(material) || material.presentationId !== input.basedOn.presentationId)) fail('FROZEN_MATERIAL_UNAVAILABLE', '所选回合的冻结材料引用无效。', 503)
  if (material && selected.factReceiptId !== undefined && material.factReceiptRef !== selected.factReceiptId) fail('NARRATIVE_CONFLICT', '冻结材料与所选事实引用不一致，请刷新后重新选择。', 409)
  return { history: first, selected, material }
}

/** Capture one confirmed ending and its public packet for an explicit model call. */
export async function playerActionSource(owner, input) {
  const { history, selected, material } = await selectedTurn(owner, input)
  if (!sameRef(history.records.at(-1)?.ref ?? {}, input.basedOn)) fail('NARRATIVE_CONFLICT', '故事正文已变化，请回到最新正文重新生成建议。', 409)
  return { record: selected, publicChanges: publicChanges(material) }
}

/** Both Studio and the scoped Companion call this same bounded passive read. */
export async function turnDetails(owner, input) {
  const { material } = await selectedTurn(owner, input)
  const current = await selectedHistory(owner, input), selected = selectedRecord(current, input.basedOn)
  if (material && selected.factReceiptId !== undefined && material.factReceiptRef !== selected.factReceiptId) fail('NARRATIVE_CONFLICT', '冻结材料与所选事实引用不一致，请刷新后重新选择。', 409)
  const textState = { truncated: false }, actionState = { truncated: false }
  const record = { id: selected.id, ref: pickRef(selected.ref), ...(selected.turn !== undefined ? { turn: selected.turn } : {}), action: bounded(selected.action, 1000, actionState), text: bounded(selected.text, 2000, textState), ...(selected.createdAt ? { createdAt: selected.createdAt } : {}), textTruncated: textState.truncated, actionTruncated: actionState.truncated }
  return { schemaVersion: 1, projectionKey: current.projectionKey, ref: pickRef(selected.ref), record, publicChanges: publicChanges(material), context: frozenContext(material), provenance: provenance(material) }
}
