import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import {
  pairingCodeRequestSchema, pairingConfirmSchema, productAssetPatchSchema, productAssetUploadSchema, productBackupCreateSchema, productKnowledgeCreateSchema, productKnowledgePatchSchema, productLedgerCreateSchema, productPageQuerySchema, productRestoreCommitSchema, successEnvelope,
} from '@dsh-rp/protocol'
import { GatewayError } from './errors.js'
import type { ProductService } from './product-service.js'

export interface ProductRouteOptions {
  reauthorize?: (request: FastifyRequest) => Promise<void>
  reauthorizeIntervalMs?: number
}

function badRequest(message: string): GatewayError {
  return new GatewayError({ code: 'bad-request', message }, 400)
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function identifier(params: unknown, key: string): string {
  const value = record(params)?.[key]
  if (typeof value !== 'string' || !value || value.length > 500) throw badRequest('资源标识无效。')
  return value
}

function pageQuery(value: unknown) {
  const parsed = productPageQuerySchema.safeParse(value)
  if (!parsed.success) throw badRequest('产品资源查询参数无效。')
  return parsed.data
}

function sessionQuery(value: unknown): string {
  const sessionId = record(value)?.sessionId
  if (typeof sessionId !== 'string' || !sessionId) throw badRequest('必须提供有效的会话 ID。')
  return sessionId
}

function body<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown, message: string): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw badRequest(message)
  return parsed.data
}

