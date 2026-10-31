import { extname, basename } from 'node:path'
import { APPLY, INSPECT, CompanionError, fail, object, supported, validateFileInput, validateOperation } from './companion-contract.mjs'
import { checkDatabaseProtection, checkProfileProtection, checkRevision } from './companion-guards.mjs'
import { COMPANION_PRESET_ID } from './companion-status.mjs'

const OWNER_NAMES = ['rpStoryKit', 'rpDatabase', 'rpLastStep', 'rpContext', 'rpGM', 'loopStudio']
const textBytes = 8_000_000, binaryBytes = 24_000_000
const decode = bytes => {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }
  catch { return fail('INVALID_UTF8', '导入文本必须是完整有效的 UTF-8。') }
}
export function companionError(error) {
  return { code: typeof error?.code === 'string' ? error.code : error?.name === 'AbortError' ? 'CANCELLED' : 'UNAVAILABLE', message: error?.message || String(error), ...(Number.isInteger(error?.status) ? { status: error.status } : {}), ...(Array.isArray(error?.diagnostics) ? { diagnostics: error.diagnostics } : {}), ...(typeof error?.entryId === 'string' ? { entryId: error.entryId } : {}) }
}
function withoutBinary(value, omitted, path = 'result') {
  if (Array.isArray(value)) return value.map((item, index) => withoutBinary(item, omitted, `${path}.${index}`))
  if (!object(value)) return value
  return Object.fromEntries(Object.entries(value).filter(([key, item]) => { if (key === 'dataBase64') { omitted.push(`${path}.${key}`); return false } return item !== undefined }).map(([key, item]) => [key, withoutBinary(item, omitted, `${path}.${key}`)]))
}
function receipt(operation, input, result, extra = {}) {
  const omitted = [], projected = withoutBinary(result, omitted)
  const target = Object.fromEntries(['sessionId', 'assetId', 'profileId', 'databaseId', 'launchId'].filter(key => input[key] !== undefined).map(key => [key, input[key]]))
  for (const key of ['character', 'persona', 'profile', 'database']) if (object(input[key]) && input[key].id) target[`${key}Id`] = input[key].id
  return { domain: operation.split('.')[0], operation, target, result: projected, ...(omitted.length ? { binaryFieldsOmitted: omitted } : {}), ...withoutBinary(extra, omitted, 'details') }
}

