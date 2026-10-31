import { isDeepStrictEqual as same } from 'node:util'
import { fail, object } from './companion-contract.mjs'

const nonempty = value => typeof value === 'string' && !!value.trim()
function records(entries, label) {
  if (!Array.isArray(entries) || entries.some(entry => !object(entry) || !nonempty(entry.id)) || new Set(entries.map(entry => entry.id)).size !== entries.length) fail('INVALID_ARGUMENTS', `${label} 条目需要唯一 ID。`)
  return new Map(entries.map(entry => [entry.id, entry]))
}
function immutableFields(before, after, editable, label) {
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) if (!editable.includes(key) && !same(before[key], after[key])) fail('PROTECTED_FIELD', `${label} 的 ${key} 不可由管理助手改变。`, 403)
}
function reportedEnable(profile, id) {
  return profile.migrationReport?.changes?.some(change => object(change) && (change.entryId === id || change.id === id) && change.enabled === true && nonempty(change.reason)) === true
}
function preserveReport(before, after) {
  if (!before) return
  if (!object(after)) fail('MIGRATION_REPORT_REQUIRED', '保存必须保留原迁移报告和诊断。', 403)
  for (const key of ['source', 'validation']) if (!same(before[key], after[key])) fail('SOURCE_IMMUTABLE', '迁移报告的来源与验证范围不可改写。', 403)
  for (const key of ['diagnostics', 'blocked']) {
    if ((before[key] ?? []).some(item => !(after[key] ?? []).some(next => same(item, next)))) fail('MIGRATION_REPORT_REQUIRED', '不可清空原迁移诊断或阻塞项来标记就绪。', 403)
  }
}

/** Keep owner policy and immutable source relationships while editing a derived profile. */
export function checkProfileProtection(before, after, { binding = false } = {}) {
  const previous = records(before.entries, '原预设'), next = records(after.entries, '新预设')
  if (after.migrationReport !== undefined && (!object(after.migrationReport) || ['changes', 'diagnostics', 'blocked'].some(key => after.migrationReport[key] !== undefined && !Array.isArray(after.migrationReport[key])))) fail('INVALID_ARGUMENTS', '迁移报告必须为对象，changes/diagnostics/blocked 必须为数组。')
  if (!binding) {
    if (before.id !== after.id || before.version !== after.version) fail('PROFILE_VERSION_CONFLICT', '请读取当前预设版本后再保存。', 409)
    immutableFields(before, after, ['name', 'status', 'entries', 'migrationReport'], '预设')
    preserveReport(before.migrationReport, after.migrationReport)
  }
  for (const [id, original] of previous) {
    const changed = next.get(id)
    if (!changed) {
      if (original.locked || original.required) fail(original.locked ? 'ENTRY_LOCKED' : 'ENTRY_REQUIRED', `受保护模块 ${id} 不能删除。`, 403)
      continue
    }
    if ((original.locked ?? false) !== (changed.locked ?? false) || (original.required ?? false) !== (changed.required ?? false)) fail('PROTECTED_FIELD', `模块 ${id} 的 locked/required 策略不可改变。`, 403)
    if (original.locked && !same(original, changed)) fail('ENTRY_LOCKED', `锁定模块 ${id} 必须完整保留。`, 403)
    if (original.required && (changed.enabled !== true || !nonempty(changed.content))) fail('ENTRY_REQUIRED', `必用模块 ${id} 必须启用且有内容。`, 403)
    if (!same(original.source, changed.source)) fail('SOURCE_IMMUTABLE', `模块 ${id} 的来源引用不可改变。`, 403)
    if (original.enabled === false && changed.enabled !== false && !reportedEnable(after, id)) fail('DEFAULT_OFF', `模块 ${id} 原本关闭；启用需要本次用户要求及 migrationReport.changes 中含 entryId、enabled:true、reason 的记录。`, 403)
    if (!binding) immutableFields(original, changed, ['name', 'content', 'phase', 'role', 'order', 'enabled', 'marker', 'fills'], `模块 ${id}`)
  }
  for (const [id, added] of next) {
    if (previous.has(id)) continue
    if (added.locked === true || added.required === true) fail('PROTECTED_FIELD', '新增模块必须可编辑且非必用。', 403)
    const allowed = ['id', 'name', 'content', 'phase', 'role', 'order', 'enabled', 'marker', 'fills', 'locked', 'required', 'source']
    if (Object.keys(added).some(key => !allowed.includes(key))) fail('PROTECTED_FIELD', `新增模块 ${id} 含不支持字段。`, 403)
    if (added.source !== undefined) {
      if (!object(added.source) || !nonempty(added.source.entryId)) fail('SOURCE_IMMUTABLE', '拆分模块必须指向真实原模块。', 403)
      const parent = previous.get(added.source.entryId) ?? [...previous.values()].find(item => item.source?.entryId === added.source.entryId)
      if (!parent || parent.locked) fail(parent?.locked ? 'ENTRY_LOCKED' : 'SOURCE_IMMUTABLE', '拆分不能借新 ID 绕过原锁或伪造来源。', 403)
      const { splitReason: _reason, reason: _plainReason, ...source } = added.source
      if (!same(source, parent.source ?? { entryId: parent.id })) fail('SOURCE_IMMUTABLE', '拆分模块必须保留原来源映射。', 403)
      if (parent.enabled === false && added.enabled !== false && !reportedEnable(after, id)) fail('DEFAULT_OFF', '关闭模块的拆分版本必须保持关闭。', 403)
    }
  }
  if (after.status === 'ready' && (after.entries.some(entry => entry.enabled !== false && !['agent', 'render', 'shared'].includes(entry.phase)) || (after.migrationReport?.blocked?.length ?? 0) > 0)) fail('PROFILE_NOT_READY', '仍有未分类启用模块或迁移阻塞；请保留草稿并先解决。', 409)
}

