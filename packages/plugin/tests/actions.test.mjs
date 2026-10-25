import test from 'node:test'
import assert from 'node:assert/strict'
import { createStudioActions } from '../src/actions.mjs'

const post = input => new Request('http://local/api/rp-studio/actions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })
test('owner actions reject unrecognized targets and forged execution context before dispatch', async () => {
  let calls = 0
  const route = createStudioActions({ getService: () => ({ material: async () => { calls++; return {} } }), authorize: async () => {} })
  for (const input of [{ action: 'call', service: 'rpLastStep', method: 'material' }, { action: 'material', sessionId: 's', presentationId: 'p', agent: {} }, { action: 'material', sessionId: 's', presentationId: 'p', stage: 'render' }]) {
    assert.equal((await route.request(post(input))).status, 400)
  }
  assert.equal(calls, 0)
})

test('adoption forwards the complete expected reference and abort signal to its one owner', async () => {
  const ref = { sessionId: 's', presentationId: 'p', assistantMessageId: 'a', callSeq: 2, baseResultSeq: 3, resultSeq: 8 }
  let actual, authorization
  const route = createStudioActions({ getService: name => name === 'rpLastStep' ? { adoptDraft: async input => { actual = input; return { narrative: { text: '采用稿' } } } } : undefined, authorize: async id => { authorization = id } })
  const request = post({ action: 'adoptDraft', sessionId: 's', draftId: 'd', expectedDraftVersion: 7, expectedNarrative: ref })
  const result = await route.request(request)
  assert.deepEqual(await result.json(), { narrative: { text: '采用稿' } })
  assert.equal(authorization, 's')
  assert.deepEqual(actual.expectedNarrative, ref)
  assert.equal(actual.signal instanceof AbortSignal, true)
  assert.equal(actual.signal.aborted, request.signal.aborted)
  assert.equal(actual.draftId, 'd')
  assert.equal(actual.expectedDraftVersion, 7)
  assert.equal((await route.request(post({ action: 'adoptDraft', sessionId: 's', draftId: 'd', expectedNarrative: ref }))).status, 400)
})

test('capabilities are method/version projections and require the owner retryDispatch flag', async () => {
  const services = { rpGM: { apiVersion: 0, storyState() {} }, rpStoryKit: { apiVersion: 1, exportReading() {}, state: async () => ({ capabilities: { readingExport: false } }) }, rpLastStep: { narratives() {}, retryPresentation() {}, presentationSummaries: async () => ({ presentations: [{ presentationId: 'p', status: 'failed', canRetry: true }], capabilities: { retryDispatch: false } }) } }
  const route = createStudioActions({ getService: name => services[name], authorize: async () => {} })
  const scoped = await (await route.request(post({ action: 'capabilities', sessionId: 's' }))).json()
  assert.equal(scoped.actions.gmState, false)
  assert.equal(scoped.actions.narratives, true)
  assert.equal(scoped.actions.exportReading, false)
  assert.equal(scoped.actions.retryPresentation, false)
  assert.equal(scoped.services.lastStep.apiVersion, null)
  assert.equal((await route.request(post({ action: 'retryPresentation', sessionId: 's', presentationId: 'p' }))).status, 503)
})

test('missing capability and owner conflicts are explicit without guessing receipt internals', async () => {
  const route = createStudioActions({ getService: name => name === 'rpLastStep' ? { editDraft: async () => { throw Object.assign(new Error('草稿已更新。'), { code: 'DRAFT_CONFLICT', status: 409 }) } } : undefined, authorize: async () => {} })
  assert.equal((await route.request(post({ action: 'material', sessionId: 's', presentationId: 'p' }))).status, 503)
  const conflict = await route.request(post({ action: 'editDraft', sessionId: 's', draftId: 'd', text: '保留未保存文字', expectedDraftVersion: 1 }))
  assert.equal(conflict.status, 409)
  assert.deepEqual(await conflict.json(), { error: { code: 'DRAFT_CONFLICT', message: '草稿已更新。' } })
})

test('manual drafts and author notes keep their distinct revision contracts', async () => {
  const basedOn = { sessionId: 's', presentationId: 'p', assistantMessageId: 'a', callSeq: 1, baseResultSeq: 2, resultSeq: 2 }
  const captured = []
  const route = createStudioActions({ getService: name => name === 'rpContext' ? { setAuthorNote: async input => { captured.push(input); return { revision: 8, note: { id: 'n', version: 1, text: input.text, status: 'pending' } } } } : { createDraft: async input => { captured.push(input); return { id: 'd', kind: input.kind, text: '原稿' } } }, authorize: async () => {} })
  assert.equal((await route.request(post({ action: 'createDraft', sessionId: 's', basedOn, kind: 'manual' }))).status, 200)
  assert.equal(captured[0].text, undefined)
  assert.equal((await route.request(post({ action: 'createDraft', sessionId: 's', basedOn, kind: 'writer', text: '不能冒充手改' }))).status, 400)
  assert.equal((await route.request(post({ action: 'setAuthorNote', sessionId: 's', text: '多一些停顿。', expectedRevision: 7 }))).status, 200)
  assert.equal(captured[1].expectedRevision, 7)
  assert.equal((await route.request(post({ action: 'setAuthorNote', sessionId: 's', text: '不允许猜版本。', version: 1 }))).status, 400)
})

test('unload cancels an owner request and cannot return a false successful operation', async () => {
  let started
  const ready = new Promise(resolve => { started = resolve })
  const route = createStudioActions({ getService: () => ({ material: ({ signal }) => new Promise((resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); started() }) }), authorize: async () => {} })
  const request = route.request(post({ action: 'material', sessionId: 's', presentationId: 'p' }))
  await ready
  route.close()
  assert.equal((await request).status, 499)
  assert.equal((await route.request(post({ action: 'capabilities' }))).status, 503)
})

