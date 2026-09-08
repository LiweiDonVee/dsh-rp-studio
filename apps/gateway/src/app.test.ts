import { afterEach, describe, expect, it } from 'vitest'
import type { Card, PromptSession, PublicGameState, SessionDetail, SessionSummary, StreamEvent } from '@dsh-rp/protocol'
import { buildApp, type SessionApi } from './app.js'
import { GatewayError } from './errors.js'

const SECRET = 'GATEWAY_CANARY_SECRET'
const card: Card = {
  id: 'fixture-card', title: '测试卡片', description: 'desc', world: '测试环境', protagonist: '测试角色', art: 'fixture-card', accent: 'crimson',
}
const state: PublicGameState = {
  started: true,
  relationships: [], faction: [], inventory: [], memories: [], quests: [], eventLog: [],
  statusLines: ['测试位置'], extensions: {}, checkpoints: { count: 2, canRollback: true, activeTurn: 2 },
}
const summary: SessionSummary = {
  id: 'session-1', cardId: card.id, title: '余烬', updatedAt: 1, running: false, blank: false, state,
}
const detail: SessionDetail = {
  session: summary,
  card,
  messages: [{ id: 'm1', seq: 1, role: 'gm', text: '测试响应。', createdAt: 1, status: 'complete' }],
  state,
}
const promptSettings: PromptSession = {
  available: true,
  revision: 4,
  coreProfileIds: ['rp-narrative-base', 'fixture-card'],
  optionalProfiles: [{
    id: 'fixture-profile', name: '测试方法组', description: 'optional', version: 1,
    entries: [{ id: 'fixture-style', name: '实验文风', slot: 'render-style', selection: 'single', tags: ['rp'], enabledByDefault: false, renderOnly: true }],
  }],
  enabledEntryIds: [],
  appliesFromNextTurn: false,
}

function fakeApi(): SessionApi {
  return {
    health: async () => ({ upstream: 'ready', version: '0.0.1' }),
    cards: async () => [card],
    sessions: async () => [summary],
    session: async () => detail,
    create: async () => detail,
    prompt: async () => ({ accepted: true }),
    cancel: async () => ({ accepted: true }),
    fork: async () => detail,
    rollback: async () => ({ accepted: true }),
    autoplay: async () => ({ accepted: true }),
    promptSettings: async () => promptSettings,
    applyPromptSettings: async (_id, input) => ({ ...promptSettings, revision: input.expectedRevision + 1, enabledEntryIds: input.enabledEntryIds, appliesFromNextTurn: true }),
    resetPromptSettings: async (_id, expectedRevision) => ({ ...promptSettings, revision: expectedRevision + 1, appliesFromNextTurn: true }),
    subscribe: (_sessionId: string, _listener: (event: StreamEvent) => void) => () => {},
  }
}

const apps: ReturnType<typeof buildApp>[] = []
afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()))
})

