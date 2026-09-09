import { createHash } from 'node:crypto'
import type {
  PairingClient, PairingCodeRequest, PairingScope, ProductAsset, ProductAssetPatch, ProductAssetUpload, ProductBackup, ProductBootstrap, ProductKnowledge, ProductKnowledgeCreate, ProductLedgerCreate, ProductLedgerEntry, ProductLocation, ProductMemory, ProductNotification, ProductNotificationBatch, ProductPageQuery, ProductRelationship, ProductScope, ProductStatus,
} from '@dsh-rp/protocol'
import { productAssetMimeSchema, productAssetSchema, productBackupSchema, productKnowledgeSchema, productLedgerEntrySchema, productLocationSchema, productMemorySchema, productNotificationBatchSchema, productNotificationSchema, productRelationshipSchema, productStatusSchema } from '@dsh-rp/protocol'
import type { ProductSourceEvent, SessionApi } from './app.js'
import { GatewayError } from './errors.js'
import { PairingManager, type PairingTokenRecord } from './pairing.js'
import { toProductProjection } from './product-projection.js'

export interface ProductPage<T> {
  items: T[]
  nextCursor: string | null
}

export interface ProductStorePageQuery {
  sessionId: string
  cursor?: string | undefined
  limit?: number
  category?: ProductAsset['category']
}

export interface ProductAssetRead {
  metadata: ProductAsset
  bytes: Uint8Array
}

export interface ProductProjectionReplacement {
  branchId: string
  fromSeq: number
  memories: ProductMemory[]
  relationships: ProductRelationship[]
  locations: ProductLocation[]
}

export interface ProductDataStore {
  status(): Promise<{ storage: 'ready' | 'unavailable'; schemaVersion: number; projection: 'current' | 'rebuilding' | 'unavailable' }>
  close(): Promise<void>
  listAssets(scope: ProductScope, query: ProductStorePageQuery): Promise<ProductPage<ProductAsset>>
  putAsset(input: { scope: ProductScope; metadata: ProductAsset; bytes: Uint8Array }): Promise<ProductAsset>
  readAsset(scope: ProductScope, assetId: string): Promise<ProductAssetRead | undefined>
  updateAsset(scope: ProductScope, assetId: string, patch: ProductAssetPatch): Promise<ProductAsset | undefined>
  deleteAsset(scope: ProductScope, assetId: string): Promise<boolean>
  listLedger(scope: ProductScope, query: ProductStorePageQuery): Promise<ProductPage<ProductLedgerEntry>>
  appendLedger(scope: ProductScope, input: ProductLedgerCreate): Promise<ProductLedgerEntry>
  listKnowledge(scope: ProductScope, query: ProductStorePageQuery): Promise<ProductPage<ProductKnowledge>>
  createKnowledge(scope: ProductScope, input: ProductKnowledgeCreate): Promise<ProductKnowledge>
  updateKnowledge(scope: ProductScope, knowledgeId: string, text: string): Promise<ProductKnowledge | undefined>
  deleteKnowledge(scope: ProductScope, knowledgeId: string): Promise<boolean>
  listMemories(scope: ProductScope, query: ProductStorePageQuery): Promise<ProductPage<ProductMemory>>
  listRelationships(scope: ProductScope, query: ProductStorePageQuery): Promise<ProductPage<ProductRelationship>>
  listLocations(scope: ProductScope, query: ProductStorePageQuery): Promise<ProductPage<ProductLocation>>
  replaceProjections(scope: ProductScope, replacement: ProductProjectionReplacement): Promise<void>
  readNotifications(scope: ProductScope, cursor?: string): Promise<ProductNotificationBatch>
  appendNotification(scope: ProductScope, input: Omit<ProductNotification, 'cursor' | 'acknowledged'>): Promise<ProductNotification>
  acknowledgeNotification(scope: ProductScope, notificationId: string): Promise<boolean>
  listBackups(scope: ProductScope, query: ProductStorePageQuery): Promise<ProductPage<ProductBackup>>
  createBackup(scope: ProductScope, commandId: string): Promise<ProductBackup>
  exportBackup(scope: ProductScope, backupId: string): Promise<Uint8Array | undefined>
  importBackup(scope: ProductScope, bytes: Uint8Array, commandId: string): Promise<ProductBackup>
  stageRestore(scope: ProductScope, backupId: string): Promise<{ backupId: string; restoreToken: string; expiresAt: string; manifestHash: string } | undefined>
  commitRestore(scope: ProductScope, backupId: string, restoreToken: string): Promise<{ restored: true; rollbackBackupId: string } | undefined>
  savePairingToken(record: PairingTokenRecord): Promise<void>
  findPairingToken(tokenHash: string): Promise<(PairingTokenRecord & { revoked: boolean }) | undefined>
  listPairingClients(): Promise<PairingClient[]>
  revokePairingClient(clientId: string): Promise<boolean>
  subscribeNotifications?: (listener: ProductNotificationListener) => () => void
}

