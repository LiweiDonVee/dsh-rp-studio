import { fullNarrativeRef, narrativeRefFields, validNarrativeRef } from './reading-state.mjs'

export const COMPANION_PRESET_ID = 'rp-companion'
export const EXTERNAL_CONVERSATION_HINT = '进入 RP 助手后，可附 SillyTavern JSONL、TXT、Markdown 或粘贴会话。'
export const EXTERNAL_CONVERSATION_PROMPT = '请把随附外部 RP 会话转成可开局 DSH RP 资产，必要时先问我关键取舍。\n可附 SillyTavern JSONL、TXT、Markdown，或直接粘贴会话。'
const ownerKeys = ['storyKit', 'database', 'lastStep', 'context', 'gm', 'loop']
const toolNames = ['rp_companion_inspect', 'rp_companion_apply', 'rp_companion_import_file']
const workspaceRegistrations = new WeakMap()
const directoryKey = path => {
  const normalized = path.replaceAll('\\', '/').replace(/\/+$/u, '')
  return /^[A-Za-z]:\//u.test(normalized) || normalized.startsWith('//') ? normalized.toLowerCase() : normalized
}

/** Read the installed preset's actual Host activation state. */
export async function readCompanionStatus({ signal } = {}) {
  const response = await fetch(new URL('api/rp-studio/companion', document.baseURI), {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal,
    body: JSON.stringify({ action: 'status' }),
  })
  const value = await response.json()
  if (!response.ok || value?.error) throw new Error(value?.error?.message || '无法检查 RP 助手，请确认 Studio 已启用。')
  if (value?.schemaVersion !== 1 || value.presetId !== COMPANION_PRESET_ID || typeof value.available !== 'boolean'
    || !Array.isArray(value.tools) || value.tools.some(name => !toolNames.includes(name)) || new Set(value.tools).size !== value.tools.length
    || value.available && value.tools.length !== toolNames.length || !value.available && (typeof value.reason !== 'string' || !value.reason.trim())
    || value.reason !== undefined && typeof value.reason !== 'string'
    || !value.owners || typeof value.owners !== 'object' || Array.isArray(value.owners) || ownerKeys.some(key => typeof value.owners[key] !== 'boolean')
    || Object.keys(value.owners).some(key => !ownerKeys.includes(key))) throw new Error('RP 助手状态响应无效，请检查 Studio 版本。')
  return value
}

/** Initialize an unsent management draft through the official Workspace flow. */
export function openCompanionSession(ctx, { targetSessionId, operation, basedOn, externalConversation = false, signal } = {}) {
  if (typeof ctx?.uiWorkspace?.startSession !== 'function') throw new Error('宿主未提供 RP 助手会话入口。')
  if (externalConversation) targetSessionId = undefined
  if (targetSessionId !== undefined && (typeof targetSessionId !== 'string' || !targetSessionId.trim() || targetSessionId.length > 256)) throw new Error('目标故事 ID 无效。')
  if (operation !== undefined && operation !== 'story.turnDetails') throw new Error('RP 助手操作无效。')
  if (operation === 'story.turnDetails' && (!validNarrativeRef(basedOn) || Object.keys(basedOn).length !== narrativeRefFields.length || basedOn.sessionId !== targetSessionId || basedOn.callSeq >= basedOn.baseResultSeq || basedOn.baseResultSeq > basedOn.resultSeq)) throw new Error('所选正文引用无效。')
  if (operation === undefined && basedOn !== undefined) throw new Error('所选正文需要明确的依据读取操作。')
  const prompt = (operation ? '请解释我所选这一轮正式正文的公开依据。' : externalConversation ? EXTERNAL_CONVERSATION_PROMPT : '请先检查 RP 插件能力，再帮助我管理角色、资料、写作预设和流程模型；修改前读取当前版本，完成后读回验证。')
    + (externalConversation ? '' : targetSessionId ? `\n本次明确的目标故事会话 ID：${JSON.stringify(targetSessionId)}。管理会话本身不是目标故事。` : '\n本次尚未指定目标故事；涉及已有故事的操作前，请先确认目标会话 ID。')
    + (operation ? `\n我正在询问这条正式正文的依据。请通过 rp_companion_inspect 读取以下明确操作，并用公开事实、所选资料与历史引用解释这一轮；先说明缺失证据，再讨论修改建议。不要据此修改故事或启动生成。\n${JSON.stringify({ operation, input: { sessionId: targetSessionId, basedOn: fullNarrativeRef(basedOn) } })}` : '')
  const options = { agentPreset: COMPANION_PRESET_ID, prompt, whenDraftExists: 'append' }
  const workspaces = ctx.workspaces?.list?.getSnapshot()?.items
  if (Array.isArray(workspaces)) {
    const workspace = targetSessionId ? workspaces.find(item => item.sessionIds.includes(targetSessionId)) : undefined
    if (workspace) { ctx.uiWorkspace.startSession(workspace.workspaceId, options); return }
    // rc.1 also gates a blank Conversation's composer on real Workspace membership.
    // Resolve the existing story directory before asking the native draft flow
    // to create or reuse its own blank Session.
    if (targetSessionId) return openDirectoryCompanion(ctx, { targetSessionId, options, signal })
    if (workspaces.length === 0) return openDefaultCompanion(ctx, { options, signal })
  }
  ctx.uiWorkspace.startSession(undefined, options)
}

