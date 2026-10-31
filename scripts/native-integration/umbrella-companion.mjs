import { mkdir, readFile, writeFile, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { syntheticStoryData } from './data-fixtures.mjs'
import { MIXED_FACT_TEXT, MIXED_PROSE_TEXT } from './umbrella-fixture.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const assert = (condition, detail) => { if (!condition) throw new Error(detail) }
const names = ['rp_companion_inspect', 'rp_companion_apply', 'rp_companion_import_file']
const messageText = message => typeof message?.content === 'string' ? message.content : (message?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n')
const valueOf = outcome => {
  if (outcome?.value !== undefined) return outcome.value
  const text = messageText(outcome?.message ?? outcome)
  try { return JSON.parse(text) } catch { return { text } }
}

async function files(out) {
  const data = syntheticStoryData(), directory = join(out, 'synthetic-sources')
  await mkdir(directory)
  const v3 = JSON.parse(data.cardJson); v3.spec = 'chara_card_v3'; v3.spec_version = '3.0'; v3.data.name = '合成 V3 雾港角色'
  const preset = JSON.stringify({ name: '合成 RP 分阶段迁移预设', prompts: [
    { identifier: 'simulation', name: '事实与剧情处理', role: 'system', content: 'Resolve facts and protect player agency before writing prose.' },
    { identifier: 'writer', name: '正文表现', role: 'system', content: 'Write the visible consequences of accepted facts in clear Chinese prose.' },
    { identifier: 'mixed', name: '混合剧情与正文职责', role: 'system', content: `${MIXED_FACT_TEXT}\n${MIXED_PROSE_TEXT}` },
    { identifier: 'default-off', name: '默认关闭模块', role: 'system', content: 'OFF_PRESET_SENTINEL {{unsupported_disabled_macro}}' },
  ], prompt_order: [{ character_id: 100001, order: [{ identifier: 'simulation', enabled: true }, { identifier: 'mixed', enabled: true }, { identifier: 'writer', enabled: true }, { identifier: 'default-off', enabled: false }] }] })
  const entries = { 'character-v2.json': Buffer.from(data.cardJson), 'character-v3.json': Buffer.from(JSON.stringify(v3)), 'original-character.png': data.png, 'worldbook.json': Buffer.from(data.worldJson), 'reference.md': data.documents[1].bytes, 'writing-preset.json': Buffer.from(preset), 'unsupported.zip': Buffer.from('PK\x03\x04Synthetic unsupported ZIP acceptance fixture'), 'oversized.json': Buffer.alloc(25_000_001, 32) }
  const manifest = {}
  for (const [name, bytes] of Object.entries(entries)) {
    const path = join(directory, name)
    await writeFile(path, bytes, { flag: 'wx' })
    manifest[name] = { path, bytes: bytes.length, sha256: hash(bytes) }
  }
  return { data, manifest }
}

export async function nativeCompanion({ page, report, out, scenario, shot, request, probe, restart }) {
  const synthetic = await files(out), state = { toolCalls: [], mutations: [], negatives: [], sourceFiles: synthetic.manifest }
  state.evidenceBoundary = { positive: 'The deterministic local model emits genuine calls in the native agent loop; installed owners execute each operation.', negatives: 'Protection and DTO negatives use real scoped ToolRuntime.execute. Permission denial uses a model-originated call and native approval UI.', migration: 'The human owner sets the synthetic agent lock and required/default-off policy. The deterministic migration model classifies an unclassified writer, changes a mixed module to simulation-only, and splits its prose instructions into a source-linked render module through the real migration path. This checks dispatch, responsibility changes, preservation, review and persistence, without evaluating general semantic migration or prose quality.' }
  report.companion = state
  const owner = (name, action, input = {}) => request(`/api/rp-${name}/request`, { action: name === 'gm' && action === 'storyState' ? 'state' : action, ...input })
  const inspect = async (operation, input = {}) => (await call('rp_companion_inspect', { operation, input })).result
  const apply = async (operation, input) => {
    const result = await call('rp_companion_apply', { operation, input })
    state.mutations.push({ operation, input, receipt: result })
    return result.result
  }
  const fileImport = async (kind, filename, expectedRevision, extra = {}) => {
    const input = { kind, path: synthetic.manifest[filename].path, expectedRevision, ...extra }
    const result = await call('rp_companion_import_file', input)
    state.mutations.push({ operation: result.operation, input, receipt: result })
    return result.result
  }
  let managerId, character, persona, profile, world, launchedId

  async function call(name, args, allowError = false) {
    assert(managerId, 'Real management session unavailable')
    const before = await probe('snapshot', { sessionId: managerId }), seq = before.events.at(-1)?.seq ?? -1
    await probe('enqueue', { name, arguments: args })
    await probe('prompt', { sessionId: managerId, text: `执行已明确授权的合成验收步骤：${name} ${args.operation ?? args.kind}；仅使用当前已排队的一次真实工具调用。` })
    const after = await probe('idle', { sessionId: managerId })
    const event = after.events.find(row => row.seq > seq && row.type === 'tool/call' && row.data?.name === name)
    assert(event, `No real model tool/call: ${name}`)
    const result = after.events.find(row => row.seq > event.seq && row.type === 'tool/result' && row.data?.message?.toolCallId === event.data.callId)
    assert(result, `No matching native tool/result: ${name}`)
    const value = valueOf(result.data.message)
    state.toolCalls.push({ name, arguments: args, call: event, result, value })
    if (allowError && result.data.message.isError === true) return { isError: true, value, message: result.data.message }
    assert(result.data.message.isError !== true && !value.error, `Real tool failure ${name}: ${JSON.stringify(value)}`)
    assert(value.operation && Object.hasOwn(value, 'result'), `Missing genuine owner receipt: ${name}`)
    return value
  }
  async function reject(label, name, args, allowedCodes, beforeRead) {
    const before = beforeRead ? await beforeRead() : undefined
    const outcome = await probe('tool', { sessionId: managerId, name, arguments: args })
    const value = valueOf(outcome)
    const error = value.error ?? outcome.error
    const code = error?.code ?? value.code ?? outcome.code
    const after = beforeRead ? await beforeRead() : undefined
    const row = { label, name, args, outcome, value, code, ...(beforeRead ? { before, after, unchanged: JSON.stringify(before) === JSON.stringify(after) } : {}) }
    state.negatives.push(row)
    assert(outcome.isError === true || outcome.kind === 'error' || value.error || outcome.error, `${label} unexpectedly succeeded`)
    assert(!allowedCodes || allowedCodes.includes(code), `${label} wrong error code: ${code}; ${JSON.stringify(outcome)}`)
    if (beforeRead) assert(row.unchanged, `${label} mutated the owner despite refusal`)
    return row
  }

  await scenario('companion-real-ui-preset-and-scope', async () => {
    const status = await request('/api/rp-studio/companion', { action: 'status' })
    state.status = status
    assert(status.available && status.presetId === 'rp-companion' && names.every(name => status.tools.includes(name)), 'Installed companion status is not ready')
    assert(report.ready.presets.some(row => row.id === 'rp-companion' && row.name === 'RP 助手'), 'Official preset roster lacks RP 助手')
    await probe('resume', { sessionId: report.storySessionId })
    state.ordinaryCatalog = await probe('catalog', { sessionId: report.storySessionId })
    assert(!state.ordinaryCatalog.tools.some(row => names.includes(row.name)), 'Ordinary story sees management tools')
    const trigger = page.getByRole('button', { name: 'RP', exact: true }).filter({ visible: true }).first()
    await trigger.click()
    await page.getByRole('menu', { name: 'RP 工作区菜单' }).getByRole('menuitem', { name: 'RP 助手', exact: true }).click()
    await page.getByRole('menu', { name: 'RP 工作区菜单' }).waitFor({ state: 'hidden' })
    await page.waitForFunction(target => {
      const id = window.__umbrella.contexts['dsh-rp-studio'].sidebarRight.mounted.getSnapshot()
      const editor = [...document.querySelectorAll('[data-composer-input]')].find(el => el.getBoundingClientRect().width > 0)
      return id && id !== target && editor?.innerText.includes(target)
    }, report.storySessionId)
    const editor = page.locator('[data-composer-input][contenteditable=true]').filter({ visible: true }).first()
    await editor.waitFor()
    state.unsentDraft = await editor.innerText()
    assert(state.unsentDraft.includes(report.storySessionId), 'Companion draft lost the explicit target story')
    const beforeModels = (await probe('models')).models.length
    await shot('companion-unsent-draft')
    assert((await probe('models')).models.length === beforeModels, 'Opening companion auto-sent a model request')
    await editor.press('Enter')
    await page.waitForFunction(old => { const ctx = window.__umbrella.contexts['dsh-rp-studio']; const id = ctx.sidebarRight.mounted.getSnapshot(); return id && id !== old }, report.storySessionId)
    managerId = await page.evaluate(() => window.__umbrella.contexts['dsh-rp-studio'].sidebarRight.mounted.getSnapshot())
    const real = await probe('idle', { sessionId: managerId })
    assert(real.header.agentPreset === 'rp-companion' && real.events.some(row => row.type === 'user/message'), 'No real rp-companion management session after send')
    state.managerId = managerId; state.createdSession = real.header
    state.managerCatalog = await probe('catalog', { sessionId: managerId })
    assert(names.every(name => state.managerCatalog.tools.some(row => row.name === name)), 'Management scope lacks three real tools')
    const skill = state.managerCatalog.managementSkill, installedStudio = report.installed.find(row => row.name === 'dsh-rp-studio')
    assert(skill?.path && skill.contentBytes > 1000, 'Packaged management skill missing')
    const observedPath = await realpath(skill.path), installedPath = await realpath(join(installedStudio.directory, 'skills/managing-rp-studio/SKILL.md'))
    assert(observedPath === installedPath && hash(await readFile(observedPath)) === installedStudio.files['skills/managing-rp-studio/SKILL.md'], 'Management skill does not match the actual installed archive')
    state.managementSkillArtifact = { observedPath, sha256: hash(await readFile(observedPath)), metadataSource: skill.source }
    state.overview = await inspect('overview')
    await shot('companion-overview')
  })
  if (!managerId) { state.remaining = 'not-run: no real management session was created in the first scenario'; return state }
  await scenario('companion-original-json-png-worldbook-document-imports', async () => {
    assert(managerId, 'Management session unavailable')
    state.imports = []
    for (const [kind, filename] of [['character', 'character-v2.json'], ['character', 'character-v3.json'], ['character', 'original-character.png']]) {
      const sk = await owner('story-kit', 'state'), imported = await fileImport(kind, filename, sk.revision)
      const actual = await owner('story-kit', 'asset', { kind: 'character', assetId: imported.assetId, version: imported.version })
      const source = await owner('story-kit', 'source', { sourceId: imported.sourceId })
      assert(source.source.sha256 === synthetic.manifest[filename].sha256, `${filename} source hash differs`)
      const raw = filename.endsWith('.png') ? Buffer.from(source.source.dataBase64, 'base64') : Buffer.from(source.source.rawText)
      assert(hash(raw) === synthetic.manifest[filename].sha256, 'Owner source bytes changed')
      const toolRead = await inspect('assets.asset', { kind: 'character', assetId: imported.assetId, version: imported.version })
      assert(JSON.stringify(toolRead.asset) === JSON.stringify(actual.asset), 'Tool and owner asset readback differ')
      assert(actual.asset.openings.some(row => row.text === synthetic.data.opening), 'Original opening missing')
      state.imports.push({ filename, imported, ownerAsset: actual, sourceSha256: source.source.sha256, toolRead })
      if (filename.endsWith('.png')) {
        const descriptor = imported.embeddedWorldbooks?.[0]
        assert(descriptor?.id, 'Original PNG embedded worldbook descriptor absent')
        const db = await owner('database', 'state')
        const linked = await apply('assets.importWorldbook', { assetId: imported.assetId, version: imported.version, descriptorId: descriptor.id, expectedRevision: (await owner('story-kit', 'state')).revision, expectedDatabaseRevision: db.revision })
        character = (await owner('story-kit', 'asset', { kind: 'character', assetId: imported.assetId, version: linked.version })).asset
        assert(character.databaseRefs.some(row => row.databaseId === linked.databaseRef.databaseId), 'PNG worldbook did not create real databaseRefs')
        state.embeddedWorldbook = { descriptor, linked, character }
      }
    }
    world = await fileImport('worldbook', 'worldbook.json', (await owner('database', 'state')).revision)
    const worldSource = await owner('database', 'source', { sourceId: world.sourceId })
    assert(hash(worldSource.source.rawText) === synthetic.manifest['worldbook.json'].sha256, 'Worldbook source changed')
    const document = await fileImport('document', 'reference.md', (await owner('database', 'state')).revision, { requestId: 'umbrella-document-original-request' })
    const documentRead = await owner('database', 'document', { documentId: document.documentId, version: document.version })
    assert(documentRead.document.sha256 === synthetic.manifest['reference.md'].sha256, 'Document original bytes changed')
    state.world = world; state.document = { receipt: document, readback: documentRead }
    const player = await apply('assets.createPersona', { persona: synthetic.data.persona, expectedRevision: (await owner('story-kit', 'state')).revision })
    persona = { assetId: player.assetId, version: player.version }
    state.persona = await owner('story-kit', 'asset', { kind: 'persona', ...persona })
    await page.evaluate(() => window.__umbrella.contexts['dsh-rp-studio'].sidebarRight.openTab('rp-story-kit'))
    await page.locator('.rpsk').filter({ visible: true }).getByText(character.name, { exact: true }).first().waitFor()
    await shot('companion-imported-owner-assets')
  })
  if (!character || !persona || !world) { state.remaining = 'not-run: asset import prerequisites failed'; return state }
  await scenario('companion-real-migration-review-ready-and-protection', async () => {
    const imported = await fileImport('preset', 'writing-preset.json', (await owner('last-step', 'state', { sessionId: managerId })).revision)
    const sourceProfile = await owner('last-step', 'profile', { profileId: imported.profileId, version: imported.version })
    assert(sourceProfile.profile.entries.find(row => row.id === 'mixed').phase === 'unclassified' && sourceProfile.profile.entries.find(row => row.id === 'mixed').content === `${MIXED_FACT_TEXT}\n${MIXED_PROSE_TEXT}`, 'Imported mixed source must begin unclassified with both responsibilities')
    const sourceBefore = await owner('last-step', 'source', { sourceId: sourceProfile.profile.sourceId })
    assert(hash(sourceBefore.source.rawText) === synthetic.manifest['writing-preset.json'].sha256, 'Original ST preset source mismatch')
    // Establish human owner policy through the real authenticated owner API.
    const humanPolicy = { ...sourceProfile.profile, entries: sourceProfile.profile.entries.map(row => row.id === 'simulation' ? { ...row, phase: 'agent', locked: true } : row.id === 'writer' ? { ...row, required: true } : row) }
    const policyReceipt = await owner('last-step', 'saveProfile', { profile: humanPolicy, expectedRevision: (await owner('last-step', 'state', { sessionId: managerId })).revision })
    state.humanPolicySetup = { profile: humanPolicy, receipt: policyReceipt }
    const migrated = await apply('presets.migrate', { sessionId: managerId, profileId: imported.profileId, version: policyReceipt.version, expectedRevision: (await owner('last-step', 'state', { sessionId: managerId })).revision })
    const draftRead = await owner('last-step', 'profile', { profileId: imported.profileId, version: migrated.version })
    assert(draftRead.profile.status === 'draft' && migrated.report && draftRead.profile.migrationReport, 'Real migration did not produce a review draft/report')
    assert(draftRead.profile.entries.find(row => row.id === 'writer').phase === 'render', 'Migration did not apply the deterministic writer phase update')
    assert(draftRead.profile.entries.find(row => row.id === 'mixed').phase === 'agent' && draftRead.profile.entries.find(row => row.id === 'mixed').content !== sourceProfile.profile.entries.find(row => row.id === 'mixed').content, 'Mixed module was not actually adapted')
    assert(draftRead.profile.entries.find(row => row.id === 'mixed-render')?.phase === 'render' && draftRead.profile.entries.find(row => row.id === 'mixed-render')?.source?.entryId === 'mixed' && draftRead.profile.entries.find(row => row.id === 'mixed-render')?.order === sourceProfile.profile.entries.find(row => row.id === 'mixed').order + 0.5, 'Source-linked render split missing')
    assert((await probe('models')).models.some(row => row.migration), 'Migration did not traverse the actual local LLM adapter')
    assert(draftRead.profile.entries.find(row => row.id === 'simulation').locked === true && draftRead.profile.entries.find(row => row.id === 'writer').required === true && draftRead.profile.entries.find(row => row.id === 'default-off').enabled === false, 'Migration changed lock/required/default-off policy')
    const readProfile = () => owner('last-step', 'profile', { profileId: imported.profileId })
    const latestRevision = async () => (await owner('last-step', 'state', { sessionId: managerId })).revision
    for (const [label, mutate, codes] of [
      ['locked-content', value => { value.entries.find(row => row.id === 'simulation').content += ' MUST_BE_DENIED' }, ['ENTRY_LOCKED']],
      ['required-delete', value => { value.entries = value.entries.filter(row => row.id !== 'writer') }, ['ENTRY_REQUIRED']],
      ['source-reference', value => { value.entries.find(row => row.id === 'writer').source.entryId = 'forged-source' }, ['SOURCE_IMMUTABLE']],
      ['default-off-enable', value => { value.entries.find(row => row.id === 'default-off').enabled = true }, ['DEFAULT_OFF']],
    ]) {
      const changed = structuredClone(draftRead.profile); mutate(changed)
      await reject(label, 'rp_companion_apply', { operation: 'presets.save', input: { profile: changed, expectedRevision: await latestRevision() } }, codes, async () => ({ revision: await latestRevision(), profile: await readProfile() }))
    }
    const ready = { ...draftRead.profile, status: 'ready' }
    state.previews = { agent: await inspect('presets.preview', { profile: ready, sessionId: managerId, phase: 'agent' }), render: await inspect('presets.preview', { profile: ready, sessionId: managerId, phase: 'render' }) }
    assert(!state.previews.agent.blocked && state.previews.agent.text.includes(MIXED_FACT_TEXT) && !state.previews.agent.text.includes(MIXED_PROSE_TEXT), 'Agent preview did not isolate factual responsibility')
    assert(!state.previews.render.blocked && state.previews.render.text.includes(MIXED_PROSE_TEXT) && !state.previews.render.text.includes(MIXED_FACT_TEXT), 'Render preview did not isolate prose responsibility')
    const saved = await apply('presets.save', { profile: ready, expectedRevision: await latestRevision() })
    profile = { profileId: saved.profileId, version: saved.version }
    const readyRead = await owner('last-step', 'profile', profile)
    assert(readyRead.profile.status === 'ready', 'Reviewed profile not persisted ready')
    const sourceAfter = await owner('last-step', 'source', { sourceId: readyRead.profile.sourceId })
    assert(JSON.stringify(sourceBefore) === JSON.stringify(sourceAfter), 'Migration or review mutated the immutable original source')
    state.preset = { imported, sourceHash: hash(sourceAfter.source.rawText), migrated, draft: draftRead, ready: readyRead, profile }
  })
  if (!profile) { state.remaining = 'not-run: migration/review prerequisites failed'; return state }
  await scenario('companion-launch-target-note-and-real-loop-route', async () => {
    assert(character && persona && profile && world, 'Synthetic launch dependencies unavailable')
    const launchInput = { launchId: 'umbrella-reviewed-synthetic-launch', character: { assetId: character.id, version: character.version }, persona, openingId: character.openings.find(row => row.text === synthetic.data.opening).id, sources: [...character.databaseRefs, { key: 'world', databaseId: world.databaseId, version: world.version }], profile, initialScene: { ...synthetic.data.initialScene, presentActorIds: [character.id] }, initialFacts: synthetic.data.initialFacts }
    const launched = await apply('story.launch', launchInput)
    launchedId = launched.sessionId; state.launchedId = launchedId
    assert(launchedId && launchedId !== managerId, 'Story launch did not produce a separate GM session')
    await probe('idle', { sessionId: launchedId })
    const gm = await owner('gm', 'storyState', { sessionId: launchedId }), native = await probe('snapshot', { sessionId: launchedId })
    assert(native.header.agentPreset === 'rp-gm' && gm.scene.location === synthetic.data.initialScene.location, 'Real GM launch projection mismatch')
    assert(gm.facts.items.some(row => row.id === 'letter-holder' && row.text === synthetic.data.initialFacts.items[0].text), 'Selected initial facts missing')
    const narratives = await owner('last-step', 'narratives', { sessionId: launchedId })
    assert(narratives.records.some(row => row.text === synthetic.data.opening), 'Selected opening not persisted through the native owner')
    const gmCatalog = await probe('catalog', { sessionId: launchedId })
    assert(!gmCatalog.tools.some(row => names.includes(row.name)), 'GM sees management tools')
    await apply('presets.bind', { sessionId: launchedId, ...profile, expectedRevision: (await owner('last-step', 'state', { sessionId: launchedId })).revision })
    const note = '合成验收作者注：保持角色守信，不代替玩家做决定。'
    const noteReceipt = await apply('context.setAuthorNote', { sessionId: launchedId, text: note, expectedRevision: (await owner('context', 'state', { sessionId: launchedId })).revision })
    const noteRead = await owner('context', 'authorNote', { sessionId: launchedId })
    assert(JSON.stringify(noteRead).includes(note), 'Author note not applied to the explicit story')
    const loop = await inspect('routes.inspect', { sessionId: launchedId })
    assert(loop.graph.nodes.some(row => row.id === 'rp-last-step.render' && row.control === 'route'), 'Real writer node missing')
    const routeReceipt = await apply('routes.save', { sessionId: launchedId, scope: 'session', expectedRevision: loop.revision, policy: { enabled: true, routes: { 'rp-last-step.render': { provider: 'rp-umbrella-local', model: 'umbrella' } } } })
    const loopRead = await inspect('routes.inspect', { sessionId: launchedId }), binding = await owner('last-step', 'state', { sessionId: launchedId })
    assert(loopRead.policies.session.routes['rp-last-step.render'].provider === 'rp-umbrella-local', 'Real Loop route did not persist')
    assert(binding.binding.profileId === profile.profileId && binding.binding.version === profile.version, 'Reviewed profile not bound to explicit story')
    state.launch = { input: launchInput, receipt: launched, gm, native, narratives, gmCatalog, noteReceipt, noteRead, routeReceipt, loopRead, binding }
  })
  if (!launchedId) { state.remaining = 'not-run: real story launch prerequisite failed'; return state }
  await scenario('companion-known-agent-user-macro-ready-bind', async () => {
    const revision = (await owner('last-step', 'state', { sessionId: managerId })).revision
    const created = await owner('last-step', 'createProfile', { name: '公开合成 agent 用户宏', expectedRevision: revision })
    const loaded = await owner('last-step', 'profile', { profileId: created.profileId, version: created.version })
    const ready = { ...loaded.profile, status: 'ready', entries: [{ id: 'user-agency', name: '玩家决定权', content: '保护 {{user}} 的选择，不代替玩家做决定。', role: 'system', phase: 'agent', order: 0, enabled: true, required: false, locked: false }] }
    const preview = await inspect('presets.preview', { profile: ready, phase: 'agent', variables: { user: '玩家' } })
    assert(!preview.blocked && preview.text.includes('保护 玩家 的选择'), 'Supported agent user macro did not compile under the actual runtime variables')
    const saved = await apply('presets.save', { profile: ready, expectedRevision: (await owner('last-step', 'state', { sessionId: managerId })).revision })
    const bound = await apply('presets.bind', { sessionId: report.storySessionId, profileId: saved.profileId, version: saved.version, expectedRevision: (await owner('last-step', 'state', { sessionId: report.storySessionId })).revision })
    const readback = await owner('last-step', 'state', { sessionId: report.storySessionId })
    assert(readback.binding.profileId === saved.profileId && readback.binding.version === saved.version, 'Known-macro ready profile was not bound to the explicit RP story')
    const agentContext = await probe('agentContext', { sessionId: report.storySessionId })
    assert(agentContext.text.includes('保护 玩家 的选择') && !agentContext.text.includes('{{user}}'), 'Actual LastStep agentContext did not resolve the supported user macro')
    const actual = await owner('last-step', 'profile', { profileId: saved.profileId, version: saved.version })
    const unknown = structuredClone(actual.profile); unknown.entries[0].content = '不得猜测 {{char}} 的值。'
    await reject('unknown-macro-remains-blocked', 'rp_companion_apply', { operation: 'presets.save', input: { profile: unknown, expectedRevision: readback.revision } }, ['PROFILE_NOT_READY'], async () => ({ profile: await owner('last-step', 'profile', { profileId: saved.profileId }), state: await owner('last-step', 'state', { sessionId: report.storySessionId }) }))
    const render = structuredClone(actual.profile); render.entries[0].phase = 'render'
    await reject('render-user-without-fill-remains-blocked', 'rp_companion_apply', { operation: 'presets.save', input: { profile: render, expectedRevision: (await owner('last-step', 'state', { sessionId: report.storySessionId })).revision } }, ['PROFILE_NOT_READY'], async () => ({ profile: await owner('last-step', 'profile', { profileId: saved.profileId }), state: await owner('last-step', 'state', { sessionId: report.storySessionId }) }))
    const filled = structuredClone(render); filled.entries[0].fills = { user: '已审阅旅人' }
    const filledPreview = await inspect('presets.preview', { profile: filled, phase: 'render' })
    assert(!filledPreview.blocked && filledPreview.text.includes('已审阅旅人'), 'Existing supported render fill did not compile')
    const filledSaved = await apply('presets.save', { profile: filled, expectedRevision: (await owner('last-step', 'state', { sessionId: report.storySessionId })).revision })
    const filledBound = await apply('presets.bind', { sessionId: report.storySessionId, profileId: filledSaved.profileId, version: filledSaved.version, expectedRevision: (await owner('last-step', 'state', { sessionId: report.storySessionId })).revision })
    const filledReadback = await owner('last-step', 'state', { sessionId: report.storySessionId })
    assert(filledReadback.binding.version === filledSaved.version, 'Supported render-fill ready profile did not bind')
    state.userMacro = { created, preview, saved, bound, readback, agentContext, filledPreview, filledSaved, filledBound, filledReadback }
  })
  await scenario('companion-negative-contract-and-owner-no-write', async () => {
    const skRead = () => owner('story-kit', 'state')
    await reject('unknown-operation', 'rp_companion_apply', { operation: 'arbitrary.remote', input: { url: 'https://example.invalid' } }, undefined, skRead)
    await reject('unknown-field', 'rp_companion_apply', { operation: 'assets.createPersona', input: { persona: synthetic.data.persona, expectedRevision: (await skRead()).revision, bypass: true } }, undefined, skRead)
    await reject('missing-target', 'rp_companion_inspect', { operation: 'story.state', input: { sessionId: 'umbrella-nonexistent-session' } })
    await reject('revision-conflict', 'rp_companion_apply', { operation: 'assets.createPersona', input: { persona: synthetic.data.persona, expectedRevision: 0 } }, ['REVISION_CONFLICT'], skRead)
    await reject('oversized-original', 'rp_companion_import_file', { kind: 'character', path: synthetic.manifest['oversized.json'].path, expectedRevision: (await skRead()).revision }, ['FS_TOO_LARGE', 'FILE_TOO_LARGE'], skRead)
    await reject('unsupported-zip', 'rp_companion_import_file', { kind: 'character', path: synthetic.manifest['unsupported.zip'].path, expectedRevision: (await skRead()).revision }, ['UNSUPPORTED_ZIP'], skRead)
    const database = await owner('database', 'database', { databaseId: world.databaseId })
    for (const [label, entryId, code] of [['database-readonly', 'readonly', 'READ_ONLY'], ['database-disabled', 'disabled', 'DISABLED']]) {
      const changed = structuredClone(database.database); changed.entries.find(row => row.id === entryId).content += ' MUST_BE_DENIED'
      await reject(label, 'rp_companion_apply', { operation: 'database.save', input: { database: changed, expectedRevision: (await owner('database', 'state')).revision } }, [code], async () => ({ state: await owner('database', 'state'), database: await owner('database', 'database', { databaseId: world.databaseId }) }))
    }
  })
  await scenario('companion-native-permission-rejection', async () => {
    await page.evaluate(id => window.__umbrella.contexts['dsh-rp-studio'].uiWorkspace.openSession(id), managerId)
    const switched = await page.evaluate(async id => {
      const ctx = window.__umbrella.contexts['@deepseek-ai/dsh-client-ui-conversation']
      return ctx.get('sessions').binding(id).session.command('/permission read-only')
    }, managerId)
    assert(switched.ok && switched.value.matched, 'Native permission command failed')
    const before = await owner('story-kit', 'state')
    const pending = call('rp_companion_apply', { operation: 'assets.createPersona', input: { persona: { name: 'DENIED_PERMISSION_PERSONA', description: 'Must never persist' }, expectedRevision: before.revision } }, true)
    await page.getByRole('button', { name: /^(拒绝|Reject)$/u }).filter({ visible: true }).first().click()
    const outcome = await pending, after = await owner('story-kit', 'state')
    state.permission = { switched, before, outcome, value: outcome.value, after }
    assert(outcome.isError === true || outcome.kind === 'error', 'Native permission refusal did not reach the tool')
    assert(JSON.stringify(before) === JSON.stringify(after), 'Rejected native approval wrote to the owner')
    await shot('companion-native-approval-rejected')
    await page.evaluate(async id => window.__umbrella.contexts['@deepseek-ai/dsh-client-ui-conversation'].get('sessions').binding(id).session.command('/permission danger-full-access'), managerId)
  })
  await scenario('companion-cold-owner-readback-and-scope-disposal', async () => {
    assert(launchedId && profile && character, 'Cold-readback dependencies unavailable')
    state.beforeCold = { asset: await owner('story-kit', 'asset', { kind: 'character', assetId: character.id, version: character.version }), profile: await owner('last-step', 'profile', profile), source: await owner('last-step', 'source', { sourceId: state.preset.ready.profile.sourceId }), binding: await owner('last-step', 'state', { sessionId: launchedId }), note: await owner('context', 'authorNote', { sessionId: launchedId }), loop: await request('/api/loop-studio/request', { action: 'inspect', sessionId: launchedId }), gm: await owner('gm', 'storyState', { sessionId: launchedId }) }
    await probe('flush')
    await restart('cold')
    state.coldReady = await probe('ready')
    assert((await probe('models')).models.length === 0, 'Cold inspection unexpectedly ran a model')
    state.afterCold = { asset: await owner('story-kit', 'asset', { kind: 'character', assetId: character.id, version: character.version }), profile: await owner('last-step', 'profile', profile), source: await owner('last-step', 'source', { sourceId: state.preset.ready.profile.sourceId }), binding: await owner('last-step', 'state', { sessionId: launchedId }), note: await owner('context', 'authorNote', { sessionId: launchedId }), loop: await request('/api/loop-studio/request', { action: 'inspect', sessionId: launchedId }), gm: await owner('gm', 'storyState', { sessionId: launchedId }) }
    for (const key of ['asset', 'profile', 'source', 'binding', 'note']) assert(JSON.stringify(state.beforeCold[key]) === JSON.stringify(state.afterCold[key]), `Cold owner ${key} mismatch`)
    assert(JSON.stringify(state.beforeCold.loop.policies) === JSON.stringify(state.afterCold.loop.policies), 'Cold Loop policy mismatch')
    assert(JSON.stringify(state.beforeCold.gm.facts) === JSON.stringify(state.afterCold.gm.facts), 'Cold facts mismatch')
    assert(state.coldReady.presets.some(row => row.id === 'rp-companion'), 'Companion preset disappeared on restart')
    await probe('resume', { sessionId: managerId })
    state.coldCatalog = await probe('catalog', { sessionId: managerId })
    assert(names.every(name => state.coldCatalog.tools.some(row => row.name === name)) && state.coldCatalog.managementSkill, 'Companion tool/skill did not remount cold')
    state.scopeDisposal = await probe('dispose', { sessionId: managerId })
    assert(state.scopeDisposal.live === false && !state.scopeDisposal.globalTools.some(row => names.includes(row.name)) && state.scopeDisposal.activeScopes.every(scope => !scope.tools.some(row => names.includes(row.name))), 'Disposed manager still owns a live management capability')
    const beforeRetired = { note: await owner('context', 'authorNote', { sessionId: launchedId }), revision: (await owner('context', 'state', { sessionId: launchedId })).revision }
    const retiredAttempt = await probe('retiredTool', { sessionId: managerId, arguments: { operation: 'context.setAuthorNote', input: { sessionId: launchedId, text: 'DISPOSED_SCOPE_MUST_NOT_WRITE', expectedRevision: beforeRetired.revision } } })
    const retiredCall = retiredAttempt.outcome
    const retiredValue = valueOf(retiredCall)
    const afterRetired = { note: await owner('context', 'authorNote', { sessionId: launchedId }), revision: (await owner('context', 'state', { sessionId: launchedId })).revision }
    const rejectedByHost = retiredCall.error?.code === undefined && retiredCall.error?.message === `session "${retiredAttempt.callerSessionId}" is not live in this store`
    const rejectedByCompanion = retiredValue.error?.code === 'COMPANION_SCOPE_REQUIRED'
    assert(retiredAttempt.callerSessionId === managerId && retiredAttempt.signalAbortedBefore === false && retiredAttempt.signalAbortedAfter === false, 'Disposed-caller probe did not use the saved identity with a fresh live signal')
    assert(retiredCall.isError === true && (rejectedByHost || rejectedByCompanion), 'Disposed caller was not rejected by the exact native/Companion lifecycle boundary')
    assert(JSON.stringify(beforeRetired) === JSON.stringify(afterRetired), 'Disposed caller changed the owner note or revision')
    state.disposedScopeCall = { before: beforeRetired, ...retiredAttempt, value: retiredValue, after: afterRetired, rejectedBy: rejectedByHost ? 'host-session-store' : 'companion-scope', cachedGenerationSchemaRetained: state.scopeDisposal.remainingTools.some(row => names.includes(row.name)) }
  })
  await scenario('companion-official-preset-disable-and-restore', async () => {
    const entries = await probe('companionPluginEntry')
    assert(entries.length === 1 && entries[0].entryId, 'Official plugin inventory did not provide an exact companion preset entry')
    const disabled = await probe('setCompanionPreset', { entryId: entries[0].entryId, enabled: false })
    if (disabled.application === 'restart-required') await restart('preset-disabled')
    else assert(disabled.application === 'applied', `Preset disable was not applied: ${JSON.stringify(disabled)}`)
    const resolved = await probe('resolveCompanion'), status = await request('/api/rp-studio/companion', { action: 'status' }), compositions = await probe('compositions')
    assert(!resolved.available && resolved.error.code === 'agent-preset/not-found' && !status.available && !compositions.some(row => row.id === 'rp-companion'), 'The disabled preset remains active or resolves to a fallback')
    const before = await probe('sessions'), createAttempt = await probe('createCompanionAttempt'), after = await probe('sessions')
    assert(!createAttempt.created && createAttempt.error?.code === 'agent-preset/not-found' && JSON.stringify(before.map(row => row.header.id).sort()) === JSON.stringify(after.map(row => row.header.id).sort()), 'Unavailable companion creation silently fell back or created a Session')
    const disabledEntries = await probe('companionPluginEntry')
    const enabled = await probe('setCompanionPreset', { entryId: disabledEntries[0].entryId, enabled: true })
    if (enabled.application === 'restart-required') await restart('preset-enabled')
    else assert(enabled.application === 'applied', `Preset enable was not applied: ${JSON.stringify(enabled)}`)
    const restored = await request('/api/rp-studio/companion', { action: 'status' })
    assert(restored.available, 'Official preset enable did not restore availability')
    state.presetLifecycle = { entry: entries[0], disabled, resolved, status, compositions, createAttempt, sessionIdsUnchanged: true, enabled, restored }
  })
  await scenario('companion-real-missing-owner-capability', async () => {
    await restart('missing-database', '- id: rp-database\n  disabled: true\n')
    await probe('resume', { sessionId: managerId })
    state.missingOwnerStatus = await request('/api/rp-studio/companion', { action: 'status' })
    assert(state.missingOwnerStatus.available && state.missingOwnerStatus.owners.database === false, 'Missing real owner capability was not reported')
    await reject('missing-database-owner', 'rp_companion_inspect', { operation: 'database.state', input: {} }, ['CAPABILITY_UNAVAILABLE'])
    state.missingOwnerModels = await probe('models')
    assert(state.missingOwnerModels.models.length === 0, 'Missing-owner inspection generated a model')
  })
  for (const [filename, original] of Object.entries(synthetic.manifest)) assert(hash(await readFile(original.path)) === original.sha256, `Original test file changed: ${filename}`)
  state.sourceFilesUnchanged = true
  return state
}
