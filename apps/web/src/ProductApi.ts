import {
  apiEnvelopeSchema,
  pairingClientSchema,
  pairingCodeSchema,
  pairingTokenSchema,
  productBootstrapSchema,
  productAssetCategorySchema,
  productAssetMimeSchema,
  productAssetSchema,
  productBackupSchema,
  productKnowledgeSchema,
  productLedgerEntrySchema,
  productLocationSchema,
  productMemorySchema,
  productNotificationBatchSchema,
  productNotificationSchema,
  productRelationshipSchema,
  productStatusSchema,
  type PairingClient,
  type PairingCodeRequest,
  type ProductAsset,
  type ProductBackup,
  type ProductKnowledge,
  type ProductLedgerCreate,
  type ProductLedgerEntry,
  type ProductLocation,
  type ProductMemory,
  type ProductNotification,
  type ProductRelationship,
  type ProductStatus,
  type ProductBootstrap,
} from '@dsh-rp/protocol'
import { z } from 'zod'

export type ProductPage<T> = { items: T[]; nextCursor: string | null }
export type ProductCategory = z.infer<typeof productAssetCategorySchema>
export type ProductProjection = ProductMemory | ProductRelationship | ProductLocation

export class ProductApiError extends Error {
  readonly code: string
  readonly status: number

  constructor(message: string, code = 'internal', status = 500) {
    super(message)
    this.name = 'ProductApiError'
    this.code = code
    this.status = status
  }
}

const pageSchema = <T>(item: z.ZodType<T>) => z.object({ items: z.array(item), nextCursor: z.string().nullable() }).strict()
const restoreStageSchema = z.object({ backupId: z.string().min(1), restoreToken: z.string().min(20), expiresAt: z.string().datetime(), manifestHash: z.string().regex(/^sha256:[a-f0-9]{64}$/u) }).strict()
const restoreCommitSchema = z.object({ restored: z.literal(true), rollbackBackupId: z.string().min(1) }).strict()
const acknowledgeSchema = z.object({ acknowledged: z.literal(true) }).strict()
const pairingStatusSchema = productStatusSchema.shape.pairing

function query(sessionId: string, cursor?: string, limit = 20): string {
  const params = new URLSearchParams({ sessionId, limit: String(limit) })
  if (cursor) params.set('cursor', cursor)
  return params.toString()
}

function randomCommandId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  const chunk = 0x8000
  for (let index = 0; index < bytes.length; index += chunk) binary += String.fromCharCode(...bytes.subarray(index, index + chunk))
  return btoa(binary)
}

export class ProductApi {
  private bearer: string | undefined
  private readonly subscriptions = new Set<AbortController>()

  constructor(private readonly fetcher: typeof fetch = (input, init) => fetch(input, init)) {}

  withBearer(token: string): this {
    this.bearer = token
    return this
  }

  clearBearer(): void {
    this.bearer = undefined
    for (const controller of this.subscriptions) controller.abort()
    this.subscriptions.clear()
  }

  async status(signal?: AbortSignal): Promise<ProductStatus> {
    return this.request('/api/v1/product/status', productStatusSchema, signal ? { signal } : undefined)
  }

  assets(sessionId: string, category?: ProductCategory, cursor?: string, signal?: AbortSignal): Promise<ProductPage<ProductAsset>> {
    const suffix = category ? `&category=${encodeURIComponent(category)}` : ''
    return this.request(`/api/v1/product/assets?${query(sessionId, cursor)}${suffix}`, pageSchema(productAssetSchema), signal ? { signal } : undefined)
  }

  async uploadAsset(sessionId: string, file: File, category: ProductCategory, label?: string): Promise<ProductAsset> {
    if (file.size > 10 * 1024 * 1024) throw new ProductApiError('资产大小超过 10 MiB 限制。', 'payload-too-large', 413)
    const mime = productAssetMimeSchema.safeParse(file.type)
    if (!mime.success) throw new ProductApiError('该资产类型不在允许列表中。', 'unsupported-media-type', 415)
    const input = { fileName: file.name, mimeType: mime.data, category, contentBase64: await fileToBase64(file), ...(label?.trim() ? { label: label.trim() } : {}) }
    return this.request(`/api/v1/product/assets?sessionId=${encodeURIComponent(sessionId)}`, productAssetSchema, { method: 'POST', body: JSON.stringify(input) })
  }