export interface ProductNotificationListener {
  (scope: ProductScope, batch: ProductNotificationBatch): void
}

export interface ProductServiceOptions {
  sessions: Pick<SessionApi, 'session'> & Partial<Pick<SessionApi, 'sessions' | 'subscribeProduct' | 'getProductScope' | 'productSnapshots'>>
  store?: ProductDataStore
  pairingEnabled?: boolean
  pairingWriteScopes?: PairingScope[]
  now?: () => number
  doctor?: { code: string; message: string }
  pairingListener?: 'loopback' | 'https-lan'
}

const MAX_ASSET_BYTES = 10 * 1024 * 1024
const MAX_BACKUP_BYTES = 32 * 1024 * 1024
const assetMimeTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'audio/mpeg', 'audio/ogg', 'audio/wav', 'application/pdf'])

export class ProductService {
  private readonly pairing: PairingManager
  private readonly listeners = new Set<ProductNotificationListener>()
  private readonly now: () => number
  private readonly unsubscribeStoreNotifications: (() => void) | undefined
  private unsubscribeProductSource: (() => void) | undefined
  private readonly sourceQueues = new Map<string, Promise<void>>()
  private doctor: { code: string; message: string } | undefined

  constructor(private readonly options: ProductServiceOptions) {
    this.now = options.now ?? Date.now
    this.doctor = options.doctor
    this.pairing = new PairingManager({
      enabled: options.pairingEnabled ?? false,
      saveToken: async record => { if (!options.store) throw new GatewayError({ code: 'storage-unavailable', message: '本地产品数据服务尚未就绪。' }, 503); await options.store.savePairingToken(record) },
      listClients: async () => options.store?.listPairingClients() ?? [],
      revokeClient: async clientId => options.store?.revokePairingClient(clientId) ?? false,
      now: this.now,
      allowedWriteScopes: options.pairingWriteScopes ?? [],
      listener: options.pairingEnabled ? options.pairingListener ?? 'loopback' : 'disabled',
    })
    this.unsubscribeStoreNotifications = options.store?.subscribeNotifications?.((scope, batch) => this.publishNotifications(scope, batch))
  }

  async close(): Promise<void> {
    this.unsubscribeProductSource?.()
    this.unsubscribeProductSource = undefined
    this.unsubscribeStoreNotifications?.()
    await Promise.allSettled(this.sourceQueues.values())
    await this.options.store?.close()
  }

  async start(): Promise<void> {
    if (!this.options.store) return
    this.unsubscribeProductSource = this.options.sessions.subscribeProduct?.(event => this.enqueueSource(event))
    if (!this.options.sessions.productSnapshots) {
      this.doctor = { code: 'projection-source-unavailable', message: '会话服务未提供官方投影游标。' }
      return
    }
    try {
      const snapshots = await this.options.sessions.productSnapshots()
      await Promise.all(snapshots.map(snapshot => this.replaceSnapshot(snapshot.detail, snapshot.scope, snapshot.sourceSeq)))
    } catch {
      this.doctor = { code: 'projection-sync-failed', message: '本地读模型初始化失败，可在 DSH 恢复后重试。' }
    }
  }

  async status(): Promise<ProductStatus> {
    let storage: { storage: 'ready' | 'unavailable'; schemaVersion: number | null; projection: 'current' | 'rebuilding' | 'unavailable' }
    try {
      storage = this.options.store ? await this.options.store.status() : { storage: 'unavailable', schemaVersion: null, projection: 'unavailable' }
    } catch {
      storage = { storage: 'unavailable', schemaVersion: null, projection: 'unavailable' }
      this.doctor = { code: 'local-data-status-failed', message: '本地数据服务状态检查失败。' }
    }
    return productStatusSchema.parse({ apiVersion: 1, dshCompatibility: '0.1.2-rc.1', ...storage, pairing: this.pairing.status(), ...(this.doctor ? { doctor: this.doctor } : {}) })
  }

