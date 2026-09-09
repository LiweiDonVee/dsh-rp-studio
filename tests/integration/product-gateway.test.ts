import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { buildApp, type ProductSourceEvent, type SessionApi } from '../../apps/gateway/src/app.js'
import { loadDefaultProductStore } from '../../apps/gateway/src/local-data-adapter.js'
import { startPairingListener } from '../../apps/gateway/src/pairing-listener.js'
import { ProductService } from '../../apps/gateway/src/product-service.js'
import { startServer } from '../../apps/gateway/src/server.js'
import { projectPublicState } from '../../packages/domain/src/public-state.js'
import { createLocalDataStore } from '../../packages/local-data/src/index.js'
import type { Card, PublicGameState, SessionDetail } from '../../packages/protocol/src/index.js'
import { describe, expect, it } from 'vitest'
import { pairingCertificate, pairingPrivateKey } from './fixtures/pairing-certificate.js'

function card(id: string, title: string, world: string, protagonist: string, accent: Card['accent']): Card {
  return { id, title, description: `${world}中的可玩故事`, world, protagonist, art: id, accent }
}

function publicState(label: string, includeProjection = true): PublicGameState {
  return projectPublicState({
    game: {
      started: true,
      currentDate: '霜月十二日',
      scene: includeProjection ? { location: `${label}港口`, region: `${label}群岛` } : {},
      protagonist: { name: `${label}旅人`, conditions: [] },
      statusLines: [`${label}公开状态`],
      relationships: includeProjection ? [
        { id: `${label}-public-edge`, subject: `${label}旅人`, object: '守门人', relation: '信任', status: '公开' },
        { id: `${label}-private-edge`, subject: 'PRIVATE-RELATIONSHIP-CANARY', object: '守门人', relation: '秘密', private: true },
        { id: `${label}-gm-edge`, subject: 'GM-ONLY-RELATIONSHIP-CANARY', object: '守门人', relation: '秘密', visibility: 'gm-only' },
        { id: `${label}-offscreen-edge`, subject: 'OFFSCREEN-RELATIONSHIP-CANARY', object: '守门人', relation: '秘密', visibility: ['offscreen'] },
      ] : [],
      memories: includeProjection ? {
        public: [
          { id: `${label}-public-memory`, text: `${label}公开记忆`, emotion: '安心', secretNote: 'SECRET-KEY-CANARY' },
          { id: `${label}-secret-memory`, text: 'SECRET-MEMORY-CANARY', visibility: 'secret' },
        ],
        private: [{ id: `${label}-private-memory`, text: 'PRIVATE-MEMORY-CANARY' }],
      } : { public: [], private: [] },
    },
    meta: { history: [] },
  })
}

function detail(sessionId: string, value: Card, state: PublicGameState): SessionDetail {
  return {
    session: { id: sessionId, cardId: value.id, title: value.title, updatedAt: 1_788_875_200_000, running: false, blank: true, state },
    card: value,
    messages: [],
    state,
  }
}

