import { validDependencySummary } from './dependency-summary.mjs'
import { canReadStory, canReadTurnDetails, readingPage, turnDetails, validNarrativeRef, validReadingCursor, validReadingLimit } from './turn-reading.mjs'
import { canReadMobileWorkspace, mobileWorkspace, validMobileWorkspaceInput } from './mobile-workspace.mjs'

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const id = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 256
const revision = value => Number.isSafeInteger(value) && value >= 0
const keys = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key))
const strings = value => Array.isArray(value) && value.every(item => typeof item === 'string')
const nonempty = value => typeof value === 'string' && value.trim().length > 0
const operationToken = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,256}$/u.test(value)
function validCandidate(value) {
  if (!keys(value, ['scene', 'facts', 'summary', 'packet']) || !nonempty(value.summary)) return false
  const { scene, facts, packet } = value
  return keys(scene, ['schemaVersion', 'title', 'location', 'time', 'presentActorIds']) && scene.schemaVersion === 1 && nonempty(scene.title) && nonempty(scene.location)
    && (scene.time === undefined || typeof scene.time === 'string') && strings(scene.presentActorIds) && scene.presentActorIds.every(nonempty) && new Set(scene.presentActorIds).size === scene.presentActorIds.length
    && keys(facts, ['schemaVersion', 'items']) && facts.schemaVersion === 1 && Array.isArray(facts.items) && facts.items.every(item => keys(item, ['id', 'text']) && nonempty(item.id) && nonempty(item.text)) && new Set(facts.items.map(item => item.id)).size === facts.items.length
    && keys(packet, ['playerAction', 'sceneInstruction', 'resolvedChanges', 'visibleConsequences', 'openHooks', 'proseConstraints', 'publicFactRefs', 'variables']) && nonempty(packet.playerAction)
    && (packet.sceneInstruction === undefined || typeof packet.sceneInstruction === 'string') && ['resolvedChanges', 'visibleConsequences', 'openHooks', 'proseConstraints', 'publicFactRefs'].every(key => packet[key] === undefined || strings(packet[key]))
    && (packet.variables === undefined || object(packet.variables) && Object.values(packet.variables).every(item => typeof item === 'string'))
}
function validDecision(value) {
  return keys(value, ['sessionId', 'roundId', 'candidateId', 'action', 'custom', 'operationId', 'expectedRoundVersion', 'expectedDatabaseRevision'])
    && ['sessionId', 'roundId', 'candidateId'].every(key => id(value[key])) && operationToken(value.operationId)
    && ['approve', 'custom', 'cancel'].includes(value.action) && revision(value.expectedRoundVersion) && revision(value.expectedDatabaseRevision)
    && (value.action === 'custom' ? validCandidate(value.custom) : value.custom === undefined)
}
const validRef = validNarrativeRef
const spec = (service, method, fields, run, apiVersion, capability) => ({ service, method, fields, run, apiVersion, capability })
// Each closure names its owner method. Browser JSON never supplies a target.
const actions = {
  mobileWorkspace: spec('rpGM', 'storyState', ['sessionId', 'knownProjectionKey', 'retainedRefs'], undefined, 1),
  gmState: spec('rpGM', 'storyState', ['sessionId'], (owner, args) => owner.storyState(args), 1),
  reviewState: spec('rpGM', 'reviewState', ['sessionId'], (owner, args) => owner.reviewState(args), 1, 'factReview'),
  configureReview: spec('rpGM', 'configureReview', ['sessionId', 'enabled', 'expectedRevision'], (owner, args) => owner.configureReview(args), 1, 'factReview'),
  decideFacts: spec('rpGM', 'decideFacts', ['decision'], (owner, args) => owner.decideFacts({ ...args.decision, signal: args.signal }), 1, 'factReview'),
  resumeFactDecision: spec('rpGM', 'resumeFactDecision', ['sessionId', 'operationId'], (owner, args) => owner.resumeFactDecision(args), 1, 'factReview'),
  regenerateFacts: spec('rpGM', 'regenerateFacts', ['sessionId', 'roundId', 'operationId', 'expectedRoundVersion', 'instruction'], (owner, args) => owner.regenerateFacts(args), 1, 'factRegeneration'),
  cancelFactGeneration: spec('rpGM', 'cancelFactGeneration', ['sessionId', 'jobId'], (owner, args) => owner.cancelFactGeneration(args), 1, 'factRegeneration'),
  resumeFactGeneration: spec('rpGM', 'resumeFactGeneration', ['sessionId', 'operationId'], (owner, args) => owner.resumeFactGeneration(args), 1, 'factRegeneration'),
  resumeFactPresentation: spec('rpGM', 'resumeFactPresentation', ['sessionId', 'roundId', 'operationId'], (owner, args) => owner.resumeFactPresentation(args), 1, 'factReview'),
  regenerateProse: spec('rpLastStep', 'regenerateProse', ['sessionId', 'basedOn', 'operationId', 'instruction'], (owner, args) => owner.regenerateProse(args), 1, 'narrativeRevisions'),
  storyHistory: spec('rpLastStep', 'storyHistory', ['sessionId'], (owner, args) => owner.storyHistory(args), 1, 'narrativeRevisions'),
  readingPage: { ...spec('rpLastStep', 'storyHistory', ['sessionId', 'before', 'limit'], readingPage, 1, 'narrativeRevisions'), available: canReadStory },
  turnDetails: { ...spec('rpLastStep', 'storyHistory', ['sessionId', 'basedOn'], turnDetails, 1, 'narrativeRevisions'), available: canReadTurnDetails },
  forkStory: spec('rpGM', 'forkStory', ['sessionId'], (owner, args) => owner.forkStory(args), 1),
  forkStoryAtReading: spec('rpGM', 'forkStoryAtReading', ['sessionId', 'basedOn'], (owner, args) => owner.forkStoryAtReading(args), 1, 'forkStoryAtReading'),
  suggestPlayerActions: { ...spec('rpLastStep', 'storyHistory', ['sessionId', 'basedOn', 'instruction'], undefined, 1, 'narrativeRevisions'), available: canReadTurnDetails },
  narratives: spec('rpLastStep', 'narratives', ['sessionId'], (owner, args) => owner.narratives(args)),
  presentationSummaries: spec('rpLastStep', 'presentationSummaries', ['sessionId'], (owner, args) => owner.presentationSummaries(args)),
  drafts: spec('rpLastStep', 'drafts', ['sessionId'], (owner, args) => owner.drafts(args)),
  createDraft: spec('rpLastStep', 'createDraft', ['sessionId', 'basedOn', 'instruction', 'kind', 'text'], (owner, args) => owner.createDraft(args)),
  editDraft: spec('rpLastStep', 'editDraft', ['sessionId', 'draftId', 'text', 'expectedDraftVersion'], (owner, args) => owner.editDraft(args)),
  adoptDraft: spec('rpLastStep', 'adoptDraft', ['sessionId', 'draftId', 'expectedDraftVersion', 'expectedNarrative'], (owner, args) => owner.adoptDraft(args)),
  retryPresentation: spec('rpLastStep', 'retryPresentation', ['sessionId', 'presentationId'], (owner, args) => owner.retryPresentation(args)),
  material: spec('rpLastStep', 'material', ['sessionId', 'presentationId'], (owner, args) => owner.material(args)),
  authorNote: spec('rpContext', 'authorNote', ['sessionId'], (owner, args) => owner.authorNote(args)),
  authorNoteState: spec('rpContext', 'state', ['sessionId'], async (owner, args) => {
    const state = await owner.state(args)
    if (!revision(state?.revision)) throw Object.assign(new Error('作者注的当前版本不可用。'), { code: 'AUTHOR_NOTE_UNAVAILABLE', status: 503 })
    return { schemaVersion: 1, revision: state.revision, note: state.authorNote ?? null }
  }),
  setAuthorNote: spec('rpContext', 'setAuthorNote', ['sessionId', 'text', 'expectedRevision'], (owner, args) => owner.setAuthorNote(args)),
  exportReading: spec('rpStoryKit', 'exportReading', ['sessionId', 'format'], (owner, args) => owner.exportReading(args), 1),
  exportSavedStory: spec('rpStoryKit', 'exportSavedStory', ['sessionId'], (owner, args) => owner.exportSavedStory(args), 1),
  previewSavedStory: spec('rpStoryKit', 'previewSavedStory', ['snapshot'], (owner, args) => owner.previewSavedStory(args), 1),
  restoreSavedStory: spec('rpStoryKit', 'restoreSavedStory', ['snapshot', 'restoreId'], (owner, args) => owner.restoreSavedStory(args), 1),
}
const owners = { gm: 'rpGM', storyKit: 'rpStoryKit', database: 'rpDatabase', context: 'rpContext', lastStep: 'rpLastStep', loop: 'loopStudio' }
const storyKitCapabilities = { exportReading: 'readingExport', exportSavedStory: 'savedStoryExport', previewSavedStory: 'savedStoryPreview', restoreSavedStory: 'savedStoryRestore' }
const failure = (status, code, message) => Response.json({ error: { code, message } }, { status, headers: { 'cache-control': 'no-store' } })
function validSnapshot(value) {
  const fields = ['format', 'schemaVersion', 'identityMode', 'exportedAt', 'selectedSessionId', 'sessions', 'pluginState', 'resources', 'requirements', 'loopPolicies', 'dependencySummary']
  return object(value) && Object.keys(value).every(key => fields.includes(key)) && value.format === 'dsh-rp-saved-story' && value.schemaVersion === 1 && value.identityMode === 'preserve'
    && typeof value.exportedAt === 'string' && id(value.selectedSessionId) && Array.isArray(value.sessions) && value.sessions.length > 0
    && value.sessions.every(session => object(session) && Object.keys(session).every(key => ['header', 'events', 'inheritedEventCount'].includes(key)) && object(session.header) && Array.isArray(session.events) && session.events.every(object) && revision(session.inheritedEventCount) && session.inheritedEventCount <= session.events.length)
    && object(value.pluginState) && ['database', 'lastStep', 'gm', 'storyKit'].every(key => Object.hasOwn(value.pluginState, key))
    && Object.keys(value.pluginState).every(key => ['database', 'context', 'lastStep', 'gm', 'storyKit'].includes(key))
    && Array.isArray(value.resources) && Array.isArray(value.requirements) && value.requirements.every(item => typeof item === 'string')
    && (value.dependencySummary === undefined || validDependencySummary(value.dependencySummary))
    && (value.loopPolicies === undefined || Array.isArray(value.loopPolicies) && value.loopPolicies.every(item => object(item) && Object.keys(item).every(key => ['sessionId', 'policy'].includes(key)) && id(item.sessionId) && object(item.policy)))
}
function valid(input) {
  if (!object(input) || typeof input.action !== 'string') return false
  if (input.action === 'mobileIdentity') return Object.keys(input).length === 1
  if (input.action === 'capabilities') return Object.keys(input).every(key => ['action', 'sessionId'].includes(key)) && (input.sessionId === undefined || id(input.sessionId))
  const entry = Object.hasOwn(actions, input.action) && actions[input.action]
  if (!entry || Object.keys(input).some(key => key !== 'action' && !entry.fields.includes(key))) return false
  if (input.action === 'decideFacts') return validDecision(input.decision)
  if (entry.fields.includes('sessionId') && !id(input.sessionId)) return false
  if (input.action === 'mobileWorkspace' && !validMobileWorkspaceInput(input)) return false
  for (const key of ['operationId', 'roundId', 'jobId']) if (entry.fields.includes(key) && !id(input[key])) return false
  if (entry.fields.includes('operationId') && !operationToken(input.operationId)) return false
  if (entry.fields.includes('presentationId') && !id(input.presentationId)) return false
  if (entry.fields.includes('draftId') && !id(input.draftId)) return false
  if (entry.fields.includes('restoreId') && !id(input.restoreId)) return false
  if (entry.fields.includes('snapshot') && !validSnapshot(input.snapshot)) return false
  if (input.action === 'createDraft' && (!validRef(input.basedOn) || input.basedOn.sessionId !== input.sessionId || input.kind !== undefined && !['writer', 'manual'].includes(input.kind)
    || input.instruction !== undefined && typeof input.instruction !== 'string' || input.text !== undefined && (input.kind !== 'manual' || typeof input.text !== 'string' || !input.text.trim()))) return false
  if (input.action === 'adoptDraft' && (!validRef(input.expectedNarrative) || input.expectedNarrative.sessionId !== input.sessionId || !revision(input.expectedDraftVersion) || input.expectedDraftVersion < 1)) return false
  if (input.action === 'editDraft' && (!revision(input.expectedDraftVersion) || input.expectedDraftVersion < 1 || typeof input.text !== 'string' || !input.text.trim())) return false
  if (input.action === 'setAuthorNote' && (!revision(input.expectedRevision) || typeof input.text !== 'string')) return false
  if (input.action === 'configureReview' && (typeof input.enabled !== 'boolean' || !revision(input.expectedRevision))) return false
  if (input.action === 'regenerateFacts' && !revision(input.expectedRoundVersion)) return false
  if (['regenerateFacts', 'regenerateProse'].includes(input.action) && input.instruction !== undefined && typeof input.instruction !== 'string') return false
  if (input.action === 'regenerateProse' && (!validRef(input.basedOn) || input.basedOn.sessionId !== input.sessionId)) return false
  if (['turnDetails', 'forkStoryAtReading', 'suggestPlayerActions'].includes(input.action) && (!validRef(input.basedOn) || input.basedOn.sessionId !== input.sessionId)) return false
  if (input.action === 'suggestPlayerActions' && input.instruction !== undefined && typeof input.instruction !== 'string') return false
  if (input.action === 'readingPage' && (input.before !== undefined && !validReadingCursor(input.before) || input.limit !== undefined && !validReadingLimit(input.limit))) return false
  return input.action !== 'exportReading' || ['markdown', 'text'].includes(input.format)
}