  async assets(query: ProductPageQuery): Promise<ProductPage<ProductAsset>> {
    return this.withStore(async store => this.parsePage(await store.listAssets(await this.scope(query.sessionId), this.storeQuery(query)), productAssetSchema))
  }

  async uploadAsset(sessionId: string, input: ProductAssetUpload): Promise<ProductAsset> {
    const scope = await this.scope(sessionId)
    const mimeType = productAssetMimeSchema.safeParse(input.mimeType)
    if (!mimeType.success || !assetMimeTypes.has(input.mimeType)) throw new GatewayError({ code: 'unsupported-media-type', message: '该资产类型不在允许列表中。' }, 415)
    if (input.fileName.includes('\\') || input.fileName.includes('/') || input.fileName.includes(String.fromCharCode(0)) || input.fileName === '.' || input.fileName === '..') throw new GatewayError({ code: 'bad-request', message: '资产文件名不能包含路径。' }, 400)
    const bytes = this.decodeBase64(input.contentBase64)
    const id = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
    const metadata = productAssetSchema.parse({ id, fileName: input.fileName, mimeType: mimeType.data, category: input.category, ...(input.label === undefined ? {} : { label: input.label }), bytes: bytes.byteLength, createdAt: new Date(this.now()).toISOString() })
    const saved = await this.withStore(async store => productAssetSchema.parse(await store.putAsset({ scope, metadata, bytes })))
    await this.notify(scope, `asset:${saved.id}`, 'asset.created', '资产已保存', saved.label ?? saved.fileName)
    return saved
  }

  async asset(sessionId: string, assetId: string): Promise<ProductAssetRead> {
    const value = await this.withStore(async store => store.readAsset(await this.scope(sessionId), assetId))
    if (!value) throw new GatewayError({ code: 'not-found', message: '找不到该资产。' }, 404)
    const expected = `sha256:${createHash('sha256').update(value.bytes).digest('hex')}`
    if (expected !== value.metadata.id || value.metadata.id !== assetId) throw new GatewayError({ code: 'internal', message: '资产完整性校验失败。' }, 500)
    return { metadata: productAssetSchema.parse(value.metadata), bytes: value.bytes }
  }

  async updateAsset(sessionId: string, assetId: string, patch: ProductAssetPatch): Promise<ProductAsset> {
    const value = await this.withStore(async store => store.updateAsset(await this.scope(sessionId), assetId, patch))
    if (!value) throw new GatewayError({ code: 'not-found', message: '找不到该资产。' }, 404)
    return productAssetSchema.parse(value)
  }

  async deleteAsset(sessionId: string, assetId: string): Promise<void> {
    const deleted = await this.withStore(async store => store.deleteAsset(await this.scope(sessionId), assetId))
    if (!deleted) throw new GatewayError({ code: 'not-found', message: '找不到该资产。' }, 404)
  }

  async ledger(query: ProductPageQuery): Promise<ProductPage<ProductLedgerEntry>> {
    return this.withStore(async store => this.parsePage(await store.listLedger(await this.scope(query.sessionId), this.storeQuery(query)), productLedgerEntrySchema))
  }

  async appendLedger(sessionId: string, input: ProductLedgerCreate): Promise<ProductLedgerEntry> {
    if (!Number.isSafeInteger(input.amountMinor)) throw new GatewayError({ code: 'bad-request', message: '账本科目必须是安全范围内的整数最小货币单位。' }, 400)
    return this.withStore(async store => productLedgerEntrySchema.parse(await store.appendLedger(await this.scope(sessionId), input)))
  }

  async knowledge(query: ProductPageQuery): Promise<ProductPage<ProductKnowledge>> {
    return this.withStore(async store => this.parsePage(await store.listKnowledge(await this.scope(query.sessionId), this.storeQuery(query)), productKnowledgeSchema))
  }

  async createKnowledge(sessionId: string, input: ProductKnowledgeCreate): Promise<ProductKnowledge> {
    return this.withStore(async store => productKnowledgeSchema.parse(await store.createKnowledge(await this.scope(sessionId), input)))
  }

  async updateKnowledge(sessionId: string, knowledgeId: string, text: string): Promise<ProductKnowledge> {
    const value = await this.withStore(async store => store.updateKnowledge(await this.scope(sessionId), knowledgeId, text))
    if (!value) throw new GatewayError({ code: 'not-found', message: '找不到该知识注释。' }, 404)
    return productKnowledgeSchema.parse(value)
  }