  async downloadAsset(sessionId: string, asset: ProductAsset): Promise<void> {
    const response = await this.fetcher(`/api/v1/product/assets/${encodeURIComponent(asset.id)}?sessionId=${encodeURIComponent(sessionId)}`, { headers: this.headers() })
    if (!response.ok) throw await this.errorFromResponse(response)
    const blob = await response.blob()
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = asset.fileName
    link.click()
    URL.revokeObjectURL(url)
  }

  updateAsset(sessionId: string, assetId: string, label: string | null): Promise<ProductAsset> {
    return this.request(`/api/v1/product/assets/${encodeURIComponent(assetId)}?sessionId=${encodeURIComponent(sessionId)}`, productAssetSchema, { method: 'PATCH', body: JSON.stringify({ label }) })
  }

  deleteAsset(sessionId: string, assetId: string): Promise<void> {
    return this.empty(`/api/v1/product/assets/${encodeURIComponent(assetId)}?sessionId=${encodeURIComponent(sessionId)}`, { method: 'DELETE' })
  }

  ledger(sessionId: string, cursor?: string, signal?: AbortSignal): Promise<ProductPage<ProductLedgerEntry>> {
    return this.request(`/api/v1/product/ledger?${query(sessionId, cursor)}`, pageSchema(productLedgerEntrySchema), signal ? { signal } : undefined)
  }

  createLedger(sessionId: string, input: Omit<ProductLedgerCreate, 'commandId'> & { commandId?: string }): Promise<ProductLedgerEntry> {
    const body = { ...input, commandId: input.commandId ?? randomCommandId('ledger') }
    return this.request(`/api/v1/product/ledger?sessionId=${encodeURIComponent(sessionId)}`, productLedgerEntrySchema, { method: 'POST', body: JSON.stringify(body) })
  }

  knowledge(sessionId: string, cursor?: string, signal?: AbortSignal): Promise<ProductPage<ProductKnowledge>> {
    return this.request(`/api/v1/product/knowledge?${query(sessionId, cursor)}`, pageSchema(productKnowledgeSchema), signal ? { signal } : undefined)
  }

  createKnowledge(sessionId: string, text: string): Promise<ProductKnowledge> {
    return this.request(`/api/v1/product/knowledge?sessionId=${encodeURIComponent(sessionId)}`, productKnowledgeSchema, { method: 'POST', body: JSON.stringify({ commandId: randomCommandId('knowledge'), text }) })
  }

  updateKnowledge(sessionId: string, id: string, text: string): Promise<ProductKnowledge> {
    return this.request(`/api/v1/product/knowledge/${encodeURIComponent(id)}?sessionId=${encodeURIComponent(sessionId)}`, productKnowledgeSchema, { method: 'PATCH', body: JSON.stringify({ text }) })
  }

  deleteKnowledge(sessionId: string, id: string): Promise<void> {
    return this.empty(`/api/v1/product/knowledge/${encodeURIComponent(id)}?sessionId=${encodeURIComponent(sessionId)}`, { method: 'DELETE' })
  }

  memories(sessionId: string, cursor?: string, signal?: AbortSignal): Promise<ProductPage<ProductMemory>> { return this.request(`/api/v1/product/memory?${query(sessionId, cursor)}`, pageSchema(productMemorySchema), signal ? { signal } : undefined) }
  relationships(sessionId: string, cursor?: string, signal?: AbortSignal): Promise<ProductPage<ProductRelationship>> { return this.request(`/api/v1/product/relationships?${query(sessionId, cursor)}`, pageSchema(productRelationshipSchema), signal ? { signal } : undefined) }
  locations(sessionId: string, cursor?: string, signal?: AbortSignal): Promise<ProductPage<ProductLocation>> { return this.request(`/api/v1/product/locations?${query(sessionId, cursor)}`, pageSchema(productLocationSchema), signal ? { signal } : undefined) }

  notifications(sessionId: string, cursor?: string, signal?: AbortSignal): Promise<z.infer<typeof productNotificationBatchSchema>> {
    return this.request(`/api/v1/product/notifications?${query(sessionId, cursor)}`, productNotificationBatchSchema, signal ? { signal } : undefined)
  }

