import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionDetail } from '@dsh-rp/protocol'
import { buildApp, type SessionApi } from './app.js'
import { ProductService, type ProductDataStore } from './product-service.js'
import { registerProductRoutes } from './product-routes.js'
import Fastify from 'fastify'

const detail = {
  session: { id: '会话-7', cardId: 'zombie-world', title: '档案', updatedAt: 1, running: false, blank: false },
  card: { id: 'zombie-world', title: '世界', description: '', world: '虚构区域', protagonist: '玩家', art: 'zombie-world', accent: 'crimson' },
  messages: [],
  state: { started: true, relationships: [], faction: [], inventory: [], memories: [], quests: [], eventLog: [], statusLines: [], extensions: {}, checkpoints: { count: 0, canRollback: false, activeTurn: null } },
} satisfies SessionDetail

function sessionApi(): SessionApi {
  return {
    health: async () => ({}), cards: async () => [], sessions: async () => [], session: async id => id === detail.session.id ? detail : Promise.reject(new Error('not owned')),
    create: async () => detail, prompt: async () => ({ accepted: true }), cancel: async () => ({ accepted: true }), fork: async () => detail,
    rollback: async () => ({ accepted: true }), autoplay: async () => ({ accepted: true }),
    promptSettings: async () => ({ available: true, revision: 0, coreProfileIds: [], optionalProfiles: [], enabledEntryIds: [], appliesFromNextTurn: false }),
    applyPromptSettings: async () => ({ available: true, revision: 0, coreProfileIds: [], optionalProfiles: [], enabledEntryIds: [], appliesFromNextTurn: false }),
    resetPromptSettings: async () => ({ available: true, revision: 0, coreProfileIds: [], optionalProfiles: [], enabledEntryIds: [], appliesFromNextTurn: false }),
    subscribe: () => () => {},
    getProductScope: async id => id === detail.session.id
      ? { workspaceId: 'workspace-zombie', cardId: detail.card.id, sessionId: id, branchId: id }
      : Promise.reject(new Error('not owned')),
  }
}

function store(): ProductDataStore {
  return {
    status: async () => ({ storage: 'ready', schemaVersion: 1, projection: 'current' }), close: async () => {},
    listAssets: async () => ({ items: [], nextCursor: null }), putAsset: async input => ({ ...input.metadata, createdAt: '2026-09-08T12:00:00.000Z' }),
    readAsset: async () => undefined, updateAsset: async () => undefined, deleteAsset: async () => false,
    listLedger: async () => ({ items: [], nextCursor: null }), appendLedger: async (_scope, input) => ({ id: 'ledger-1', ...input, createdAt: '2026-09-08T12:00:00.000Z' }),
    listKnowledge: async () => ({ items: [], nextCursor: null }), createKnowledge: async (_scope, input) => ({ id: 'knowledge-1', text: input.text, source: 'user', createdAt: '2026-09-08T12:00:00.000Z', updatedAt: '2026-09-08T12:00:00.000Z' }),
    updateKnowledge: async () => undefined, deleteKnowledge: async () => false,
    listMemories: async () => ({ items: [], nextCursor: null }), listRelationships: async () => ({ items: [], nextCursor: null }), listLocations: async () => ({ items: [], nextCursor: null }), replaceProjections: async () => {},
    readNotifications: async (_scope, cursor) => ({ items: [], cursor: cursor ?? 'cursor-0', resetRequired: false }), acknowledgeNotification: async () => false,
    appendNotification: async (_scope, input) => ({ ...input, cursor: `cursor-${input.id}`, acknowledged: false }),
    listBackups: async () => ({ items: [], nextCursor: null }), createBackup: async scope => ({ id: 'backup-1', schemaVersion: 1, scope, createdAt: '2026-09-08T12:00:00.000Z', state: 'ready', manifestHash: `sha256:${'a'.repeat(64)}`, includes: { authoritativeAppData: true, rpProjections: true, dshSessions: false } }),
    exportBackup: async () => undefined, importBackup: async scope => ({ id: 'backup-imported', schemaVersion: 1, scope, createdAt: '2026-09-08T12:00:00.000Z', state: 'ready', manifestHash: `sha256:${'c'.repeat(64)}`, includes: { authoritativeAppData: true, rpProjections: true, dshSessions: false } }),
    stageRestore: async () => undefined, commitRestore: async () => undefined,
    savePairingToken: async () => {}, listPairingClients: async () => [], revokePairingClient: async () => false,
    findPairingToken: async () => undefined,
  }
}

