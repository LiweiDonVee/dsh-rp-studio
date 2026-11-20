import test from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMobileIdentity } from '../src/mobile-identity.mjs'
import { createStudioActions } from '../src/actions.mjs'

test('profile identity survives reload and boot, while profiles and copied profiles are independent', async t => {
  const root = await mkdtemp(join(tmpdir(), 'rp-mobile-identity-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dir = join(root, 'one'), second = join(root, 'two'), copied = join(root, 'copied')
  await mkdir(dir); await mkdir(second)
  const profile = { name: 'desktop', dir }, bootIds = new Map()
  const one = await createMobileIdentity({ getProfile: () => profile, bootIds })()
  const reloaded = await createMobileIdentity({ getProfile: () => profile, bootIds })()
  assert.deepEqual(reloaded, one)
  const restarted = await createMobileIdentity({ getProfile: () => profile, bootIds: new Map() })()
  assert.equal(restarted.instanceId, one.instanceId)
  assert.notEqual(restarted.bootId, one.bootId)
  const two = await createMobileIdentity({ getProfile: () => ({ name: 'desktop', dir: second }), bootIds })()
  assert.notEqual(two.instanceId, one.instanceId)
  await cp(dir, copied, { recursive: true })
  const clone = await createMobileIdentity({ getProfile: () => ({ name: 'desktop', dir: copied }), bootIds })()
  assert.notEqual(clone.instanceId, one.instanceId)
  assert.deepEqual(Object.keys(one).sort(), ['bootId', 'instanceId', 'schemaVersion'])
  assert.equal(JSON.stringify(one).includes(root), false)
  const persisted = JSON.parse(await readFile(join(dir, '.rp-studio-mobile-identity.json'), 'utf8'))
  assert.equal(persisted.instanceId, one.instanceId)
  assert.equal(persisted.bootId, undefined)
})

test('sessionless identity has a strict action shape and does not activate a story', async () => {
  const identity = { schemaVersion: 1, instanceId: 'ce9afb61-88be-4f42-ae41-b08b9975e94e', bootId: '31d5d1eb-86da-44a6-a317-e442d7b5e6e6' }
  let reads = 0
  const route = createStudioActions({
    getService() { throw new Error('Identity must not initialize story services') },
    authorize() { throw new Error('Identity must not authorize a made-up session') },
    mobileIdentity: async () => { reads++; return identity },
  })
  const request = input => route.request(new Request('http://fixture/api/rp-studio/actions', { method: 'POST', body: JSON.stringify(input) }))
  const response = await request({ action: 'mobileIdentity' })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await response.json(), identity)
  for (const extra of [{ sessionId: 'story' }, { profile: 'other' }, { endpoint: 'http://other' }]) {
    assert.equal((await request({ action: 'mobileIdentity', ...extra })).status, 400)
  }
  assert.equal(reads, 1)
  route.close()
  assert.equal((await request({ action: 'mobileIdentity' })).status, 503)
})

test('missing real profile never manufactures a process-global host identity', async () => {
  await assert.rejects(createMobileIdentity({ getProfile: () => undefined })(), /Profile identity is unavailable/u)
})