export function createStudioActions({ getService, authorize, mobileIdentity, playerActions }) {
  const lifetime = new AbortController()
  const supported = (entry, owner) => !!owner && (entry.apiVersion === undefined || owner.apiVersion === entry.apiVersion) && typeof owner[entry.method] === 'function' && owner.capabilities?.[entry.method] !== false && (!entry.capability || owner.capabilities?.[entry.capability] === 1) && (!entry.available || entry.available(owner)) && (entry !== actions.mobileWorkspace || canReadMobileWorkspace(owner, getService('rpLastStep')))
  async function forkAvailability(sessionId, signal, current) {
    const gm = getService('rpGM'), lastStep = getService('rpLastStep'), agent = getService('agents')?.get?.(sessionId)
    if (!sessionId || !supported(actions.forkStory, gm) || typeof gm.binding !== 'function' || typeof gm.storyState !== 'function' || !canReadStory(lastStep)) return { available: false, code: 'CAPABILITY_UNAVAILABLE' }
    if (!agent) return { available: false, code: 'AGENT_REQUIRED' }
    if (agent.status === 'running') return { available: false, code: 'STORY_BUSY' }
    if (!current && !await gm.binding({ sessionId, signal })) return { available: false, code: 'STORY_NOT_FOUND' }
    const state = current ?? await gm.storyState({ sessionId, signal })
    if (state.binding?.status !== 'active' || state.capabilities?.fork !== true) return { available: false, code: 'FORK_UNAVAILABLE' }
    let review = state.review
    if (!review && gm.capabilities?.factReview === 1) {
      if (typeof gm.reviewState !== 'function') return { available: false, code: 'CAPABILITY_UNAVAILABLE' }
      review = await gm.reviewState({ sessionId, signal })
    }
    if (review?.latestRound?.pendingCandidateId || ['recorded', 'interrupted'].includes(review?.pendingDecision?.status) || review?.generation?.status === 'running') return { available: false, code: 'PENDING_FACT_REVIEW' }
    const latest = (await readingPage(lastStep, { sessionId, limit: 1, signal })).records.at(-1)
    if (!latest || !id(state.lastFactReceipt?.id) || latest.factReceiptId !== state.lastFactReceipt.id) return { available: false, code: 'FORK_UNAVAILABLE' }
    signal.throwIfAborted()
    if (getService('agents')?.get?.(sessionId) !== agent || agent.status === 'running') return { available: false, code: 'STORY_BUSY' }
    return { available: true }
  }
  async function capabilities(sessionId, signal) {
    const services = Object.fromEntries(Object.entries(owners).map(([key, name]) => {
      const owner = getService(name)
      return [key, { available: !!owner, apiVersion: typeof owner?.apiVersion === 'number' ? owner.apiVersion : null }]
    }))
    const flags = Object.fromEntries(Object.entries(actions).map(([name, entry]) => [name, supported(entry, getService(entry.service))]))
    flags.forkStory = false
    flags.forkStoryAtReading = !!sessionId && flags.forkStoryAtReading
    flags.suggestPlayerActions = !!sessionId && flags.suggestPlayerActions && playerActions?.available(sessionId) === true
    const storyKit = getService('rpStoryKit')
    let actualStoryKitCapabilities = {}
    if (storyKit?.apiVersion === 1 && typeof storyKit.state === 'function') {
      try { actualStoryKitCapabilities = (await storyKit.state({ signal }))?.capabilities ?? {} }
      catch { /* An unavailable owner cannot advertise transfer capability. */ }
    }
    for (const [action, flag] of Object.entries(storyKitCapabilities)) flags[action] = flags[action] && actualStoryKitCapabilities[flag] === true
    flags.retryPresentation = false
    const lastStep = getService('rpLastStep')
    if (sessionId && supported(actions.retryPresentation, lastStep) && typeof lastStep.presentationSummaries === 'function') {
      try { flags.retryPresentation = (await lastStep.presentationSummaries({ sessionId, signal }))?.capabilities?.retryDispatch === true }
      catch { flags.retryPresentation = false }
    }
    let story
    const gm = getService('rpGM')
    if (sessionId) {
      story = { generic: false }
      if (gm?.apiVersion === 1 && typeof gm.binding === 'function' && typeof gm.storyState === 'function' && await gm.binding({ sessionId, signal })) {
        const current = await gm.storyState({ sessionId, signal })
        try { flags.forkStory = (await forkAvailability(sessionId, signal, current)).available } catch { signal.throwIfAborted() }
        story = { generic: true, gm: { rollback: current.capabilities?.rollback === true && typeof gm.rollbackStory === 'function', fork: flags.forkStory, autoplay: false } }
      }
    }
    return { schemaVersion: 1, services, actions: flags, ...(story ? { story } : {}) }
  }
  return {
    async request(request) {
      if (lifetime.signal.aborted) return failure(503, 'CAPABILITY_UNAVAILABLE', 'RP Studio 已停用。')
      let input
      try { input = await request.json() } catch { return failure(400, 'INVALID_REQUEST', '请求必须是有效 JSON。') }
      if (!valid(input)) return failure(400, 'INVALID_REQUEST', 'RP 操作参数无效。')
      const signal = AbortSignal.any([request.signal, lifetime.signal])
      try {
        signal.throwIfAborted()
        if (input.action === 'mobileIdentity') {
          if (typeof mobileIdentity !== 'function') return failure(503, 'CAPABILITY_UNAVAILABLE', '主机身份尚不可用。')
          const identity = await mobileIdentity()
          signal.throwIfAborted()
          return Response.json(identity, { headers: { 'cache-control': 'no-store' } })
        }
        const sessionId = input.action === 'decideFacts' ? input.decision.sessionId : input.sessionId
        if (sessionId) await authorize(sessionId, signal)
        if (input.action === 'capabilities') return Response.json(await capabilities(input.sessionId, signal), { headers: { 'cache-control': 'no-store' } })
        const entry = actions[input.action], owner = getService(entry.service)
        if (!supported(entry, owner)) return failure(503, 'CAPABILITY_UNAVAILABLE', '所需 RP 服务或方法不可用，请检查插件版本。')
        if (input.action === 'suggestPlayerActions' && playerActions?.available(input.sessionId) !== true) return failure(503, 'CAPABILITY_UNAVAILABLE', '当前故事的行动建议模型尚不可用。')
        if (input.action === 'forkStory') {
          const eligibility = await forkAvailability(input.sessionId, signal)
          if (!eligibility.available) return failure(eligibility.code === 'CAPABILITY_UNAVAILABLE' ? 503 : 409, eligibility.code, '当前故事无法分支；请打开已完成且没有待审核事实的故事后重试。')
        }
        if (input.action === 'retryPresentation' && !(await capabilities(input.sessionId, signal)).actions.retryPresentation) return failure(503, 'CAPABILITY_UNAVAILABLE', '当前会话未提供受限的正文重试执行。')
        if (Object.hasOwn(storyKitCapabilities, input.action) && !(await capabilities(input.sessionId, signal)).actions[input.action]) return failure(503, 'CAPABILITY_UNAVAILABLE', 'Story Kit 所需导出或恢复能力尚未就绪。')
        const { action: _action, ...args } = input
        const result = input.action === 'mobileWorkspace'
          ? await mobileWorkspace({ gm: owner, lastStep: getService('rpLastStep') }, { ...args, signal })
          : input.action === 'suggestPlayerActions'
          ? await playerActions.suggest(owner, { ...args, signal })
          : await entry.run(owner, { ...args, signal })
        signal.throwIfAborted()
        return Response.json(result, { headers: { 'cache-control': 'no-store' } })
      } catch (error) {
        if (signal.aborted || error?.name === 'AbortError') return failure(499, 'CANCELLED', '操作已取消。')
        if (error?.apiError) return failure(error.statusCode, error.apiError.code, error.apiError.message)
        if (typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]+$/u.test(error.code) && Number.isInteger(error.status) && error.status >= 400 && error.status < 600) return failure(error.status, error.code, error.message)
        return failure(503, 'UNAVAILABLE', 'RP 服务暂不可用，请在所属插件检查后重试。')
      }
    },
    close() { lifetime.abort() },
  }
}