  acknowledge(sessionId: string, id: string): Promise<z.infer<typeof acknowledgeSchema>> {
    return this.request(`/api/v1/product/notifications/${encodeURIComponent(id)}/ack?sessionId=${encodeURIComponent(sessionId)}`, acknowledgeSchema, { method: 'POST', body: '{}' })
  }

  backups(sessionId: string, cursor?: string, signal?: AbortSignal): Promise<ProductPage<ProductBackup>> { return this.request(`/api/v1/product/backups?${query(sessionId, cursor)}`, pageSchema(productBackupSchema), signal ? { signal } : undefined) }
  createBackup(sessionId: string): Promise<ProductBackup> {
    return this.request(`/api/v1/product/backups?sessionId=${encodeURIComponent(sessionId)}`, productBackupSchema, { method: 'POST', body: JSON.stringify({ commandId: randomCommandId('backup') }) })
  }
  stageRestore(sessionId: string, id: string): Promise<z.infer<typeof restoreStageSchema>> {
    return this.request(`/api/v1/product/backups/${encodeURIComponent(id)}/stage-restore?sessionId=${encodeURIComponent(sessionId)}`, restoreStageSchema, { method: 'POST', body: '{}' })
  }
  commitRestore(sessionId: string, id: string, restoreToken: string): Promise<z.infer<typeof restoreCommitSchema>> {
    return this.request(`/api/v1/product/backups/${encodeURIComponent(id)}/commit-restore?sessionId=${encodeURIComponent(sessionId)}`, restoreCommitSchema, { method: 'POST', body: JSON.stringify({ restoreToken }) })
  }

  pairing(signal?: AbortSignal): Promise<z.infer<typeof pairingStatusSchema>> { return this.request('/api/v1/product/pairing', pairingStatusSchema, signal ? { signal } : undefined) }
  createPairingCode(clientName: string, sessionIds: string[], requestedScopes: PairingCodeRequest['requestedScopes'] = []): Promise<z.infer<typeof pairingCodeSchema>> {
    return this.request('/api/v1/product/pairing/codes', pairingCodeSchema, { method: 'POST', body: JSON.stringify({ clientName, requestedScopes, sessionIds }) })
  }
  confirmPairing(code: string, clientName: string, signal?: AbortSignal): Promise<z.infer<typeof pairingTokenSchema>> {
    return this.request('/api/v1/product/pairing/confirm', pairingTokenSchema, { method: 'POST', body: JSON.stringify({ code, clientName }), ...(signal ? { signal } : {}) })
  }
  bootstrap(signal?: AbortSignal): Promise<ProductBootstrap> { return this.request('/api/v1/product/bootstrap', productBootstrapSchema, signal ? { signal } : undefined) }
  clients(signal?: AbortSignal): Promise<PairingClient[]> { return this.request('/api/v1/product/pairing/clients', z.array(pairingClientSchema), signal ? { signal } : undefined) }
  revokeClient(id: string): Promise<void> { return this.empty(`/api/v1/product/pairing/clients/${encodeURIComponent(id)}`, { method: 'DELETE' }) }

  subscribeNotifications(sessionId: string, onEvent: (event: { type: 'notification'; item: ProductNotification } | { type: 'reset'; items: ProductNotification[] }) => void, onError: (error: ProductApiError) => void): () => void {
    const controller = new AbortController()
    this.subscriptions.add(controller)
    void (async () => {
      let cursor: string | undefined; let retries = 0
      while (!controller.signal.aborted) {
        try { cursor = await this.readNotificationStream(sessionId, cursor, controller.signal, onEvent); retries = 0 } catch (error) {
          if (controller.signal.aborted) return
          const parsed = error instanceof ProductApiError ? error : new ProductApiError(errorText(error))
          if (parsed.status === 401 || parsed.status === 403 || parsed.code === 'unauthorized' || parsed.code === 'forbidden') { this.clearBearer(); onError(parsed); return }
          retries++
          if (retries > 5) { onError(parsed); return }
        }
        await abortableDelay(Math.min(500 * 2 ** retries, 5_000), controller.signal)
      }
    })().finally(() => this.subscriptions.delete(controller))
    return () => { controller.abort(); this.subscriptions.delete(controller) }
  }