describe('RP Gateway v1', () => {
  it('serves the actual rc.1 Remote health metadata through the strict public schema', async () => {
    const api = fakeApi()
    api.health = async () => ({ upstream: 'ready', version: 'unknown', transport: 'remote', compatibility: '0.1.2-rc.1' })
    const app = buildApp({ api })
    apps.push(app)
    const response = await app.inject({ method: 'GET', url: '/api/v1/health' })
    expect(response.statusCode).toBe(200)
    expect(response.json().data).toEqual(await api.health())
  })

  it('serves health, cards, sessions, and a secret-free detail envelope', async () => {
    const app = buildApp({ api: fakeApi() })
    apps.push(app)
    const health = await app.inject({ method: 'GET', url: '/api/v1/health' })
    expect(health.statusCode).toBe(200)
    expect(health.json()).toMatchObject({ ok: true, protocolVersion: 1, data: { upstream: 'ready' } })
    expect(health.headers['content-security-policy']).toContain("default-src 'self'")
    expect(health.headers['x-frame-options']).toBe('DENY')
    expect((await app.inject({ method: 'GET', url: '/api/v1/cards' })).json().data).toEqual([card])
    expect((await app.inject({ method: 'GET', url: '/api/v1/sessions' })).json().data).toEqual([summary])
    const body = (await app.inject({ method: 'GET', url: '/api/v1/sessions/session-1' })).body
    expect(body).not.toContain(SECRET)
    expect(JSON.parse(body).data).toEqual(detail)
  })

  it('validates commands and exposes all session control routes', async () => {
    const calls: string[] = []
    const api = fakeApi()
    api.prompt = async (_id, text) => { calls.push(`prompt:${text}`); return { accepted: true } }
    api.rollback = async () => { calls.push('rollback'); return { accepted: true } }
    api.autoplay = async (_id, input) => { calls.push(`autoplay:${JSON.stringify(input)}`); return { accepted: true } }
    const app = buildApp({ api })
    apps.push(app)
    expect((await app.inject({ method: 'POST', url: '/api/v1/sessions/session-1/messages', payload: { text: '' } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url: '/api/v1/sessions/session-1/messages', payload: { text: '继续' } })).statusCode).toBe(200)
    expect((await app.inject({ method: 'POST', url: '/api/v1/sessions/session-1/prompt', payload: { text: '兼容入口' } })).statusCode).toBe(200)
    expect((await app.inject({ method: 'POST', url: '/api/v1/sessions/session-1/rollback' })).statusCode).toBe(200)
    expect((await app.inject({ method: 'POST', url: '/api/v1/sessions/session-1/autoplay', payload: { rounds: 65 } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'PUT', url: '/api/v1/sessions/session-1/autoplay', payload: { rounds: 12, objective: '推进主线' } })).statusCode).toBe(200)
    expect(calls).toEqual(['prompt:继续', 'prompt:兼容入口', 'rollback', 'autoplay:{"rounds":12,"objective":"推进主线"}'])
  })

  it('serves and updates sanitized session prompt settings', async () => {
    const app = buildApp({ api: fakeApi() })
    apps.push(app)
    const loaded = await app.inject({ method: 'GET', url: '/api/v1/sessions/session-1/prompt-presets' })
    expect(loaded.statusCode).toBe(200)
    expect(loaded.body).not.toContain('content')
    expect(loaded.json().data.enabledEntryIds).toEqual([])

    const applied = await app.inject({
      method: 'PUT', url: '/api/v1/sessions/session-1/prompt-presets',
      payload: { enabledEntryIds: ['fixture-style'], expectedRevision: 4 },
    })
    expect(applied.statusCode).toBe(200)
    expect(applied.json().data).toMatchObject({ revision: 5, enabledEntryIds: ['fixture-style'], appliesFromNextTurn: true })

    expect((await app.inject({ method: 'PUT', url: '/api/v1/sessions/session-1/prompt-presets', payload: { enabledEntryIds: 'bad', expectedRevision: 4 } })).statusCode).toBe(400)
    const reset = await app.inject({ method: 'DELETE', url: '/api/v1/sessions/session-1/prompt-presets', payload: { expectedRevision: 5 } })
    expect(reset.statusCode).toBe(200)
    expect(reset.json().data.enabledEntryIds).toEqual([])
  })

  it('fails closed when an API implementation returns a non-public DTO', async () => {
    const api = fakeApi()
    api.session = async () => ({
      ...detail,
      state: { ...state, secrets: { answer: SECRET } },
    } as unknown as SessionDetail)
    const app = buildApp({ api })
    apps.push(app)
    const response = await app.inject({ method: 'GET', url: '/api/v1/sessions/session-1' })
    expect(response.statusCode).toBe(500)
    expect(response.json()).toEqual({
      ok: false,
      protocolVersion: 1,
      error: { code: 'internal', message: 'RP Gateway 处理请求时发生错误。' },
    })
    expect(response.body).not.toContain(SECRET)
  })

  it('preserves a safe upstream code in command errors', async () => {
    const api = fakeApi()
    api.rollback = async () => {
      throw new GatewayError({
        code: 'rollback-unavailable',
        message: '当前没有可回退的 RP 回合。',
        upstreamCode: 'command-error',
      }, 409)
    }
    const app = buildApp({ api })
    apps.push(app)
    const response = await app.inject({ method: 'POST', url: '/api/v1/sessions/session-1/rollback' })
    expect(response.statusCode).toBe(409)
    expect(response.json().error).toEqual({
      code: 'rollback-unavailable',
      message: '当前没有可回退的 RP 回合。',
      upstreamCode: 'command-error',
    })
  })

  it('streams only protocol events and rejects an invalid SSE payload', async () => {
    let publish: (event: StreamEvent) => void = () => {}
    const api = fakeApi()
    api.subscribe = (_sessionId, listener) => {
      publish = listener
      return () => {}
    }
    const app = buildApp({ api })
    apps.push(app)
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const response = await fetch(`${address}/api/v1/sessions/session-1/events`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let body = ''

    publish({ type: 'message.delta', sessionId: 'session-1', messageId: 'stream-1', text: '测试流' })
    publish({
      type: 'message.completed',
      sessionId: 'session-1',
      message: { id: 'gm-2', seq: 2, role: 'gm', text: '测试流完成。', createdAt: 2, status: 'complete' },
    })
    publish({ type: 'state.updated', sessionId: 'session-1', state })
    publish({ type: 'session.status', sessionId: 'session-1', running: true })
    publish({ type: 'session.rebased', sessionId: 'session-1' })
    publish({ type: 'error', sessionId: 'session-1', error: { code: 'agent-busy', message: '仍在运行。' } })
    publish({ type: 'message.delta', sessionId: 'session-other', messageId: 'private', text: SECRET })
    publish({
      type: 'state.updated', sessionId: 'session-1',
      state: { ...state, secrets: SECRET },
    } as unknown as StreamEvent)

    while (!body.includes('RP Gateway 丢弃了无效事件。')) {
      const chunk = await reader.read()
      if (chunk.done) break
      body += decoder.decode(chunk.value, { stream: true })
    }
    await reader.cancel()

    for (const event of ['connected', 'message.delta', 'message.completed', 'state.updated', 'session.status', 'session.rebased', 'error']) {
      expect(body).toContain(`event: ${event}`)
    }
    expect(body).toContain('RP Gateway 丢弃了无效事件。')
    expect(body).not.toContain(SECRET)
    expect(body).not.toContain('"secrets"')
  })
})
