import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPolicyStore } from '../src/store.mjs'

const enabled = { enabled: true, routes: { 'host.first': { provider: 'cloud', model: 'fast' } } }

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'loop-store-'))
  const store = await createPolicyStore({ home })
  t.after(async () => {
    const { rm } = await import('node:fs/promises')
    await rm(home, { recursive: true, force: true })
  })
  return { store, home }
}

test('policy records and revision survive a store restart in the DSH home', async t => {
  const { store, home } = await fixture(t)
  assert.deepEqual(store.read({ sessionId: 'a', presetId: 'standard' }), { revision: 0, policies: { session: null, preset: null } })
  assert.deepEqual(await store.savePolicy({ scope: 'preset', presetId: 'standard', expectedRevision: 0, policy: enabled }), { revision: 1 })
  await store.savePolicy({ scope: 'session', sessionId: 'a', expectedRevision: 1, policy: { enabled: false, routes: {} } })
  const restarted = await createPolicyStore({ home })
  assert.deepEqual(restarted.read({ sessionId: 'a', presetId: 'standard' }), { revision: 2, policies: { session: { enabled: false, routes: {} }, preset: enabled } })
  const stored = JSON.parse(await readFile(join(home, 'app-data', 'loop-studio', 'policies.json'), 'utf8'))
  assert.equal(stored.schemaVersion, 1)
})

test('stale revisions reject writes without changing committed policies', async t => {
  const { store } = await fixture(t)
  await store.savePolicy({ scope: 'session', sessionId: 'a', expectedRevision: 0, policy: enabled })
  await assert.rejects(store.savePolicy({ scope: 'session', sessionId: 'b', expectedRevision: 0, policy: enabled }), { code: 'revision-conflict', status: 409 })
  assert.equal(store.read({ sessionId: 'b' }).policies.session, null)
  assert.equal(store.read({ sessionId: 'a' }).revision, 1)
})

test('concurrent writes with the same revision commit exactly one policy', async t => {
  const { store } = await fixture(t)
  const writes = await Promise.allSettled(['a', 'b'].map(sessionId => store.savePolicy({ scope: 'session', sessionId, expectedRevision: 0, policy: enabled })))
  assert.equal(writes.filter(write => write.status === 'fulfilled').length, 1)
  assert.equal(writes.filter(write => write.status === 'rejected' && write.reason.code === 'revision-conflict').length, 1)
})

test('reset removes only its policy layer and advances revision', async t => {
  const { store } = await fixture(t)
  await store.savePolicy({ scope: 'preset', presetId: 'standard', expectedRevision: 0, policy: enabled })
  await store.savePolicy({ scope: 'session', sessionId: 'a', expectedRevision: 1, policy: { enabled: false, routes: {} } })
  assert.deepEqual(await store.resetPolicy({ scope: 'session', sessionId: 'a', expectedRevision: 2 }), { revision: 3 })
  assert.deepEqual(store.read({ sessionId: 'a', presetId: 'standard' }).policies, { session: null, preset: enabled })
  assert.equal(store.read({ sessionId: 'other', presetId: 'other' }).policies.preset, null)
})

test('invalid scopes and absent revisions never create records', async t => {
  const { store } = await fixture(t)
  await assert.rejects(store.savePolicy({ scope: 'global', sessionId: 'a', expectedRevision: 0, policy: enabled }), { code: 'bad-request' })
  await assert.rejects(store.savePolicy({ scope: 'session', sessionId: 'a', policy: enabled }), { code: 'bad-request' })
  assert.equal(store.read({ sessionId: 'a' }).revision, 0)
})
