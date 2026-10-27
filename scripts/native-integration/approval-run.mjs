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
import { modelDeltas, zeroModels, pendingWorld, durablePending, assertReceiptProjection, successfulToolResults, terminalProposal, acceptedProse, preservePrefix, commandProof, generatedCandidate, approvedWithoutPresentation, stagedGeneration, fixedOperationAudit, assertFixedOperationRetained, ownerRequestHash, textOf } from './approval-proof.mjs'

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
  const provider = await startRetrievalProvider(), report = { schemaVersion: 1, scope: 'A029 installed-owner approval native scenarios; checkpoint 3 of 5', packages: staged.packages, scenarios: [], segments: [], actions: [], limitations: [], fullChain: { status: 'not-run', finalAcceptance: false } }
  const write = async (name, value) => writeFile(await ownedRunPath(workspace, run, join(run, name)), JSON.stringify(value, null, 2) + '\n')
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
  let source, sessionId, pendingSnapshot, worldSourceId, fixedWorkAudit
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
      report.actions.push({ name: 'disable fact approval', deltas: modelDeltas(presentedBefore.models, before.models) }, { name: 'OFF generation completion interruption attempt', deltas: generationEvidence.deltas }, { name: 'OFF generation settlement resume', deltas: settleDeltas }, { name: 'OFF generation settlement replay', deltas: replayDeltas }, ...(presentationDeltas ? [{ name: 'explicit OFF fact presentation', deltas: presentationDeltas }] : []))
      return { sessionId, roundId: round.roundId, originalGenerationOperationId: operationId, mappedDecisionOperationId: decisionOperationId, candidateId: generationEvidence.candidate.id, factReceiptId: resumed.decision.factReceiptId, interruption: { status: nativeBoundary ? 'passed' : 'NOT NATIVELY VERIFIED', attemptCount: 1 }, presentation: body.ref, evidence: 'policy-off-generation-resume.json' }
    })
    report.fullChain = { status: report.limitations.length ? 'checkpoint-passed-with-limitations' : 'checkpoint-passed', finalAcceptance: false, reason: 'Groups 1–3 are implemented in this review checkpoint; groups 4–5 remain not-run. Public fault scheduling limitations are listed separately.' }
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
