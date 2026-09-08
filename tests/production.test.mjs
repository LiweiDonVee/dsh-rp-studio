import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { buildApp } from '../apps/gateway/dist/app.js'
import { SessionService } from '../apps/gateway/dist/session-service.js'

const root = fileURLToPath(new URL('../', import.meta.url))
async function files(dir) {
  const entries = (await readdir(dir, { withFileTypes: true })).filter(entry => entry.name !== 'node_modules' && !entry.isSymbolicLink())
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? files(join(dir, entry.name)) : join(dir, entry.name)))).flat()
}

test('compiled production API has no cards or sessions without user content', async () => {
  const home = await mkdtemp(join(tmpdir(), 'studio-empty-'))
  const dsh = {
    listPresets: async () => [],
    listSessions: async () => [],
    listWorkspaces: async () => ({ items: [], archivedSessionIds: [] }),
    connectStreams: () => () => {},
    createWorkspace: () => { throw new Error('Empty startup must not create workspaces') },
  }
  const service = new SessionService({ dsh, dshHome: home })
  const app = buildApp({ api: service })
  try {
    await service.start()
    for (const endpoint of ['cards', 'sessions']) {
      const response = await app.inject({ url: '/api/v1/' + endpoint })
      assert.equal(response.statusCode, 200)
      assert.deepEqual(response.json(), { ok: true, protocolVersion: 1, data: [] })
    }
    const create = await app.inject({ method: 'POST', url: '/api/v1/sessions', payload: { cardId: 'missing-user-card' } })
    assert.equal(create.statusCode, 404)
    assert.equal(create.json().error.code, 'card-unavailable')
    assert.deepEqual(await readdir(home), [])
  } finally {
    service.stop()
    await app.close()
    await rm(home, { recursive: true, force: true })
  }
})

test('production outputs exclude fixtures, tests, prompt packs and artwork', async () => {
  const outputs = ['apps/web/dist', 'apps/gateway/dist', 'packages/domain/dist', 'packages/protocol/dist']
  const forbidden = /fixture-card|fixture-profile|测试消息 A|MOCK_DSH_CANARY_SECRET|CANARY_DO_NOT_LEAK|zombie-world|hp-potion|dreamwhale|梦鲸|伊莱亚斯|E:[/\\\\]WorkSpace|C:[/\\\\]Users/i
  for (const output of outputs) {
    const built = await files(join(root, output))
    assert.ok(built.length > 0, output + ' must exist')
    for (const path of built) {
      assert.doesNotMatch(path, /(?:\.test\.|\.spec\.|mock-server|fixtures|rp-card\.json|prompt-manifest\.json|\.(?:png|jpe?g|webp|gif|svg)$)/i)
      assert.doesNotMatch(await readFile(path, 'utf8'), forbidden, path)
    }
  }
  const source = (await Promise.all(['apps', 'packages'].map(dir => files(join(root, dir))))).flat()
  assert.equal(source.some(path => /(?:rp-card|prompt-manifest)\.json$/.test(path)), false)
  for (const path of source.filter(path => path.endsWith('package.json') && !path.includes('node_modules'))) {
    assert.doesNotMatch(await readFile(path, 'utf8'), /"(?:file|link):/)
  }
})
