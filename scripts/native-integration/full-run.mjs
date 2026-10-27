import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect } from '@playwright/test'
import { syntheticStoryData } from './data-fixtures.mjs'
import { startRetrievalProvider } from './retrieval-provider.mjs'
import { scenarioState } from './scenario-state.mjs'
import { SCENARIOS, assessServices } from './requirements.mjs'
import { openNativeContext, waitForNative } from './contexts.mjs'
import { ownedRunPath } from './paths.mjs'
import { redact } from './host.mjs'
import { verifyAction, verifyColdBeforeAction, verifyRetryGuard, canonicalToolErrors } from './action-proof.mjs'
import { verifyDocumentCache } from './document-proof.mjs'
import { verifyUnchanged } from './witness-proof.mjs'

const hash = text => createHash('sha256').update(text).digest('hex')
const frozen = value => Object.fromEntries(['packet', 'contextPreparation', 'compiled', 'storySnapshot', 'factReceiptRef'].map(key => [key, value[key] ?? null]))
const header = value => ({ ...value, delegationDepth: value.delegationDepth === undefined ? 0 : value.delegationDepth })
const body = message => (message?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n')
const successfulFacts = events => {
  const calls = new Map(events.filter(event => event.type === 'tool/call').map(event => [event.data.callId, event.data.name]))
  return events.filter(event => event.type === 'tool/result' && event.data.message?.isError !== true && calls.get(event.data.message?.toolCallId) === 'rp_commit_turn')
}
function prefix(actual, expected) {
  assert.deepEqual(header(actual.header), header(expected.header)); assert.equal(actual.inheritedEventCount, expected.inheritedEventCount)
  assert.deepEqual(actual.events.slice(0, expected.events.length), expected.events)
  assert.ok(actual.events.slice(expected.events.length).every(event => event.type === 'session/end-seed'))
}
async function nativeClick(page, action, click, suffix = '/api/rp-studio/actions') {
  const response = page.waitForResponse(value => value.url().endsWith(suffix) && value.request().method() === 'POST' && value.request().postDataJSON()?.action === action)
  await click(); const value = await response, result = await value.json()
  if (value.status() >= 400 || result.error) throw new Error(JSON.stringify(result))
  return result
}
async function active(context, sessionId) {
  await context.idle(sessionId)
  return waitForNative(() => context.api('studio', 'gmState', { sessionId }), value => value.binding.status === 'active', 'GM active')
}
async function storyView(context, sessionId) {
  await context.openStudio(sessionId)
  await context.page.getByRole('button', { name: '沉浸阅读', exact: true }).click()
  const summary = context.page.locator('.rp-owner-tools > summary').filter({ hasText: '正文与材料' })
  await summary.waitFor(); if (!await summary.evaluate(element => element.parentElement.open)) await summary.click()
}
async function sendUi(context, sessionId, text, expected = {}) {
  await storyView(context, sessionId)
  const capture = async () => {
    const [gm, narratives, snapshot, models] = await Promise.all([context.api('studio', 'gmState', { sessionId }), context.api('studio', 'narratives', { sessionId }), context.snapshot(sessionId), context.probe('models')])
    return { gm, narratives: narratives.records, snapshot, models }
  }
  const before = await capture()
  let coldProof
  if (expected.coldBaseline) try { coldProof = verifyColdBeforeAction(before, expected.coldBaseline) }
  catch (error) { context.failedAction = { sessionId, before, expected: { text, ...expected } }; throw error }
  const received = context.page.waitForResponse(response => response.url().endsWith('/api/rp-studio/request') && response.request().postDataJSON()?.path?.endsWith('/messages'))
  await context.page.getByRole('textbox', { name: '写下你的行动', exact: true }).fill(text)
  await context.page.getByRole('button', { name: '发送行动 ↑', exact: true }).click()
  assert.equal((await received).status(), 200); await context.idle(sessionId)
  const after = await capture()
  try { context.actionProofs.push({ ...verifyAction(before, after, { text, ...expected }), ...(coldProof ? { coldBeforeClick: coldProof } : {}) }) }
  catch (error) { context.failedAction = { sessionId, before, after, expected: { text, ...expected } }; throw error }
}
async function bindStyle(context, sessionId, profile) {
  const state = await context.api('lastStep', 'state', { sessionId })
  await context.api('lastStep', 'bindSession', { sessionId, ...profile, expectedRevision: state.revision })
}
async function currentStyle(context, sessionId) { return (await context.api('lastStep', 'state', { sessionId })).binding }
async function note(context, sessionId, text) { const state = await context.api('context', 'state', { sessionId }); return context.api('studio', 'setAuthorNote', { sessionId, text, expectedRevision: state.revision }) }
async function latest(context, sessionId) { return (await context.api('studio', 'narratives', { sessionId })).records.at(-1) }
async function failed(context, sessionId, priorIds) { return waitForNative(() => context.api('studio', 'presentationSummaries', { sessionId }), value => value.presentations.some(item => !priorIds.has(item.presentationId) && item.status === 'failed'), 'failed presentation') }
const idsOf = summaries => new Set(summaries.presentations.map(row => row.presentationId))

export async function executeFullNative({ workspace, run, staged, cli, browserPath, diagnostic = false }) {
  if (staged.stage !== 'final') throw new Error('FULL_REQUIRES_APPROVED_FINAL_INPUTS')
  const data = syntheticStoryData(), provider = await startRetrievalProvider(), segments = [], report = { schemaVersion: 1, scope: diagnostic ? 'diagnostic real-package run; not final acceptance' : 'final real-package native acceptance', inputStage: staged.stage, packages: staged.packages, fullChain: { status: 'not-run' } }
  let source, destination
  const finalizations = new Map()
  const write = async (name, value) => writeFile(await ownedRunPath(workspace, run, join(run, name)), JSON.stringify(value, null, 2) + '\n')
  const cases = scenarioState(SCENARIOS, async rows => { report.scenarios = structuredClone(rows); await write('full-progress.json', report) })
  const open = async (name, existing) => {
    try {
      const context = await openNativeContext({ workspace, run, staged, cli, browserPath, providerURL: provider.baseURL, name, existing })
      segments.push({ name, hostPid: context.hostPid, installed: context.installed.installed, browserErrors: context.errors, httpErrors: context.httpErrors, actionProofs: context.actionProofs })
      return context
    } catch (error) { if (error.nativeStartup) segments.push({ ...error.nativeStartup, startupFailed: true, modelStatus: 'unavailable-during-startup' }); throw error }
  }
  const finish = context => {
    if (finalizations.has(context)) return finalizations.get(context)
    const operation = (async () => {
      const segment = segments.find(row => row.hostPid === context.hostPid)
      let failure
      try { segment.modelsOnClose = await context.probe('models'); segment.modelStatus = 'recorded' }
      catch (error) { segment.modelStatus = 'failed'; segment.counterError = redact(error.message); failure = error }
      try { await context.close(); segment.cleanupStatus = 'stopped' }
      catch (error) { segment.cleanupStatus = 'failed'; segment.cleanupError = redact(error.message); failure ??= error }
      if (failure) throw failure
    })()
    finalizations.set(context, operation); return operation
  }
  const restart = async context => {
    const name = context.name, installed = context.installed
    await finish(context); return open(name, installed)
  }
  let character, persona, cardRef, worldRef, worldSourceId, documentRefs, documentCacheProof, primaryId, selectedId, styles, initialStyle, firstNarrative, retryNarrative, adopted, generated, minimalId, minimalCharacter, minimalSnapshot, mainSnapshot, launchSources
  try {
    source = await open('home-a')
    report.hostVersion = source.installed.version
    const readiness = await source.probe('ready'), assessment = assessServices(readiness)
    report.readiness = readiness; report.assessment = assessment
    if (!assessment.interfacesReady) throw Object.assign(new Error(`FINAL_INTERFACES_NOT_READY:${JSON.stringify(assessment.deferred)}`), { deferred: true })
    await cases.run(SCENARIOS[0], async () => {
      const sk = await source.api('storyKit', 'state')
      const imported = await source.api('storyKit', 'importAsset', { format: 'png', dataBase64: data.png.toString('base64'), expectedRevision: sk.revision })
      const original = await source.api('storyKit', 'source', { sourceId: imported.sourceId })
      assert.equal(original.source.dataBase64, data.png.toString('base64')); assert.equal(original.source.sha256, hash(data.png))
      const db = await source.api('database', 'state'), descriptor = imported.embeddedWorldbooks[0]
      assert.equal(descriptor.rawText, data.cardJson)
      const linked = await source.api('storyKit', 'importWorldbook', { assetId: imported.assetId, version: imported.version, descriptorId: descriptor.id, expectedRevision: imported.revision, expectedDatabaseRevision: db.revision })
      cardRef = linked.databaseRef
      const world = await source.api('database', 'import', { name: 'Native world', rawText: data.worldJson, expectedRevision: (await source.api('database', 'state')).revision })
      worldRef = { key: 'world', databaseId: world.databaseId, version: world.version }
      worldSourceId = world.sourceId
      documentRefs = []
      for (const document of data.documents) {
        const result = await source.api('database', 'importDocument', { name: document.name, mimeType: document.mimeType, dataBase64: document.bytes.toString('base64'), expectedRevision: (await source.api('database', 'state')).revision, requestId: randomUUID() })
        const actual = await source.api('database', 'document', { documentId: result.documentId, version: result.version })
        assert.equal(actual.document.dataBase64, document.bytes.toString('base64')); assert.equal(actual.document.sha256, hash(document.bytes))
        if (document.mimeType === 'application/pdf') assert.ok(actual.extraction.chunks.some(chunk => chunk.ref.page === 2))
        documentRefs.push({ key: `document-${documentRefs.length}`, databaseId: result.databaseId, version: 1, documentId: result.documentId, documentVersion: result.version, originalHash: actual.document.sha256, chunks: actual.extraction.chunks })
      }
      styles = { B: await source.probe('style', { style: 'B' }), C: await source.probe('style', { style: 'C' }), D: await source.probe('style', { style: 'D' }) }
      const loaded = await source.api('storyKit', 'asset', { kind: 'character', assetId: imported.assetId, version: linked.version })
      const saved = await source.api('storyKit', 'saveCharacter', { character: { ...loaded.asset, profileRef: styles.C, databaseRefs: [cardRef, { key: 'document-default', databaseId: documentRefs[0].databaseId, version: 1 }] }, expectedRevision: loaded.revision })
      character = (await source.api('storyKit', 'asset', { kind: 'character', assetId: saved.assetId, version: saved.version })).asset
      const player = await source.api('storyKit', 'createPersona', { persona: data.persona, expectedRevision: (await source.api('storyKit', 'state')).revision })
      persona = { assetId: player.assetId, version: player.version }
      launchSources = [worldRef, cardRef]
      const launched = await source.api('storyKit', 'launch', { launchId: randomUUID(), character: { assetId: character.id, version: character.version }, persona, openingId: character.openings.find(opening => opening.text === data.opening).id, sources: launchSources, profile: null, initialScene: { ...data.initialScene, presentActorIds: [character.id] }, initialFacts: data.initialFacts })
      primaryId = launched.sessionId; const state = await active(source, primaryId); initialStyle = state.binding.profile
      const records = (await source.api('studio', 'narratives', { sessionId: primaryId })).records
      assert.equal(records.length, 1); assert.equal(records[0].text, data.opening)
      assert.equal((await source.probe('models')).counts.writer, 0)
      const snapshot = await source.snapshot(primaryId)
      assert.ok(snapshot.events.some(event => event.type === 'tool/call' && event.data.name === 'rp_begin_story'))
      assert.ok(snapshot.events.some(event => event.type === 'tool/call' && event.data.name === 'rp_present'))
      await source.probe('routes', { sessionId: primaryId }); await bindStyle(source, primaryId, styles.B)
      await write('opening.json', { launched, state, records, snapshot })
      return { sessionId: primaryId, opening: records[0].ref, sourceHash: original.source.sha256, defaultStyle: styles.C, launchStyle: initialStyle }
    })
    await cases.run(SCENARIOS[1], async () => {
      await source.probe('armConflict'); await source.probe('armMaterialGuard')
      await sendUi(source, primaryId, 'STUDIO_TRANSFER_LETTER：把信交给林遥。', { facts: { schemaVersion: 1, items: [{ id: 'letter-holder', text: '密封信件当前由林遥持有。' }] } })
      firstNarrative = await waitForNative(() => latest(source, primaryId), value => value?.text !== data.opening, 'first ordinary narrative')
      const state = await source.api('studio', 'gmState', { sessionId: primaryId }), snapshot = await source.snapshot(primaryId), models = await source.probe('models')
      assert.ok(state.facts.items.find(item => item.id === 'letter-holder').text.includes('林遥'))
      assert.equal(successfulFacts(snapshot.events).length, 1)
      assert.equal(models.conflicts.length, 1); assert.equal(models.conflicts[0].isError, true); assert.equal(models.conflicts[0].code, 'TURN_ALREADY_COMMITTED'); assert.equal(models.conflicts[0].receiptId, state.lastFactReceipt.id)
      assert.equal(models.conflicts[0].firstDatabaseRevision, models.conflicts[0].postRejectedRevision); assert.deepEqual(models.conflicts[0].stateRefs, state.lastFactReceipt.stateRefs)
      const errors = canonicalToolErrors(snapshot.events)
      assert.ok(errors.some(value => value?.error?.code === 'TURN_ALREADY_COMMITTED' && value.error.receiptId === state.lastFactReceipt.id))
      await write('facts-once.json', { state, snapshot, models }); return { receiptId: state.lastFactReceipt.id, actualErrorJSON: models.conflicts[0] }
    })
    await cases.run(SCENARIOS[2], async () => {
      const material = await source.api('studio', 'material', { sessionId: primaryId, presentationId: firstNarrative.ref.presentationId }), effective = await source.api('database', 'effectiveV2', { sessionId: primaryId }), models = await source.probe('models')
      const prepare = models.requests.filter(row => row.model === 'prepare')
      assert.ok(!prepare[0].candidateKeys.includes('["world","outside"]'))
      assert.ok(prepare.some(row => row.searchKeys?.includes('["world","outside"]')))
      assert.ok(prepare.some(row => row.readKeys?.includes('["world","0"]') && row.readKeys?.includes('["card","0"]')))
      assert.deepEqual(models.materialGuards, [{ code: 'FACT_OWNER_REQUIRED', workUnchanged: true }])
      assert.ok(JSON.stringify(effective.notes).includes('合法的合成选材备注。'))
      assert.ok(!effective.entries.find(row => row.ref.sourceKey === 'world' && row.ref.entryId === '0').content.includes('MIXED_SHOULD_NOT_STAGE'))
      assert.equal((await source.api('database', 'source', { sourceId: worldSourceId })).source.rawText, data.worldJson)
      assert.ok(material.contextPreparation.materials.entries.some(row => row.ref.sourceKey === 'card' && row.ref.entryId === '0'))
      assert.ok(material.contextPreparation.materials.entries.some(row => row.ref.sourceKey === 'world' && row.ref.entryId === 'readonly'))
      assert.ok(!JSON.stringify(material).includes('DISABLED_NATIVE_PROVIDER_SENTINEL'))
      let readOnlyRejection
      await assert.rejects(source.probe('readOnlyAttempt', { sessionId: primaryId }), error => { readOnlyRejection = { code: error.code, message: error.detail?.error?.message }; return error.code === 'READ_ONLY' })
      const afterReadOnly = await source.api('database', 'effectiveV2', { sessionId: primaryId }); assert.deepEqual(afterReadOnly, effective)
      await source.probe('editWorking', { sessionId: primaryId, text: effective.entries.find(row => row.ref.sourceKey === 'world' && row.ref.entryId === '0').content + '\nREAD_ONLY_DENIAL_VALID_WORK' })
      const afterLegal = await source.api('database', 'effectiveV2', { sessionId: primaryId })
      assert.ok(afterLegal.revision > afterReadOnly.revision); assert.ok(afterLegal.entries.find(row => row.ref.sourceKey === 'world' && row.ref.entryId === '0').content.includes('READ_ONLY_DENIAL_VALID_WORK'))
      assert.deepEqual(afterLegal.entries.find(row => row.ref.sourceKey === 'world' && row.ref.entryId === 'readonly'), effective.entries.find(row => row.ref.sourceKey === 'world' && row.ref.entryId === 'readonly'))
      await write('context-material.json', { material, effective, models, readOnlyRejection, afterReadOnly, afterLegal }); return { outsideSearch: true, qualifiedCollision: true, atomicFactDenial: true, actualReadOnlyDenial: readOnlyRejection.code, laterWorkingWrite: true }
    })
    await cases.run(SCENARIOS[3], async () => {
      const settings = await source.api('context', 'state', { sessionId: primaryId })
      await source.api('context', 'configure', { sessionId: primaryId, settings: { enabled: true, recentTurns: 1, maxChars: 24000, maxSteps: 12 }, expectedRevision: settings.revision })
      await note(source, primaryId, 'PRE_FREEZE_OWNER_NOTE')
      let summaries = await source.api('studio', 'presentationSummaries', { sessionId: primaryId }), old = idsOf(summaries)
      await source.probe('failAssemblyOnce'); await sendUi(source, primaryId, '编译前失败的已结算等待。', { presentation: 'failed', failureStage: 'assembly' })
      summaries = await failed(source, primaryId, old)
      const pre = summaries.presentations.find(row => !old.has(row.presentationId) && row.status === 'failed')
      assert.equal(pre.canRetry, false)
      assert.equal((await source.api('studio', 'authorNote', { sessionId: primaryId })).status, 'pending')
      const preMaterial = await source.api('studio', 'material', { sessionId: primaryId, presentationId: pre.presentationId }); assert.ok(!preMaterial.compiled)
      const settledBeforeRecovery = await source.api('database', 'effectiveV2', { sessionId: primaryId })
      await sendUi(source, primaryId, 'STUDIO_PRESENT_UNRESOLVED：仅完成上次已结算呈现。', { fact: 'same' })
      await waitForNative(() => source.api('studio', 'authorNote', { sessionId: primaryId }), value => value.status === 'consumed', 'pre-freeze note recovered')
      assert.equal((await source.api('database', 'effectiveV2', { sessionId: primaryId })).entries.find(row => row.ref.entryId === 'gm.facts').version, settledBeforeRecovery.entries.find(row => row.ref.entryId === 'gm.facts').version)
      const oldNote = await note(source, primaryId, 'FROZEN_OWNER_NOTE')
      old = idsOf(await source.api('studio', 'presentationSummaries', { sessionId: primaryId }))
      await source.probe('failWriterOnce'); await sendUi(source, primaryId, '冻结后正文失败的等待。', { presentation: 'failed', failureStage: 'writer' })
      summaries = await failed(source, primaryId, old)
      const failure = summaries.presentations.find(row => !old.has(row.presentationId) && row.status === 'failed')
      assert.equal(failure.canRetry, true); assert.equal(summaries.capabilities.retryDispatch, true)
      const frozenBefore = await source.api('studio', 'material', { sessionId: primaryId, presentationId: failure.presentationId }); assert.ok(frozenBefore.compiled)
      await source.probe('editWorking', { sessionId: primaryId, text: 'OWNER_CHANGED_WORKING_MATERIAL_AFTER_FREEZE' })
      assert.equal((await source.api('database', 'effectiveV2', { sessionId: primaryId })).entries.find(row => row.ref.sourceKey === 'world' && row.ref.entryId === '0').content, 'OWNER_CHANGED_WORKING_MATERIAL_AFTER_FREEZE')
      const newNote = await note(source, primaryId, 'NEW_NOTE_MUST_REMAIN_PENDING')
      const before = await source.probe('models'), dbBefore = await source.api('database', 'effectiveV2', { sessionId: primaryId })
      const beforeDenial = await source.snapshot(primaryId)
      await source.probe('retryMode', { mode: 'wrong' })
      const denied = await source.api('studio', 'retryPresentation', { sessionId: primaryId, presentationId: failure.presentationId })
      assert.equal(denied.result.kind, 'error')
      const deniedModels = await source.probe('models'); assert.equal(deniedModels.counts.writer, before.counts.writer); assert.equal(deniedModels.counts.gm, before.counts.gm + 1)
      const deniedSnapshot = await source.snapshot(primaryId), attempt = deniedSnapshot.events.find(event => event.seq > beforeDenial.events.at(-1).seq && event.type === 'tool/call' && event.data.name === 'rp_present')
      assert.ok(attempt); assert.deepEqual(JSON.parse(attempt.data.arguments), { rewriteOf: 'not-the-selected-failed-presentation' })
      const rejection = deniedSnapshot.events.find(event => event.type === 'tool/result' && event.data.message?.toolCallId === attempt.data.callId)
      verifyRetryGuard(attempt, rejection, failure.presentationId)
      assert.match(denied.result.text, /^RETRY_DISPATCH_FAILED:/u)
      assert.deepEqual((await source.api('database', 'effectiveV2', { sessionId: primaryId })).entries, dbBefore.entries)
      await source.probe('retryMode', { mode: 'proper' }); await storyView(source, primaryId)
      await source.page.getByRole('button', { name: '刷新正文操作', exact: true }).click()
      const failureRow = source.page.locator('.rp-receipt').filter({ hasText: failure.presentationId })
      const retryButton = failureRow.getByRole('button', { name: '重试该次正文', exact: true }); await expect(retryButton).toBeEnabled()
      const retried = await nativeClick(source.page, 'retryPresentation', () => retryButton.click())
      assert.notEqual(retried.result.kind, 'error'); await source.idle(primaryId)
      retryNarrative = await waitForNative(() => latest(source, primaryId), value => value?.factReceiptId === failure.factReceiptId, 'accepted frozen retry')
      const after = await source.probe('models')
      assert.equal(after.counts.gm, deniedModels.counts.gm + 1); assert.equal(after.counts.writer, deniedModels.counts.writer + 1)
      for (const stage of ['prepare', 'summarize', 'assembly']) assert.equal(after.counts[stage], before.counts[stage])
      const retryMaterial = await source.api('studio', 'material', { sessionId: primaryId, presentationId: retryNarrative.ref.presentationId })
      assert.deepEqual(frozen(retryMaterial), frozen(frozenBefore))
      const currentNote = await source.api('studio', 'authorNote', { sessionId: primaryId }); assert.equal(currentNote.version, newNote.note.version); assert.equal(currentNote.status, 'pending')
      const audit = await source.probe('contextAudit', { sessionIds: [primaryId] }), claim = audit.payload.sessions[0].state.noteClaims[frozenBefore.contextPreparation.authorNote.claimId]
      assert.equal(claim.status, 'consumed'); assert.equal(claim.note.version, oldNote.note.version); assert.equal(claim.outcomePresentationId, retryNarrative.ref.presentationId)
      assert.deepEqual((await source.api('database', 'effectiveV2', { sessionId: primaryId })).entries, dbBefore.entries)
      await write('frozen-retry.json', { pre, preMaterial, failure, frozenBefore, retryMaterial, denied, denialProof: { attempt, rejection }, before, after, audit, currentNote }); return { failedId: failure.presentationId, retry: retryNarrative.ref, deniedDispatch: denied.result.kind, oldClaimConsumed: true, newNotePending: true }
    })
    await cases.run(SCENARIOS[4], async () => {
      await storyView(source, primaryId)
      const before = await source.probe('models')
      const manual = await nativeClick(source.page, 'createDraft', () => source.page.getByRole('button', { name: '手改当前正文', exact: true }).click())
      const manualText = '采用稿：林遥依约保管密封信件，雨声仍在门外。'
      await source.page.getByRole('textbox', { name: '候选正文', exact: true }).fill(manualText)
      const edited = await nativeClick(source.page, 'editDraft', () => source.page.getByRole('button', { name: '保存候选修改', exact: true }).click())
      assert.equal((await source.probe('models')).total, before.total)
      await assert.rejects(source.api('studio', 'adoptDraft', { sessionId: primaryId, draftId: edited.id, expectedDraftVersion: manual.version, expectedNarrative: retryNarrative.ref }), error => error.code === 'DRAFT_VERSION_CONFLICT')
      assert.deepEqual((await latest(source, primaryId)).ref, retryNarrative.ref)
      const button = source.page.getByRole('button', { name: '采用这个候选', exact: true }); await expect(button).toBeEnabled()
      adopted = (await nativeClick(source.page, 'adoptDraft', () => button.click())).narrative
      assert.equal(adopted.text, manualText); assert.equal((await source.probe('models')).total, before.total)
      const snapshot = await source.snapshot(primaryId), result = snapshot.events.find(event => event.seq === adopted.ref.resultSeq)
      assert.equal(body(result.data.message), manualText); assert.notEqual(result.data.meta.rpLastStep.record.text, manualText)
      assert.equal(snapshot.events.findLast(event => event.type === 'turn/end').data.reason.kind, 'blocked')
      const reader = await source.studio('GET', `/api/v1/sessions/${primaryId}`); assert.ok(reader.messages.some(message => message.text === manualText))
      const originalMaterial = await source.api('studio', 'material', { sessionId: primaryId, presentationId: adopted.ref.presentationId })
      await source.probe('routes', { sessionId: primaryId, renderModel: 'writer-alt' })
      generated = await source.api('studio', 'createDraft', { sessionId: primaryId, basedOn: adopted.ref, kind: 'writer', instruction: 'STUDIO_NATIVE_ALTERNATIVE' })
      assert.equal(generated.models.render.provider, 'studio-native-local'); assert.equal(generated.models.render.model, 'writer-alt')
      assert.deepEqual(frozen(await source.api('studio', 'material', { sessionId: primaryId, presentationId: adopted.ref.presentationId })), frozen(originalMaterial))
      assert.ok(!(await source.api('studio', 'exportReading', { sessionId: primaryId, format: 'markdown' })).text.includes(generated.text))
      await write('adoption.json', { manual, edited, adopted, generated, snapshot, reader }); return { adopted: adopted.ref, currentRenderModel: generated.models.render, blockedMaintenanceRetained: true }
    })
    await cases.run(SCENARIOS[5], async () => {
      await sendUi(source, primaryId, '普通行动：继续等待，确认 retry scope 已解除。')
      await sendUi(source, primaryId, '普通行动：再看一眼客栈，让上一轮成为旧历史。')
      const models = await source.probe('models')
      assert.ok(models.requests.filter(row => row.model === 'summarize').some(row => row.history?.some(item => item.id === adopted.id && item.textHash === hash(adopted.text))))
      const later = await latest(source, primaryId), laterMaterial = await source.api('studio', 'material', { sessionId: primaryId, presentationId: later.ref.presentationId })
      const adoptedSummary = laterMaterial.contextPreparation.materials.history.find(row => row.id === adopted.id)
      assert.equal(adoptedSummary?.mode, 'summary'); assert.ok(adoptedSummary.content.includes(adopted.text))
      await bindStyle(source, primaryId, styles.D)
      await source.openStudio(primaryId)
      const forkResponse = source.page.waitForResponse(response => response.url().endsWith('/api/rp-studio/request') && response.request().postDataJSON()?.path?.endsWith('/fork'))
      await source.page.getByRole('button', { name: '分支', exact: true }).click(); const forked = (await (await forkResponse).json()).data
      await source.page.locator(`.dsh-rp-workspace[data-rp-session="${forked.session.id}"]`).waitFor()
      await source.page.locator('.rp-empty').waitFor({ state: 'hidden' })
      assert.equal((await currentStyle(source, forked.session.id)).profileId, styles.B.profileId)
      await source.openStudio(primaryId)
      const rollbackResponse = source.page.waitForResponse(response => response.url().endsWith('/api/rp-studio/request') && response.request().postDataJSON()?.path?.endsWith('/rollback'))
      await source.page.getByRole('button', { name: '回退', exact: true }).click(); const rolled = (await (await rollbackResponse).json()).data
      selectedId = rolled.sessionId; assert.ok(selectedId && selectedId !== primaryId)
      assert.equal((await currentStyle(source, selectedId)).profileId, styles.B.profileId)
      assert.equal((await source.api('studio', 'gmState', { sessionId: selectedId })).binding.profile.profileId, initialStyle.profileId)
      await source.probe('routes', { sessionId: selectedId, renderModel: 'writer' })
      const effective = await source.api('database', 'effectiveV2', { sessionId: selectedId })
      const sources = [...effective.binding.sources, ...documentRefs.map(({ key, databaseId, version }) => ({ key, databaseId, version }))]
      await source.api('database', 'bindSources', { sessionId: selectedId, sources, expectedRevision: effective.revision, resetOverlay: false })
      const state = await source.api('studio', 'gmState', { sessionId: selectedId }); assert.deepEqual(state.binding.sources, launchSources)
      const cacheQuery = 'studio-cache-probe-query', beforeRevision = await source.api('database', 'contentRevision')
      const beforeIndex = await source.api('database', 'indexState'), documentEntries = (await source.api('database', 'effectiveV2', { sessionId: selectedId })).entries.filter(row => documentRefs.some(ref => row.ref.sourceKey === ref.key))
      provider.phase('source-before-cold-index')
      const warmResults = [await source.api('database', 'searchV2', { sessionId: selectedId, query: cacheQuery, limit: 100 }), await source.api('database', 'searchV2', { sessionId: selectedId, query: cacheQuery, limit: 100 })]
      const warmRevision = await source.api('database', 'contentRevision'), warmIndex = await source.api('database', 'indexState')
      assert.deepEqual(warmRevision, beforeRevision)
      await source.probe('flush')
      const snapshots = await Promise.all([primaryId, selectedId].map(id => source.snapshot(id)))
      source = await restart(source)
      for (const expected of snapshots) prefix(await source.snapshot(expected.header.id), expected)
      assert.equal((await source.probe('models')).total, 0)
      provider.phase('source-after-cold-index')
      const coldResult = await source.api('database', 'searchV2', { sessionId: selectedId, query: cacheQuery, limit: 100 })
      const coldEmbeddings = provider.stats().requests.filter(row => row.phase === 'source-after-cold-index' && row.path.endsWith('/embeddings'))
      assert.ok(coldEmbeddings.length > 0); assert.ok(coldEmbeddings.every(row => row.inputHashes.every(digest => digest === hash(cacheQuery))))
      const coldRevision = await source.api('database', 'contentRevision')
      documentCacheProof = verifyDocumentCache({ databaseHash: staged.packages.find(row => row.name === 'dsh-rp-database').sha256, query: cacheQuery, documents: documentRefs, entries: documentEntries, warmResults, coldResult, requests: provider.stats().requests, beforeIndex, warmIndex, revisions: [beforeRevision, warmRevision, coldRevision] })
      await source.probe('resume', { sessionId: selectedId }); assert.equal((await source.probe('models')).total, 0)
      const sourceColdBaseline = { snapshot: await source.snapshot(selectedId), receiptId: (await source.api('studio', 'gmState', { sessionId: selectedId })).lastFactReceipt.id }
      await sendUi(source, selectedId, '冷启动后明确继续当前故事。', { coldBaseline: sourceColdBaseline })
      assert.equal((await currentStyle(source, selectedId)).profileId, styles.B.profileId)
      await write('branch-cold.json', { primaryId, selectedId, forkId: forked.session.id, snapshots, state, coldEmbeddings, models, adoptedSummary, documentCacheProof, warmResults, coldResult, documentEntries }); return { selectedId, exactColdPrefix: true, historicalModelRequests: 0, currentSourcesAuthoritativeInDatabase: true }
    })
    await cases.run(SCENARIOS[6], async () => {
      const state = await source.api('database', 'indexState'), requests = provider.stats().requests
      assert.ok(requests.some(row => row.path.endsWith('/embeddings'))); assert.ok(requests.some(row => row.path.endsWith('/rerank')))
      assert.ok(requests.every(row => !row.disabledSentinelSeen))
      assert.ok(documentCacheProof.chunks.length >= documentRefs.length)
      await write('document-cache.json', { documents: documentRefs, state, proof: documentCacheProof, provider: provider.stats() }); return { originals: true, actualLocalHttp: true, coldCacheProof: 'branch-cold.json', exactDocumentChunks: documentCacheProof.chunks, disabledProviderBodies: 0 }
    })
    await cases.run(SCENARIOS[7], async () => {
      const template = { id: 'native-template', title: 'Imported minimal override', character: { assetId: character.id, version: character.version }, persona, openingId: character.openings.find(opening => opening.text === data.opening).id, sources: [], profile: null, initialScene: data.initialScene, initialFacts: { schemaVersion: 1, items: [] } }
      const pack = (await source.api('storyKit', 'exportPack', { characters: [template.character], personas: [persona], templates: [template] })).pack
      const imported = await source.api('storyKit', 'importPack', { pack, expectedRevision: (await source.api('storyKit', 'state')).revision })
      const mapped = imported.mappings.assets[JSON.stringify([character.id, character.version])], player = imported.mappings.assets[JSON.stringify([persona.assetId, persona.version])]
      assert.notEqual(mapped.assetId, character.id); assert.notEqual(player.assetId, persona.assetId)
      const loaded = await source.api('storyKit', 'asset', { kind: 'character', assetId: mapped.assetId, version: mapped.version })
      const renamed = await source.api('storyKit', 'saveCharacter', { character: { ...loaded.asset, name: '内容包最小覆盖故事' }, expectedRevision: loaded.revision })
      minimalCharacter = (await source.api('storyKit', 'asset', { kind: 'character', assetId: renamed.assetId, version: renamed.version })).asset
      assert.equal((await source.api('lastStep', 'profile', { profileId: minimalCharacter.profileRef.profileId, version: minimalCharacter.profileRef.version })).profile.status, 'draft')
      await source.page.getByRole('button', { name: '打开 Story Kit', exact: true }).first().click()
      const panel = source.page.locator('[data-story-kit-root]')
      await panel.locator('.rpsk-library button').filter({ hasText: minimalCharacter.name }).click()
      await panel.getByRole('combobox', { name: '选择玩家身份', exact: true }).selectOption(JSON.stringify([player.assetId, player.version]))
      await panel.getByRole('combobox', { name: '选择开场', exact: true }).selectOption(minimalCharacter.openings.find(opening => opening.text === data.opening).id)
      const launch = panel.getByRole('region', { name: '审阅并开始故事', exact: true })
      await launch.getByRole('textbox', { name: '初始场景标题', exact: true }).fill('最小覆盖')
      await launch.getByRole('textbox', { name: '初始位置', exact: true }).fill('港口')
      while (await launch.getByRole('button', { name: /移除来源/u }).count()) await launch.getByRole('button', { name: /移除来源/u }).first().click()
      await launch.getByRole('combobox', { name: '启动预设', exact: true }).selectOption('builtin')
      await launch.getByRole('checkbox', { name: '已审阅初始场景与事实', exact: true }).check()
      const result = await nativeClick(source.page, 'launch', () => launch.getByRole('button', { name: '开始故事', exact: true }).click(), '/api/rp-story-kit/request')
      minimalId = result.sessionId; await active(source, minimalId)
      assert.deepEqual((await source.api('database', 'effectiveV2', { sessionId: minimalId })).binding.sources, [])
      assert.equal((await currentStyle(source, minimalId)).profileId, initialStyle.profileId)
      assert.equal((await latest(source, minimalId)).text, data.opening)
      // Newer library versions must not replace the Character's pinned defaults.
      for (const ref of minimalCharacter.databaseRefs) { const value = await source.api('database', 'database', { databaseId: ref.databaseId, version: ref.version }); await source.api('database', 'save', { database: { ...value.database, name: `${value.database.name} newer`, entries: value.database.entries.map((entry, index) => index ? entry : { ...entry, content: entry.content + '\nNEWER_NOT_PINNED' }) }, expectedRevision: value.revision }) }
      const profile = await source.api('lastStep', 'profile', { profileId: minimalCharacter.profileRef.profileId, version: minimalCharacter.profileRef.version })
      await source.api('lastStep', 'saveProfile', { profile: { ...profile.profile, entries: profile.profile.entries.map((entry, index) => index ? entry : { ...entry, content: entry.content + '\nNEWER_NOT_PINNED' }) }, expectedRevision: profile.revision })
      await write('content-pack.json', { pack, imported, minimalId, minimalCharacter }); return { mappedCharacter: mapped, mappedPersona: player, explicitEmptySources: true, builtinOverride: true }
    })
    await cases.run(SCENARIOS[8], async () => {
      const exportSnapshot = async sessionId => (await source.api('studio', 'exportSavedStory', { sessionId })).snapshot
      minimalSnapshot = await exportSnapshot(minimalId)
      await storyView(source, selectedId)
      const sourceWitness = await source.probe('witness', { sessionIds: [primaryId, selectedId] })
      const configuredLoops = await Promise.all([primaryId, selectedId].map(async sessionId => ({ sessionId, view: await source.probe('loop', { sessionId }) })))
      const mainResult = await nativeClick(source.page, 'exportSavedStory', () => source.page.getByRole('button', { name: '导出完整存档', exact: true }).click())
      mainSnapshot = mainResult.snapshot
      assert.ok(mainSnapshot.sessions.some(session => session.header.id === primaryId)); assert.ok(mainSnapshot.sessions.some(session => session.header.id === selectedId))
      const roles = ref => mainSnapshot.dependencySummary.profiles.filter(row => row.profileId === ref.profileId && row.version === ref.version).flatMap(row => row.uses).sort()
      assert.deepEqual(roles(styles.B), ['current-binding']); assert.deepEqual(roles(styles.C), ['asset-default']); assert.deepEqual(roles(initialStyle), []); assert.deepEqual(roles(styles.D), [])
      for (const configured of configuredLoops) {
        const saved = mainSnapshot.loopPolicies.find(row => row.sessionId === configured.sessionId)
        assert.ok(saved, 'configured source policy missing from new export'); assert.deepEqual(saved.policy, configured.view.policies.session)
      }
      const mainIds = mainSnapshot.sessions.map(session => session.header.id), mainInputHash = hash(JSON.stringify(mainSnapshot))
      const verifyRestoredBindings = async () => {
        const witness = await destination.probe('witness', { sessionIds: mainIds })
        for (const expected of sourceWitness.sessions) {
          const actual = witness.sessions.find(row => row.sessionId === expected.sessionId)
          assert.ok(actual?.exists); assert.deepEqual(actual.databaseBinding, expected.databaseBinding)
          assert.deepEqual(actual.gm.sources, expected.gm.sources); assert.deepEqual(actual.gm.profile, expected.gm.profile); assert.equal(actual.gm.status, 'active')
        }
        for (const ref of launchSources) { const value = await destination.api('database', 'database', { databaseId: ref.databaseId, version: ref.version }); assert.equal(value.database.id, ref.databaseId); assert.equal(value.database.version, ref.version) }
        return witness
      }
      destination = await open('home-b')
      const minimalInput = structuredClone(minimalSnapshot); delete minimalInput.dependencySummary
      const minimalJob = 'studio-minimal-' + randomUUID(), mainJob = 'studio-main-' + randomUUID()
      const minimalBeforePreview = await destination.probe('witness', { sessionIds: minimalSnapshot.sessions.map(session => session.header.id) })
      const previewMinimal = await destination.api('studio', 'previewSavedStory', { snapshot: minimalInput }); assert.equal(previewMinimal.supported, true)
      const minimalAfterPreview = await destination.probe('witness', { sessionIds: minimalSnapshot.sessions.map(session => session.header.id) }); verifyUnchanged(minimalBeforePreview, minimalAfterPreview)
      assert.equal((await destination.api('studio', 'restoreSavedStory', { snapshot: minimalInput, restoreId: minimalJob })).status, 'complete')
      assert.equal((await destination.probe('models')).total, 0)
      for (const ref of minimalCharacter.databaseRefs) {
        const original = await source.api('database', 'database', { databaseId: ref.databaseId, version: ref.version }), actual = await destination.api('database', 'database', { databaseId: ref.databaseId, version: ref.version })
        assert.deepEqual(actual.database, original.database)
        const sourceId = (await source.api('database', 'state')).databases.find(row => row.id === ref.databaseId)?.sourceId
        assert.ok(sourceId)
        assert.deepEqual((await destination.api('database', 'source', { sourceId })).source, (await source.api('database', 'source', { sourceId })).source)
      }
      assert.deepEqual((await destination.api('database', 'effectiveV2', { sessionId: minimalId })).binding.sources, [])
      assert.equal((await currentStyle(destination, minimalId)).profileId, initialStyle.profileId)
      assert.equal((await currentStyle(destination, minimalId)).version, initialStyle.version)
      assert.deepEqual((await destination.api('lastStep', 'profile', minimalCharacter.profileRef)).profile, (await source.api('lastStep', 'profile', minimalCharacter.profileRef)).profile)
      const mainBeforePreview = await destination.probe('witness', { sessionIds: mainIds })
      const preview = await destination.api('studio', 'previewSavedStory', { snapshot: mainSnapshot }); assert.equal(preview.supported, true); assert.ok(preview.deferredChecks.length > 0)
      const mainAfterPreview = await destination.probe('witness', { sessionIds: mainIds }); verifyUnchanged(mainBeforePreview, mainAfterPreview)
      await destination.probe('armMetadataPause', { sessionId: selectedId })
      await destination.page.evaluate(snapshot => {
        const controller = new AbortController(); window.__fullRestore = { controller, state: 'running' }
        void fetch('/api/rp-studio/actions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(snapshot), signal: controller.signal }).then(async response => { window.__fullRestore.state = 'settled'; window.__fullRestore.result = await response.json() }).catch(error => { window.__fullRestore.state = error.name })
      }, { action: 'restoreSavedStory', snapshot: mainSnapshot, restoreId: mainJob })
      const pause = await waitForNative(() => destination.probe('metadataPause'), value => value?.entered && !value.timedOut, 'post-create preactivation metadata pause', 12000)
      assert.equal(pause.bindingStatus, 'restoring'); assert.equal(pause.actualAgentId, selectedId)
      await destination.page.evaluate(() => window.__fullRestore.controller.abort())
      await destination.probe('releaseMetadataPause')
      const pendingAudit = await waitForNative(() => destination.probe('storyKitAudit', { sessionIds: mainSnapshot.sessions.map(session => session.header.id) }), value => value.payload.journalAudit.some(row => row.restoreId === mainJob && row.status === 'pending'), 'real pending owner journal')
      const pendingRow = pendingAudit.payload.journalAudit.find(row => row.restoreId === mainJob)
      assert.deepEqual(Object.keys(pendingRow).sort(), ['fingerprint', 'restoreId', 'sessionIds', 'status']); assert.deepEqual([...pendingRow.sessionIds].sort(), [...mainIds].sort()); assert.match(pendingRow.fingerprint, /^[a-f0-9]{64}$/u)
      const pendingWitness = await destination.probe('witness', { sessionIds: mainIds })
      for (const session of mainSnapshot.sessions) { const actual = pendingWitness.sessions.find(row => row.sessionId === session.header.id); assert.equal(actual.exists, true); assert.equal(actual.live, true); assert.equal(actual.gm.status, 'restoring'); prefix(actual, session) }
      assert.equal((await destination.probe('models')).total, 0)
      assert.equal((await destination.api('studio', 'gmState', { sessionId: selectedId })).binding.status, 'restoring')
      await write('pending-restore.json', { preview, pause, pendingAudit, pendingWitness, inputHash: mainInputHash, snapshot: mainSnapshot, restoreId: mainJob })
      destination = await restart(destination)
      assert.equal((await destination.probe('models')).total, 0)
      const legacy = await destination.studio('POST', '/api/v1/sessions', { cardId: 'studio-legacy-fixture' })
      assert.equal(legacy.state.extensions.gm, undefined)
      await destination.openStudio(legacy.session.id)
      await destination.page.getByRole('button', { name: '故事档案', exact: true }).click()
      const upload = destination.page.getByLabel('完整存档文件', { exact: true }); await expect(upload).toBeEnabled()
      const coldBeforePreview = await destination.probe('witness', { sessionIds: mainIds })
      assert.equal(hash(JSON.stringify(mainSnapshot)), mainInputHash)
      await nativeClick(destination.page, 'previewSavedStory', () => upload.setInputFiles({ name: 'main-saved-story.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(mainSnapshot)) }))
      const coldAfterPreview = await destination.probe('witness', { sessionIds: mainIds }); verifyUnchanged(coldBeforePreview, coldAfterPreview)
      await destination.page.getByRole('textbox', { name: '恢复任务 ID', exact: true }).fill(mainJob)
      const restoreButton = destination.page.getByRole('button', { name: /^(恢复完整存档|暂存并验证目标路由)$/u }); await expect(restoreButton).toBeEnabled()
      const resumed = await nativeClick(destination.page, 'restoreSavedStory', () => restoreButton.click()); assert.equal(resumed.status, 'complete')
      for (const session of mainSnapshot.sessions) {
        const actual = await destination.snapshot(session.header.id); prefix(actual, session); assert.equal(actual.live, true)
        const loop = await destination.probe('loop', { sessionId: session.header.id }), saved = mainSnapshot.loopPolicies.find(row => row.sessionId === session.header.id)
        assert.ok(saved); assert.deepEqual(loop.policies.session, saved.policy); for (const id of Object.keys(saved.policy.routes)) assert.ok(loop.graph.nodes.some(node => node.id === id && node.control === 'route'))
      }
      const restoredWitness = await verifyRestoredBindings(), completedRow = restoredWitness.audit.find(row => row.restoreId === mainJob)
      assert.equal(completedRow.status, 'complete'); assert.equal(completedRow.fingerprint, pendingRow.fingerprint); assert.deepEqual(completedRow.sessionIds, pendingRow.sessionIds)
      const restoredNarratives = await destination.api('studio', 'narratives', { sessionId: selectedId }), restoredReader = await destination.studio('GET', `/api/v1/sessions/${selectedId}`)
      assert.equal(restoredNarratives.records.find(row => row.ref.presentationId === adopted.ref.presentationId && row.ref.resultSeq === adopted.ref.resultSeq)?.text, adopted.text)
      assert.ok(restoredReader.messages.some(row => row.text === adopted.text))
      assert.equal((await destination.probe('models')).total, 0)
      assert.equal((await currentStyle(destination, selectedId)).profileId, styles.B.profileId)
      assert.equal((await currentStyle(destination, selectedId)).version, styles.B.version)
      assert.equal((await destination.api('studio', 'gmState', { sessionId: selectedId })).binding.profile.profileId, initialStyle.profileId)
      for (const ref of [initialStyle, styles.B, styles.C]) await destination.api('lastStep', 'profile', ref)
      const beforeReplay = await destination.snapshot(selectedId)
      assert.equal((await destination.api('studio', 'restoreSavedStory', { snapshot: mainSnapshot, restoreId: mainJob })).status, 'complete')
      assert.deepEqual((await destination.snapshot(selectedId)).events, beforeReplay.events)
      const conflictSnapshot = structuredClone(mainSnapshot); conflictSnapshot.dependencySummary = { databases: [], profiles: [] }
      const conflictJob = 'new-conflicting-job-' + randomUUID(), beforeConflictPreview = await destination.probe('witness', { sessionIds: mainIds })
      assert.ok(!beforeConflictPreview.audit.some(row => row.restoreId === conflictJob))
      const conflict = await destination.api('studio', 'previewSavedStory', { snapshot: conflictSnapshot }); assert.equal(conflict.supported, false); assert.ok(conflict.conflicts.some(row => row.code === 'RESTORE_ID_CONFLICT'))
      const beforeConflict = await destination.probe('witness', { sessionIds: mainIds }); verifyUnchanged(beforeConflictPreview, beforeConflict)
      await assert.rejects(destination.api('studio', 'restoreSavedStory', { snapshot: conflictSnapshot, restoreId: conflictJob }), error => error.code === 'RESTORE_ID_CONFLICT')
      const afterConflict = await destination.probe('witness', { sessionIds: mainIds }); verifyUnchanged(beforeConflict, afterConflict, { allowAuditRevision: true })
      assert.ok(!afterConflict.audit.some(row => row.restoreId === conflictJob))
      destination = await restart(destination)
      for (const session of mainSnapshot.sessions) prefix(await destination.snapshot(session.header.id), session)
      const coldRestoredWitness = await verifyRestoredBindings()
      assert.equal((await destination.probe('models')).total, 0)
      await destination.probe('resume', { sessionId: selectedId }); assert.equal((await destination.probe('models')).total, 0)
      const destinationColdBaseline = { snapshot: await destination.snapshot(selectedId), receiptId: (await destination.api('studio', 'gmState', { sessionId: selectedId })).lastFactReceipt.id }
      await sendUi(destination, selectedId, '恢复后明确继续，不重演历史。', { coldBaseline: destinationColdBaseline })
      assert.equal((await currentStyle(destination, selectedId)).profileId, styles.B.profileId)
      const rolled = await destination.studio('POST', `/api/v1/sessions/${selectedId}/rollback`), forked = await destination.studio('POST', `/api/v1/sessions/${selectedId}/fork`, {})
      assert.ok(rolled.sessionId); assert.ok(forked.session.id)
      assert.ok((await destination.api('studio', 'gmState', { sessionId: rolled.sessionId })).facts.items.find(item => item.id === 'letter-holder').text.includes('林遥'))
      await write('saved-story.json', { minimalSnapshot, minimalJob, minimalBeforePreview, minimalAfterPreview, mainSnapshot, mainInputHash, mainJob, sourceWitness, configuredLoops, mainBeforePreview, mainAfterPreview, coldBeforePreview, coldAfterPreview, resumed, restoredWitness, restoredNarratives, restoredReader, conflictJob, conflict, beforeConflictPreview, beforeConflict, afterConflict, coldRestoredWitness, rolled, forked })
      return { minimalDefaultsRetained: true, explicitOverridesPreserved: true, pendingColdSameJob: true, pauseKind: 'public AbortSignal during local metadata wait; not incompatible graph repair', actualLoopAndActivation: true, newJobConflictUnchanged: true, coldExactPrefixes: true, restoredContinueRollbackFork: true }
    })
    for (const context of [source, destination]) {
      await context.openStudio(selectedId)
      for (const [name, width] of [['sidebar', 1440], ['full', 1440], ['narrow', 520]]) {
        if (name === 'full') { const button = context.page.getByRole('button', { name: '全屏', exact: true }); await expect(button).toBeVisible(); await button.click(); await context.page.waitForFunction(() => document.querySelector('.dsh-rp-workspace')?.clientWidth > 1000) }
        await context.page.setViewportSize({ width, height: 1000 })
        const panel = context.page.locator('.dsh-rp-workspace'), metrics = await panel.evaluate(element => ({ width: element.clientWidth, height: element.clientHeight, overflow: element.scrollWidth > element.clientWidth }))
        assert.equal(metrics.overflow, false); assert.ok(metrics.width >= 250 && metrics.height >= 200); if (name === 'full') assert.ok(metrics.width > 1000); report.layouts ??= []; report.layouts.push({ home: context.name, name, ...metrics }); await context.page.screenshot({ path: await ownedRunPath(workspace, run, join(run, `${context.name}-${name}.png`)) })
      }
      assert.deepEqual(context.errors, [])
    }
    for (const segment of segments) assert.deepEqual(segment.browserErrors, [], `browser errors in ${segment.name} process ${segment.hostPid}`)
    report.fullChain = { status: diagnostic ? 'diagnostic-complete' : 'passed', finalAcceptance: !diagnostic }
  } catch (error) { report.error = redact(error.stack ?? error.message).slice(0, 10000); report.fullChain = { status: error.deferred ? 'deferred' : 'failed', finalAcceptance: false } }
  finally {
    report.scenarios = cases.snapshot(); report.segments = segments; report.retrieval = provider.stats()
    if (report.error) for (const context of [source, destination].filter(Boolean)) {
      if (context.failedAction) try { await write(`${context.name}-failed-action.json`, context.failedAction) }
      catch (error) { report.evidenceErrors ??= []; report.evidenceErrors.push({ home: context.name, error: redact(error.message) }) }
      try { await context.page.screenshot({ path: await ownedRunPath(workspace, run, join(run, `${context.name}-failure.png`)) }) }
      catch (error) { report.evidenceErrors ??= []; report.evidenceErrors.push({ home: context.name, error: redact(error.message) }) }
      if (context === source && primaryId) try {
        await write('failed-source-state.json', { snapshot: await context.snapshot(primaryId), summaries: await context.api('studio', 'presentationSummaries', { sessionId: primaryId }) })
      } catch (error) { report.evidenceErrors ??= []; report.evidenceErrors.push({ home: context.name, error: redact(error.message) }) }
    }
    const resources = [...[source, destination].filter(Boolean).map(context => ({ name: context.name, close: () => finish(context) })), { name: 'retrieval', close: () => provider.close() }]
    const cleanup = await Promise.allSettled(resources.map(resource => resource.close()))
    report.cleanup = cleanup.map((result, index) => ({ resource: resources[index].name, status: result.status, ...(result.status === 'rejected' ? { error: redact(result.reason?.message ?? result.reason) } : {}) }))
    report.modelSegments = segments.map(segment => ({ home: segment.name, hostPid: segment.hostPid, status: segment.modelStatus, models: segment.modelsOnClose, cleanupStatus: segment.cleanupStatus, ...(segment.counterError ? { error: segment.counterError } : {}) }))
    report.modelTotals = { complete: segments.every(segment => segment.modelStatus === 'recorded'), total: segments.reduce((total, segment) => total + (segment.modelsOnClose?.total ?? 0), 0), counts: {} }
    for (const segment of segments) for (const [stage, count] of Object.entries(segment.modelsOnClose?.counts ?? {})) report.modelTotals.counts[stage] = (report.modelTotals.counts[stage] ?? 0) + count
    for (const segment of segments.filter(row => row.startupFailed)) report.cleanup.push({ resource: `startup-${segment.name}`, status: segment.cleanupErrors.length ? 'rejected' : 'fulfilled', errors: segment.cleanupErrors })
    report.browserErrors = segments.flatMap(segment => segment.browserErrors.map(error => ({ home: segment.name, hostPid: segment.hostPid, error })))
    if (cleanup.some(result => result.status === 'rejected')) report.fullChain = { status: 'failed', finalAcceptance: false }
    if (!report.modelTotals.complete || report.browserErrors.length || segments.some(segment => segment.cleanupErrors?.length)) report.fullChain = { status: 'failed', finalAcceptance: false }
    await write('full-result.json', report)
  }
  return report
}