  async deleteKnowledge(sessionId: string, knowledgeId: string): Promise<void> {
    const deleted = await this.withStore(async store => store.deleteKnowledge(await this.scope(sessionId), knowledgeId))
    if (!deleted) throw new GatewayError({ code: 'not-found', message: '找不到该知识注释。' }, 404)
  }

  async memories(query: ProductPageQuery): Promise<ProductPage<ProductMemory>> {
    return this.withStore(async store => this.parsePage(await store.listMemories(await this.scope(query.sessionId), this.storeQuery(query)), productMemorySchema))
  }

  async relationships(query: ProductPageQuery): Promise<ProductPage<ProductRelationship>> {
    return this.withStore(async store => this.parsePage(await store.listRelationships(await this.scope(query.sessionId), this.storeQuery(query)), productRelationshipSchema))
  }

  async locations(query: ProductPageQuery): Promise<ProductPage<ProductLocation>> {
    return this.withStore(async store => this.parsePage(await store.listLocations(await this.scope(query.sessionId), this.storeQuery(query)), productLocationSchema))
  }

  async replaceProjections(sessionId: string, replacement: ProductProjectionReplacement): Promise<void> {
    const scope = await this.scope(sessionId)
    const parsed = {
      branchId: replacement.branchId,
      fromSeq: replacement.fromSeq,
      memories: replacement.memories.map(item => productMemorySchema.parse(item)),
      relationships: replacement.relationships.map(item => productRelationshipSchema.parse(item)),
      locations: replacement.locations.map(item => productLocationSchema.parse(item)),
    }
    await this.withStore(store => store.replaceProjections(scope, parsed))
  }

  async notifications(query: ProductPageQuery): Promise<ProductNotificationBatch> {
    return this.withStore(async store => productNotificationBatchSchema.parse(await store.readNotifications(await this.scope(query.sessionId), query.cursor)))
  }

