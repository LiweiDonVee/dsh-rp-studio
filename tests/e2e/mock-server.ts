import { AsyncLocalStorage } from 'node:async_hooks'
import { fileURLToPath } from 'node:url'
import type { Card, PublicGameState, SessionDetail, SessionSummary, StreamEvent, TranscriptMessage } from '@dsh-rp/protocol'
import { buildApp, type SessionApi } from '../../apps/gateway/src/app.js'
import { GatewayError } from '../../apps/gateway/src/errors.js'
import { registerStaticApp } from '../../apps/gateway/src/server.js'

const INTERNAL_CANARY = 'MOCK_DSH_CANARY_SECRET'

const cards: Card[] = [
  {
    id: 'rp-runtime', title: '魔药宗师', description: '世界杯营地档案', world: '1994 · 魁地奇世界杯营地',
    protagonist: '加斯帕·拉尚斯', art: 'potion-master', accent: 'jade',
  },
  {
    id: 'zombie-world', title: '世界模拟器', description: '洛杉矶末日档案', world: '2005 · 洛杉矶末日第七天',
    protagonist: '伊莱亚斯·诺伦', art: 'zombie-world', accent: 'crimson',
  },
]

function initialState(cardId = 'rp-runtime'): PublicGameState {
  return {
    started: true,
    currentDate: cardId === 'zombie-world' ? '2005-09-17' : '1994-08-20',
    currentTime: '21:40',
    scene: { location: cardId === 'zombie-world' ? 'MDC D 区' : '世界杯营地', weather: '低云' },
    protagonist: {
      name: cardId === 'zombie-world' ? '伊莱亚斯·诺伦' : '加斯帕·拉尚斯',
      conditions: [{ id: 'alert', label: '警觉' }],
      attributes: { 意志: 8, 感知: 7 },
      resources: cardId === 'zombie-world' ? { 体力: 76, 饮水: 2 } : { 金加隆: 12, 魔力: 84 },
    },
    relationships: [{ id: 'r1', name: '阿莫斯', status: '谨慎信任' }],
    faction: [{ id: 'f1', name: '营地守卫', status: '戒备' }],
    inventory: [{ id: 'i1', name: cardId === 'zombie-world' ? '折叠刀' : '银质药瓶', description: '可立即取用' }],
    memories: [{ id: 'm1', title: '抵达', summary: '黄昏前抵达当前区域。' }],
    quests: [{ id: 'q1', title: '追查异常', status: '进行中' }],
    eventLog: [{ id: 'e1', title: '营火点亮', status: '已记录' }],
    statusLines: ['夜色正在收紧，附近仍有动静。'],
    extensions: {},
    checkpoints: { count: 3, canRollback: true, activeTurn: 3 },
  }
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

interface MockState {
  listeners: Map<string, Set<(event: StreamEvent) => void>>
  details: Map<string, SessionDetail>
  timers: Map<string, Set<ReturnType<typeof setTimeout>>>
  nextSession: number
  nextMessage: number
}

const tenantContext = new AsyncLocalStorage<string>()

function createMockState(): MockState {
  const state = initialState()
  const session: SessionSummary = {
    id: 'session-1', cardId: cards[0]!.id, title: '营地余烬', updatedAt: Date.now(), running: false, blank: false, state,
  }
  return {
    listeners: new Map(),
    timers: new Map(),
    details: new Map([[session.id, {
      session,
      card: cards[0]!,
      messages: [
        { id: 'm1', seq: 1, role: 'gm', text: '冷风越过帐篷，营火边留下了一串陌生脚印。', createdAt: Date.now() - 2_000, status: 'complete' },
        { id: 'm2', seq: 2, role: 'player', text: '我俯身查看脚印。', createdAt: Date.now() - 1_000, status: 'complete' },
      ],
      state,
    }]]),
    nextSession: 2,
    nextMessage: 3,
  }
}

class MockSessionApi implements SessionApi {
  private readonly tenants = new Map<string, MockState>()
  private readonly internal = { secrets: { answer: INTERNAL_CANARY } }

  async health(): Promise<Record<string, unknown>> {
    return { upstream: 'mock-ready', version: 'e2e' }
  }

  async cards(): Promise<Card[]> {
    return clone(cards)
  }

  async sessions(): Promise<SessionSummary[]> {
    return [...this.current().details.values()].map(item => clone(item.session)).sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async session(sessionId: string): Promise<SessionDetail> {
    const detail = this.current().details.get(sessionId)
    if (!detail) throw new GatewayError({ code: 'not-found', message: '找不到测试会话。' }, 404)
    return clone(detail)
  }

  async create(cardId: string): Promise<SessionDetail> {
    const tenant = this.current()
    const card = cards.find(item => item.id === cardId)
    if (!card) throw new GatewayError({ code: 'card-unavailable', message: '测试卡片不可用。' }, 404)
    const id = `session-${tenant.nextSession++}`
    const state = initialState(cardId)
    const session: SessionSummary = { id, cardId, title: card.title, updatedAt: Date.now(), running: false, blank: true, state }
    const detail: SessionDetail = { session, card, messages: [], state }
    tenant.details.set(id, detail)
    return clone(detail)
  }

  async prompt(sessionId: string, text: string): Promise<Record<string, unknown>> {
    const tenant = this.current()
    const detail = this.required(tenant, sessionId)
    const player: TranscriptMessage = {
      id: `m${tenant.nextMessage++}`, seq: tenant.nextMessage, role: 'player', text, createdAt: Date.now(), status: 'complete',
    }
    detail.messages.push(player)
    detail.session.running = true
    detail.session.blank = false
    detail.session.updatedAt = Date.now()
    this.publish(tenant, { type: 'message.completed', sessionId, message: clone(player) })
    this.publish(tenant, { type: 'session.status', sessionId, running: true })

    const messageId = `m${tenant.nextMessage++}`
    this.schedule(tenant, sessionId, 20, () => this.publish(tenant, { type: 'message.delta', sessionId, messageId: `stream-${messageId}`, text: '脚印在灰土里' }))
    this.schedule(tenant, sessionId, 45, () => this.publish(tenant, { type: 'message.delta', sessionId, messageId: `stream-${messageId}`, text: '突然转向。' }))
    this.schedule(tenant, sessionId, 70, () => {
      const message: TranscriptMessage = {
        id: messageId, seq: tenant.nextMessage, role: 'gm', text: '脚印在灰土里突然转向，没入两顶帐篷之间的暗处。', createdAt: Date.now(), status: 'complete',
      }
      detail.messages.push(message)
      detail.session.running = false
      detail.state = {
        ...detail.state,
        eventLog: [...detail.state.eventLog, { id: `e${tenant.nextMessage}`, title: '发现转向的脚印', status: '新线索' }],
        checkpoints: {
          count: detail.state.checkpoints.count + 1,
          canRollback: true,
          activeTurn: (detail.state.checkpoints.activeTurn ?? 0) + 1,
        },
      }
      detail.session.state = detail.state
      this.publish(tenant, { type: 'message.completed', sessionId, message: clone(message) })
      this.publish(tenant, { type: 'state.updated', sessionId, state: clone(detail.state) })
      this.publish(tenant, { type: 'session.status', sessionId, running: false })
    })
    return { accepted: true }
  }

  async cancel(sessionId: string): Promise<Record<string, unknown>> {
    const tenant = this.current()
    const detail = this.required(tenant, sessionId)
    for (const timer of tenant.timers.get(sessionId) ?? []) clearTimeout(timer)
    tenant.timers.delete(sessionId)
    detail.session.running = false
    this.publish(tenant, { type: 'session.status', sessionId, running: false })
    return { accepted: true }
  }

  async fork(sessionId: string): Promise<SessionDetail> {
    const tenant = this.current()
    const source = this.required(tenant, sessionId)
    const id = `session-${tenant.nextSession++}`
    const detail = clone(source)
    detail.session = { ...detail.session, id, title: `${detail.session.title} · 分支`, parentSessionId: sessionId, updatedAt: Date.now(), running: false }
    tenant.details.set(id, detail)
    return clone(detail)
  }

  async rollback(sessionId: string): Promise<Record<string, unknown>> {
    const tenant = this.current()
    const detail = this.required(tenant, sessionId)
    if (detail.messages.length > 2) detail.messages.splice(-2)
    const count = Math.max(0, detail.state.checkpoints.count - 1)
    detail.state = {
      ...detail.state,
      checkpoints: { count, canRollback: count > 0, activeTurn: count > 0 ? count : null },
    }
    detail.session.state = detail.state
    detail.session.running = false
    detail.session.updatedAt = Date.now()
    this.publish(tenant, { type: 'session.rebased', sessionId })
    return { accepted: true }
  }

  async autoplay(sessionId: string, input: { off?: boolean; rounds?: number; objective?: string }): Promise<Record<string, unknown>> {
    const tenant = this.current()
    const detail = this.required(tenant, sessionId)
    detail.state = input.off
      ? { ...detail.state, driver: { armed: false } }
      : {
          ...detail.state,
          driver: {
            armed: true,
            maxRounds: input.rounds ?? 8,
            ...(input.objective ? { objective: input.objective } : {}),
          },
        }
    detail.session.state = detail.state
    this.publish(tenant, { type: 'state.updated', sessionId, state: clone(detail.state) })
    return { accepted: true }
  }

  subscribe(sessionId: string, listener: (event: StreamEvent) => void): () => void {
    const tenant = this.current()
    const listeners = tenant.listeners.get(sessionId) ?? new Set()
    listeners.add(listener)
    tenant.listeners.set(sessionId, listeners)
    return () => listeners.delete(listener)
  }

  private current(): MockState {
    const tenantId = tenantContext.getStore() ?? 'default'
    const tenant = this.tenants.get(tenantId) ?? createMockState()
    this.tenants.set(tenantId, tenant)
    return tenant
  }

  private required(tenant: MockState, sessionId: string): SessionDetail {
    void this.internal
    const detail = tenant.details.get(sessionId)
    if (!detail) throw new GatewayError({ code: 'not-found', message: '找不到测试会话。' }, 404)
    return detail
  }

  private publish(tenant: MockState, event: StreamEvent): void {
    for (const listener of tenant.listeners.get(event.sessionId) ?? []) listener(clone(event))
  }

  private schedule(tenant: MockState, sessionId: string, delay: number, action: () => void): void {
    const timers = tenant.timers.get(sessionId) ?? new Set()
    const timer = setTimeout(() => {
      timers.delete(timer)
      if (timers.size === 0) tenant.timers.delete(sessionId)
      action()
    }, delay)
    timers.add(timer)
    tenant.timers.set(sessionId, timers)
  }
}

const service = new MockSessionApi()
const app = buildApp({ api: service })
app.addHook('onRequest', (request, _reply, done) => {
  const cookie = request.headers.cookie ?? ''
  const tenant = /(?:^|;\s*)dsh-rp-e2e=([^;]+)/u.exec(cookie)?.[1] ?? 'default'
  tenantContext.run(tenant, done)
})
registerStaticApp(app, fileURLToPath(new URL('../../apps/web/dist/', import.meta.url)))
await app.listen({ host: '127.0.0.1', port: 4327 })
process.stdout.write('Mock RP Gateway: http://127.0.0.1:4327\n')

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => { void app.close().finally(() => process.exit(0)) })
}