function sessionStub() {
  const cards = [
    card('moon-guard', '月港守望', '月港', '林舟', 'jade'),
    card('ember-archive', '余烬档案', '灰塔', '阿澜', 'crimson'),
  ]
  const details = new Map([
    ['session-moon', detail('session-moon', cards[0]!, publicState('月港'))],
    ['session-ember', detail('session-ember', cards[1]!, publicState('灰塔'))],
  ])
  const listeners = new Set<(event: ProductSourceEvent) => void>()
  const api: SessionApi = {
    health: async () => ({ upstream: 'ready', version: 'deterministic-dsh-stub' }),
    cards: async () => cards,
    sessions: async () => [...details.values()].map(value => value.session),
    session: async sessionId => {
      const value = details.get(sessionId)
      if (!value) throw new Error('unknown deterministic session')
      return value
    },
    create: async cardId => {
      const value = [...details.values()].find(item => item.card.id === cardId)
      if (!value) throw new Error('unknown deterministic card')
      return value
    },
    prompt: async () => ({ accepted: true }),
    cancel: async () => ({ accepted: true }),
    fork: async sessionId => api.session(sessionId),
    rollback: async () => ({ accepted: true }),
    autoplay: async () => ({ accepted: true }),
    promptSettings: async () => ({ available: false, message: '测试桩未启用提示词', revision: 0, coreProfileIds: [], optionalProfiles: [], enabledEntryIds: [], appliesFromNextTurn: true }),
    applyPromptSettings: async () => ({ available: false, message: '测试桩未启用提示词', revision: 0, coreProfileIds: [], optionalProfiles: [], enabledEntryIds: [], appliesFromNextTurn: true }),
    resetPromptSettings: async () => ({ available: false, message: '测试桩未启用提示词', revision: 0, coreProfileIds: [], optionalProfiles: [], enabledEntryIds: [], appliesFromNextTurn: true }),
    subscribe: () => () => undefined,
    subscribeProduct: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    getProductScope: async sessionId => {
      const value = await api.session(sessionId)
      return { workspaceId: 'workspace-integration', cardId: value.card.id, sessionId, branchId: `branch-${sessionId}` }
    },
    productSnapshots: async () => Promise.all([...details.values()].map(async value => ({ detail: value, scope: await api.getProductScope!(value.session.id), sourceSeq: 1 }))),
  }
  return {
    api,
    replace(sessionId: string, state: PublicGameState) {
      const current = details.get(sessionId)
      if (!current) throw new Error('unknown deterministic session')
      details.set(sessionId, { ...current, session: { ...current.session, state }, state })
    },
    emit(event: ProductSourceEvent) {
      for (const listener of listeners) listener(event)
    },
  }
}

async function createSystem(options: { notificationRetention?: number } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-rp-integration-home-'))
  const dataRoot = join(home, 'app-data')
  const loaded = options.notificationRetention === undefined
    ? await loadDefaultProductStore({ dshHome: home, dataRoot })
    : { store: await createLocalDataStore({ dataDir: dataRoot, notificationRetention: options.notificationRetention }) }
  if (!loaded.store) throw new Error(`real local-data default failed: ${loaded.doctor?.code ?? 'unknown'}`)
  const sessions = sessionStub()
  const product = new ProductService({
    sessions: sessions.api,
    store: loaded.store,
    pairingEnabled: true,
    pairingWriteScopes: ['assets:write', 'ledger:write', 'knowledge:write', 'notifications:ack'],
  })
  await product.start()
  const app = buildApp({ api: sessions.api, product })
  await app.listen({ host: '127.0.0.1', port: 0 })
  return { app, dataRoot, home, product, sessions, url: app.listeningOrigin }
}

async function json(url: string, init?: RequestInit): Promise<{ response: Response; body: any }> {
  const response = await fetch(url, init)
  const body = response.status === 204 ? undefined : await response.json()
  return { response, body }
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error('integration projection did not settle')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

async function reservePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('ephemeral port was not allocated')
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return address.port
}

async function insecureLoopbackJson(url: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<{ status: number; body: any }> {
  const payload = init.body === undefined ? undefined : JSON.stringify(init.body)
  return new Promise((resolve, reject) => {
    const request = httpsRequest(url, {
      method: init.method ?? 'GET',
      rejectUnauthorized: false,
      headers: { ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload).toString() } : {}), ...init.headers },
    }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(Buffer.from(chunk)))
      response.once('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve({ status: response.statusCode ?? 0, body: text ? JSON.parse(text) : undefined })
      })
    })
    request.once('error', reject)
    request.setTimeout(2_000, () => request.destroy(new Error('HTTPS pairing request timed out')))
    if (payload) request.write(payload)
    request.end()
  })
}

