import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import {
  acceptedResponseSchema,
  cardSchema,
  failureEnvelope,
  healthStatusSchema,
  sessionDetailSchema,
  sessionSummarySchema,
  streamEventSchema,
  successEnvelope,
  type Card,
  type SessionDetail,
  type SessionSummary,
  type StreamEvent,
} from '@dsh-rp/protocol'
import { GatewayError } from './errors.js'

export interface SessionApi {
  health(): Promise<Record<string, unknown>>
  cards(): Promise<Card[]>
  sessions(): Promise<SessionSummary[]>
  session(sessionId: string): Promise<SessionDetail>
  create(cardId: string): Promise<SessionDetail>
  prompt(sessionId: string, text: string): Promise<Record<string, unknown>>
  cancel(sessionId: string): Promise<Record<string, unknown>>
  fork(sessionId: string, atSeq?: number): Promise<SessionDetail>
  rollback(sessionId: string): Promise<Record<string, unknown>>
  autoplay(sessionId: string, input: { off?: boolean; rounds?: number; objective?: string }): Promise<Record<string, unknown>>
  subscribe(sessionId: string, listener: (event: StreamEvent) => void): () => void
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function badRequest(message: string): GatewayError {
  return new GatewayError({ code: 'bad-request', message }, 400)
}

function sessionId(params: unknown): string {
  const id = record(params)?.id
  if (typeof id !== 'string' || !id) throw badRequest('会话 ID 无效。')
  return id
}

export function buildApp(options: { api: SessionApi }): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 1_048_576 })

  app.addHook('onSend', async (_request, reply, payload) => {
    reply
      .header('content-security-policy', "default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; script-src 'self'; style-src 'self' 'unsafe-inline'")
      .header('referrer-policy', 'no-referrer')
      .header('x-content-type-options', 'nosniff')
      .header('x-frame-options', 'DENY')
    return payload
  })

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof GatewayError) {
      void reply.code(error.statusCode).send(failureEnvelope(error.apiError))
      return
    }
    void reply.code(500).send(failureEnvelope({ code: 'internal', message: 'RP Gateway 处理请求时发生错误。' }))
  })

  app.get('/api/v1/health', async () => successEnvelope(healthStatusSchema.parse(await options.api.health())))
  app.get('/api/v1/cards', async () => successEnvelope(cardSchema.array().parse(await options.api.cards())))
  app.get('/api/v1/sessions', async () => successEnvelope(sessionSummarySchema.array().parse(await options.api.sessions())))
  app.get('/api/v1/sessions/:id', async request => successEnvelope(sessionDetailSchema.parse(await options.api.session(sessionId(request.params)))))

  app.post('/api/v1/sessions', async (request) => {
    const cardId = record(request.body)?.cardId
    if (typeof cardId !== 'string' || !cardId) throw badRequest('必须选择一张 RP 卡片。')
    return successEnvelope(sessionDetailSchema.parse(await options.api.create(cardId)))
  })
  const handlePrompt = async (request: FastifyRequest) => {
    const text = record(request.body)?.text
    if (typeof text !== 'string' || !text.trim() || text.length > 20_000) throw badRequest('请输入有效的玩家行动。')
    return successEnvelope(acceptedResponseSchema.parse(await options.api.prompt(sessionId(request.params), text.trim())))
  }

  app.post('/api/v1/sessions/:id/prompt', handlePrompt)
  app.post('/api/v1/sessions/:id/messages', handlePrompt)
  app.post('/api/v1/sessions/:id/cancel', async request => successEnvelope(acceptedResponseSchema.parse(await options.api.cancel(sessionId(request.params)))))
  app.post('/api/v1/sessions/:id/fork', async (request) => {
    const atSeq = record(request.body)?.atSeq
    if (atSeq !== undefined && (!Number.isInteger(atSeq) || (atSeq as number) < 0)) throw badRequest('分支事件序号无效。')
    return successEnvelope(sessionDetailSchema.parse(await options.api.fork(sessionId(request.params), atSeq as number | undefined)))
  })
  app.post('/api/v1/sessions/:id/rollback', async request => successEnvelope(acceptedResponseSchema.parse(await options.api.rollback(sessionId(request.params)))))
  const handleAutoplay = async (request: FastifyRequest) => {
    const body = record(request.body) ?? {}
    if (body.off === true) return successEnvelope(acceptedResponseSchema.parse(await options.api.autoplay(sessionId(request.params), { off: true })))
    const rounds = body.rounds ?? 8
    if (!Number.isInteger(rounds) || (rounds as number) < 1 || (rounds as number) > 64) throw badRequest('自动续跑轮数必须在 1 到 64 之间。')
    if (body.objective !== undefined && (typeof body.objective !== 'string' || body.objective.length > 2_000)) throw badRequest('自动续跑目标无效。')
    return successEnvelope(acceptedResponseSchema.parse(await options.api.autoplay(sessionId(request.params), {
      rounds: rounds as number,
      ...(typeof body.objective === 'string' && body.objective.trim() ? { objective: body.objective.trim() } : {}),
    })))
  }
  app.post('/api/v1/sessions/:id/autoplay', handleAutoplay)
  app.put('/api/v1/sessions/:id/autoplay', handleAutoplay)

  const handleStream = async (request: FastifyRequest, reply: FastifyReply) => {
    const id = sessionId(request.params)
    const detail = sessionDetailSchema.parse(await options.api.session(id))
    reply.hijack()
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    const writeEvent = (event: StreamEvent): void => {
      reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    }
    const send = (event: StreamEvent): void => {
      const parsed = streamEventSchema.safeParse(event)
      if (parsed.success && parsed.data.sessionId === id) writeEvent(parsed.data)
      else writeEvent({
        type: 'error',
        sessionId: id,
        error: { code: 'internal', message: 'RP Gateway 丢弃了无效事件。' },
      })
    }
    send({ type: 'connected', sessionId: id })
    send({ type: 'session.status', sessionId: id, running: detail.session.running })
    send({ type: 'state.updated', sessionId: id, state: detail.state })
    const unsubscribe = options.api.subscribe(id, send)
    const heartbeat = setInterval(() => reply.raw.write(': heartbeat\n\n'), 15_000)
    request.raw.on('close', () => {
      clearInterval(heartbeat)
      unsubscribe()
    })
  }
  app.get('/api/v1/sessions/:id/stream', handleStream)
  app.get('/api/v1/sessions/:id/events', handleStream)

  return app
}