const apps: ReturnType<typeof buildApp>[] = []
afterEach(async () => Promise.all(apps.splice(0).map(app => app.close())))

describe('product routes', () => {
  it('reports unavailable storage without falling back to an in-memory database', async () => {
    const app = buildApp({ api: sessionApi(), product: new ProductService({ sessions: sessionApi() }) })
    apps.push(app)
    const status = await app.inject({ method: 'GET', url: '/api/v1/product/status' })
    const assets = await app.inject({ method: 'GET', url: `/api/v1/product/assets?sessionId=${encodeURIComponent(detail.session.id)}` })
    expect(status.json().data).toMatchObject({ storage: 'unavailable', pairing: { enabled: false } })
    expect(assets.statusCode).toBe(503)
    expect(assets.json().error.code).toBe('storage-unavailable')
  })

  it('checks session ownership before reading scoped resources', async () => {
    const data = store()
    const list = vi.spyOn(data, 'listMemories')
    const app = buildApp({ api: sessionApi(), product: new ProductService({ sessions: sessionApi(), store: data }) })
    apps.push(app)
    expect((await app.inject({ method: 'GET', url: '/api/v1/product/memory?sessionId=foreign' })).statusCode).toBe(404)
    expect(list).not.toHaveBeenCalled()
  })

  it('accepts allowed uploads by hash and rejects active content and oversized payloads', async () => {
    const data = store()
    const put = vi.spyOn(data, 'putAsset')
    const app = buildApp({ api: sessionApi(), product: new ProductService({ sessions: sessionApi(), store: data }) })
    apps.push(app)
    const uploaded = await app.inject({ method: 'POST', url: `/api/v1/product/assets?sessionId=${encodeURIComponent(detail.session.id)}`, payload: { fileName: '贴纸.png', mimeType: 'image/png', category: 'sticker', contentBase64: Buffer.from('safe-png').toString('base64') } })
    expect(uploaded.statusCode).toBe(201)
    expect(uploaded.json().data.id).toMatch(/^sha256:[a-f0-9]{64}$/u)
    expect(put.mock.calls[0]?.[0].bytes).toEqual(Buffer.from('safe-png'))
    expect((await app.inject({ method: 'POST', url: `/api/v1/product/assets?sessionId=${encodeURIComponent(detail.session.id)}`, payload: { fileName: 'x.svg', mimeType: 'image/svg+xml', category: 'sticker', contentBase64: Buffer.from('<svg/>').toString('base64') } })).statusCode).toBe(415)
    expect((await app.inject({ method: 'POST', url: `/api/v1/product/assets?sessionId=${encodeURIComponent(detail.session.id)}`, payload: { fileName: 'x.png', mimeType: 'image/png', category: 'sticker', contentBase64: 'A'.repeat(14_000_001) } })).statusCode).toBe(413)
  })

  it('validates ledger integer currency data and appends an idempotent command', async () => {
    const data = store()
    const append = vi.spyOn(data, 'appendLedger')
    const app = buildApp({ api: sessionApi(), product: new ProductService({ sessions: sessionApi(), store: data }) })
    apps.push(app)
    const url = `/api/v1/product/ledger?sessionId=${encodeURIComponent(detail.session.id)}`
    expect((await app.inject({ method: 'POST', url, payload: { commandId: 'cmd-旅店', amountMinor: 1.5, currency: 'usd', description: '住宿', occurredAt: new Date().toISOString() } })).statusCode).toBe(400)
    const response = await app.inject({ method: 'POST', url, payload: { commandId: 'cmd-旅店', amountMinor: -1250, currency: 'USD', description: '住宿', occurredAt: '2026-09-08T12:00:00.000Z' } })
    expect(response.statusCode).toBe(201)
    expect(append).toHaveBeenCalledOnce()
  })

  it('runs restore as stage then token-bound commit', async () => {
    const data = store()
    data.stageRestore = async (_scope, backupId) => ({ backupId, restoreToken: 'restore-token-1234567890', expiresAt: '2026-09-08T12:05:00.000Z', manifestHash: `sha256:${'b'.repeat(64)}` })
    data.commitRestore = async (_scope, _backupId, restoreToken) => restoreToken === 'restore-token-1234567890' ? { restored: true, rollbackBackupId: 'backup-rollback' } : undefined
    const app = buildApp({ api: sessionApi(), product: new ProductService({ sessions: sessionApi(), store: data }) })
    apps.push(app)
    const base = `/api/v1/product/backups/backup-1`
    const staged = await app.inject({ method: 'POST', url: `${base}/stage-restore?sessionId=${encodeURIComponent(detail.session.id)}`, payload: {} })
    expect(staged.statusCode).toBe(200)
    const committed = await app.inject({ method: 'POST', url: `${base}/commit-restore?sessionId=${encodeURIComponent(detail.session.id)}`, payload: { restoreToken: staged.json().data.restoreToken } })
    expect(committed.json().data).toEqual({ restored: true, rollbackBackupId: 'backup-rollback' })
  })

  it('emits a reset snapshot when the notification cursor is no longer retained', async () => {
    const data = store()
    data.readNotifications = async () => ({ items: [], cursor: 'cursor-9', resetRequired: true, snapshot: [{ id: 'n-1', cursor: 'cursor-9', type: 'system', title: '同步', body: '请重新同步', createdAt: '2026-09-08T12:00:00.000Z', acknowledged: false }] })
    const app = buildApp({ api: sessionApi(), product: new ProductService({ sessions: sessionApi(), store: data }) })
    apps.push(app)
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const response = await fetch(`${address}/api/v1/product/notifications/stream?sessionId=${encodeURIComponent(detail.session.id)}&cursor=cursor-old`)
    expect(response.status).toBe(200)
    const reader = response.body!.getReader()
    const chunk = await reader.read()
    await reader.cancel()
    expect(new TextDecoder().decode(chunk.value)).toContain('event: reset')
  })

  it('fails closed when a projection contains a hidden visibility marker', async () => {
    const data = store()
    data.listMemories = async () => ({ items: [{ id: 'hidden', sessionId: detail.session.id, branchId: detail.session.id, sourceSeq: 3, text: 'hidden', visibility: 'hidden' } as never], nextCursor: null })
    const app = buildApp({ api: sessionApi(), product: new ProductService({ sessions: sessionApi(), store: data }) })
    apps.push(app)
    const response = await app.inject({ method: 'GET', url: `/api/v1/product/memory?sessionId=${encodeURIComponent(detail.session.id)}` })
    expect(response.statusCode).toBe(500)
    expect(response.json().error.code).toBe('internal')
  })

  it('forwards only strict public projection replacements to the data adapter', async () => {
    const data = store()
    const replace = vi.spyOn(data, 'replaceProjections')
    const service = new ProductService({ sessions: sessionApi(), store: data })
    await service.replaceProjections(detail.session.id, {
      branchId: detail.session.id,
      fromSeq: 4,
      memories: [{ id: 'memory-1', sessionId: detail.session.id, branchId: detail.session.id, sourceSeq: 4, text: 'public memory' }],
      relationships: [],
      locations: [],
    })
    expect(replace).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'workspace-zombie', sessionId: detail.session.id }), expect.objectContaining({ branchId: detail.session.id, fromSeq: 4, memories: expect.any(Array) }))
  })

  it('keeps forked session app data in an independent real session scope', async () => {
    const data = store()
    const list = vi.spyOn(data, 'listLedger')
    const api = sessionApi()
    api.session = async id => ({ ...detail, session: { ...detail.session, id } })
    api.getProductScope = async id => ({ workspaceId: 'workspace-zombie', cardId: detail.card.id, sessionId: id, branchId: id })
    const service = new ProductService({ sessions: api, store: data })
    await service.ledger({ sessionId: 'parent-session', limit: 20 })
    await service.ledger({ sessionId: 'fork-session', limit: 20 })
    expect(list.mock.calls.map(call => call[0].sessionId)).toEqual(['parent-session', 'fork-session'])
    expect(list.mock.calls[0]?.[0]).not.toBe(list.mock.calls[1]?.[0])
  })

  it('maps data conflicts to HTTP 409 instead of storage unavailable', async () => {
    const data = store()
    data.appendLedger = async () => { const error = new Error('conflict'); error.name = 'DataConflictError'; throw error }
    const app = buildApp({ api: sessionApi(), product: new ProductService({ sessions: sessionApi(), store: data }) })
    apps.push(app)
    const response = await app.inject({ method: 'POST', url: `/api/v1/product/ledger?sessionId=${encodeURIComponent(detail.session.id)}`, payload: { commandId: 'same', amountMinor: 1, currency: 'USD', description: '冲突', occurredAt: '2026-09-08T12:00:00.000Z' } })
    expect(response.statusCode).toBe(409)
    expect(response.json().error.code).toBe('conflict')
  })

  it('subscribes before the initial notification read and deduplicates the buffered overlap', async () => {
    const data = store()
    const scope = await sessionApi().getProductScope!(detail.session.id)
    const first = { id: 'n-1', cursor: 'cursor-1', type: 'turn.completed', title: '一', body: '一', createdAt: '2026-09-08T12:00:00.000Z', acknowledged: false }
    const second = { ...first, id: 'n-2', cursor: 'cursor-2', title: '二', body: '二' }
    const product = new ProductService({ sessions: sessionApi(), store: data })
    data.readNotifications = async () => {
      product.publishNotifications(scope, { items: [first, second], cursor: second.cursor, resetRequired: false })
      return { items: [first], cursor: first.cursor, resetRequired: false }
    }
    const app = buildApp({ api: sessionApi(), product })
    apps.push(app)
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const response = await fetch(`${address}/api/v1/product/notifications/stream?sessionId=${encodeURIComponent(detail.session.id)}`)
    const reader = response.body!.getReader()
    let body = ''
    while (!body.includes('n-2')) {
      const chunk = await reader.read()
      if (chunk.done) break
      body += new TextDecoder().decode(chunk.value)
    }
    await reader.cancel()
    expect(body.match(/"id":"n-1"/gu)).toHaveLength(1)
    expect(body.match(/"id":"n-2"/gu)).toHaveLength(1)
  })

  it('releases an SSE subscription on response close and after remote token revocation', async () => {
    const data = store()
    const product = new ProductService({ sessions: sessionApi(), store: data })
    const originalSubscribe = product.subscribe.bind(product)
    const released = vi.fn()
    vi.spyOn(product, 'subscribe').mockImplementation(listener => {
      const unsubscribe = originalSubscribe(listener)
      return () => { unsubscribe(); released() }
    })
    let checks = 0
    const app = Fastify({ logger: false })
    apps.push(app as ReturnType<typeof buildApp>)
    registerProductRoutes(app, product, { reauthorize: async () => { checks++; if (checks > 1) throw new Error('revoked') }, reauthorizeIntervalMs: 10 })
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const response = await fetch(`${address}/api/v1/product/notifications/stream?sessionId=${encodeURIComponent(detail.session.id)}`)
    const body = await response.text()
    expect(body).toContain('移动端认证已撤销')
    await vi.waitFor(() => expect(released).toHaveBeenCalledOnce())
  })

  it('returns only token-bound owned sessions from the paired bootstrap', async () => {
    const data = store()
    data.findPairingToken = async () => ({ clientId: 'client-1', clientName: '手机', tokenHash: `sha256:${'a'.repeat(64)}`, scopes: ['product:read'], sessionIds: [detail.session.id, 'removed-session'], createdAt: '2026-09-08T12:00:00.000Z', expiresAt: '2099-09-08T12:00:00.000Z', revoked: false })
    const app = buildApp({ api: sessionApi(), product: new ProductService({ sessions: sessionApi(), store: data }) })
    apps.push(app)
    const response = await app.inject({ method: 'GET', url: '/api/v1/product/bootstrap', headers: { authorization: `Bearer ${'a'.repeat(43)}` } })
    expect(response.statusCode).toBe(200)
    expect(response.json().data.sessions).toEqual([{ sessionId: detail.session.id, cardId: detail.card.id, title: detail.session.title }])
  })
})
