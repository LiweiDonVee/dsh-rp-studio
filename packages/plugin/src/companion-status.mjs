export const COMPANION_PRESET_ID = 'rp-companion'
export const COMPANION_TOOL_NAMES = Object.freeze(['rp_companion_inspect', 'rp_companion_apply', 'rp_companion_import_file'])
const owners = { storyKit: 'rpStoryKit', database: 'rpDatabase', lastStep: 'rpLastStep', context: 'rpContext', gm: 'rpGM', loop: 'loopStudio' }

export async function companionStatus(ctx) {
  const services = Object.fromEntries(Object.entries(owners).map(([key, name]) => [key, Boolean(ctx.get(name))]))
  let reason
  try {
    const registry = ctx.get('agentPresets')
    if (typeof registry?.resolve !== 'function') reason = '宿主未提供 Agent Preset 注册表。'
    else {
      const preset = await registry.resolve(COMPANION_PRESET_ID)
      if (preset.broken) reason = `RP 助手预设无法加载：${preset.broken}`
      else if (preset.id !== COMPANION_PRESET_ID) reason = '宿主返回了不同的 Agent Preset。'
    }
  } catch (error) {
    reason = error?.code === 'agent-preset/not-found' ? 'RP 助手预设尚未安装，请重新安装或启用 RP Studio。' : `无法检查 RP 助手预设：${error?.message || String(error)}`
  }
  return { schemaVersion: 1, presetId: COMPANION_PRESET_ID, available: !reason, ...(reason ? { reason } : {}), tools: reason ? [] : [...COMPANION_TOOL_NAMES], owners: services }
}

export function createCompanionStatusRoute(ctx) {
  let stopped = false
  const fail = (status, code, message) => Response.json({ error: { code, message } }, { status, headers: { 'cache-control': 'no-store' } })
  return {
    async request(request) {
      if (stopped) return fail(503, 'UNAVAILABLE', 'RP Studio 已停用。')
      let input
      try { input = await request.json() } catch { return fail(400, 'INVALID_REQUEST', '需要 JSON 状态请求。') }
      if (!input || Array.isArray(input) || input.action !== 'status' || Object.keys(input).some(key => key !== 'action')) return fail(400, 'INVALID_REQUEST', '仅支持 RP 助手状态查询。')
      request.signal.throwIfAborted()
      return Response.json(await companionStatus(ctx), { headers: { 'cache-control': 'no-store' } })
    },
    close() { stopped = true },
  }
}