  private headers(): Headers {
    const headers = new Headers({ accept: 'application/json' })
    if (this.bearer) headers.set('authorization', `Bearer ${this.bearer}`)
    return headers
  }

  private async request<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
    const headers = this.headers()
    if (init?.body) headers.set('content-type', 'application/json')
    const response = await this.fetcher(path, { ...init, headers })
    if (!response.ok) throw await this.errorFromResponse(response)
    let payload: unknown
    try { payload = await response.json() } catch { throw new ProductApiError(`产品 API 返回了无效响应 (${response.status})`) }
    const envelope = apiEnvelopeSchema.safeParse(payload)
    if (!envelope.success) throw new ProductApiError('产品 API 成功响应不符合协议。', 'internal', response.status)
    if (!envelope.data.ok) throw new ProductApiError(envelope.data.error.message, envelope.data.error.code, response.status)
    const parsed = schema.safeParse(envelope.data.data)
    if (!parsed.success) throw new ProductApiError('产品 API DTO 不符合协议。', 'internal', response.status)
    return parsed.data
  }

  private async empty(path: string, init: RequestInit): Promise<void> {
    const headers = this.headers()
    const response = await this.fetcher(path, { ...init, headers })
    if (!response.ok) throw await this.errorFromResponse(response)
  }

  private async errorFromResponse(response: Response): Promise<ProductApiError> {
    try {
      const payload: unknown = await response.json()
      const parsed = apiEnvelopeSchema.safeParse(payload)
      if (parsed.success && !parsed.data.ok) return new ProductApiError(parsed.data.error.message, parsed.data.error.code, response.status)
    } catch { /* fall through to status */ }
    return new ProductApiError(`产品 API 请求失败 (${response.status})`, 'internal', response.status)
  }

  private async readNotificationStream(sessionId: string, cursor: string | undefined, signal: AbortSignal, onEvent: (event: { type: 'notification'; item: ProductNotification } | { type: 'reset'; items: ProductNotification[] }) => void): Promise<string | undefined> {
    const headers = this.headers(); headers.set('accept', 'text/event-stream')
    const params = new URLSearchParams({ sessionId, limit: '20' }); if (cursor) params.set('cursor', cursor)
    const response = await this.fetcher(`/api/v1/product/notifications/stream?${params.toString()}`, { headers, signal })
    if (!response.ok) throw await this.errorFromResponse(response)
    if (!response.body) throw new ProductApiError('通知连接没有可读取的数据。')
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''
    try {
      while (!signal.aborted) {
        const chunk = await reader.read(); if (chunk.done) break
        buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, '\n')
        let boundary = buffer.indexOf('\n\n')
        while (boundary >= 0) {
          const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2); boundary = buffer.indexOf('\n\n')
          const eventType = block.split('\n').find(line => line.startsWith('event:'))?.slice(6).trim()
          const eventId = block.split('\n').find(line => line.startsWith('id:'))?.slice(3).trim()
          const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n')
          if (!eventType || !data) continue
          let parsedJson: unknown
          try { parsedJson = JSON.parse(data) } catch { throw new ProductApiError('通知流包含无效数据。') }
          if (eventType === 'notification') { const parsed = productNotificationSchema.safeParse(parsedJson); if (parsed.success) { cursor = eventId || parsed.data.cursor; onEvent({ type: 'notification', item: parsed.data }) } }
          if (eventType === 'reset') { const parsed = z.object({ cursor: z.string(), items: z.array(productNotificationSchema) }).strict().safeParse(parsedJson); if (parsed.success) { cursor = parsed.data.cursor; onEvent({ type: 'reset', items: dedupeNotifications(parsed.data.items) }) } }
        }
      }
      return cursor
    } finally {
      try { await reader.cancel() } catch { /* stream may already be closed */ }
      reader.releaseLock()
    }
  }
}

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function dedupeNotifications(items: ProductNotification[]): ProductNotification[] { return [...new Map(items.map(item => [item.id, item])).values()] }
function abortableDelay(ms: number, signal: AbortSignal): Promise<void> { return new Promise(resolve => { if (signal.aborted) return resolve(); const finish = () => { window.clearTimeout(timer); signal.removeEventListener('abort', finish); resolve() }; const timer = window.setTimeout(finish, ms); signal.addEventListener('abort', finish, { once: true }) }) }

export const productApi = new ProductApi()