async function openDefaultCompanion(ctx, { options, signal }) {
  if (typeof ctx.workspaces?.initializeDefault !== 'function') throw new Error('宿主未提供默认工作区入口。')
  const signals = [signal, ctx.layout?.beginNavigation?.()].filter(Boolean)
  const navigation = signals.length ? AbortSignal.any(signals) : undefined
  navigation?.throwIfAborted()
  let workspace = await ctx.workspaces.initializeDefault(navigation)
  navigation?.throwIfAborted()
  if (!workspace) {
    if (typeof ctx.uiWorkspace.pickDirectory !== 'function' || typeof ctx.workspaces.create !== 'function') throw new Error('请选择一个工作目录后再打开 RP 助手，无需先创建 RP 故事。')
    const path = await ctx.uiWorkspace.pickDirectory()
    navigation?.throwIfAborted()
    if (path === null) return
    workspace = await ctx.workspaces.create({ path })
  }
  navigation?.throwIfAborted()
  ctx.uiWorkspace.startSession(workspace.workspaceId, options)
}

async function openDirectoryCompanion(ctx, { targetSessionId, options, signal }) {
  if (typeof ctx.workspaces?.create !== 'function') throw new Error('宿主未提供故事目录的工作区登记入口。')
  const cwd = targetSessionId ? ctx.sessions?.list?.getSnapshot()?.byId[targetSessionId]?.cwd : undefined
  if (typeof cwd !== 'string' || !cwd.trim()) throw new Error('无法读取目标故事的工作目录，请选择故事或工作区后重试。')
  const signals = [signal, ctx.layout?.beginNavigation?.()].filter(Boolean)
  const navigation = signals.length ? AbortSignal.any(signals) : undefined
  navigation?.throwIfAborted()
  const key = directoryKey(cwd)
  let workspace = ctx.workspaces.list.getSnapshot().items.find(item => directoryKey(item.path) === key)
  if (!workspace) {
    let pending = workspaceRegistrations.get(ctx)
    if (!pending) { pending = new Map(); workspaceRegistrations.set(ctx, pending) }
    let registration = pending.get(key)
    if (!registration) {
      registration = Promise.resolve().then(() => ctx.workspaces.create({ path: cwd })).finally(() => { if (pending.get(key) === registration) pending.delete(key) })
      pending.set(key, registration)
    }
    workspace = await registration
  }
  navigation?.throwIfAborted()
  ctx.uiWorkspace.startSession(workspace.workspaceId, options)
}