function writeSse(reply: FastifyReply, event: string, data: unknown, cursor?: string): void {
  if (cursor) reply.raw.write(`id: ${cursor}\n`)
  reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

function bearerToken(request: FastifyRequest): string {
  const authorization = request.headers.authorization
  if (!authorization?.startsWith('Bearer ') || authorization.length <= 7) throw new GatewayError({ code: 'unauthorized', message: '需要移动端认证。' }, 401)
  return authorization.slice(7)
}

export function registerProductRoutes(app: FastifyInstance, product: ProductService, options: ProductRouteOptions = {}): void {
  if (!app.hasContentTypeParser('application/octet-stream')) app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: 32 * 1024 * 1024 }, (_request, payload, done) => done(null, payload))
  app.get('/api/v1/product/status', async () => successEnvelope(await product.status()))
  app.get('/api/v1/product/bootstrap', async request => successEnvelope(await product.bootstrap(bearerToken(request))))

  app.get('/api/v1/product/assets', async request => successEnvelope(await product.assets(pageQuery(request.query))))
  app.post('/api/v1/product/assets', { bodyLimit: 14_100_000 }, async (request, reply) => {
    const input = body(productAssetUploadSchema, request.body, '资产上传请求无效。')
    return reply.code(201).send(successEnvelope(await product.uploadAsset(sessionQuery(request.query), input)))
  })
  app.get('/api/v1/product/assets/:assetId', async (request, reply) => {
    const asset = await product.asset(sessionQuery(request.query), identifier(request.params, 'assetId'))
    return reply
      .header('content-disposition', `attachment; filename="${encodeURIComponent(asset.metadata.fileName)}"`)
      .header('cache-control', 'private, no-store')
      .header('x-content-type-options', 'nosniff')
      .type(asset.metadata.mimeType)
      .send(Buffer.from(asset.bytes))
  })
  app.patch('/api/v1/product/assets/:assetId', async request => successEnvelope(await product.updateAsset(sessionQuery(request.query), identifier(request.params, 'assetId'), body(productAssetPatchSchema, request.body, '资产元数据请求无效。'))))
  app.delete('/api/v1/product/assets/:assetId', async (request, reply) => {
    await product.deleteAsset(sessionQuery(request.query), identifier(request.params, 'assetId'))
    return reply.code(204).send()
  })

  app.get('/api/v1/product/ledger', async request => successEnvelope(await product.ledger(pageQuery(request.query))))
  app.post('/api/v1/product/ledger', async (request, reply) => reply.code(201).send(successEnvelope(await product.appendLedger(sessionQuery(request.query), body(productLedgerCreateSchema, request.body, '账本命令无效。')))))

  app.get('/api/v1/product/knowledge', async request => successEnvelope(await product.knowledge(pageQuery(request.query))))
  app.post('/api/v1/product/knowledge', async (request, reply) => reply.code(201).send(successEnvelope(await product.createKnowledge(sessionQuery(request.query), body(productKnowledgeCreateSchema, request.body, '知识注释请求无效。')))))
  app.patch('/api/v1/product/knowledge/:knowledgeId', async request => successEnvelope(await product.updateKnowledge(sessionQuery(request.query), identifier(request.params, 'knowledgeId'), body(productKnowledgePatchSchema, request.body, '知识注释请求无效。').text)))
  app.delete('/api/v1/product/knowledge/:knowledgeId', async (request, reply) => {
    await product.deleteKnowledge(sessionQuery(request.query), identifier(request.params, 'knowledgeId'))
    return reply.code(204).send()
  })

  app.get('/api/v1/product/memory', async request => successEnvelope(await product.memories(pageQuery(request.query))))
  app.get('/api/v1/product/relationships', async request => successEnvelope(await product.relationships(pageQuery(request.query))))
  app.get('/api/v1/product/locations', async request => successEnvelope(await product.locations(pageQuery(request.query))))

  app.get('/api/v1/product/notifications', async request => successEnvelope(await product.notifications(pageQuery(request.query))))
  app.post('/api/v1/product/notifications/:notificationId/ack', async request => {
    await product.acknowledgeNotification(sessionQuery(request.query), identifier(request.params, 'notificationId'))
    return successEnvelope({ acknowledged: true as const })
  })
  app.get('/api/v1/product/notifications/stream', async (request: FastifyRequest, reply: FastifyReply) => {
    const raw = record(request.query) ?? {}
    const cursor = typeof raw.cursor === 'string' ? raw.cursor : typeof request.headers['last-event-id'] === 'string' ? request.headers['last-event-id'] : undefined
    const query = pageQuery({ ...raw, ...(cursor ? { cursor } : {}) })
    const buffered: Array<Parameters<Parameters<ProductService['subscribe']>[0]>[1]> = []
    let bufferOverflow = false
    let streaming = false
    let closed = false
    const seen = new Set<string>()
    const deliver = (batch: Parameters<Parameters<ProductService['subscribe']>[0]>[1]): void => {
      if (closed) return
      if (batch.resetRequired) {
        const items = batch.snapshot ?? batch.items
        for (const notification of items) seen.add(`${notification.id}\u0000${notification.cursor}\u0000${notification.acknowledged}`)
        writeSse(reply, 'reset', { cursor: batch.cursor, items }, batch.cursor)
        return
      }
      for (const notification of batch.items) {
        const signature = `${notification.id}\u0000${notification.cursor}\u0000${notification.acknowledged}`
        if (seen.has(signature)) continue
        seen.add(signature)
        writeSse(reply, 'notification', notification, notification.cursor)
      }
    }
    const unsubscribe = product.subscribe((scope, batch) => {
      if (scope.sessionId !== query.sessionId) return
      if (streaming) deliver(batch)
      else if (buffered.length < 256) buffered.push(batch)
      else bufferOverflow = true
    })
    let initial
    try { initial = await product.notifications(query) } catch (error) { unsubscribe(); throw error }
    reply.hijack()
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' })
    deliver(initial)
    if (bufferOverflow) deliver(await product.notifications({ ...query, cursor: initial.cursor }))
    streaming = true
    for (const batch of buffered.splice(0)) deliver(batch)
    const heartbeat = setInterval(() => reply.raw.write(': heartbeat\n\n'), 15_000)
    let authenticating = false
    const authorization = options.reauthorize ? setInterval(() => {
      if (authenticating || closed) return
      authenticating = true
      void options.reauthorize!(request).catch(() => {
        if (!closed) {
          writeSse(reply, 'error', { code: 'unauthorized', message: '移动端认证已撤销。' })
          reply.raw.end()
        }
      }).finally(() => { authenticating = false })
    }, options.reauthorizeIntervalMs ?? 5_000) : undefined
    const cleanup = (): void => {
      if (closed) return
      closed = true
      clearInterval(heartbeat)
      if (authorization) clearInterval(authorization)
      unsubscribe()
    }
    reply.raw.once('close', cleanup)
    request.raw.once('aborted', cleanup)
  })

  app.get('/api/v1/product/backups', async request => successEnvelope(await product.backups(pageQuery(request.query))))
  app.post('/api/v1/product/backups', async (request, reply) => reply.code(201).send(successEnvelope(await product.createBackup(sessionQuery(request.query), body(productBackupCreateSchema, request.body, '备份请求无效。').commandId))))
  app.get('/api/v1/product/backups/:backupId/export', async (request, reply) => {
    const backupId = identifier(request.params, 'backupId')
    const bytes = await product.exportBackup(sessionQuery(request.query), backupId)
    return reply.header('content-disposition', `attachment; filename="${encodeURIComponent(backupId)}.dsh-rp-backup"`).header('cache-control', 'private, no-store').header('x-content-type-options', 'nosniff').type('application/octet-stream').send(Buffer.from(bytes))
  })
  app.post('/api/v1/product/backups/import', { bodyLimit: 32 * 1024 * 1024 }, async (request, reply) => {
    const query = record(request.query)
    const commandId = query?.commandId
    if (typeof commandId !== 'string' || !commandId || commandId.length > 200) throw badRequest('备份导入命令 ID 无效。')
    if (!Buffer.isBuffer(request.body)) throw new GatewayError({ code: 'unsupported-media-type', message: '备份导入必须使用 application/octet-stream。' }, 415)
    return reply.code(201).send(successEnvelope(await product.importBackup(sessionQuery(request.query), request.body, commandId)))
  })
  app.post('/api/v1/product/backups/:backupId/stage-restore', async request => successEnvelope(await product.stageRestore(sessionQuery(request.query), identifier(request.params, 'backupId'))))
  app.post('/api/v1/product/backups/:backupId/commit-restore', async request => successEnvelope(await product.commitRestore(sessionQuery(request.query), identifier(request.params, 'backupId'), body(productRestoreCommitSchema, request.body, '恢复提交请求无效。').restoreToken)))

  app.get('/api/v1/product/pairing', async () => successEnvelope(product.pairingStatus()))
  app.post('/api/v1/product/pairing/codes', async request => successEnvelope(await product.createPairingCode(body(pairingCodeRequestSchema, request.body, '配对码请求无效。'))))
  app.post('/api/v1/product/pairing/confirm', async request => successEnvelope(await product.confirmPairing(body(pairingConfirmSchema, request.body, '配对确认请求无效。'), request.ip)))
  app.get('/api/v1/product/pairing/clients', async () => successEnvelope(await product.pairingClients()))
  app.delete('/api/v1/product/pairing/clients/:clientId', async (request, reply) => {
    if (!await product.revokePairingClient(identifier(request.params, 'clientId'))) throw new GatewayError({ code: 'not-found', message: '找不到该配对客户端。' }, 404)
    return reply.code(204).send()
  })
}