describe('real Gateway and SQLite product integration', () => {
  it('starts the Gateway through its true default local-data initialization path', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-rp-default-store-home-'))
    const publicDir = join(home, 'public')
    const dataRoot = join(home, 'default-data')
    await mkdir(publicDir)
    await writeFile(join(publicDir, 'index.html'), '<main>isolated integration shell</main>')
    const dshPort = await reservePort()
    const gatewayPort = await reservePort()
    const server = await startServer({ host: '127.0.0.1', port: gatewayPort, dshUrl: `http://127.0.0.1:${dshPort}`, dshHome: home, dataRoot, publicDir })
    try {
      const status = await json(`${server.url}/api/v1/product/status`)
      expect({ status: status.response.status, body: status.body }).toMatchObject({ status: 200, body: { ok: true, protocolVersion: 1, data: { storage: 'ready', schemaVersion: 1 } } })
      await access(join(dataRoot, 'local-data.sqlite3'))
      const database = new DatabaseSync(join(dataRoot, 'local-data.sqlite3'), { readOnly: true })
      try {
        const tables = database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all().map(row => row.name)
        expect(tables).toEqual(expect.arrayContaining(['command_journal', 'ledger_entries', 'memory_index', 'notifications']))
      } finally {
        database.close()
      }
    } finally {
      await server.app.close()
    }
  })

  it('routes two deterministic stub cards through the versioned Gateway session boundary', async () => {
    const system = await createSystem()
    try {
      const cards = await json(`${system.url}/api/v1/cards`)
      expect(cards.body).toMatchObject({ ok: true, protocolVersion: 1, data: [{ id: 'moon-guard' }, { id: 'ember-archive' }] })
      for (const [cardId, sessionId] of [['moon-guard', 'session-moon'], ['ember-archive', 'session-ember']]) {
        const created = await json(`${system.url}/api/v1/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cardId }) })
        expect(created.body.data.session.id).toBe(sessionId)
        const played = await json(`${system.url}/api/v1/sessions/${sessionId}/prompt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: `推进${cardId}剧情` }) })
        expect(played.body).toMatchObject({ ok: true, data: { accepted: true } })
      }
    } finally {
      await system.app.close()
    }
  })

  it('commits authoritative commands with journals and restores a verified backup', async () => {
    const system = await createSystem()
    const session = 'session-moon'
    const query = `sessionId=${session}&limit=100`
    try {
      const sticker = await json(`${system.url}/api/v1/product/assets?sessionId=${session}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fileName: '月兔.png', mimeType: 'image/png', category: 'sticker', label: '月兔', contentBase64: 'iVBORw0KGgo=' }),
      })
      expect(sticker.response.status).toBe(201)
      const assetId = sticker.body.data.id as string
      const relabeled = await json(`${system.url}/api/v1/product/assets/${encodeURIComponent(assetId)}?sessionId=${session}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: '月兔招手' }) })
      expect(relabeled.body.data.label).toBe('月兔招手')

      const original = await json(`${system.url}/api/v1/product/ledger?sessionId=${session}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ commandId: 'ledger-buy-tea', amountMinor: -700, currency: 'CNY', description: '购买月桂茶', occurredAt: '2026-09-08T12:00:00.000Z' }) })
      const compensation = await json(`${system.url}/api/v1/product/ledger?sessionId=${session}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ commandId: 'ledger-reverse-tea', amountMinor: 700, currency: 'CNY', description: '冲正月桂茶', occurredAt: '2026-09-08T12:01:00.000Z', reversesEntryId: original.body.data.id }) })
      expect(compensation.body.data.reversesEntryId).toBe(original.body.data.id)

      const knowledge = await json(`${system.url}/api/v1/product/knowledge?sessionId=${session}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ commandId: 'knowledge-moon-gate', text: '月门在潮汐最低时开启' }) })
      const knowledgeId = knowledge.body.data.id as string
      const updated = await json(`${system.url}/api/v1/product/knowledge/${knowledgeId}?sessionId=${session}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '月门只在银潮最低时开启' }) })
      expect(updated.body.data.text).toContain('银潮')

      const backup = await json(`${system.url}/api/v1/product/backups?sessionId=${session}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ commandId: 'backup-before-extra-entry' }) })
      expect({ status: backup.response.status, body: backup.body }).toMatchObject({
        status: 201,
        body: { ok: true, protocolVersion: 1, data: { id: expect.stringMatching(/^backup-/u), manifestHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u) } },
      })
      expect(backup.body.data.manifestHash).toMatch(/^sha256:[a-f0-9]{64}$/u)
      const deletedAsset = await json(`${system.url}/api/v1/product/assets/${encodeURIComponent(assetId)}?sessionId=${session}`, { method: 'DELETE' })
      expect(deletedAsset.response.status).toBe(204)
      const deletedKnowledge = await json(`${system.url}/api/v1/product/knowledge/${knowledgeId}?sessionId=${session}`, { method: 'DELETE' })
      expect(deletedKnowledge.response.status).toBe(204)
      await json(`${system.url}/api/v1/product/ledger?sessionId=${session}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ commandId: 'ledger-after-backup', amountMinor: 99, currency: 'CNY', description: '备份后条目', occurredAt: '2026-09-08T12:02:00.000Z' }) })

      const changedDatabase = new DatabaseSync(join(system.dataRoot, 'local-data.sqlite3'), { readOnly: true })
      let changedJournal: unknown[]
      try {
        changedJournal = changedDatabase.prepare('SELECT domain, command_id FROM command_journal WHERE session_id = ? ORDER BY domain, command_id').all(session)
        expect(changedDatabase.prepare('SELECT COUNT(*) AS count FROM assets WHERE session_id = ?').get(session)).toEqual({ count: 0 })
        expect(changedDatabase.prepare("SELECT COUNT(*) AS count FROM knowledge_items WHERE session_id = ? AND source = 'user'").get(session)).toEqual({ count: 0 })
      } finally {
        changedDatabase.close()
      }

      const staged = await json(`${system.url}/api/v1/product/backups/${backup.body.data.id}/stage-restore?sessionId=${session}`, { method: 'POST' })
      const restored = await json(`${system.url}/api/v1/product/backups/${backup.body.data.id}/commit-restore?sessionId=${session}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ restoreToken: staged.body.data.restoreToken }) })
      expect(restored.body.data).toMatchObject({ restored: true, rollbackBackupId: expect.stringMatching(/^backup-/u) })

      const ledger = await json(`${system.url}/api/v1/product/ledger?${query}`)
      expect(ledger.body.data.items.map((entry: { description: string }) => entry.description)).toEqual(expect.arrayContaining(['购买月桂茶', '冲正月桂茶']))
      expect(ledger.body.data.items.map((entry: { description: string }) => entry.description)).not.toContain('备份后条目')
      const restoredAsset = await fetch(`${system.url}/api/v1/product/assets/${encodeURIComponent(assetId)}?sessionId=${session}`)
      expect(restoredAsset.status).toBe(200)
      expect(Buffer.from(await restoredAsset.arrayBuffer())).toEqual(Buffer.from('iVBORw0KGgo=', 'base64'))
      const restoredKnowledge = await json(`${system.url}/api/v1/product/knowledge?${query}`)
      expect(restoredKnowledge.body.data.items).toEqual(expect.arrayContaining([expect.objectContaining({ id: knowledgeId, text: '月门只在银潮最低时开启' })]))

      const database = new DatabaseSync(join(system.dataRoot, 'local-data.sqlite3'), { readOnly: true })
      try {
        const journal = database.prepare('SELECT domain, command_id FROM command_journal WHERE session_id = ? ORDER BY domain, command_id').all(session)
        expect(journal).toEqual(expect.arrayContaining([
          expect.objectContaining({ domain: 'asset.create' }),
          expect.objectContaining({ domain: 'asset.update' }),
          expect.objectContaining({ domain: 'knowledge.create', command_id: 'knowledge-moon-gate' }),
          expect.objectContaining({ domain: 'knowledge.update' }),
          expect.objectContaining({ domain: 'ledger.append', command_id: 'ledger-buy-tea' }),
          expect.objectContaining({ domain: 'ledger.append', command_id: 'ledger-reverse-tea' }),
        ]))
        expect(changedJournal).toEqual(expect.arrayContaining([
          expect.objectContaining({ domain: 'asset.delete' }),
          expect.objectContaining({ domain: 'knowledge.delete' }),
        ]))
        expect(database.prepare('SELECT COUNT(*) AS count FROM ledger_entries WHERE session_id = ?').get(session)).toEqual({ count: 2 })
      } finally {
        database.close()
      }
    } finally {
      await system.app.close()
    }
  })

  it('updates clears and rebuilds public RP projections without leaking private markers', async () => {
    const system = await createSystem()
    const session = 'session-moon'
    const projectionJson = async () => JSON.stringify({
      memories: (await json(`${system.url}/api/v1/product/memory?sessionId=${session}&limit=100`)).body.data.items,
      relationships: (await json(`${system.url}/api/v1/product/relationships?sessionId=${session}&limit=100`)).body.data.items,
      locations: (await json(`${system.url}/api/v1/product/locations?sessionId=${session}&limit=100`)).body.data.items,
    })
    try {
      expect(await projectionJson()).toContain('月港公开记忆')
      expect(await projectionJson()).not.toMatch(/PRIVATE-|SECRET-|GM-ONLY-|OFFSCREEN-/u)

      system.sessions.replace(session, publicState('新月'))
      system.sessions.emit({ type: 'projection', sessionId: session, branchId: 'branch-updated', sourceSeq: 4, state: publicState('新月') })
      await waitFor(async () => (await projectionJson()).includes('新月公开记忆'))
      expect(await projectionJson()).not.toContain('月港公开记忆')

      system.sessions.replace(session, publicState('空白', false))
      system.sessions.emit({ type: 'rebase', sessionId: session, branchId: 'branch-clear', sourceSeq: 5 })
      await waitFor(async () => JSON.parse(await projectionJson()).memories.length === 0)
      expect(JSON.parse(await projectionJson())).toMatchObject({ memories: [], relationships: [], locations: [] })

      system.sessions.replace(session, publicState('重建'))
      system.sessions.emit({ type: 'rebase', sessionId: session, branchId: 'branch-rebuild', sourceSeq: 6 })
      await waitFor(async () => (await projectionJson()).includes('重建公开记忆'))
      const rebuilt = await projectionJson()
      expect(rebuilt).toContain('安心')
      expect(rebuilt).not.toMatch(/PRIVATE-|SECRET-|GM-ONLY-|OFFSCREEN-/u)

      system.sessions.emit({ type: 'turn.completed', sessionId: session, sourceSeq: 7 })
      await waitFor(async () => (await json(`${system.url}/api/v1/product/notifications?sessionId=${session}&limit=100`)).body.data.items.some((item: { type: string }) => item.type === 'turn.completed'))

      const database = new DatabaseSync(join(system.dataRoot, 'local-data.sqlite3'), { readOnly: true })
      try {
        const values = database.prepare("SELECT text AS value FROM memory_index UNION ALL SELECT subject || ' ' || object || ' ' || relation || ' ' || COALESCE(status, '') FROM relationship_edges UNION ALL SELECT world || ' ' || COALESCE(region, '') || ' ' || COALESCE(scene, '') || ' ' || COALESCE(landmark, '') FROM location_snapshots").all()
        expect(JSON.stringify(values)).not.toMatch(/PRIVATE-|SECRET-|GM-ONLY-|OFFSCREEN-/u)
      } finally {
        database.close()
      }
    } finally {
      await system.app.close()
    }
  })

  it('enforces HTTPS pairing scopes and revocation on the real remote listener', async () => {
    const system = await createSystem()
    const port = await reservePort()
    const pairing = await startPairingListener({
      product: system.product,
      host: '127.0.0.1',
      port,
      cert: pairingCertificate,
      key: pairingPrivateKey,
      allowedOrigins: ['https://companion.example'],
    })
    try {
      const issued = await json(`${system.url}/api/v1/product/pairing/codes`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientName: '测试手机', requestedScopes: ['ledger:write'], sessionIds: ['session-moon'] }),
      })
      const confirmed = await insecureLoopbackJson(`${pairing.url}/api/v1/product/pairing/confirm`, { method: 'POST', body: { code: issued.body.data.code, clientName: '测试手机' } })
      expect(confirmed.status).toBe(200)
      expect(confirmed.body.data.scopes).toEqual(['product:read', 'ledger:write'])
      const authorization = { authorization: `Bearer ${confirmed.body.data.token}` }

      const bootstrap = await insecureLoopbackJson(`${pairing.url}/api/v1/product/bootstrap`, { headers: authorization })
      expect(bootstrap.body.data.sessions).toEqual([expect.objectContaining({ sessionId: 'session-moon', cardId: 'moon-guard' })])
      const ledger = await insecureLoopbackJson(`${pairing.url}/api/v1/product/ledger?sessionId=session-moon`, { method: 'POST', headers: authorization, body: { commandId: 'paired-ledger', amountMinor: 25, currency: 'CNY', description: '移动端追加', occurredAt: '2026-09-08T13:00:00.000Z' } })
      expect(ledger.status).toBe(201)
      const forbiddenAsset = await insecureLoopbackJson(`${pairing.url}/api/v1/product/assets?sessionId=session-moon`, { method: 'POST', headers: authorization, body: { fileName: '拒绝.png', mimeType: 'image/png', category: 'sticker', contentBase64: 'iVBORw0KGgo=' } })
      expect(forbiddenAsset.status).toBe(403)

      const revoked = await fetch(`${system.url}/api/v1/product/pairing/clients/${confirmed.body.data.clientId}`, { method: 'DELETE' })
      expect(revoked.status).toBe(204)
      const rejected = await insecureLoopbackJson(`${pairing.url}/api/v1/product/bootstrap`, { headers: authorization })
      expect(rejected.status).toBe(401)
    } finally {
      await pairing.app.close()
      await system.app.close()
    }
  })

  it('returns a recovery snapshot when a notification cursor falls behind retention', async () => {
    const system = await createSystem({ notificationRetention: 2 })
    const sessionId = 'session-moon'
    try {
      system.sessions.emit({ type: 'turn.completed', sessionId, sourceSeq: 10 })
      await waitFor(async () => (await json(`${system.url}/api/v1/product/notifications?sessionId=${sessionId}&limit=100`)).body.data.items.some((item: { id: string }) => item.id.endsWith(':10')))
      const initial = await json(`${system.url}/api/v1/product/notifications?sessionId=${sessionId}&limit=100`)
      const oldCursor = initial.body.data.cursor as string

      for (const sourceSeq of [11, 12, 13]) system.sessions.emit({ type: 'turn.completed', sessionId, sourceSeq })
      await waitFor(async () => (await json(`${system.url}/api/v1/product/notifications?sessionId=${sessionId}&limit=100`)).body.data.items.some((item: { id: string }) => item.id.endsWith(':13')))
      const recovered = await json(`${system.url}/api/v1/product/notifications?sessionId=${sessionId}&limit=100&cursor=${encodeURIComponent(oldCursor)}`)

      expect(recovered.body).toMatchObject({ ok: true, protocolVersion: 1, data: { resetRequired: true, snapshot: expect.any(Array) } })
      expect(recovered.body.data.snapshot).toHaveLength(2)
      expect(recovered.body.data.snapshot.map((item: { id: string }) => item.id)).toEqual(expect.arrayContaining([expect.stringMatching(/:12$/u), expect.stringMatching(/:13$/u)]))
    } finally {
      await system.app.close()
    }
  })
})
