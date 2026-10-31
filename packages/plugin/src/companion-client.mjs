export const COMPANION_PRESET_ID = 'rp-companion'
const ownerKeys = ['storyKit', 'database', 'lastStep', 'context', 'gm', 'loop']
const toolNames = ['rp_companion_inspect', 'rp_companion_apply', 'rp_companion_import_file']

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
export function openCompanionSession(ctx, { targetSessionId } = {}) {
  if (typeof ctx?.uiWorkspace?.startSession !== 'function') throw new Error('宿主未提供 RP 助手会话入口。')
  if (targetSessionId !== undefined && (typeof targetSessionId !== 'string' || !targetSessionId.trim() || targetSessionId.length > 256)) throw new Error('目标故事 ID 无效。')
  const prompt = '请先检查 RP 插件能力，再帮助我管理角色、资料、写作预设和流程模型；修改前读取当前版本，完成后读回验证。'
    + (targetSessionId ? `\n本次明确的目标故事会话 ID：${JSON.stringify(targetSessionId)}。管理会话本身不是目标故事。` : '\n本次尚未指定目标故事；涉及已有故事的操作前，请先确认目标会话 ID。')
  ctx.uiWorkspace.startSession(undefined, { agentPreset: COMPANION_PRESET_ID, prompt, whenDraftExists: 'append' })
}