test('reading files and unknown snapshot fields cannot invoke saved-story restoration', async () => {
  let calls = 0
  const route = createStudioActions({ getService: () => ({ apiVersion: 1, restoreSavedStory: async () => { calls++; return { status: 'complete' } } }), authorize: async () => {} })
  const snapshot = { format: 'dsh-rp-saved-story', schemaVersion: 1, identityMode: 'preserve', exportedAt: '2026-10-25T00:00:00Z', selectedSessionId: 's', sessions: [{ header: { id: 's' }, events: [], inheritedEventCount: 0 }], pluginState: { database: {}, context: null, lastStep: {}, gm: {}, storyKit: {} }, resources: [], requirements: [] }
  assert.equal((await route.request(post({ action: 'restoreSavedStory', snapshot: { text: '阅读稿' }, restoreId: 'job' }))).status, 400)
  assert.equal((await route.request(post({ action: 'restoreSavedStory', snapshot: { ...snapshot, destinationPath: '/arbitrary' }, restoreId: 'job' }))).status, 400)
  assert.equal(calls, 0)
})

test('saved-story preview preserves authoritative inherited count and deferred checks without requiring absent Context', async () => {
  const snapshot = { format: 'dsh-rp-saved-story', schemaVersion: 1, identityMode: 'preserve', exportedAt: '2026-10-25T00:00:00Z', selectedSessionId: 's', sessions: [{ header: { id: 's' }, events: [], inheritedEventCount: 0 }], pluginState: { database: {}, lastStep: {}, gm: {}, storyKit: {} }, resources: [], requirements: [] }
  const preview = { supported: true, conflicts: [], requirements: [], identityMode: 'preserve', deferredChecks: [{ code: 'LOOP_NODE_VALIDATION', sessionId: 's', nodeIds: ['render'] }] }
  let actual
  const route = createStudioActions({ getService: name => name === 'rpStoryKit' ? { apiVersion: 1, previewSavedStory: async input => { actual = input.snapshot; return preview } } : undefined, authorize: async () => { throw new Error('A destination ID is not an existing selected story') } })
  const response = await route.request(post({ action: 'previewSavedStory', snapshot }))
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), preview)
  assert.deepEqual(actual.sessions[0], snapshot.sessions[0])
  const invalid = structuredClone(snapshot)
  delete invalid.sessions[0].inheritedEventCount
  assert.equal((await route.request(post({ action: 'previewSavedStory', snapshot: invalid }))).status, 400)
})
