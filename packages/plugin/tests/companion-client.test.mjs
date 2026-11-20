import test from 'node:test'
import assert from 'node:assert/strict'
import { openCompanionSession, readCompanionStatus, COMPANION_PRESET_ID, EXTERNAL_CONVERSATION_PROMPT } from '../src/companion-client.mjs'
import { companionStatus, createCompanionStatusRoute } from '../src/companion-status.mjs'

test('Companion initializes an unsent dedicated-preset draft with an explicit target', () => {
  const calls = []
  const ctx = { uiWorkspace: { startSession: (...args) => calls.push(args) } }
  assert.equal(openCompanionSession(ctx, { targetSessionId: 'story-1' }), undefined)
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], undefined)
  assert.equal(calls[0][1].agentPreset, COMPANION_PRESET_ID)
  assert.equal(calls[0][1].whenDraftExists, 'append')
  assert.match(calls[0][1].prompt, /"story-1"/u)
  assert.throws(() => openCompanionSession(ctx, { targetSessionId: '' }), /无效/u)
  assert.throws(() => openCompanionSession({}), /入口/u)
})

test('a selected prose question creates only an unsent exact-ref inspection draft', () => {
  const calls = []
  const ctx = { uiWorkspace: { startSession: (...args) => calls.push(args) } }
  const basedOn = { sessionId: 'story-1', presentationId: 'older-turn', assistantMessageId: 'writer', callSeq: 2, baseResultSeq: 3, resultSeq: 7 }
  openCompanionSession(ctx, { targetSessionId: 'story-1', operation: 'story.turnDetails', basedOn })
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], undefined)
  const draft = calls[0][1]
  assert.equal(draft.whenDraftExists, 'append')
  assert.equal(draft.agentPreset, COMPANION_PRESET_ID)
  assert.match(draft.prompt, /^请解释我所选这一轮/u)
  assert.ok(draft.prompt.includes(JSON.stringify({ operation: 'story.turnDetails', input: { sessionId: 'story-1', basedOn } })))
  assert.throws(() => openCompanionSession(ctx, { targetSessionId: 'another-story', operation: 'story.turnDetails', basedOn }), /引用无效/u)
  assert.throws(() => openCompanionSession(ctx, { targetSessionId: 'story-1', operation: 'story.turnDetails', basedOn: { ...basedOn, stale: true } }), /引用无效/u)
  assert.throws(() => openCompanionSession(ctx, { targetSessionId: 'story-1', operation: 'story.turnDetails', basedOn: { presentationId: 'older-turn' } }), /引用无效/u)
  assert.equal(calls.length, 1)
})

test('external conversations initialize a default Workspace without needing an RP story or submitting a message', async () => {
  const calls = []
  const ctx = {
    workspaces: { list: { getSnapshot: () => ({ items: [] }) }, async initializeDefault(signal) { assert.equal(signal, undefined); calls.push(['default']); return { workspaceId: 'default-workspace' } } },
    uiWorkspace: { startSession: (...args) => calls.push(['draft', ...args]) },
    sessions: { prompt: () => assert.fail('The import entry must not send a prompt') },
  }
  await openCompanionSession(ctx, { targetSessionId: 'unrelated-current-story', externalConversation: true })
  assert.deepEqual(calls, [['default'], ['draft', 'default-workspace', { agentPreset: COMPANION_PRESET_ID, prompt: EXTERNAL_CONVERSATION_PROMPT, whenDraftExists: 'append' }]])
  assert.ok(!calls[1][2].prompt.includes('unrelated-current-story'))
})

test('external conversations reuse native workspace selection and preserve an existing draft through append semantics', () => {
  const calls = []
  const ctx = { workspaces: { list: { getSnapshot: () => ({ items: [{ workspaceId: 'ordinary-workspace', sessionIds: [] }] }) } }, uiWorkspace: { startSession: (...args) => calls.push(args) } }
  openCompanionSession(ctx, { externalConversation: true })
  assert.deepEqual(calls, [[undefined, { agentPreset: COMPANION_PRESET_ID, prompt: EXTERNAL_CONVERSATION_PROMPT, whenDraftExists: 'append' }]])
})