/** All calls are scoped to the retained real preset, then to existing authorized Sessions. */
export function createCompanionBridge(ctx, { approveEscalation } = {}) {
  const life = new AbortController()
  const get = name => ctx.get(name)
  function scope(exec) {
    life.signal.throwIfAborted()
    exec.signal.throwIfAborted()
    const agent = exec.agent, registry = get('agentPresets')
    if (!agent || get('agents')?.get(agent.id) !== agent || typeof registry?.inspectCompositions !== 'function'
      || !registry.inspectCompositions(agent.ctx).some(item => item.id === COMPANION_PRESET_ID)) fail('COMPANION_SCOPE_REQUIRED', '管理工具仅供真实 RP 助手会话使用。', 403)
    return { agent, signal: AbortSignal.any([exec.signal, life.signal]) }
  }
  async function authorize(sessionId, signal) {
    signal.throwIfAborted()
    const gateway = get('typertGateway'), peer = get('connection')?.browserPeer
    if (typeof gateway?.stream !== 'function' || !peer) fail('CAPABILITY_UNAVAILABLE', '宿主未提供授权的会话读取。', 503)
    let iterator
    try {
      const stream = await gateway.stream({ namespace: 'session', method: 'follow', args: { request: { address: { kind: 'session', sessionId }, maxMessages: 1 } }, peer, signal })
      iterator = stream[Symbol.asyncIterator]()
      const first = await iterator.next()
      if (first.done || first.value?.header?.id !== sessionId) fail('SESSION_NOT_FOUND', '找不到指定的目标会话。', 404)
    } finally { await iterator?.return?.() }
  }
  function ownerFor(definition) {
    const owner = get(definition.owner)
    if (!supported(definition, owner)) fail('CAPABILITY_UNAVAILABLE', `需要已启用且兼容的 ${definition.owner}.${definition.method}。`, 503)
    return owner
  }
  async function permit(exec, operation, input, signal) {
    const policy = get('sandboxPolicy')?.resolve({ session: exec.agent.session })
    if (!policy || typeof approveEscalation !== 'function') fail('CAPABILITY_UNAVAILABLE', '宿主未提供正式 RP 管理权限机制。', 503)
    // Match plugin_manager's per-call native escalation. This never changes a Session's policy.
    const target = { ...input }
    for (const key of ['rawText', 'dataBase64', 'text', 'pack', 'character', 'persona', 'profile', 'database', 'initialScene', 'initialFacts']) {
      if (target[key] === undefined) continue
      const value = target[key]
      target[key] = object(value) ? Object.fromEntries(['id', 'version', 'name', 'profileId', 'assetId'].filter(field => value[field] !== undefined).map(field => [field, value[field]])) : `[${typeof value === 'string' ? value.length : 'data'} characters]`
    }
    try {
      await approveEscalation({ requestedMode: 'danger-full-access', effectiveMode: policy.mode, subject: 'RP management operation', justification: `RP 管理 ${operation} ${JSON.stringify(target)}。RP app-data 变更保存在工作区外，可能影响目标故事或多个会话；仅批准本次固定操作。` }, { approver: get('approval'), agent: exec.agent, callId: exec.callId, toolName: exec.name ?? 'rp_companion_apply', signal })
    } catch (error) {
      signal.throwIfAborted()
      if (error?.code) throw error
      fail(/rejected/iu.test(error.message) ? 'PERMISSION_DENIED' : /cancelled/iu.test(error.message) ? 'CANCELLED' : 'APPROVAL_UNAVAILABLE', error.message, 403)
    }
    signal.throwIfAborted()
  }
  async function overview(sessionId, agent, signal) {
    const owners = Object.fromEntries(OWNER_NAMES.map(name => { const owner = get(name); return [name, { available: !!owner, apiVersion: typeof owner?.apiVersion === 'number' ? owner.apiVersion : null }] }))
    const operations = Object.fromEntries([['inspect', INSPECT], ['apply', APPLY]].map(([kind, table]) => [kind, Object.fromEntries(Object.entries(table).map(([operation, definition]) => [operation, { available: definition.owner === null || supported(definition, get(definition.owner)), required: Object.keys(definition.required), optional: Object.keys(definition.optional) }]))]))
    const results = {}
    const read = async (name, run) => {
      try { results[name] = { available: true, value: await run() } }
      catch (error) { signal.throwIfAborted(); results[name] = { available: false, error: companionError(error) } }
    }
    await read('assets', async () => INSPECT['assets.state'].run(ownerFor(INSPECT['assets.state']), {}, signal))
    await read('database', async () => {
      const state = await INSPECT['database.state'].run(ownerFor(INSPECT['database.state']), sessionId ? { sessionId } : {}, signal)
      return { revision: state.revision, databases: (state.databases ?? []).map(item => ({ id: item.id, name: item.name, version: item.version, sourceId: item.sourceId, entryCount: item.entries?.length })), binding: state.binding?.binding ?? (state.binding ? { databaseId: state.binding.databaseId, version: state.binding.version } : null), capabilities: state.capabilities, retrieval: state.retrieval }
    })
    await read('presets', async () => {
      const state = await INSPECT['presets.state'].run(ownerFor(INSPECT['presets.state']), { sessionId: sessionId ?? agent.session.id }, signal)
      return { revision: state.revision, profiles: state.profiles, binding: state.binding, capabilities: state.capabilities, ...(sessionId ? {} : { librarySessionId: agent.session.id }) }
    })
    if (sessionId) {
      await read('story', async () => { const owner = ownerFor(INSPECT['story.state']); return { binding: typeof owner.binding === 'function' ? await owner.binding({ sessionId, signal }) : null, state: await owner.storyState({ sessionId, signal }) } })
      await read('context', async () => { const state = await INSPECT['context.state'].run(ownerFor(INSPECT['context.state']), { sessionId }, signal); return { revision: state.revision, settings: state.settings, historyCount: state.history?.length ?? 0, historyError: state.historyError, scope: state.scope } })
      await read('routes', async () => { const state = await INSPECT['routes.inspect'].run(ownerFor(INSPECT['routes.inspect']), { sessionId }, signal); return { revision: state.revision, selectedPresetId: state.selectedPresetId, effectivePolicy: state.effectivePolicy, routingCapability: state.routingCapability, diagnostics: state.diagnostics, models: state.models, graph: state.graph } })
    }
    return { schemaVersion: 1, owners, operations, ...results }
  }
  async function profileSave(owner, input, signal) {
    const current = await owner.profile({ profileId: input.profile.id }, signal)
    checkRevision(current.revision, input.expectedRevision)
    checkProfileProtection(current.profile, input.profile)
    if (input.profile.status === 'ready') await readyProfile(owner, input.profile, signal)
  }
  async function readyProfile(owner, profile, signal) {
    if (profile.status !== 'ready') fail('PROFILE_NOT_READY', '请选择已审阅并保存就绪的预设版本。', 409)
    for (const phase of ['agent', 'render']) {
      const preview = await owner.preview({ profile, phase }, signal)
      if (preview.blocked || preview.diagnostics?.some(item => item.severity === 'error')) fail('PROFILE_NOT_READY', '预设编译仍有阻塞，请保留草稿并查看 agent/render 预览。', 409)
    }
  }
  async function beforeApply(operation, owner, input, signal) {
    const extra = {}
    if (operation === 'presets.save') await profileSave(owner, input, signal)
    if (operation === 'database.save') {
      const current = await owner.database({ databaseId: input.database.id, signal })
      checkRevision(current.revision, input.expectedRevision)
      checkDatabaseProtection(current.database, input.database)
    }
    if (operation === 'presets.bind') {
      const selected = await owner.profile({ profileId: input.profileId, version: input.version }, signal)
      checkRevision(selected.revision, input.expectedRevision)
      await readyProfile(owner, selected.profile, signal)
      const state = await owner.state(input.sessionId, signal)
      checkRevision(state.revision, input.expectedRevision)
      if (state.binding) {
        const previous = await owner.profile({ profileId: state.binding.profileId, version: state.binding.version }, signal)
        if (previous.profile.sourceId && previous.profile.sourceId === selected.profile.sourceId) checkProfileProtection(previous.profile, selected.profile, { binding: true })
      }
      extra.transition = { previous: state.binding ? { profileId: state.binding.profileId, version: state.binding.version } : null, next: { profileId: input.profileId, version: input.version } }
    }
    if (operation === 'database.bindSources') {
      const previous = await owner.state({ sessionId: input.sessionId, signal })
      checkRevision(previous.revision, input.expectedRevision)
      const binding = previous.binding?.binding ?? previous.binding
      extra.transition = { previous: binding ? { sources: binding.sources ?? (binding.databaseId ? [{ key: 'legacy', databaseId: binding.databaseId, version: binding.version }] : []) } : null, next: { sources: input.sources, resetOverlay: false } }
    }
    if (operation === 'assets.importPack') {
      if (typeof owner.previewPack !== 'function') fail('CAPABILITY_UNAVAILABLE', 'Story Kit 缺少内容包预检。', 503)
      extra.preview = await owner.previewPack({ pack: input.pack, signal })
    }
    if (['assets.saveCharacter', 'assets.savePersona'].includes(operation)) {
      const kind = operation === 'assets.saveCharacter' ? 'character' : 'persona', asset = input[kind]
      const current = await owner.asset({ kind, assetId: asset.id, signal })
      checkRevision(current.revision, input.expectedRevision)
      if (current.asset.version !== asset.version) fail('ASSET_VERSION_CONFLICT', '请先读取当前资产版本。', 409)
      if (current.asset.sourceId !== asset.sourceId) fail('SOURCE_IMMUTABLE', '资产原件的来源引用不可改写。', 403)
    }
    return extra
  }
  async function perform(operation, definition, input, exec, signal, alreadyPermitted = false) {
    const owner = ownerFor(definition)
    if (input.sessionId) await authorize(input.sessionId, signal)
    const extra = await beforeApply(operation, owner, input, signal)
    if (!alreadyPermitted) await permit(exec, operation, { ...input, ...(extra.transition ? { bindingTransition: extra.transition } : {}) }, signal)
    signal.throwIfAborted()
    const result = await definition.run(owner, input, signal)
    return receipt(operation, input, result, extra)
  }
  return {
    async inspect(args, exec) {
      const { agent, signal } = scope(exec)
      const { definition, input } = validateOperation(INSPECT, args)
      if (args.operation === 'presets.state' && input.sessionId === undefined) input.sessionId = agent.session.id
      if (input.sessionId) await authorize(input.sessionId, signal)
      const result = args.operation === 'overview' ? await overview(input.sessionId, agent, signal) : await definition.run(ownerFor(definition), input, signal)
      return receipt(args.operation, input, result)
    },
    async apply(args, exec) {
      const { signal } = scope(exec)
      const { definition, input } = validateOperation(APPLY, args)
      return perform(args.operation, definition, input, exec, signal)
    },
    async importFile(args, exec) {
      const { agent, signal } = scope(exec)
      validateFileInput(args)
      const input = structuredClone(args)
      const extension = extname(input.path).toLowerCase()
      const formats = { character: ['.json', '.png'], worldbook: ['.json'], preset: ['.json'], document: ['.txt', '.md', '.markdown', '.pdf'], 'content-pack': ['.json'] }
      if (!formats[input.kind].includes(extension)) fail(extension === '.zip' ? 'UNSUPPORTED_ZIP' : 'UNSUPPORTED_FORMAT', '不支持此文件格式；请提供原始 JSON/角色 PNG，或 TXT/Markdown/PDF 资料。')
      const operation = { character: 'assets.import', worldbook: 'database.import', preset: 'presets.import', document: 'database.importDocument', 'content-pack': 'assets.importPack' }[input.kind]
      const definition = APPLY[operation]
      ownerFor(definition)
      await permit(exec, `import_file.${input.kind}`, input, signal)
      const fs = get('fs'), directory = get('workingDirectory')
      if (!fs || typeof directory?.ensure !== 'function') fail('CAPABILITY_UNAVAILABLE', '宿主未提供正式文件读取服务。', 503)
      const cwd = await directory.ensure(agent, signal)
      const target = await fs.resolve(input.path, { cwd, signal }), info = await fs.stat(target, signal)
      if (!info) { ctx.emit('fs/observed', target, { kind: 'absent' }, exec); fail('FS_NOT_FOUND', '找不到导入文件。', 404) }
      if (info.type !== 'file') fail('FS_NOT_REGULAR_FILE', '只能导入普通文件。')
      const maxBytes = ['.png', '.pdf'].includes(extension) ? binaryBytes : textBytes
      if (info.size > maxBytes) fail('FILE_TOO_LARGE', `文件超过工具上限 ${maxBytes} bytes；原件未被截断。`)
      const bytes = await fs.readBytes(target, signal, maxBytes)
      if (bytes.byteLength > maxBytes) fail('FILE_TOO_LARGE', '文件超过工具上限；原件未被截断。')
      ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)
      const common = { expectedRevision: input.expectedRevision, ...(input.name === undefined ? {} : { name: input.name }) }
      let dto
      if (input.kind === 'character') dto = { ...common, format: extension === '.png' ? 'png' : 'json', ...(extension === '.png' ? { dataBase64: Buffer.from(bytes).toString('base64') } : { rawText: decode(bytes) }) }
      else if (['worldbook', 'preset'].includes(input.kind)) dto = { ...common, rawText: decode(bytes), ...(input.orderCharacterId === undefined ? {} : { orderCharacterId: input.orderCharacterId }) }
      else if (input.kind === 'document') {
        const mimeType = extension === '.pdf' ? 'application/pdf' : extension === '.txt' ? 'text/plain' : 'text/markdown'
        if (mimeType === 'application/pdf' && Buffer.from(bytes).subarray(0, 5).toString('ascii') !== '%PDF-') fail('INVALID_DOCUMENT', 'PDF 原件缺少有效文件头。')
        if (mimeType !== 'application/pdf') decode(bytes)
        dto = { ...common, name: input.name ?? basename(input.path), mimeType, requestId: input.requestId, dataBase64: Buffer.from(bytes).toString('base64') }
      } else {
        let pack
        try { pack = JSON.parse(decode(bytes).replace(/^\uFEFF/u, '')) } catch (error) { if (error instanceof CompanionError) throw error; fail('INVALID_JSON', '内容包不是有效 JSON。') }
        dto = { pack, expectedRevision: input.expectedRevision }
      }
      const { input: checked } = validateOperation(APPLY, { operation, input: dto })
      const result = await perform(operation, definition, checked, exec, signal, true)
      return { ...result, file: { kind: input.kind, path: target.displayPath, bytes: bytes.byteLength } }
    },
    close() { life.abort() },
  }
}
