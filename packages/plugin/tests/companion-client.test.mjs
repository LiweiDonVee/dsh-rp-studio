import test from 'node:test'
import assert from 'node:assert/strict'
import { openCompanionSession, readCompanionStatus, COMPANION_PRESET_ID } from '../src/companion-client.mjs'
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