test('ineligible default initialization uses the official directory picker without requiring an existing story', async () => {
  const calls = []
  const ctx = {
    workspaces: { list: { getSnapshot: () => ({ items: [] }) }, initializeDefault: async () => undefined,
      create: async input => { calls.push(['workspace', input]); return { workspaceId: 'chosen' } } },
    uiWorkspace: { pickDirectory: async () => { calls.push(['pick']); return 'E:/Imported stories' }, startSession: (...args) => calls.push(['draft', ...args]) },
  }
  await openCompanionSession(ctx, { externalConversation: true })
  assert.deepEqual(calls, [['pick'], ['workspace', { path: 'E:/Imported stories' }], ['draft', 'chosen', { agentPreset: COMPANION_PRESET_ID, prompt: EXTERNAL_CONVERSATION_PROMPT, whenDraftExists: 'append' }]])
  calls.length = 0
  ctx.uiWorkspace.pickDirectory = async () => null
  await openCompanionSession(ctx, { externalConversation: true })
  assert.deepEqual(calls, [])
})

test('a retired external-conversation entry never opens a session after delayed default initialization', async () => {
  const signal = new AbortController(), calls = []
  let finish
  const ctx = { workspaces: { list: { getSnapshot: () => ({ items: [] }) }, initializeDefault: () => new Promise(resolve => { finish = resolve }) },
    uiWorkspace: { startSession: (...args) => calls.push(args) } }
  const pending = openCompanionSession(ctx, { externalConversation: true, signal: signal.signal })
  signal.abort()
  finish({ workspaceId: 'default' })
  await assert.rejects(pending, { name: 'AbortError' })
  assert.deepEqual(calls, [])
})

function ungroupedCompanion() {
  const calls = []
  const navigation = new AbortController()
  let workspaces = []
  const ctx = {
    workspaces: {
      list: { getSnapshot: () => ({ phase: 'ready', items: workspaces }) },
      async create(input) { calls.push(['workspace', input]); const workspace = { workspaceId: 'same-directory', path: input.path, sessionIds: [] }; workspaces = [...workspaces, workspace]; return workspace },
    },
    sessions: {
      list: { getSnapshot: () => ({ byId: { story: { cwd: 'E:/Stories/Harbor' } } }) },
    },
    layout: { beginNavigation: () => navigation.signal },
    uiWorkspace: {
      startSession(...args) { calls.push(['start', ...args]) },
    },
  }
  return { calls, ctx, navigation }
}

test('ungrouped stories register the existing directory before the native unsent Companion draft flow', async () => {
  const h = ungroupedCompanion()
  const basedOn = { sessionId: 'story', presentationId: 'selected-turn', assistantMessageId: 'writer', callSeq: 2, baseResultSeq: 3, resultSeq: 7 }
  await openCompanionSession(h.ctx, { targetSessionId: 'story', operation: 'story.turnDetails', basedOn })
  assert.deepEqual(h.calls.map(call => call[0]), ['workspace', 'start'])
  assert.deepEqual(h.calls[0][1], { path: 'E:/Stories/Harbor' })
  assert.equal(h.calls[1][1], 'same-directory')
  assert.equal(h.calls[1][2].agentPreset, COMPANION_PRESET_ID)
  assert.equal(h.calls[1][2].whenDraftExists, 'append')
  assert.ok(h.calls[1][2].prompt.includes(JSON.stringify({ operation: 'story.turnDetails', input: { sessionId: 'story', basedOn } })))
  await openCompanionSession(h.ctx, { targetSessionId: 'story', operation: 'story.turnDetails', basedOn })
  assert.deepEqual(h.calls.map(call => call[0]), ['workspace', 'start', 'start'])
})

test('a registered story explicitly names its own Workspace instead of depending on current/recent selection', () => {
  const h = ungroupedCompanion()
  h.ctx.workspaces.list.getSnapshot = () => ({ items: [{ workspaceId: 'selected-workspace', sessionIds: ['story'] }, { workspaceId: 'other', sessionIds: [] }] })
  assert.equal(openCompanionSession(h.ctx, { targetSessionId: 'story' }), undefined)
  assert.deepEqual(h.calls.map(call => call[0]), ['start'])
  assert.equal(h.calls[0][1], 'selected-workspace')
  assert.equal(h.calls[0][2].agentPreset, COMPANION_PRESET_ID)
})

