import { afterEach, describe, expect, it } from 'vitest'
import type { Card, PublicGameState, SessionDetail, SessionSummary, StreamEvent } from '@dsh-rp/protocol'
import { buildApp, type SessionApi } from './app.js'

const SECRET = 'GATEWAY_CANARY_SECRET'
const card: Card = {
  id: 'rp-runtime', title: '魔药宗师', description: 'desc', world: '营地', protagonist: '加斯帕', art: 'potion-master', accent: 'jade',
}
const state: PublicGameState = {
  started: true,
  relationships: [], faction: [], inventory: [], memories: [], quests: [], eventLog: [],
  statusLines: ['营地'], extensions: {}, checkpoints: { count: 2, canRollback: true, activeTurn: 2 },
}
const summary: SessionSummary = {
  id: 'session-1', cardId: card.id, title: '余烬', updatedAt: 1, running: false, blank: false, state,
}
const detail: SessionDetail = {
  session: summary,
  card,
  messages: [{ id: 'm1', seq: 1, role: 'gm', text: '冷风卷过营地。', createdAt: 1, status: 'complete' }],
  state,
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
    subscribe: (_sessionId: string, _listener: (event: StreamEvent) => void) => () => {},
  }
}

const apps: ReturnType<typeof buildApp>[] = []
afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()))
})

describe('RP Gateway v1', () => {
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
})
