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
import { modelDeltas, zeroModels, pendingWorld, durablePending, assertReceiptProjection, successfulToolResults, terminalProposal, acceptedProse, preservePrefix } from './approval-proof.mjs'

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
  const provider = await startRetrievalProvider(), report = { schemaVersion: 1, scope: 'A029 installed-owner approval native scenarios; checkpoint 1 of 5', packages: staged.packages, scenarios: [], segments: [], actions: [], limitations: [], fullChain: { status: 'not-run', finalAcceptance: false } }
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
  let source, sessionId, pendingSnapshot
  try {
    source = await open('approval-source')
    const data = syntheticStoryData()
    await cases.run(APPROVAL_SCENARIOS[0], async () => {
      const sk = await source.api('storyKit', 'state')
      const imported = await source.api('storyKit', 'importAsset', { format: 'png', dataBase64: data.png.toString('base64'), expectedRevision: sk.revision })
      const world = await source.api('database', 'import', { name: 'Approval synthetic world', rawText: data.worldJson, expectedRevision: (await source.api('database', 'state')).revision })
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
    report.fullChain = { status: 'checkpoint-passed', finalAcceptance: false, reason: 'Only group 1 is implemented in this review checkpoint; groups 2–5 remain not-run.' }
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