test('ungrouped stories reuse an already registered matching directory without another registration', async () => {
  const h = ungroupedCompanion()
  h.ctx.workspaces.list.getSnapshot = () => ({ items: [{ workspaceId: 'matching-directory', path: 'e:\\stories\\harbor\\', sessionIds: [] }] })
  await openCompanionSession(h.ctx, { targetSessionId: 'story' })
  assert.deepEqual(h.calls.map(call => call[0]), ['start'])
  assert.equal(h.calls[0][1], 'matching-directory')
})

test('a later navigation prevents delayed Workspace registration from creating or opening a helper', async () => {
  const h = ungroupedCompanion()
  let finish
  h.ctx.workspaces.create = input => new Promise(resolve => { h.calls.push(['workspace', input]); finish = () => resolve({ workspaceId: 'registered' }) })
  const opening = openCompanionSession(h.ctx, { targetSessionId: 'story' })
  await Promise.resolve()
  h.navigation.abort()
  finish()
  await assert.rejects(opening, { name: 'AbortError' })
  assert.deepEqual(h.calls.map(call => call[0]), ['workspace'])
})

test('denied Workspace registration is preserved without creating a fallback Session', async () => {
  const h = ungroupedCompanion()
  h.ctx.workspaces.create = async () => { throw Object.assign(new Error('工作区登记被拒绝'), { code: 'PERMISSION_DENIED' }) }
  await assert.rejects(openCompanionSession(h.ctx, { targetSessionId: 'story' }), { code: 'PERMISSION_DENIED' })
  assert.deepEqual(h.calls, [])
})

test('missing source directory or registration support is explicit before any helper is created', async () => {
  const h = ungroupedCompanion()
  h.ctx.sessions.list.getSnapshot = () => ({ byId: {} })
  await assert.rejects(openCompanionSession(h.ctx, { targetSessionId: 'story' }), /工作目录/u)
  assert.deepEqual(h.calls, [])
  delete h.ctx.workspaces.create
  await assert.rejects(openCompanionSession(h.ctx, { targetSessionId: 'story' }), /工作区登记入口/u)
  assert.deepEqual(h.calls, [])
})

test('status uses the live preset diagnostic and optional owners do not disable it', async () => {
  let broken
  const ctx = { get: name => name === 'agentPresets' ? { resolve: async id => ({ id, ...(broken ? { broken } : {}) }) } : undefined }
  const ready = await companionStatus(ctx)
  assert.equal(ready.available, true)
  assert.equal(ready.tools.length, 3)
  assert.equal(ready.owners.database, false)
  broken = 'missing module'
  const unavailable = await companionStatus(ctx)
  assert.equal(unavailable.available, false)
  assert.match(unavailable.reason, /missing module/u)
  assert.deepEqual(unavailable.tools, [])
})

test('status route cannot turn into a management proxy', async () => {
  let calls = 0
  const route = createCompanionStatusRoute({ get: () => { calls++; return undefined } })
  const post = value => new Request('http://local/api/rp-studio/companion', { method: 'POST', body: JSON.stringify(value) })
  for (const value of [{ action: 'import' }, { action: 'status', method: 'launch' }, { action: 'status', input: {} }]) assert.equal((await route.request(post(value))).status, 400)
  assert.equal(calls, 0)
  assert.equal((await route.request(post({ action: 'status' }))).status, 200)
  route.close()
  assert.equal((await route.request(post({ action: 'status' }))).status, 503)
})

test('client status rejects malformed capability schema before enabling management entry', async t => {
  const ready = await companionStatus({ get: name => name === 'agentPresets' ? { resolve: async id => ({ id }) } : undefined })
  t.mock.method(globalThis, 'fetch', async () => Response.json(ready))
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document')
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { baseURI: 'http://local/' } })
  try {
    assert.equal((await readCompanionStatus()).available, true)
    ready.owners.database = 'yes'
    await assert.rejects(readCompanionStatus(), /响应无效/u)
  } finally {
    if (previous) Object.defineProperty(globalThis, 'document', previous)
    else delete globalThis.document
  }
})