  subscribe(listener: ProductNotificationListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  publishNotifications(scope: ProductScope, batch: ProductNotificationBatch): void {
    const parsed = productNotificationBatchSchema.parse(batch)
    for (const listener of this.listeners) listener(scope, parsed)
  }

  async acknowledgeNotification(sessionId: string, notificationId: string): Promise<void> {
    const acknowledged = await this.withStore(async store => store.acknowledgeNotification(await this.scope(sessionId), notificationId))
    if (!acknowledged) throw new GatewayError({ code: 'not-found', message: '找不到该通知。' }, 404)
  }

  async backups(query: ProductPageQuery): Promise<ProductPage<ProductBackup>> {
    return this.withStore(async store => this.parsePage(await store.listBackups(await this.scope(query.sessionId), this.storeQuery(query)), productBackupSchema))
  }

  async createBackup(sessionId: string, commandId: string): Promise<ProductBackup> {
    const scope = await this.scope(sessionId)
    const backup = await this.withStore(async store => productBackupSchema.parse(await store.createBackup(scope, commandId)))
    await this.notify(scope, `backup:${backup.id}`, 'backup.ready', '备份已完成', '应用数据与公共 RP 投影已通过一致性校验。')
    return backup
  }

  async exportBackup(sessionId: string, backupId: string): Promise<Uint8Array> {
    const bytes = await this.withStore(async store => store.exportBackup(await this.scope(sessionId), backupId))
    if (!bytes) throw new GatewayError({ code: 'not-found', message: '找不到可导出的备份。' }, 404)
    if (bytes.byteLength > MAX_BACKUP_BYTES) throw new GatewayError({ code: 'payload-too-large', message: '备份超过 32 MiB 限制。' }, 413)
    return Uint8Array.from(bytes)
  }

  async importBackup(sessionId: string, bytes: Uint8Array, commandId: string): Promise<ProductBackup> {
    if (bytes.byteLength === 0) throw new GatewayError({ code: 'bad-request', message: '导入备份不能为空。' }, 400)
    if (bytes.byteLength > MAX_BACKUP_BYTES) throw new GatewayError({ code: 'payload-too-large', message: '备份超过 32 MiB 限制。' }, 413)
    return this.withStore(async store => productBackupSchema.parse(await store.importBackup(await this.scope(sessionId), Uint8Array.from(bytes), commandId)))
  }

  async stageRestore(sessionId: string, backupId: string): Promise<{ backupId: string; restoreToken: string; expiresAt: string; manifestHash: string }> {
    const value = await this.withStore(async store => store.stageRestore(await this.scope(sessionId), backupId))
    if (!value) throw new GatewayError({ code: 'not-found', message: '找不到可恢复的备份。' }, 404)
    if (value.restoreToken.length < 20 || value.manifestHash.length < 10) throw new GatewayError({ code: 'internal', message: '备份恢复校验未生成有效令牌。' }, 500)
    return value
  }

  async commitRestore(sessionId: string, backupId: string, restoreToken: string): Promise<{ restored: true; rollbackBackupId: string }> {
    const value = await this.withStore(async store => store.commitRestore(await this.scope(sessionId), backupId, restoreToken))
    if (!value) throw new GatewayError({ code: 'conflict', message: '备份恢复令牌无效或已过期。' }, 409)
    return value
  }

  pairingStatus(): ProductStatus['pairing'] { return this.pairing.status() }
  async createPairingCode(input: PairingCodeRequest): Promise<{ code: string; expiresAt: string; requestedScopes: PairingScope[]; sessionIds: string[] }> {
    await Promise.all(input.sessionIds.map(sessionId => this.scope(sessionId)))
    return this.pairing.createCode(input)
  }
  confirmPairing(input: { code: string; clientName: string }, source: string): Promise<{ clientId: string; token: string; scopes: PairingScope[]; sessionIds: string[]; expiresAt: string }> { return this.pairing.confirm(input, source) }
  pairingClients(): Promise<PairingClient[]> { return this.pairing.clients() }
  revokePairingClient(clientId: string): Promise<boolean> { return this.pairing.revoke(clientId) }
  async authorizePairingToken(token: string): Promise<PairingTokenRecord & { revoked: boolean }> {
    if (!this.options.store || !/^[A-Za-z0-9_-]{40,}$/u.test(token)) throw new GatewayError({ code: 'unauthorized', message: '移动端认证无效。' }, 401)
    const hash = `sha256:${createHash('sha256').update(token, 'utf8').digest('hex')}`
    const record = await this.options.store.findPairingToken(hash)
    if (!record || record.revoked || Date.parse(record.expiresAt) <= this.now()) throw new GatewayError({ code: 'unauthorized', message: '移动端认证无效。' }, 401)
    return record
  }

  async bootstrap(token: string): Promise<ProductBootstrap> {
    const authorized = await this.authorizePairingToken(token)
    const sessions = (await Promise.all(authorized.sessionIds.map(async sessionId => {
      try {
        const detail = await this.options.sessions.session(sessionId)
        return { sessionId: detail.session.id, cardId: detail.session.cardId, title: detail.session.title }
      } catch { return undefined }
    }))).filter((value): value is NonNullable<typeof value> => value !== undefined)
    return { clientId: authorized.clientId, clientName: authorized.clientName, scopes: authorized.scopes, expiresAt: authorized.expiresAt, sessions }
  }

  private async scope(sessionId: string): Promise<ProductScope> {
    try {
      if (!this.options.sessions.getProductScope) throw new GatewayError({ code: 'storage-unavailable', message: '会话工作区解析器尚未就绪。' }, 503)
      return await this.options.sessions.getProductScope(sessionId)
    } catch (error) {
      if (error instanceof GatewayError) throw error
      throw new GatewayError({ code: 'not-found', message: '找不到该 RP 会话。' }, 404)
    }
  }

  private async withStore<T>(operation: (store: ProductDataStore) => Promise<T>): Promise<T> {
    if (!this.options.store) throw new GatewayError({ code: 'storage-unavailable', message: '本地产品数据服务尚未就绪。' }, 503)
    try { return await operation(this.options.store) } catch (error) {
      if (error instanceof GatewayError) throw error
      if (error instanceof Error && error.name === 'DataConflictError') throw new GatewayError({ code: 'conflict', message: '产品数据已被其他操作更新，请刷新后重试。' }, 409)
      if (error instanceof Error && ['DataValidationError', 'DataInputError'].includes(error.name)) throw new GatewayError({ code: 'bad-request', message: '产品数据请求未通过校验。' }, 400)
      if (error instanceof Error && error.name === 'DataPayloadTooLargeError') throw new GatewayError({ code: 'payload-too-large', message: '产品数据超过允许大小。' }, 413)
      if (error instanceof Error && error.name === 'DataMediaTypeError') throw new GatewayError({ code: 'unsupported-media-type', message: '产品数据媒体类型不受支持。' }, 415)
      if (error instanceof Error && error.name === 'DataIntegrityError') throw new GatewayError({ code: 'internal', message: '本地产品数据完整性校验失败。' }, 500)
      if (error instanceof Error && error.name === 'ZodError') throw new GatewayError({ code: 'internal', message: '本地产品数据未通过公共协议校验。' }, 500)
      throw new GatewayError({ code: 'storage-unavailable', message: '本地产品数据服务暂不可用。' }, 503)
    }
  }

  private enqueueSource(event: ProductSourceEvent): void {
    const previous = this.sourceQueues.get(event.sessionId) ?? Promise.resolve()
    const current = previous.then(() => this.handleSource(event)).catch(() => {
      this.doctor = { code: 'projection-update-failed', message: '公共 RP 读模型更新失败。' }
    }).finally(() => {
      if (this.sourceQueues.get(event.sessionId) === current) this.sourceQueues.delete(event.sessionId)
    })
    this.sourceQueues.set(event.sessionId, current)
  }

  private async handleSource(event: ProductSourceEvent): Promise<void> {
    const scope = await this.scope(event.sessionId)
    if (event.type === 'projection') {
      const detail = await this.options.sessions.session(event.sessionId)
      await this.replaceSnapshot({ ...detail, state: event.state, session: { ...detail.session, state: event.state } }, scope, event.sourceSeq)
      return
    }
    if (event.type === 'rebase') {
      const detail = await this.options.sessions.session(event.sessionId)
      await this.replaceSnapshot(detail, scope, event.sourceSeq)
      return
    }
    const definitions = {
      'turn.completed': ['turn.completed', '回合已完成', '新的公开叙事回合已写入。'],
      'attention.required': ['attention.required', '需要在桌面处理', 'DSH 有一项确认或问题等待桌面端处理。'],
      'autoplay.completed': ['autoplay.completed', '自动续跑已结束', '自动续跑目标已结束或停止。'],
    } as const
    const [type, title, body] = definitions[event.type]
    await this.notify(scope, `dsh:${event.type}:${event.sessionId}:${event.sourceSeq}`, type, title, body)
  }

  private async replaceSnapshot(detail: import('@dsh-rp/protocol').SessionDetail, scope: ProductScope, sourceSeq: number): Promise<void> {
    const replacement = toProductProjection(detail, scope.branchId, sourceSeq)
    await this.withStore(store => store.replaceProjections(scope, replacement))
  }

  private async notify(scope: ProductScope, id: string, type: string, title: string, body: string): Promise<void> {
    const notification = await this.withStore(async store => productNotificationSchema.parse(await store.appendNotification(scope, { id, type, title, body, createdAt: new Date(this.now()).toISOString() })))
    this.publishNotifications(scope, { items: [notification], cursor: notification.cursor, resetRequired: false })
  }

  private parsePage<T>(page: ProductPage<T>, schema: { parse(value: unknown): T }): ProductPage<T> {
    return { items: page.items.map(item => schema.parse(item)), nextCursor: page.nextCursor }
  }

  private storeQuery(query: ProductPageQuery): ProductStorePageQuery {
    return { sessionId: query.sessionId, limit: query.limit, ...(query.cursor === undefined ? {} : { cursor: query.cursor }), ...(query.category === undefined ? {} : { category: query.category }) }
  }

  private decodeBase64(value: string): Uint8Array {
    if (value.length > Math.ceil(MAX_ASSET_BYTES / 3) * 4 + 4) throw new GatewayError({ code: 'payload-too-large', message: '资产大小超过 10 MiB 限制。' }, 413)
    if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(value) || value.length % 4 === 1) throw new GatewayError({ code: 'bad-request', message: '资产内容不是有效的 base64。' }, 400)
    const bytes = Buffer.from(value, 'base64')
    if (bytes.byteLength > MAX_ASSET_BYTES) throw new GatewayError({ code: 'payload-too-large', message: '资产大小超过 10 MiB 限制。' }, 413)
    return bytes
  }
}

export function unavailableProductService(sessions: Pick<SessionApi, 'session'>): ProductService {
  return new ProductService({ sessions })
}

export const PRODUCT_BACKUP_MAX_BYTES = MAX_BACKUP_BYTES