export function checkDatabaseProtection(before, after) {
  if (before.id !== after.id || before.version !== after.version) fail('DATABASE_VERSION_CONFLICT', '请读取当前资料版本后再保存。', 409)
  if (Object.keys(after).some(key => !['id', 'name', 'version', 'entries'].includes(key))) fail('PROTECTED_FIELD', '资料库只允许 owner 支持的字段，不能更改来源或 provenance。', 403)
  const previous = records(before.entries, '原资料'), next = records(after.entries, '新资料')
  for (const [id, original] of previous) {
    const changed = next.get(id)
    if (!changed) {
      if (original.readOnly || ['disabled', 'required'].includes(original.mode)) fail(original.readOnly ? 'READ_ONLY' : original.mode === 'disabled' ? 'DISABLED' : 'REQUIRED', `受保护资料 ${id} 不能删除。`, 403)
      continue
    }
    if ((original.readOnly ?? false) !== (changed.readOnly ?? false) || (original.mode ?? 'auto') !== (changed.mode ?? 'auto')) fail('PROTECTED_FIELD', `资料 ${id} 的 readOnly/mode 策略不可改变。`, 403)
    if ((original.readOnly || original.mode === 'disabled') && !same(original, changed)) fail(original.readOnly ? 'READ_ONLY' : 'DISABLED', `资料 ${id} 必须完整保留。`, 403)
    immutableFields(original, changed, ['title', 'content', 'keywords', 'tags', 'notes'], `资料 ${id}`)
  }
  for (const [id, added] of next) if (!previous.has(id)) {
    if (added.readOnly === true || added.mode !== undefined && added.mode !== 'auto' || added.version !== undefined && added.version !== 1 || added.provenance !== undefined) fail('PROTECTED_FIELD', '新增资料必须 unlocked/auto、version 1，不能伪造文档 provenance。', 403)
    if (Object.keys(added).some(key => !['id', 'title', 'content', 'keywords', 'tags', 'notes', 'readOnly', 'mode', 'version'].includes(key))) fail('PROTECTED_FIELD', '新增资料含不支持字段。', 403)
  }
}

export function checkRevision(actual, expected) {
  if (actual !== expected) fail('REVISION_CONFLICT', '对象或绑定已改变，请读取最新 revision 后重试。', 409)
}
