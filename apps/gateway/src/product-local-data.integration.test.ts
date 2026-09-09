import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalDataStore } from '@dsh-rp/local-data'
import { projectPublicState } from '@dsh-rp/domain'
import type { ProductSourceEvent, SessionApi } from './app.js'
import { buildApp } from './app.js'
import { ProductService, type ProductDataStore } from './product-service.js'
import { productDetail } from './product-test-fixture.js'

const scope = { workspaceId: 'workspace-real', cardId: productDetail.card.id, sessionId: productDetail.session.id, branchId: productDetail.session.id }
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const resources: Array<{ close(): Promise<void> }> = []
const directories: string[] = []

afterEach(async () => {
  await Promise.allSettled(resources.splice(0).map(resource => resource.close()))
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

function sessions(publishSource: (listener: (event: ProductSourceEvent) => void) => void): Pick<SessionApi, 'session'> & Partial<SessionApi> {
  return {
    session: async id => id === scope.sessionId ? productDetail : Promise.reject(new Error('not owned')),
    getProductScope: async id => id === scope.sessionId ? scope : Promise.reject(new Error('not owned')),
    productSnapshots: async () => [],
    subscribeProduct: listener => { publishSource(listener); return () => {} },
  }
}

async function fixture(options?: { now?: () => number; restoreTtlMs?: number }) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-gateway-product-'))
  directories.push(directory)
  const localStore = await createLocalDataStore({ dataDir: directory, ...options })
  const store: ProductDataStore = localStore
  let source: (event: ProductSourceEvent) => void = () => {}
  const api = sessions(listener => { source = listener })
  const product = new ProductService({ sessions: api, store })
  await product.start()
  const app = buildApp({ api: api as SessionApi, product })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  resources.push({ close: async () => { await app.close(); await product.close() } })
  return { directory, product, source, address }
}

async function json(address: string, path: string, init?: RequestInit) {
  const response = await fetch(`${address}${path}`, { ...init, headers: { 'content-type': 'application/json', ...init?.headers } })
  return { response, body: await response.json() as { ok: boolean; data?: Record<string, unknown>; error?: { code: string } } }
}

describe('Gateway with the real local-data adapter', () => {
  it('keeps a private canary out of SQLite projections and the HTTP read model', async () => {
    const harness = await fixture()
    const canary = 'SECRET_CANARY_SQLITE_7F3A'
    const state = projectPublicState({ game: { started: true, statusLines: [], scene: { location: '公开地点' }, memories: [{ id: 'public', summary: '公开记忆' }, { id: 'private', summary: canary, visibility: 'PRIVATE' }], relationships: [{ id: 'known', name: '守卫', status: '谨慎' }, { id: 'hidden', name: canary, private: true }] } })
    harness.source({ type: 'projection', sessionId: scope.sessionId, branchId: scope.branchId, sourceSeq: 17, state })
    await vi.waitFor(async () => {
      const result = await json(harness.address, `/api/v1/product/memory?sessionId=${scope.sessionId}`)
      expect(result.response.status).toBe(200)
      expect(result.response.url).not.toContain(canary)
      expect(JSON.stringify(result.body)).toContain('公开记忆')
    })
    const database = await readFile(join(harness.directory, 'local-data.sqlite3'))
    expect(database.includes(Buffer.from(canary))).toBe(false)
  })

  it('backs up and restores real asset bytes through stage and commit', async () => {
    const harness = await fixture()
    const query = `?sessionId=${scope.sessionId}`
    const uploaded = await json(harness.address, `/api/v1/product/assets${query}`, { method: 'POST', body: JSON.stringify({ fileName: 'portrait.png', mimeType: 'image/png', category: 'portrait', contentBase64: png.toString('base64') }) })
    expect(uploaded.response.status, JSON.stringify(uploaded.body)).toBe(201)
    const assetId = String(uploaded.body.data?.id)
    const backup = await json(harness.address, `/api/v1/product/backups${query}`, { method: 'POST', body: JSON.stringify({ commandId: 'backup-assets' }) })
    expect(backup.response.status, JSON.stringify(backup.body)).toBe(201)
    expect(backup.body.data?.manifestHash).toMatch(/^sha256:[a-f0-9]{64}$/u)
    const backupId = String(backup.body.data?.id)
    expect((await fetch(`${harness.address}/api/v1/product/assets/${encodeURIComponent(assetId)}${query}`, { method: 'DELETE' })).status).toBe(204)
    const staged = await json(harness.address, `/api/v1/product/backups/${backupId}/stage-restore${query}`, { method: 'POST', body: '{}' })
    expect(staged.response.status).toBe(200)
    const committed = await json(harness.address, `/api/v1/product/backups/${backupId}/commit-restore${query}`, { method: 'POST', body: JSON.stringify({ restoreToken: staged.body.data?.restoreToken }) })
    expect(committed.response.status).toBe(200)
    expect(committed.body.data?.rollbackBackupId).toMatch(/^backup-/u)
    const restored = await fetch(`${harness.address}/api/v1/product/assets/${encodeURIComponent(assetId)}${query}`)
    expect(Buffer.from(await restored.arrayBuffer())).toEqual(png)
  })

  it('returns conflict for expired and concurrent restore commits', async () => {
    let now = Date.parse('2026-09-08T00:00:00.000Z')
    const harness = await fixture({ now: () => now, restoreTtlMs: 100 })
    const query = `?sessionId=${scope.sessionId}`
    const backup = await json(harness.address, `/api/v1/product/backups${query}`, { method: 'POST', body: JSON.stringify({ commandId: 'backup-expiry' }) })
    const backupId = String(backup.body.data?.id)
    const staged = await json(harness.address, `/api/v1/product/backups/${backupId}/stage-restore${query}`, { method: 'POST', body: '{}' })
    now += 101
    const expired = await json(harness.address, `/api/v1/product/backups/${backupId}/commit-restore${query}`, { method: 'POST', body: JSON.stringify({ restoreToken: staged.body.data?.restoreToken }) })
    expect(expired.response.status, JSON.stringify(expired.body)).toBe(409)
    expect(expired.body.error?.code).toBe('conflict')
    const concurrentBackup = await json(harness.address, `/api/v1/product/backups${query}`, { method: 'POST', body: JSON.stringify({ commandId: 'backup-concurrent' }) })
    const concurrentId = String(concurrentBackup.body.data?.id)
    const concurrentStage = await json(harness.address, `/api/v1/product/backups/${concurrentId}/stage-restore${query}`, { method: 'POST', body: '{}' })
    await json(harness.address, `/api/v1/product/ledger${query}`, { method: 'POST', body: JSON.stringify({ commandId: 'concurrent-write', amountMinor: 1, currency: 'USD', description: '并发写', occurredAt: '2026-09-08T00:00:01.000Z' }) })
    const concurrent = await json(harness.address, `/api/v1/product/backups/${concurrentId}/commit-restore${query}`, { method: 'POST', body: JSON.stringify({ restoreToken: concurrentStage.body.data?.restoreToken }) })
    expect(concurrent.response.status).toBe(409)
    expect(concurrent.body.error?.code).toBe('conflict')
  })

  it('reports a tampered backup as an integrity error instead of opaque storage unavailability', async () => {
    const harness = await fixture()
    const query = `?sessionId=${scope.sessionId}`
    const backup = await json(harness.address, `/api/v1/product/backups${query}`, { method: 'POST', body: JSON.stringify({ commandId: 'backup-tamper' }) })
    const files = await readdir(join(harness.directory, 'backups'))
    const manifest = files.find(file => file.includes(String(backup.body.data?.id)))
    expect(manifest).toBeTruthy()
    await writeFile(join(harness.directory, 'backups', manifest!), '{}')
    const staged = await json(harness.address, `/api/v1/product/backups/${String(backup.body.data?.id)}/stage-restore${query}`, { method: 'POST', body: '{}' })
    expect(staged.response.status).toBe(500)
    expect(staged.body.error?.code).toBe('internal')
  })

  it('exports portable bytes and imports them into a new data root without auto-committing', async () => {
    const source = await fixture()
    const query = `?sessionId=${scope.sessionId}`
    const uploaded = await json(source.address, `/api/v1/product/assets${query}`, { method: 'POST', body: JSON.stringify({ fileName: 'portable.png', mimeType: 'image/png', category: 'portrait', contentBase64: png.toString('base64') }) })
    const assetId = String(uploaded.body.data?.id)
    const created = await json(source.address, `/api/v1/product/backups${query}`, { method: 'POST', body: JSON.stringify({ commandId: 'portable-source' }) })
    const exported = await fetch(`${source.address}/api/v1/product/backups/${String(created.body.data?.id)}/export${query}`)
    expect(exported.status).toBe(200)
    expect(exported.headers.get('content-type')).toBe('application/octet-stream')
    const bytes = Buffer.from(await exported.arrayBuffer())

    const target = await fixture()
    const imported = await json(target.address, `/api/v1/product/backups/import${query}&commandId=portable-target`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: bytes })
    expect(imported.response.status).toBe(201)
    expect(imported.body.data?.manifestHash).toEqual(created.body.data?.manifestHash)
    expect((await fetch(`${target.address}/api/v1/product/assets/${encodeURIComponent(assetId)}${query}`)).status).toBe(404)
    const backupId = String(imported.body.data?.id)
    const staged = await json(target.address, `/api/v1/product/backups/${backupId}/stage-restore${query}`, { method: 'POST', body: '{}' })
    const committed = await json(target.address, `/api/v1/product/backups/${backupId}/commit-restore${query}`, { method: 'POST', body: JSON.stringify({ restoreToken: staged.body.data?.restoreToken }) })
    expect(committed.response.status).toBe(200)
    const restored = await fetch(`${target.address}/api/v1/product/assets/${encodeURIComponent(assetId)}${query}`)
    expect(Buffer.from(await restored.arrayBuffer())).toEqual(png)
  })
})
