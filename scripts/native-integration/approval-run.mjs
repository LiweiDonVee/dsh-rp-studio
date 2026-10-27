import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect } from '@playwright/test'
import { syntheticStoryData } from './data-fixtures.mjs'
import { startRetrievalProvider } from './retrieval-provider.mjs'
import { scenarioState } from './scenario-state.mjs'
import { openNativeContext, finishNativeContext, restartNativeContext } from './contexts.mjs'
import { ownedRunPath } from './paths.mjs'
import { redact } from './host.mjs'
import { verifyAction } from './action-proof.mjs'
import { verifyUnchanged } from './witness-proof.mjs'
import { modelDeltas, zeroModels, pendingWorld, durablePending, assertReceiptProjection, successfulToolResults, terminalProposal, acceptedProse, preservePrefix, commandProof, generatedCandidate, approvedWithoutPresentation, stagedGeneration, fixedOperationAudit, assertFixedOperationRetained, writerRevision, writerScopeDenial, effectiveMaterialAudit, authorNoteRecord, forkPrefix, forkReaderUnchanged, restoredReviseRoute, ownerRequestHash, textOf, sha } from './approval-proof.mjs'

export const APPROVAL_SCENARIOS = ['default-off-pending-cold', 'custom-regeneration-decision-resume', 'policy-off-generation-resume', 'effective-writer-scope', 'fork-saved-story-cold']
export async function clickOwner(context, action, click, matches = () => true) {
  const response = context.page.waitForResponse(row => row.url().endsWith('/api/rp-studio/actions') && row.request().method() === 'POST' && row.request().postDataJSON()?.action === action && matches(row.request().postDataJSON()))
  const [, result] = await Promise.all([click(), response]), value = await result.json()
  assert.equal(result.status(), 200, JSON.stringify(value)); assert.ok(!value.error, JSON.stringify(value)); return value
}
export async function configureApproval(context, sessionId, enabled) {
  const toggle = context.page.getByRole('checkbox', { name: '本故事事实审批', exact: true })
  await expect(toggle).toBeEnabled(); await expect(toggle).toBeChecked({ checked: !enabled })
  const result = await clickOwner(context, 'configureReview', () => toggle.click(), input => input.sessionId === sessionId && input.enabled === enabled)
  assert.equal(result.enabled, enabled); await expect(toggle).toBeChecked({ checked: enabled })
  return result
}
export async function fillCustomFacts(context, custom) {
  const fields = { 场景标题: custom.scene.title, 场景地点: custom.scene.location, 场景时间: custom.scene.time ?? '', '在场角色 ID': custom.scene.presentActorIds.join('\n'), 事实摘要: custom.summary, 玩家行动: custom.packet.playerAction, 场景方向: custom.packet.sceneInstruction ?? '' }
  for (const [key, label] of Object.entries({ resolvedChanges: '已经解决的变化', visibleConsequences: '可见后果', openHooks: '未决线索', proseConstraints: '写作约束', publicFactRefs: '公开事实引用' })) fields[label] = (custom.packet[key] ?? []).join('\n')
  assert.equal(await context.page.getByRole('textbox', { name: /^事实 [0-9]+ 标识$/u }).count(), custom.facts.items.length)
  for (const [index, item] of custom.facts.items.entries()) { fields[`事实 ${index + 1} 标识`] = item.id; fields[`事实 ${index + 1} 内容`] = item.text }
  const variables = Object.entries(custom.packet.variables ?? {})
  assert.equal(await context.page.getByRole('textbox', { name: /^变量 [0-9]+ 名称$/u }).count(), variables.length)
  for (const [index, [name, value]] of variables.entries()) { fields[`变量 ${index + 1} 名称`] = name; fields[`变量 ${index + 1} 内容`] = value }
  for (const [name, value] of Object.entries(fields)) await context.page.getByRole('textbox', { name, exact: true }).fill(value)
}
async function sendPlayer(context, sessionId, input) {
  const response = context.page.waitForResponse(row => row.url().endsWith('/api/rp-studio/request') && row.request().method() === 'POST' && row.request().postDataJSON()?.path?.endsWith('/messages'))
  await context.page.getByRole('textbox', { name: '写下你的行动', exact: true }).fill(input)
  await context.page.getByRole('button', { name: '发送行动 ↑', exact: true }).click()
  assert.equal((await response).status(), 200); await context.idle(sessionId)
}
const capture = (context, sessionId) => context.probe('approvalCapture', { sessionId })
async function setNote(context, sessionId, text) { const state = await context.api('context', 'state', { sessionId }); return context.api('studio', 'setAuthorNote', { sessionId, text, expectedRevision: state.revision }) }
async function screenshots(context, run, label, write) {
  const metrics = []
  for (const [mode, width] of [['sidebar', 1440], ['full', 1440], ['narrow', 520]]) {
    await context.page.setViewportSize({ width, height: 1000 })
    if (mode === 'full') { await context.page.getByRole('button', { name: '全屏', exact: true }).click(); await context.page.waitForFunction(() => document.querySelector('.dsh-rp-workspace')?.clientWidth > 1000) }
    const value = await context.page.locator('.dsh-rp-workspace').evaluate(element => ({ width: element.clientWidth, height: element.clientHeight, overflow: element.scrollWidth > element.clientWidth }))
    assert.equal(value.overflow, false); assert.ok(value.width >= 250 && value.height >= 200)
    await context.page.screenshot({ path: join(run, `${label}-${mode}.png`) }); metrics.push({ mode, ...value })
  }
  await context.page.setViewportSize({ width: 1440, height: 1000 }); await write(`${label}-layout.json`, metrics)
  return metrics
}
export async function executeApprovalNative({ workspace, run, staged, cli, browserPath }) {
  assert.equal(staged.stage, 'final')
  const provider = await startRetrievalProvider(), report = { schemaVersion: 1, scope: 'A029 installed-owner approval native scenarios; five-group source checkpoint, coordinator final acceptance separate', packages: staged.packages, scenarios: [], segments: [], actions: [], limitations: [], fullChain: { status: 'not-run', finalAcceptance: false } }
  const write = async (name, value, { exclusive = false } = {}) => writeFile(await ownedRunPath(workspace, run, join(run, name)), JSON.stringify(value, null, 2) + '\n', { flag: exclusive ? 'wx' : 'w' })
  const cases = scenarioState(APPROVAL_SCENARIOS, async rows => { report.scenarios = structuredClone(rows); await write('approval-progress.json', report) })
  const active = new Set(), finalized = new Map()
  const open = async (name, existing) => {
    try {
      const context = await openNativeContext({ workspace, run, staged, cli, browserPath, providerURL: provider.baseURL, name, existing, approval: true })
      report.segments.push({ name, hostPid: context.hostPid, hostVersion: context.installed.version, installed: context.installed.installed, browserErrors: context.errors, httpErrors: context.httpErrors })
      active.add(context); return context
    } catch (error) { if (error.nativeStartup) report.segments.push({ ...error.nativeStartup, startupFailed: true }); throw error }
  }
  const finish = (context, retry = false) => {
    if (!retry && finalized.has(context)) return finalized.get(context)
    const task = (async () => {
      const segment = report.segments.find(row => row.hostPid === context.hostPid)
      try { await finishNativeContext(context, segment) }
      finally { if (segment.cleanupStatus === 'stopped') active.delete(context) }
    })(); finalized.set(context, task); return task
  }
  const restart = context => restartNativeContext(context, finish, open)
  let source, sessionId, pendingSnapshot, pendingExportEvidence, revisedEvidence, worldSourceId, fixedWorkAudit
  try {
    source = await open('approval-source')
    const data = syntheticStoryData()
    await cases.run(APPROVAL_SCENARIOS[0], async () => {
      const sk = await source.api('storyKit', 'state')
      const imported = await source.api('storyKit', 'importAsset', { format: 'png', dataBase64: data.png.toString('base64'), expectedRevision: sk.revision })
      const world = await source.api('database', 'import', { name: 'Approval synthetic world', rawText: data.worldJson, expectedRevision: (await source.api('database', 'state')).revision })
      worldSourceId = world.sourceId
      const character = (await source.api('storyKit', 'asset', { kind: 'character', assetId: imported.assetId, version: imported.version })).asset
      const persona = await source.api('storyKit', 'createPersona', { persona: data.persona, expectedRevision: (await source.api('storyKit', 'state')).revision })
      const launch = await source.api('storyKit', 'launch', { launchId: randomUUID(), character: { assetId: character.id, version: character.version }, persona: { assetId: persona.assetId, version: persona.version }, openingId: character.openings.find(row => row.text === data.opening).id, sources: [{ key: 'world', databaseId: world.databaseId, version: world.version }], profile: null, initialScene: data.initialScene, initialFacts: data.initialFacts })
      sessionId = launch.sessionId; await source.idle(sessionId)
      await source.probe('routes', { sessionId })
      const settings = await source.api('context', 'state', { sessionId })
      await source.api('context', 'configure', { sessionId, settings: { enabled: true, recentTurns: 1, maxChars: 24000, maxSteps: 12 }, expectedRevision: settings.revision })
      await source.openStudio(sessionId)
      const initial = await capture(source, sessionId); assert.equal(initial.review.enabled, false); assert.equal(initial.models.total, 2)
      const toggle = source.page.getByRole('checkbox', { name: '本故事事实审批', exact: true }); await expect(toggle).toBeEnabled(); await expect(toggle).not.toBeChecked()
      await sendPlayer(source, sessionId, 'NATIVE_APPROVAL_BASELINE')
      const baseline = await capture(source, sessionId), baselineDeltas = modelDeltas(initial.models, baseline.models)
      assert.equal(baselineDeltas.revise, 0); assert.equal(baselineDeltas.writer, 1)
      const baselineBody = acceptedProse(baseline, baseline.gm.lastFactReceipt.id)
      assert.notEqual(baseline.gm.lastFactReceipt.id, initial.gm.lastFactReceipt.id)
      const commits = successfulToolResults(baseline.snapshot.events, 'rp_commit_turn', initial.snapshot.events.at(-1)?.seq ?? -1)
      const presentations = successfulToolResults(baseline.snapshot.events, 'rp_present', initial.snapshot.events.at(-1)?.seq ?? -1)
      assert.equal(commits.length, 1); assert.equal(presentations.length, 1)
      assert.equal(JSON.parse(commits[0].result.data.message.content[0].text).id, baseline.gm.lastFactReceipt.id)
      assert.equal(baselineBody.ref.resultSeq, presentations[0].result.seq)
      assert.equal(baseline.history.records.length, initial.history.records.length + 1)
      assert.ok(baseline.gm.facts.items.some(row => row.id === 'native-marker' && row.text === 'FACT_BASELINE'))
      assert.deepEqual(baseline.gm.facts.items.filter(row => row.id !== 'native-marker'), initial.gm.facts.items)
      for (const ref of baseline.gm.lastFactReceipt.stateRefs) assert.equal(baseline.database.entries.find(entry => entry.ref.sourceKey === ref.sourceKey && entry.ref.entryId === ref.entryId)?.version, ref.version)
      assert.equal(baseline.review.latestRound.approvalRequired, false)
      assertReceiptProjection(baseline, baseline.gm.lastFactReceipt)
      const reviewConfiguration = await configureApproval(source, sessionId, true)
      await setNote(source, sessionId, 'NATIVE_OLD_NOTE_CONSUMED_ON_CUSTOM')
      const before = await capture(source, sessionId)
      await sendPlayer(source, sessionId, 'NATIVE_APPROVAL_PENDING')
      const pending = await capture(source, sessionId), pendingDeltas = modelDeltas(before.models, pending.models)
      assert.ok(pendingDeltas.gm > 0); zeroModels({ ...pendingDeltas, gm: 0 })
      assert.deepEqual(pendingWorld(pending.database), pendingWorld(before.database)); assert.deepEqual(pending.gm.lastFactReceipt, before.gm.lastFactReceipt)
      assert.deepEqual(pending.history.records, before.history.records)
      const round = pending.review.latestRound, candidateId = round.pendingCandidateId; assert.ok(candidateId); assert.equal(round.approvalRequired, true)
      assertReceiptProjection(pending, baseline.gm.lastFactReceipt)
      const added = pending.snapshot.events.slice(before.snapshot.events.length), call = added.find(row => row.type === 'tool/call' && row.data.name === 'rp_propose_turn')
      assert.ok(call); assert.ok(added.some(row => row.type === 'tool/call' && row.data.name === 'rp_db_read'))
      assert.equal(added.filter(row => row.type === 'tool/call' && ['rp_commit_turn', 'rp_present'].includes(row.data.name)).length, 0)
      const proposal = terminalProposal(pending, before.snapshot.events.at(-1)?.seq ?? -1), result = proposal.result
      assert.ok(added.some(row => row.type === 'turn/end' && row.data.turn === call.data.turn))
      assert.equal(added.filter(row => row.seq > result.seq && row.type === 'assistant/message' && row.data.message?.source?.kind === 'model').length, 0)
      assert.equal((await source.api('studio', 'authorNote', { sessionId })).status, 'pending')
      await expect(source.page.getByText('候选事实 · 尚未写入', { exact: true })).toBeVisible()
      await source.page.getByRole('textbox', { name: '写下你的行动', exact: true }).fill('保留的待审玩家输入')
      await source.page.getByRole('textbox', { name: '写下你的行动', exact: true }).press('Enter')
      assert.deepEqual((await source.snapshot(sessionId)).events, pending.snapshot.events)
      await expect(source.page.getByRole('textbox', { name: '写下你的行动', exact: true })).toHaveValue('保留的待审玩家输入')
      const layouts = await screenshots(source, run, 'pending', write)
      pendingSnapshot = (await source.api('studio', 'exportSavedStory', { sessionId })).snapshot
      await source.probe('flush')
      const saved = await capture(source, sessionId), selectedSaved = pendingSnapshot.sessions.find(row => row.header.id === sessionId)
      assertReceiptProjection(saved, baseline.gm.lastFactReceipt)
      assert.equal(pendingSnapshot.selectedSessionId, sessionId); assert.ok(selectedSaved)
      preservePrefix(selectedSaved, saved.snapshot); assert.deepEqual(selectedSaved.events, saved.snapshot.events)
      pendingExportEvidence = { saved, baselineReceipt: baseline.gm.lastFactReceipt }
      source = await restart(source)
      const coldBefore = await source.probe('models'); zeroModels(modelDeltas(coldBefore, coldBefore)); assert.equal(coldBefore.total, 0)
      const cold = await capture(source, sessionId); assert.equal(cold.models.total, 0); assert.equal(cold.review.enabled, true); assert.equal(cold.review.latestRound.pendingCandidateId, candidateId)
      assertReceiptProjection(cold, baseline.gm.lastFactReceipt)
      assert.deepEqual(durablePending(cold), durablePending(saved)); zeroModels(cold.models.counts)
      const prefix = preservePrefix(cold.snapshot, saved.snapshot); assert.ok(cold.snapshot.events.slice(saved.snapshot.events.length).every(row => row.type === 'session/end-seed'))
      await source.openStudio(sessionId); await expect(source.page.getByText('候选事实 · 尚未写入', { exact: true })).toBeVisible()
      const afterColdUi = await capture(source, sessionId)
      assertReceiptProjection(afterColdUi, baseline.gm.lastFactReceipt)
      assert.equal(afterColdUi.models.total, 0); zeroModels(afterColdUi.models.counts); assert.deepEqual(durablePending(afterColdUi), durablePending(saved))
      preservePrefix(afterColdUi.snapshot, saved.snapshot); assert.ok(afterColdUi.snapshot.events.slice(saved.snapshot.events.length).every(row => row.type === 'session/end-seed'))
      await write('pending-cold.json', { sessionId, initial, baseline, baselineBody, baselineDeltas, commits, presentations, reviewConfiguration, before, pending, pendingDeltas, proposal, saved, cold, afterColdUi, prefix, pendingSnapshot, layouts })
      report.actions.push({ name: 'default-off ordinary', deltas: baselineDeltas }, { name: 'terminal pending', deltas: pendingDeltas }, { name: 'cold pending observation', models: cold.models.counts })
      return { sessionId, candidateId, baselineReceiptId: baseline.gm.lastFactReceipt.id, proposalCallSeq: call.seq, proposalResultSeq: result.seq, pendingWorldUnchanged: true, coldHistoricalModels: 0, prefix, layouts }
    })
    await cases.run(APPROVAL_SCENARIOS[1], async () => {
      await source.probe('resume', { sessionId }); await source.idle(sessionId)
      assert.equal((await source.probe('models')).total, 0)
      await source.page.getByRole('button', { name: '刷新事实与写作状态', exact: true }).click()
      const before = await capture(source, sessionId), originalSource = await source.api('database', 'source', { sourceId: worldSourceId })
      const retry = await clickOwner(source, 'regenerateFacts', () => source.page.getByRole('button', { name: '重试事实', exact: true }).click(), row => row.sessionId === sessionId && row.roundId === before.review.latestRound.roundId)
      await source.idle(sessionId)
      const retried = await capture(source, sessionId), retryEvidence = generatedCandidate(before, retried, { operationId: retry.job.operationId, instruction: '', marker: 'FACT_PENDING_RETRY' })
      assert.equal(retry.job.status, 'complete'); assert.equal(retried.review.latestRound.approvalRequired, true)
      const retryCommand = commandProof(retried.snapshot.events, retry.job.operationId, 'rp-gm-fact-regenerate')
      assert.equal(JSON.parse(retryCommand.done.data.text).candidateId, retryEvidence.candidate.id); assert.equal(JSON.parse(retryCommand.done.data.text).payloadHash, retryEvidence.candidate.payloadHash)
      await source.page.locator('.rp-fact-tools .rp-draft-list button').filter({ hasText: retryEvidence.candidate.id }).click()
      await source.page.getByRole('button', { name: '自定义事实', exact: true }).click()
      const custom = structuredClone(retryEvidence.candidate.payload)
      custom.scene = { schemaVersion: 1, title: 'HUMAN_SCENE', location: 'HUMAN_LOCATION', time: 'HUMAN_TIME', presentActorIds: ['human-traveler', 'human-guide'] }
      custom.facts.items.find(row => row.id === 'native-marker').text = 'FACT_CUSTOM_EFFECTIVE'; custom.summary = 'FACT_CUSTOM_EFFECTIVE'
      custom.packet = { playerAction: 'HUMAN_PLAYER_ACTION', sceneInstruction: 'HUMAN_DIRECTION', resolvedChanges: ['HUMAN_RESOLVED_CHANGE'], visibleConsequences: ['FACT_CUSTOM_EFFECTIVE'], openHooks: ['HUMAN_OPEN_HOOK'], proseConstraints: ['HUMAN_PROSE_CONSTRAINT'], publicFactRefs: ['native-marker'], variables: { native: 'HUMAN_VARIABLE' } }
      await fillCustomFacts(source, custom)
      await source.page.screenshot({ path: join(run, 'custom-facts-editor.png') })
      const preCustom = await capture(source, sessionId); let customRequest
      const approved = await clickOwner(source, 'decideFacts', () => source.page.getByRole('button', { name: '采用自定义并继续', exact: true }).click(), row => {
        if (row.decision?.sessionId !== sessionId || row.decision?.candidateId !== retryEvidence.candidate.id || row.decision?.action !== 'custom') return false
        customRequest = structuredClone(row); return true
      })
      await source.idle(sessionId)
      const customView = await capture(source, sessionId), customDeltas = modelDeltas(preCustom.models, customView.models)
      assert.deepEqual(customRequest.decision.custom, custom); assert.equal(approved.operationId, customRequest.decision.operationId)
      assert.equal(approved.status, 'approved'); assert.equal(approved.presentation.status, 'complete'); assert.equal(customDeltas.revise, 0); assert.equal(customDeltas.writer, 1); assert.ok(customDeltas.gm > 0)
      assert.deepEqual(customView.gm.scene, custom.scene); assert.deepEqual(customView.gm.facts, custom.facts)
      const storedCustom = customView.review.latestRound.candidates.find(row => row.id === customView.gm.lastFactReceipt.candidateId)
      assert.equal(storedCustom.origin, 'owner'); assert.deepEqual(storedCustom.payload, custom)
      assert.equal(customView.review.latestRound.activeReceiptId, approved.factReceiptId); assert.equal(customView.review.latestRound.pendingCandidateId, null)
      const customCommand = commandProof(customView.snapshot.events, approved.operationId, 'rp-gm-fact-decision')
      fixedWorkAudit = fixedOperationAudit(preCustom, customView, customCommand)
      assert.deepEqual(customView.database.binding, preCustom.database.binding)
      assert.deepEqual(customView.database.entries.filter(row => row.ref.sourceKey !== '@session'), preCustom.database.entries.filter(row => row.ref.sourceKey !== '@session'))
      assert.deepEqual((await source.api('database', 'source', { sourceId: worldSourceId })).source, originalSource.source)
      assert.equal((await source.api('studio', 'authorNote', { sessionId })).status, 'consumed')
      const customBody = acceptedProse(customView, approved.factReceiptId)
      assert.equal(customView.gm.lastFactReceipt.decisionSource.commandId, customCommand.run.data.commandId)
      assert.equal(customView.gm.lastFactReceipt.decisionSource.doneSeq, customCommand.done.seq)
      assert.equal(successfulToolResults(customView.snapshot.events, 'rp_present', preCustom.snapshot.events.at(-1)?.seq ?? -1).length, 1)
      assert.deepEqual(customView.snapshot.events.slice(preCustom.snapshot.events.length).filter(row => row.type === 'tool/call').map(row => row.data.name), ['rp_present'])
      preservePrefix(customView.snapshot, preCustom.snapshot)
      await source.page.getByRole('textbox', { name: '事实重生要求', exact: true }).fill('FACT_REVISION_A')
      const generated = await clickOwner(source, 'regenerateFacts', () => source.page.getByRole('button', { name: '重新生成事实', exact: true }).click(), row => row.sessionId === sessionId && row.roundId === customView.review.latestRound.roundId && row.instruction === 'FACT_REVISION_A')
      await source.idle(sessionId)
      const pending = await capture(source, sessionId), generateEvidence = generatedCandidate(customView, pending, { operationId: generated.job.operationId, instruction: 'FACT_REVISION_A', marker: 'FACT_REVISION_A' })
      assertFixedOperationRetained(customView, pending, fixedWorkAudit)
      assert.equal(pending.review.latestRound.approvalRequired, true)
      const generateCommand = commandProof(pending.snapshot.events, generated.job.operationId, 'rp-gm-fact-regenerate')
      assert.equal(JSON.parse(generateCommand.done.data.text).candidateId, generateEvidence.candidate.id); assert.equal(JSON.parse(generateCommand.done.data.text).payloadHash, generateEvidence.candidate.payloadHash)
      assert.match(generateEvidence.request.input.fixedWorkPolicy, /never replay/u)
      const captured = generateEvidence.request.input.capture
      assert.equal(captured.playerInput.text, 'NATIVE_APPROVAL_PENDING')
      const player = pending.snapshot.events.find(row => row.seq === captured.playerInput.seq)
      assert.equal(player?.type, 'user/message'); assert.equal(player.data.id, captured.playerInput.messageId); assert.equal(textOf(player.data), captured.playerInput.text)
      assert.ok(captured.observations.some(row => row.toolName === 'rp_db_read'))
      for (const observation of captured.observations) {
        const call = pending.snapshot.events.find(row => row.seq === observation.callSeq), result = pending.snapshot.events.find(row => row.seq === observation.resultSeq)
        assert.equal(call?.type, 'tool/call'); assert.equal(call.data.name, observation.toolName); assert.equal(result?.type, 'tool/result'); assert.equal(result.data.message.toolCallId, call.data.callId); assert.equal(textOf(result.data.message), observation.text)
      }
      const preAbort = await capture(source, sessionId), round = preAbort.review.latestRound
      const decision = { sessionId, roundId: round.roundId, candidateId: round.pendingCandidateId, action: 'approve', operationId: randomUUID(), expectedRoundVersion: round.version, expectedDatabaseRevision: preAbort.review.databaseRevision }
      const interrupted = await source.probe('abortFactDecision', { decision }); await source.idle(sessionId)
      const afterAbort = await capture(source, sessionId), command = commandProof(afterAbort.snapshot.events, decision.operationId, 'rp-gm-fact-decision')
      assertFixedOperationRetained(preAbort, afterAbort, fixedWorkAudit)
      const abortDeltas = modelDeltas(preAbort.models, afterAbort.models)
      const intent = afterAbort.factReview.decisions.find(row => row.operationId === decision.operationId)
      assert.ok(intent); assert.equal(intent.source.commandId, command.run.data.commandId); assert.equal(intent.source.runSeq, command.run.seq); assert.equal(intent.requestHash, command.run.data.args.trim().split(/\s+/u)[1])
      assert.equal(intent.requestHash, ownerRequestHash({ sessionId, roundId: round.roundId, candidateId: decision.candidateId, action: 'approve', candidatePayloadHash: generateEvidence.candidate.payloadHash }))
      const nativeBoundary = interrupted.boundary.aborted && intent.status === 'recorded' && afterAbort.gm.lastFactReceipt.id === preAbort.gm.lastFactReceipt.id
      if (nativeBoundary) {
        assert.deepEqual(interrupted.boundary, { run: command.run, done: command.done, aborted: true })
        assert.deepEqual(pendingWorld(afterAbort.database), pendingWorld(preAbort.database)); zeroModels(abortDeltas)
        assert.equal(afterAbort.review.pendingDecision.operationId, decision.operationId); assert.equal(afterAbort.review.pendingDecision.status, 'recorded')
      } else {
        assert.equal(intent.status, 'applied', 'fault boundary missed without a legitimately finalized decision')
        assert.equal(afterAbort.gm.lastFactReceipt.id, intent.factReceiptId)
        const gm = staged.packages.find(row => row.name === 'dsh-rp-gm'), database = staged.packages.find(row => row.name === 'dsh-rp-database')
        assert.equal(gm.sha256, 'b4738a787e6f30ce2e00c81e11307a0e5c65071bbb2799acb1b51ff66de4b38a'); assert.equal(database.sha256, '3bfe66001889d373ded28a312f3f55613b94828f4506f9e11727fd64bdb01f77')
        report.limitations.push({ code: 'DECISION_PRE_FINALIZE_NOT_NATIVELY_VERIFIED', status: 'NOT NATIVELY VERIFIED', operationId: decision.operationId, attemptCount: 1, boundary: interrupted.boundary, actualIntent: intent, regressions: [
          { package: gm, commit: '20d3ab1fe9e1bbec6f0cdbba0acbf684bd147d22', file: 'tests/fact-review.test.mjs', test: 'cold decision completion resumes with zero model calls and explicit writing failure keeps approved facts resumable' },
          { package: database, commit: '93853ccbff8b4ad7997471a72fe7e62cc24c2eae', file: 'tests/fact-review.test.mjs', test: 'intent and run-only cannot write facts; exact successful done atomically accepts fixed operations once' },
        ] })
      }
      const resumed = await source.api('studio', 'resumeFactDecision', { sessionId, operationId: decision.operationId }), settled = await capture(source, sessionId), settleDeltas = modelDeltas(afterAbort.models, settled.models)
      assertFixedOperationRetained(afterAbort, settled, fixedWorkAudit)
      zeroModels(settleDeltas); assert.equal(resumed.status, 'approved'); assert.equal(resumed.operationId, decision.operationId)
      if (nativeBoundary) approvedWithoutPresentation(afterAbort, settled, resumed, decision.operationId)
      else { assert.equal(resumed.factReceiptId, afterAbort.gm.lastFactReceipt.id); assert.deepEqual(pendingWorld(settled.database), pendingWorld(afterAbort.database)) }
      assert.equal(settled.gm.lastFactReceipt.factRevision, customView.gm.lastFactReceipt.factRevision + 1)
      const replay = await source.api('studio', 'resumeFactDecision', { sessionId, operationId: decision.operationId }), replayed = await capture(source, sessionId), replayDeltas = modelDeltas(settled.models, replayed.models)
      assertFixedOperationRetained(settled, replayed, fixedWorkAudit)
      zeroModels(replayDeltas); assert.equal(replay.factReceiptId, resumed.factReceiptId); assert.deepEqual(pendingWorld(replayed.database), pendingWorld(settled.database)); assert.deepEqual(replayed.gm.lastFactReceipt, settled.gm.lastFactReceipt)
      assert.deepEqual(replayed.factReview.rounds, settled.factReview.rounds); assert.deepEqual(replayed.factReview.decisions, settled.factReview.decisions)
      let written, presentationDeltas
      if (replayed.review.pendingDecision?.status === 'applied') {
        assert.equal(replayed.review.pendingDecision.operationId, decision.operationId)
        await source.page.getByRole('button', { name: '刷新事实与写作状态', exact: true }).click()
        written = await clickOwner(source, 'resumeFactPresentation', () => source.page.getByRole('button', { name: '继续已批准事实的写作', exact: true }).click(), row => row.sessionId === sessionId && row.operationId === decision.operationId && row.roundId === round.roundId)
        await source.idle(sessionId)
        const presented = await capture(source, sessionId); presentationDeltas = modelDeltas(replayed.models, presented.models)
        assert.equal(written.presentation.status, 'complete'); assert.equal(written.factReceiptId, resumed.factReceiptId); assert.equal(presentationDeltas.revise, 0); assert.equal(presentationDeltas.writer, 1); assert.ok(presentationDeltas.gm > 0)
        assert.deepEqual(presented.snapshot.events.slice(replayed.snapshot.events.length).filter(row => row.type === 'tool/call').map(row => row.data.name), ['rp_present'])
      } else { assert.equal(nativeBoundary, false); acceptedProse(replayed, resumed.factReceiptId) }
      const presented = await capture(source, sessionId), body = acceptedProse(presented, resumed.factReceiptId)
      assert.equal(presented.review.pendingDecision, null); assert.deepEqual(pendingWorld(presented.database), pendingWorld(replayed.database)); assertFixedOperationRetained(replayed, presented, fixedWorkAudit)
      assert.ok(presented.gm.facts.items.some(row => row.id === 'native-marker' && row.text === 'FACT_REVISION_A'))
      assert.equal(presented.history.records.some(row => row.factReceiptId === customBody.factReceiptId), false)
      preservePrefix(presented.snapshot, customView.snapshot)
      assert.deepEqual((await source.api('database', 'source', { sourceId: worldSourceId })).source, originalSource.source)
      await source.page.screenshot({ path: join(run, 'custom-decision-presented.png') })
      await write('custom-decision-resume.json', { sessionId, before, originalSource, retry, retried, retryEvidence, retryCommand, customRequest, custom, preCustom, approved, customView, customDeltas, customCommand, customBody, fixedWorkAudit, generated, pending, generateEvidence, generateCommand, preAbort, decision, interrupted, afterAbort, abortDeltas, command, intent, nativeBoundary, resumed, settled, settleDeltas, replay, replayed, replayDeltas, written, presentationDeltas, presented, body })
      report.actions.push({ name: 'pending fact retry', deltas: retryEvidence.deltas }, { name: 'custom approval', deltas: customDeltas }, { name: 'fact regeneration ON', deltas: generateEvidence.deltas }, { name: 'decision completion interruption attempt', deltas: abortDeltas }, { name: 'decision settlement resume', deltas: settleDeltas }, { name: 'decision settlement replay', deltas: replayDeltas }, ...(presentationDeltas ? [{ name: 'explicit fact presentation', deltas: presentationDeltas }] : []))
      return { sessionId, roundId: round.roundId, originalOperationId: decision.operationId, factReceiptId: resumed.factReceiptId, customReceiptId: approved.factReceiptId, interruption: { status: nativeBoundary ? 'passed' : 'NOT NATIVELY VERIFIED', attemptCount: 1 }, presentation: body.ref, evidence: 'custom-decision-resume.json' }
    })
    await cases.run(APPROVAL_SCENARIOS[2], async () => {
      await source.idle(sessionId)
      const presentedBefore = await capture(source, sessionId), oldBody = acceptedProse(presentedBefore, presentedBefore.gm.lastFactReceipt.id)
      assert.equal(presentedBefore.review.pendingDecision, null); assert.equal(presentedBefore.review.latestRound.pendingCandidateId, null)
      const configuration = await configureApproval(source, sessionId, false), before = await capture(source, sessionId)
      zeroModels(modelDeltas(presentedBefore.models, before.models)); assert.equal(before.review.enabled, false)
      const round = before.review.latestRound, operationId = randomUUID(), instruction = 'FACT_REVISION_B'
      const interrupted = await source.probe('abortFactGeneration', { sessionId, roundId: round.roundId, operationId, expectedRoundVersion: round.version, instruction })
      await source.idle(sessionId)
      const afterAbort = await capture(source, sessionId), generationEvidence = stagedGeneration(before, afterAbort, { operationId, instruction, marker: 'FACT_REVISION_B' })
      assertFixedOperationRetained(before, afterAbort, fixedWorkAudit)
      const generationCommand = commandProof(afterAbort.snapshot.events, operationId, 'rp-gm-fact-regenerate'), output = JSON.parse(generationCommand.done.data.text)
      assert.equal(output.candidateId, generationEvidence.candidate.id); assert.equal(output.payloadHash, generationEvidence.candidate.payloadHash)
      assert.equal(generationCommand.run.data.args.trim().split(/\s+/u)[1], ownerRequestHash({ schemaVersion: 1, sessionId, roundId: round.roundId, operationId, expectedRoundVersion: round.version, instruction, approvalRequired: false }))
      const needsApplication = afterAbort.gm.lastFactReceipt.id === before.gm.lastFactReceipt.id
      const nativeBoundary = interrupted.boundary.aborted && generationEvidence.candidate.generationConfirmed === false && needsApplication
      if (nativeBoundary) {
        assert.deepEqual(interrupted.boundary, { run: generationCommand.run, done: generationCommand.done, aborted: true })
        zeroModels({ ...generationEvidence.deltas, revise: 0 }); assert.deepEqual(pendingWorld(afterAbort.database), pendingWorld(before.database)); assert.deepEqual(afterAbort.history.records, before.history.records)
        assert.equal(afterAbort.review.latestRound.pendingCandidateId, before.review.latestRound.pendingCandidateId)
        assert.deepEqual(afterAbort.factReview.decisions, before.factReview.decisions)
      } else {
        assert.equal(generationEvidence.candidate.generationConfirmed, true, 'fault boundary missed without an actual confirmed candidate')
        if (needsApplication) { assert.equal(afterAbort.review.latestRound.pendingCandidateId, generationEvidence.candidate.id); assert.deepEqual(pendingWorld(afterAbort.database), pendingWorld(before.database)) }
        else assert.equal(afterAbort.gm.lastFactReceipt.candidateId, generationEvidence.candidate.id)
        const gm = staged.packages.find(row => row.name === 'dsh-rp-gm'), database = staged.packages.find(row => row.name === 'dsh-rp-database')
        assert.equal(gm.sha256, 'b4738a787e6f30ce2e00c81e11307a0e5c65071bbb2799acb1b51ff66de4b38a'); assert.equal(database.sha256, '3bfe66001889d373ded28a312f3f55613b94828f4506f9e11727fd64bdb01f77')
        report.limitations.push({ code: 'GENERATION_PRE_CONFIRMATION_NOT_NATIVELY_VERIFIED', status: 'NOT NATIVELY VERIFIED', operationId, attemptCount: 1, boundary: interrupted.boundary, actualJob: generationEvidence.job, actualCandidate: generationEvidence.candidate, regressions: [
          { package: gm, commit: '20d3ab1fe9e1bbec6f0cdbba0acbf684bd147d22', file: 'tests/fact-generation.test.mjs', test: 'successful generation done lost before confirmation is reused without command or model replay' },
          { package: database, commit: '93853ccbff8b4ad7997471a72fe7e62cc24c2eae', file: 'tests/fact-review.test.mjs', test: 'cold provisional generation resumes by its exact immutable operation and confirms without a new candidate' },
        ] })
      }
      const uiInstruction = 'UI_MUST_NOT_REBUILD_THE_DURABLE_GENERATION'
      await source.page.getByRole('textbox', { name: '事实重生要求', exact: true }).fill(uiInstruction)
      const resumed = await source.api('studio', 'resumeFactGeneration', { sessionId, operationId }); await source.idle(sessionId)
      const settled = await capture(source, sessionId), settleDeltas = modelDeltas(afterAbort.models, settled.models)
      assertFixedOperationRetained(afterAbort, settled, fixedWorkAudit)
      zeroModels(settleDeltas); assert.equal(resumed.job.operationId, operationId); assert.equal(resumed.job.status, 'complete'); assert.equal(resumed.job.candidateId, generationEvidence.candidate.id)
      assert.equal(resumed.decision?.status, 'approved'); assert.equal(resumed.decision.factReceiptId, settled.gm.lastFactReceipt.id)
      const decisionOperationId = resumed.decision.operationId
      assert.ok(decisionOperationId); assert.notEqual(decisionOperationId, operationId)
      if (needsApplication) approvedWithoutPresentation(afterAbort, settled, resumed.decision, decisionOperationId)
      else { assert.equal(settled.gm.lastFactReceipt.id, afterAbort.gm.lastFactReceipt.id); assert.deepEqual(pendingWorld(settled.database), pendingWorld(afterAbort.database)) }
      const settledCandidate = settled.review.latestRound.candidates.find(row => row.id === generationEvidence.candidate.id)
      assert.equal(settledCandidate.generationConfirmed, true); assert.deepEqual(settledCandidate.payload, generationEvidence.candidate.payload); assert.equal(settledCandidate.payloadHash, generationEvidence.candidate.payloadHash); assert.equal(settledCandidate.operationId, operationId)
      assert.equal(settled.review.latestRound.candidates.length, afterAbort.review.latestRound.candidates.length)
      assert.equal(settled.gm.lastFactReceipt.factRevision, before.gm.lastFactReceipt.factRevision + 1)
      const decisionCommand = commandProof(settled.snapshot.events, decisionOperationId, 'rp-gm-fact-decision')
      assert.ok(decisionCommand.run.seq > generationCommand.done.seq, 'OFF acceptance must use a separate real decision after generation done')
      assert.equal(settled.gm.lastFactReceipt.decisionSource.commandId, decisionCommand.run.data.commandId); assert.equal(settled.gm.lastFactReceipt.decisionSource.doneSeq, decisionCommand.done.seq)
      assert.equal(settled.snapshot.events.slice(afterAbort.snapshot.events.length).filter(row => row.type === 'tool/call').length, 0)
      const replay = await source.api('studio', 'resumeFactGeneration', { sessionId, operationId }); await source.idle(sessionId)
      const replayed = await capture(source, sessionId), replayDeltas = modelDeltas(settled.models, replayed.models)
      assertFixedOperationRetained(settled, replayed, fixedWorkAudit)
      zeroModels(replayDeltas); assert.equal(replay.job.operationId, operationId); assert.equal(replay.decision.operationId, decisionOperationId); assert.equal(replay.decision.factReceiptId, resumed.decision.factReceiptId)
      assert.deepEqual(pendingWorld(replayed.database), pendingWorld(settled.database)); assert.deepEqual(replayed.gm.lastFactReceipt, settled.gm.lastFactReceipt); assert.deepEqual(replayed.factReview.rounds, settled.factReview.rounds); assert.deepEqual(replayed.factReview.decisions, settled.factReview.decisions)
      let written, presentationDeltas
      if (replayed.review.pendingDecision?.status === 'applied') {
        assert.equal(replayed.review.pendingDecision.operationId, decisionOperationId)
        await source.page.getByRole('button', { name: '刷新事实与写作状态', exact: true }).click()
        written = await clickOwner(source, 'resumeFactPresentation', () => source.page.getByRole('button', { name: '继续已批准事实的写作', exact: true }).click(), row => row.sessionId === sessionId && row.operationId === decisionOperationId && row.roundId === round.roundId)
        await source.idle(sessionId)
        const presented = await capture(source, sessionId); presentationDeltas = modelDeltas(replayed.models, presented.models)
        assert.equal(written.presentation.status, 'complete'); assert.equal(written.factReceiptId, resumed.decision.factReceiptId); assert.equal(presentationDeltas.revise, 0); assert.equal(presentationDeltas.writer, 1); assert.ok(presentationDeltas.gm > 0)
        assert.deepEqual(presented.snapshot.events.slice(replayed.snapshot.events.length).filter(row => row.type === 'tool/call').map(row => row.data.name), ['rp_present'])
      } else { assert.equal(nativeBoundary, false); acceptedProse(replayed, resumed.decision.factReceiptId) }
      const presented = await capture(source, sessionId), body = acceptedProse(presented, resumed.decision.factReceiptId)
      assertFixedOperationRetained(replayed, presented, fixedWorkAudit)
      assert.equal(presented.review.pendingDecision, null); assert.deepEqual(pendingWorld(presented.database), pendingWorld(replayed.database)); assert.deepEqual(presented.database.notes, before.database.notes); assert.deepEqual(presented.database.binding, before.database.binding)
      assert.deepEqual(presented.database.entries.filter(row => row.ref.sourceKey !== '@session'), before.database.entries.filter(row => row.ref.sourceKey !== '@session'))
      assert.equal(presented.history.records.some(row => row.factReceiptId === oldBody.factReceiptId), false)
      assert.ok(presented.gm.facts.items.some(row => row.id === 'native-marker' && row.text === 'FACT_REVISION_B'))
      preservePrefix(presented.snapshot, before.snapshot)
      await source.page.screenshot({ path: join(run, 'policy-off-generation-presented.png') })
      await write('policy-off-generation-resume.json', { sessionId, configuration, before, operationId, instruction, interrupted, afterAbort, generationEvidence, generationCommand, nativeBoundary, needsApplication, uiInstruction, fixedWorkAudit, resumed, settled, settleDeltas, decisionOperationId, decisionCommand, replay, replayed, replayDeltas, written, presentationDeltas, presented, body })
      revisedEvidence = { before, generationOperationId: operationId, decisionOperationId, decisionCommand, unpresented: replayed, presented, body }
      report.actions.push({ name: 'disable fact approval', deltas: modelDeltas(presentedBefore.models, before.models) }, { name: 'OFF generation completion interruption attempt', deltas: generationEvidence.deltas }, { name: 'OFF generation settlement resume', deltas: settleDeltas }, { name: 'OFF generation settlement replay', deltas: replayDeltas }, ...(presentationDeltas ? [{ name: 'explicit OFF fact presentation', deltas: presentationDeltas }] : []))
      return { sessionId, roundId: round.roundId, originalGenerationOperationId: operationId, mappedDecisionOperationId: decisionOperationId, candidateId: generationEvidence.candidate.id, factReceiptId: resumed.decision.factReceiptId, interruption: { status: nativeBoundary ? 'passed' : 'NOT NATIVELY VERIFIED', attemptCount: 1 }, presentation: body.ref, evidence: 'policy-off-generation-resume.json' }
    })
    await cases.run(APPROVAL_SCENARIOS[3], async () => {
      await source.idle(sessionId)
      const before = await capture(source, sessionId), originalBody = acceptedProse(before, before.gm.lastFactReceipt.id)
      const originalMaterial = await source.api('studio', 'material', { sessionId, presentationId: originalBody.ref.presentationId })
      const writerModels = new Set(['writer', 'writer-alt']), originalWriter = before.models.requests.findLast(row => writerModels.has(row.model))
      assert.ok(originalWriter); assert.deepEqual(originalWriter.input.packet, originalMaterial.packet); assert.equal(originalMaterial.models.render.model, 'writer')
      const previousWriter = before.models.requests.findLast(row => writerModels.has(row.model) && row.index < originalWriter.index)
      assert.ok(previousWriter)
      const effectiveRequests = before.models.requests.filter(row => row.index > previousWriter.index && row.index <= originalWriter.index)
      const materialAudit = effectiveMaterialAudit(before, originalMaterial, effectiveRequests)
      const readingBefore = await source.api('studio', 'exportReading', { sessionId, format: 'markdown' })
      assert.ok(readingBefore.text.includes(originalBody.text))
      for (const obsolete of materialAudit.superseded) assert.equal(readingBefore.text.includes(obsolete.text), false)
      const oldNote = authorNoteRecord(await source.api('studio', 'authorNote', { sessionId })); assert.equal(oldNote.status, 'consumed')
      assert.equal(oldNote.text, 'NATIVE_OLD_NOTE_CONSUMED_ON_CUSTOM')
      for (const request of effectiveRequests.filter(row => ['prepare', 'summarize', 'assembly', 'writer', 'writer-alt'].includes(row.model))) assert.equal(JSON.stringify(request.input).includes(oldNote.text), false, 'folded prose requeued the consumed author note')
      const pendingNote = await setNote(source, sessionId, 'NATIVE_NEW_NOTE_MUST_REMAIN_PENDING_DURING_WRITER_REGEN')
      const loopBefore = await source.probe('loop', { sessionId }), routes = await source.probe('routes', { sessionId, renderModel: 'writer-alt' }), loopAfter = await source.probe('loop', { sessionId })
      assert.equal(loopAfter.policies.session.routes['rp-last-step.render'].model, 'writer-alt')
      const regenerate = async (instruction, basedOn) => {
        await source.page.getByRole('button', { name: '刷新事实与写作状态', exact: true }).click()
        await source.page.getByRole('textbox', { name: '写作重生要求', exact: true }).fill(instruction)
        let request
        const result = await clickOwner(source, 'regenerateProse', () => source.page.locator('.rp-fact-tools').getByRole('button', { name: '只重新写作', exact: true }).click(), row => {
          if (row.sessionId !== sessionId || row.basedOn?.presentationId !== basedOn.presentationId || row.instruction !== instruction) return false
          request = structuredClone(row); return true
        })
        await source.idle(sessionId); return { request, result }
      }
      const preWriter = await capture(source, sessionId), first = await regenerate('NATIVE_WRITER_EXPRESSION_A', originalBody.ref), rewritten = await capture(source, sessionId)
      const firstBody = acceptedProse(rewritten, before.gm.lastFactReceipt.id), firstMaterial = await source.api('studio', 'material', { sessionId, presentationId: firstBody.ref.presentationId })
      const firstProof = writerRevision(preWriter, rewritten, { ...first, originalMaterial, material: firstMaterial, originalInput: originalWriter.input, operationId: first.request.operationId, instruction: first.request.instruction, model: 'writer-alt', basedOn: originalBody.ref })
      assertFixedOperationRetained(preWriter, rewritten, fixedWorkAudit)
      const afterFirstNote = authorNoteRecord(await source.api('studio', 'authorNote', { sessionId })); assert.equal(afterFirstNote.status, 'pending'); assert.equal(afterFirstNote.version, pendingNote.note.version)
      const armed = await source.probe('armOwnerPatch', { sessionId }), preDenial = await capture(source, sessionId)
      const denied = await regenerate('NATIVE_WRITER_SCOPE_GUARD', firstBody.ref), afterDenial = await capture(source, sessionId)
      assert.equal(denied.result.status, 'failed')
      const denialProof = writerScopeDenial(preDenial, afterDenial, armed, denied.request.operationId)
      assertFixedOperationRetained(preDenial, afterDenial, fixedWorkAudit)
      const afterDenialNote = authorNoteRecord(await source.api('studio', 'authorNote', { sessionId })); assert.equal(afterDenialNote.status, 'pending'); assert.equal(afterDenialNote.version, pendingNote.note.version)
      const nextWriter = await regenerate('NATIVE_WRITER_SCOPE_RELEASED', firstBody.ref), valid = await capture(source, sessionId)
      const validBody = acceptedProse(valid, before.gm.lastFactReceipt.id), validMaterial = await source.api('studio', 'material', { sessionId, presentationId: validBody.ref.presentationId })
      const validProof = writerRevision(afterDenial, valid, { ...nextWriter, originalMaterial: firstMaterial, material: validMaterial, originalInput: firstProof.request.input, operationId: nextWriter.request.operationId, instruction: nextWriter.request.instruction, model: 'writer-alt', basedOn: firstBody.ref })
      assertFixedOperationRetained(afterDenial, valid, fixedWorkAudit)
      const afterValidNote = authorNoteRecord(await source.api('studio', 'authorNote', { sessionId })); assert.equal(afterValidNote.status, 'pending'); assert.equal(afterValidNote.version, pendingNote.note.version)
      const readingAfter = await source.api('studio', 'exportReading', { sessionId, format: 'markdown' }), nativeReader = await source.studio('GET', `/api/v1/sessions/${sessionId}`)
      assert.ok(readingAfter.text.includes(validBody.text)); assert.ok(nativeReader.messages.some(row => row.text === validBody.text))
      for (const obsolete of materialAudit.superseded) { assert.equal(readingAfter.text.includes(obsolete.text), false); assert.equal(nativeReader.messages.some(row => row.text === obsolete.text), false) }
      for (const earlier of before.history.records.filter(row => row.factReceiptId !== before.gm.lastFactReceipt.id)) assert.ok(readingAfter.text.includes(earlier.text), 'legitimate earlier selected history disappeared')
      const preNext = await capture(source, sessionId); zeroModels(modelDeltas(valid.models, preNext.models)); assert.deepEqual(preNext.snapshot.events, valid.snapshot.events)
      const nextAction = 'NATIVE_APPROVAL_NEXT_SCOPE_RELEASE'
      await sendPlayer(source, sessionId, nextAction)
      const next = await capture(source, sessionId), stateResults = successfulToolResults(next.snapshot.events, 'rp_gm_state', preNext.snapshot.events.at(-1)?.seq ?? -1)
      assert.equal(stateResults.length, 1)
      const actualState = JSON.parse(textOf(stateResults[0].result.data.message)), observed = next.models.observedStates.findLast(row => row.action === nextAction)
      assert.equal(actualState.lastFactReceipt.id, preNext.gm.lastFactReceipt.id); assert.deepEqual(actualState.scene, preNext.gm.scene); assert.deepEqual(actualState.facts, preNext.gm.facts)
      assert.equal(observed.receiptId, actualState.lastFactReceipt.id); assert.equal(observed.revision, actualState.revision); assert.deepEqual(observed.scene, actualState.scene); assert.deepEqual(observed.facts, actualState.facts)
      const commits = successfulToolResults(next.snapshot.events, 'rp_commit_turn', preNext.snapshot.events.at(-1)?.seq ?? -1); assert.equal(commits.length, 1)
      const actualCommit = JSON.parse(commits[0].call.data.arguments)
      assert.equal(actualCommit.expectedRevision, actualState.revision); assert.deepEqual(actualCommit.scene, actualState.scene); assert.deepEqual(actualCommit.facts, actualState.facts)
      assert.deepEqual(next.review.latestRound.base, { scene: actualState.scene, facts: actualState.facts }); assert.equal(next.review.latestRound.capture.playerInput.text, nextAction)
      const nextProof = verifyAction({ ...preNext, narratives: preNext.canonical.records }, { ...next, narratives: next.canonical.records }, { text: nextAction, facts: preNext.gm.facts })
      assertFixedOperationRetained(preNext, next, fixedWorkAudit); preservePrefix(next.snapshot, preNext.snapshot)
      const consumedNote = authorNoteRecord(await source.api('studio', 'authorNote', { sessionId })); assert.equal(consumedNote.status, 'consumed'); assert.equal(consumedNote.version, pendingNote.note.version)
      await source.page.screenshot({ path: join(run, 'effective-writer-scope-released.png') })
      await write('effective-writer-scope.json', { sessionId, before, originalBody, originalMaterial, originalWriter, effectiveRequests, materialAudit, readingBefore, oldNote, pendingNote, loopBefore, routes, loopAfter, preWriter, first, rewritten, firstMaterial, firstProof, afterFirstNote, armed, preDenial, denied, afterDenial, denialProof, afterDenialNote, nextWriter, valid, validMaterial, validProof, afterValidNote, readingAfter, nativeReader, preNext, nextAction, actualState, observed, actualCommit, next, nextProof, consumedNote, fixedWorkAudit })
      report.actions.push({ name: 'writer regeneration current route', deltas: firstProof.deltas }, { name: 'writer scope forbidden real patch', deltas: denialProof.deltas }, { name: 'valid writer after denial', deltas: validProof.deltas }, { name: 'ordinary action after scope disposal', deltas: modelDeltas(preNext.models, next.models) })
      return { sessionId, selectedFactsDuringWriter: before.gm.lastFactReceipt.id, renderModel: firstMaterial.models.render, firstPresentation: firstProof.narrative.ref, guard: { code: denied.result.errorCode, callSeq: denialProof.call.seq, resultSeq: denialProof.rejection.seq }, validPresentation: validProof.narrative.ref, nextFactReceiptId: next.gm.lastFactReceipt.id, nextRoundId: next.review.latestRound.roundId, evidence: 'effective-writer-scope.json' }
    })
    await cases.run(APPROVAL_SCENARIOS[4], async () => {
      const parentBefore = await capture(source, sessionId), command = revisedEvidence.decisionCommand, selectedReceipt = revisedEvidence.presented.gm.lastFactReceipt
      await write('fork-parent-before.json', { sessionId, parentBefore }, { exclusive: true })
      const priorReceipt = revisedEvidence.before.gm.lastFactReceipt, beforeRun = parentBefore.snapshot.events.findLast(row => row.seq < command.run.seq).seq
      const cuts = [{ name: 'before-decision', atSeq: beforeRun, receipt: priorReceipt, state: revisedEvidence.before }, { name: 'run-only', atSeq: command.run.seq, receipt: priorReceipt, state: revisedEvidence.before }, { name: 'done-unpresented', atSeq: command.done.seq, receipt: selectedReceipt, state: revisedEvidence.presented }, { name: 'prose-appended', atSeq: revisedEvidence.body.ref.resultSeq, receipt: selectedReceipt, state: revisedEvidence.presented }]
      const forks = []
      for (const cut of cuts) {
        const created = await source.probe('approvalFork', { sessionId, atSeq: cut.atSeq }), evidenceName = `fork-${cut.name}-${cut.atSeq}-${encodeURIComponent(created.sessionId)}`
        await write(`${evidenceName}-created.json`, { cut, created }, { exclusive: true })
        const view = await capture(source, created.sessionId)
        await write(`${evidenceName}-captured.json`, { cut, created, view }, { exclusive: true })
        zeroModels(modelDeltas(parentBefore.models, view.models))
        const prefix = forkPrefix(view.snapshot, parentBefore.snapshot, cut.atSeq), group = view.factReviewProjection.groups.find(row => row.roundId === cut.receipt.factRoundId)
        assert.ok(group); assert.equal(group.activeReceiptId, cut.receipt.id); assert.equal(group.factRevision, cut.receipt.factRevision); assert.deepEqual(group.source, cut.receipt.source)
        assert.deepEqual(view.gm.scene, cut.state.gm.scene); assert.deepEqual(view.gm.facts, cut.state.gm.facts); assert.equal(view.review.generation, null)
        if (view.gm.lastFactReceipt) { assert.equal(view.gm.lastFactReceipt.id, cut.receipt.id); assert.deepEqual(view.gm.lastFactReceipt.source, cut.receipt.source); assert.deepEqual(view.gm.lastFactReceipt.stateRefs, cut.receipt.stateRefs) }
        if (cut.name === 'before-decision' || cut.name === 'run-only') {
          assert.equal(view.review.pendingDecision, null); assert.equal(view.history.records.some(row => row.factReceiptId === selectedReceipt.id), false)
          assert.ok(view.history.records.some(row => row.factReceiptId === priorReceipt.id))
        } else if (cut.name === 'done-unpresented') {
          assert.equal(view.review.pendingDecision?.status, 'applied'); assert.equal(view.review.pendingDecision.operationId, revisedEvidence.decisionOperationId); assert.equal(view.review.pendingDecision.factReceiptId, selectedReceipt.id)
          assert.equal(view.history.records.some(row => [selectedReceipt.id, priorReceipt.id].includes(row.factReceiptId)), false)
        } else {
          const body = view.history.records.find(row => row.ref.presentationId === revisedEvidence.body.ref.presentationId)
          assert.equal(body?.text, revisedEvidence.body.text); assert.equal(body.factReceiptId, selectedReceipt.id); assert.equal(view.review.pendingDecision, null)
        }
        const reader = await source.studio('GET', `/api/v1/sessions/${created.sessionId}`), selectedTexts = new Set(view.history.records.map(row => row.text))
        const afterReader = await source.snapshot(created.sessionId)
        await write(`${evidenceName}-reader.json`, { cut, created, reader, afterReader }, { exclusive: true })
        forkReaderUnchanged(view.snapshot, afterReader)
        for (const record of view.history.records) assert.ok(reader.messages.some(row => row.text === record.text), 'fork native reader omitted selected prefix prose')
        for (const record of parentBefore.canonical.records.filter(row => !selectedTexts.has(row.text))) assert.equal(reader.messages.some(row => row.text === record.text), false, 'fork native reader exposed superseded or future prose')
        forks.push({ ...cut, created, view, prefix, reader, afterReader })
      }
      const afterForks = await capture(source, sessionId); zeroModels(modelDeltas(parentBefore.models, afterForks.models))
      assert.deepEqual(durablePending(afterForks), durablePending(parentBefore)); assert.deepEqual(afterForks.snapshot.events, parentBefore.snapshot.events); assert.deepEqual(afterForks.gm.lastFactReceipt, parentBefore.gm.lastFactReceipt)
      const writingChild = forks.find(row => row.name === 'done-unpresented'), childId = writingChild.created.sessionId
      await source.probe('resume', { sessionId: childId })
      const beforeForbiddenResume = await capture(source, childId)
      zeroModels(modelDeltas(afterForks.models, beforeForbiddenResume.models)); assert.equal(beforeForbiddenResume.review.generation, null)
      await assert.rejects(source.api('studio', 'resumeFactGeneration', { sessionId: childId, operationId: revisedEvidence.generationOperationId }), error => error.code === 'OPERATION_NOT_FOUND')
      await assert.rejects(source.api('studio', 'resumeFactDecision', { sessionId: childId, operationId: revisedEvidence.decisionOperationId }), error => error.code === 'OPERATION_NOT_FOUND')
      const afterForbiddenResume = await capture(source, childId)
      zeroModels(modelDeltas(beforeForbiddenResume.models, afterForbiddenResume.models)); assert.deepEqual(durablePending(afterForbiddenResume), durablePending(beforeForbiddenResume)); assert.deepEqual(afterForbiddenResume.snapshot.events, beforeForbiddenResume.snapshot.events)
      await source.probe('routes', { sessionId: childId, renderModel: 'writer-alt' }); await source.openStudio(childId)
      await source.page.getByRole('button', { name: '刷新事实与写作状态', exact: true }).click()
      const childBefore = await capture(source, childId); zeroModels(modelDeltas(afterForbiddenResume.models, childBefore.models)); assert.equal(childBefore.gm.lastFactReceipt.id, selectedReceipt.id)
      const childWritten = await clickOwner(source, 'resumeFactPresentation', () => source.page.getByRole('button', { name: '继续已批准事实的写作', exact: true }).click(), row => row.sessionId === childId && row.roundId === selectedReceipt.factRoundId && row.operationId === revisedEvidence.decisionOperationId)
      await source.idle(childId)
      const childAfter = await capture(source, childId), childBody = acceptedProse(childAfter, selectedReceipt.id), childDeltas = modelDeltas(childBefore.models, childAfter.models)
      assert.equal(childWritten.presentation.status, 'complete'); assert.equal(childWritten.factReceiptId, selectedReceipt.id); assert.equal(childDeltas.revise, 0); assert.equal(childDeltas['writer-alt'], 1); assert.ok(childDeltas.gm > 0)
      assert.deepEqual(pendingWorld(childAfter.database), pendingWorld(childBefore.database)); assert.deepEqual(childAfter.factReview.rounds, childBefore.factReview.rounds); assert.deepEqual(childAfter.factReview.decisions, childBefore.factReview.decisions)
      assert.equal(childAfter.review.pendingDecision, null); assert.equal(childAfter.review.generation, null)
      const childSuffix = childAfter.snapshot.events.slice(childBefore.snapshot.events.length)
      assert.deepEqual(childSuffix.filter(row => row.type === 'tool/call').map(row => row.data.name), ['rp_present']); assert.equal(childSuffix.some(row => row.type === 'command/run' && ['rp-gm-fact-regenerate', 'rp-gm-fact-decision'].includes(row.data.name)), false)
      const parentMaterial = await source.api('studio', 'material', { sessionId, presentationId: revisedEvidence.body.ref.presentationId }), childMaterial = await source.api('studio', 'material', { sessionId: childId, presentationId: childBody.ref.presentationId })
      assert.equal(childMaterial.ownerOperation.kind, 'present-fact'); assert.notEqual(childMaterial.ownerOperation.operationId, parentMaterial.ownerOperation.operationId)
      assert.equal(childMaterial.ownerOperation.requestHash, ownerRequestHash({ schemaVersion: 1, kind: 'present-fact', sessionId: childId, factReceiptId: selectedReceipt.id }))
      assert.notEqual(childMaterial.ownerOperation.requestHash, parentMaterial.ownerOperation.requestHash)
      const parentAfter = await capture(source, sessionId)
      assert.deepEqual(durablePending(parentAfter), durablePending(parentBefore)); assert.deepEqual(parentAfter.snapshot, { ...parentBefore.snapshot, models: parentAfter.snapshot.models }); assert.deepEqual(parentAfter.gm.lastFactReceipt, parentBefore.gm.lastFactReceipt)
      await write('causal-forks.json', { sessionId, parentBefore, command, selectedReceipt, priorReceipt, forks, afterForks, childId, beforeForbiddenResume, afterForbiddenResume, childBefore, childWritten, childAfter, childDeltas, childBody, childMaterial, parentMaterial, parentAfter })
      report.actions.push({ name: 'four real inclusive GM forks', deltas: modelDeltas(parentBefore.models, afterForks.models) }, { name: 'reject parent-bound child recovery', deltas: modelDeltas(beforeForbiddenResume.models, afterForbiddenResume.models) }, { name: 'C12 child-owned inherited receipt writing', deltas: childDeltas })

      await source.openStudio(sessionId); await source.idle(sessionId)
      const completedSnapshot = (await source.api('studio', 'exportSavedStory', { sessionId })).snapshot, completedSource = await capture(source, sessionId)
      const completeHash = sha(completedSnapshot), pendingHash = sha(pendingSnapshot), transfers = []
      assert.notEqual(completeHash, pendingHash)
      for (const kind of ['pending', 'complete']) {
        const snapshot = kind === 'pending' ? pendingSnapshot : completedSnapshot, expected = kind === 'pending' ? pendingExportEvidence.saved : completedSource
        const expectedReceipt = kind === 'pending' ? pendingExportEvidence.baselineReceipt : completedSource.gm.lastFactReceipt, inputHash = sha(snapshot), ids = snapshot.sessions.map(row => row.header.id), restoreId = `approval-${kind}-${randomUUID()}`
        const savedSession = snapshot.sessions.find(row => row.header.id === sessionId), policy = snapshot.loopPolicies.find(row => row.sessionId === sessionId)?.policy
        assert.ok(savedSession && policy?.routes?.['rp-gm.revise']); assert.deepEqual(expected.snapshot.events, savedSession.events)
        let target = await open(`approval-restore-${kind}`)
        try {
          const beforePreview = await target.probe('witness', { sessionIds: ids }), preview = await target.api('studio', 'previewSavedStory', { snapshot }), afterPreview = await target.probe('witness', { sessionIds: ids })
          verifyUnchanged(beforePreview, afterPreview); assert.equal(preview.supported, true)
          assert.ok(preview.deferredChecks.some(row => row.code === 'LOOP_NODE_VALIDATION' && row.nodeIds.includes('rp-gm.revise')))
          const restored = await target.api('studio', 'restoreSavedStory', { snapshot, restoreId }); assert.equal(restored.status, 'complete', JSON.stringify(restored))
          const warm = await capture(target, sessionId); assert.equal(warm.models.total, 0); zeroModels(warm.models.counts); assert.deepEqual(durablePending(warm), durablePending(expected)); assert.deepEqual(warm.review.generation, expected.review.generation); assertReceiptProjection(warm, expectedReceipt)
          const loop = await target.probe('loop', { sessionId }), route = await target.probe('reviseRoute', { sessionId }), routeProof = restoredReviseRoute(policy, loop, route, warm.gm.binding)
          const replay = await target.api('studio', 'restoreSavedStory', { snapshot, restoreId }), replayed = await capture(target, sessionId)
          assert.equal(replay.status, 'complete'); assert.deepEqual(replayed.snapshot.events, warm.snapshot.events); assert.equal(replayed.models.total, 0)
          await target.probe('flush'); target = await restart(target)
          const cold = await capture(target, sessionId)
          const checkCold = view => {
            assert.equal(view.models.total, 0); zeroModels(view.models.counts); preservePrefix(view.snapshot, savedSession); assert.deepEqual(durablePending(view), durablePending(expected)); assert.deepEqual(view.review.generation, expected.review.generation); assertReceiptProjection(view, expectedReceipt)
            assert.ok(view.snapshot.events.slice(savedSession.events.length).every(row => row.type === 'session/end-seed'))
          }
          checkCold(cold); await target.openStudio(sessionId)
          const coldUi = await capture(target, sessionId); checkCold(coldUi)
          const reader = await target.studio('GET', `/api/v1/sessions/${sessionId}`), coldRead = await capture(target, sessionId); checkCold(coldRead); assert.deepEqual(coldRead.snapshot.events, coldUi.snapshot.events)
          for (const record of expected.history.records) assert.ok(reader.messages.some(row => row.text === record.text), 'restored selected prose missing from native reader')
          const selectedTexts = new Set(expected.history.records.map(row => row.text)), selectedRefs = new Set(expected.history.records.map(row => `${row.ref.presentationId}:${row.ref.resultSeq}`))
          for (const record of expected.canonical.records.filter(row => !selectedRefs.has(`${row.ref.presentationId}:${row.ref.resultSeq}`) && !selectedTexts.has(row.text))) assert.equal(reader.messages.some(row => row.text === record.text), false)
          const coldLoop = await target.probe('loop', { sessionId }), coldRoute = await target.probe('reviseRoute', { sessionId }); restoredReviseRoute(policy, coldLoop, coldRoute, coldRead.gm.binding)
          const transfer = { kind, inputHash, restoreId, preview, beforePreview, afterPreview, restored, warm, loop, route, routeProof, replay, cold, coldUi, reader, coldRead, coldLoop, coldRoute }
          await target.page.screenshot({ path: join(run, `restored-${kind}-cold.png`) })
          if (kind === 'pending') {
            const pendingId = coldRead.review.latestRound.pendingCandidateId, candidate = coldRead.review.latestRound.candidates.find(row => row.id === pendingId)
            assert.ok(candidate); assert.equal(coldRead.review.enabled, true)
            await target.probe('resume', { sessionId }); await target.page.getByRole('button', { name: '刷新事实与写作状态', exact: true }).click()
            const beforeApproval = await capture(target, sessionId); assert.equal(beforeApproval.models.total, 0)
            let approvalRequest
            const approved = await clickOwner(target, 'decideFacts', () => target.page.getByRole('button', { name: '通过并继续', exact: true }).click(), row => {
              if (row.decision?.sessionId !== sessionId || row.decision?.candidateId !== pendingId || row.decision?.action !== 'approve') return false
              approvalRequest = structuredClone(row); return true
            })
            await target.idle(sessionId)
            const continued = await capture(target, sessionId), approvalDeltas = modelDeltas(beforeApproval.models, continued.models), approvalCommand = commandProof(continued.snapshot.events, approvalRequest.decision.operationId, 'rp-gm-fact-decision')
            assert.equal(approved.status, 'approved'); assert.equal(approved.presentation.status, 'complete'); assert.equal(approvalDeltas.revise, 0); assert.ok(approvalDeltas.gm > 0); assert.equal(approvalDeltas.writer, 1)
            assert.deepEqual(continued.gm.scene, candidate.payload.scene); assert.deepEqual(continued.gm.facts, candidate.payload.facts); assert.equal(continued.gm.lastFactReceipt.candidateId, candidate.id)
            const body = acceptedProse(continued, approved.factReceiptId), restoredFixed = fixedOperationAudit(beforeApproval, continued, approvalCommand)
            preservePrefix(continued.snapshot, coldRead.snapshot); Object.assign(transfer, { beforeApproval, approvalRequest, approved, approvalDeltas, approvalCommand, continued, body, restoredFixed })
            report.actions.push({ name: 'restored pending native approval', deltas: approvalDeltas })
          } else {
            const group = coldRead.factReviewProjection.groups.find(row => row.roundId === selectedReceipt.factRoundId)
            assert.equal(group.activeReceiptId, selectedReceipt.id); assert.equal(group.factRevision, selectedReceipt.factRevision); assert.deepEqual(group.source, selectedReceipt.source)
            const beforeConflictPreview = await target.probe('witness', { sessionIds: ids }), conflict = await target.api('studio', 'previewSavedStory', { snapshot: pendingSnapshot }), beforeConflict = await target.probe('witness', { sessionIds: ids })
            assert.equal(conflict.supported, false); assert.ok(conflict.conflicts.some(row => row.code === 'RESTORE_ID_CONFLICT')); verifyUnchanged(beforeConflictPreview, beforeConflict)
            const conflictId = `approval-collision-${randomUUID()}`
            await assert.rejects(target.api('studio', 'restoreSavedStory', { snapshot: pendingSnapshot, restoreId: conflictId }), error => error.code === 'RESTORE_ID_CONFLICT')
            const afterConflict = await target.probe('witness', { sessionIds: ids }); verifyUnchanged(beforeConflict, afterConflict, { allowAuditRevision: true }); assert.equal(afterConflict.audit.some(row => row.restoreId === conflictId), false)
            await target.probe('resume', { sessionId })
            const beforeNext = await capture(target, sessionId); assert.equal(beforeNext.models.total, 0)
            const action = 'NATIVE_APPROVAL_NEXT_RESTORED'
            await sendPlayer(target, sessionId, action)
            const continued = await capture(target, sessionId), nextProof = verifyAction({ ...beforeNext, narratives: beforeNext.canonical.records }, { ...continued, narratives: continued.canonical.records }, { text: action, facts: beforeNext.gm.facts })
            const states = successfulToolResults(continued.snapshot.events, 'rp_gm_state', beforeNext.snapshot.events.at(-1)?.seq ?? -1); assert.equal(states.length, 1)
            const actualState = JSON.parse(textOf(states[0].result.data.message)), observed = continued.models.observedStates.findLast(row => row.action === action)
            assert.equal(actualState.lastFactReceipt.id, beforeNext.gm.lastFactReceipt.id); assert.deepEqual(actualState.facts, beforeNext.gm.facts); assert.deepEqual(actualState.scene, beforeNext.gm.scene)
            assert.equal(observed.receiptId, actualState.lastFactReceipt.id); assert.equal(observed.revision, actualState.revision); assert.deepEqual(observed.facts, actualState.facts); assert.deepEqual(continued.review.latestRound.base, { scene: actualState.scene, facts: actualState.facts })
            assert.equal(modelDeltas(beforeNext.models, continued.models)['writer-alt'], 1); assertFixedOperationRetained(beforeNext, continued, fixedWorkAudit)
            const legacy = await target.studio('POST', '/api/v1/sessions', { cardId: 'studio-legacy-fixture' }), legacyId = legacy.session.id
            assert.equal(await target.api('gm', 'binding', { sessionId: legacyId }), null); await target.openStudio(legacyId)
            const legacyBefore = await target.snapshot(legacyId); await sendPlayer(target, legacyId, 'NATIVE_C17_ORDINARY_LEGACY')
            const legacyRendered = await target.snapshot(legacyId), legacyDeltas = modelDeltas(legacyBefore.models, legacyRendered.models)
            assert.equal(legacyDeltas.gm, 1); zeroModels({ ...legacyDeltas, gm: 0 })
            const legacyHistory = await target.api('studio', 'storyHistory', { sessionId: legacyId }), legacyReader = await target.studio('GET', `/api/v1/sessions/${legacyId}`)
            assert.deepEqual(legacyHistory.records, []); assert.deepEqual(legacyHistory.folded, []); assert.ok(legacyReader.messages.some(row => row.text === 'NATIVE_C17_ORDINARY_LEGACY_BODY'))
            await expect(target.page.locator(`.dsh-rp-workspace[data-rp-session="${legacyId}"]`).getByText('NATIVE_C17_ORDINARY_LEGACY_BODY', { exact: true })).toBeVisible()
            const legacyRead = await target.snapshot(legacyId); zeroModels(modelDeltas(legacyRendered.models, legacyRead.models)); assert.deepEqual(legacyRead.events, legacyRendered.events); assert.equal(await target.api('gm', 'binding', { sessionId: legacyId }), null)
            await target.openStudio(sessionId)
            const currentBeforeRead = await capture(target, sessionId), currentReader = await target.studio('GET', `/api/v1/sessions/${sessionId}`), currentAfterRead = await capture(target, sessionId)
            zeroModels(modelDeltas(currentBeforeRead.models, currentAfterRead.models)); assert.deepEqual(currentAfterRead.snapshot.events, currentBeforeRead.snapshot.events)
            for (const record of currentAfterRead.history.records) assert.ok(currentReader.messages.some(row => row.text === record.text))
            Object.assign(transfer, { group, conflictId, conflict, beforeConflictPreview, beforeConflict, afterConflict, beforeNext, action, continued, nextProof, actualState, observed, legacyId, legacyBefore, legacyRendered, legacyDeltas, legacyHistory, legacyReader, legacyRead, currentBeforeRead, currentReader, currentAfterRead })
            report.actions.push({ name: 'restored completed explicit next action', deltas: modelDeltas(beforeNext.models, continued.models) }, { name: 'ordinary legacy native text', deltas: legacyDeltas }, { name: 'legacy zero-model reading', deltas: modelDeltas(legacyRendered.models, legacyRead.models) }, { name: 'restored current zero-model reading', deltas: modelDeltas(currentBeforeRead.models, currentAfterRead.models) })
          }
          assert.equal(sha(snapshot), inputHash); await target.page.screenshot({ path: join(run, `restored-${kind}-continued.png`) })
          await write(`opaque-${kind}-restore.json`, { snapshot, ...transfer }); transfers.push({ kind, inputHash, restoreId, evidence: `opaque-${kind}-restore.json`, coldModels: coldRead.models.counts })
        } catch (error) {
          try { await write(`opaque-${kind}-failure.json`, { error: redact(error.stack ?? error.message), inputHash, capture: await capture(target, sessionId), models: await target.probe('models') }); await target.page.screenshot({ path: join(run, `opaque-${kind}-failure.png`) }) } catch (cause) { report.evidenceErrors ??= []; report.evidenceErrors.push(redact(cause.message)) }
          throw error
        } finally { await finish(target) }
      }
      assert.equal(sha(completedSnapshot), completeHash); assert.equal(sha(pendingSnapshot), pendingHash)
      const parentFinal = await capture(source, sessionId); assert.deepEqual(durablePending(parentFinal), durablePending(completedSource)); assert.deepEqual(parentFinal.snapshot.events, completedSource.snapshot.events)
      await write('fork-saved-story-cold.json', { sessionId, completeHash, pendingHash, transfers, parentFinal, child: { childId, body: childBody.ref, ownerOperation: childMaterial.ownerOperation } })
      return { sessionId, forkCuts: forks.map(row => ({ name: row.name, ...row.prefix, selectedReceiptId: row.receipt.id })), childWriting: { sessionId: childId, presentation: childBody.ref, originalReadOnlyDecisionOperationId: revisedEvidence.decisionOperationId, childOwnerOperationId: childMaterial.ownerOperation.operationId }, transfers, opaqueInputsUnchanged: true, actualRouteAndActivation: true, ordinaryLegacyAndRestoredReading: true, evidence: 'fork-saved-story-cold.json' }
    })
    report.fullChain = { status: report.limitations.length ? 'checkpoint-passed-with-limitations' : 'checkpoint-passed', finalAcceptance: false, reason: 'All five bounded groups completed their assertions. This increment remains a source/native diagnostic checkpoint; coordinator final-manifest acceptance is separate. Public fault scheduling limitations are listed explicitly.' }
  } catch (error) {
    report.error = redact(error.stack ?? error.message).slice(0, 12000); report.fullChain = { status: 'failed', finalAcceptance: false }
    if (source) {
      try { await write('approval-failure-state.json', { sessionId, capture: sessionId ? await capture(source, sessionId) : null }); await source.page.screenshot({ path: join(run, 'approval-failure.png') }) }
      catch (cause) { report.evidenceErrors = [redact(cause.message)] }
    }
  } finally {
    const resources = [...active].map(context => ({ resource: `${context.name}:${context.hostPid}`, close: () => finish(context, true) }))
    resources.push({ resource: 'retrieval', close: () => provider.close() })
    const cleanup = await Promise.allSettled(resources.map(row => row.close()))
    report.cleanup = cleanup.map((result, index) => ({ resource: resources[index].resource, status: result.status, ...(result.status === 'rejected' ? { error: redact(result.reason?.message ?? result.reason) } : {}) }))
    report.scenarios = cases.snapshot()
    try { report.retrieval = provider.stats() } catch (error) { report.retrievalError = redact(error.message) }
    report.models = { total: report.segments.reduce((sum, row) => sum + (row.models?.total ?? 0), 0), counts: Object.fromEntries(['gm', 'revise', 'prepare', 'summarize', 'assembly', 'writer', 'writer-alt'].map(stage => [stage, report.segments.reduce((sum, row) => sum + (row.models?.counts[stage] ?? 0), 0)])) }
    if (cleanup.some(row => row.status === 'rejected') || report.retrievalError || report.segments.some(row => row.modelStatus !== 'recorded' || row.cleanupStatus !== 'stopped' || row.browserErrors.length || row.finalizationErrors?.length)) report.fullChain = { status: 'failed', finalAcceptance: false }
    await write('approval-result.json', report)
  }
  return report
}
