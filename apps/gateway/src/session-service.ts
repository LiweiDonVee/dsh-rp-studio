import { foldSurface, projectPublicState, toTranscript, type RawSessionEvent, type SurfaceOperation } from '@dsh-rp/domain'
import type { Card, SessionDetail, SessionSummary, StreamEvent } from '@dsh-rp/protocol'
import { discoverCards } from './cards.js'
import type { DshClient, DshHistoryEntry, DshSessionListItem, DshStreamFrame } from './dsh/client.js'
import { mapDshError, statusForDshError } from './dsh/wire.js'
import { GatewayError } from './errors.js'
import { EventHub } from './event-hub.js'
import type { SessionApi } from './app.js'

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function surfaceOperation(value: unknown): SurfaceOperation | undefined {
  if (value === 'append') return 'append'
  const item = record(value)
  return item?.op === 'replace' && typeof item.start === 'number' && typeof item.end === 'number'
    ? { op: 'replace', start: item.start, end: item.end }
    : undefined
}

function rawEvent(entry: DshHistoryEntry['event']): RawSessionEvent {
  const surfaceOp = surfaceOperation(entry.surfaceOp)
  return {
    seq: entry.seq,
    time: entry.time,
    type: entry.type,
    data: record(entry.data) ?? {},
    ...(surfaceOp ? { surfaceOp } : {}),
    ...(Array.isArray(entry.sourceEventSeqs) ? { sourceEventSeqs: entry.sourceEventSeqs } : {}),
  }
}

function upstreamError(error: unknown): GatewayError {
  const apiError = mapDshError(error)
  return new GatewayError(apiError, statusForDshError(apiError))
}

export interface SessionServiceOptions {
  dsh: DshClient
  dshHome?: string
  sessionCwd?: string
}

export class SessionService implements SessionApi {
  private readonly hub = new EventHub()
  private cardsById = new Map<string, Card>()
  private summaries = new Map<string, DshSessionListItem>()
  private events = new Map<string, RawSessionEvent[]>()
  private projections = new Map<string, unknown>()
  private closeStreams: (() => void) | undefined
  private recovering = false
  private recoveryAttempts = 0
  private recoveryTimer: ReturnType<typeof setTimeout> | undefined
  private stopped = false

  constructor(private readonly options: SessionServiceOptions) {}

  async start(): Promise<void> {
    this.stopped = false
    try {
      await this.refresh()
    } catch {
      // The local Studio shell remains available while DSH is restarting.
    }
    try {
      this.closeStreams = this.options.dsh.connectStreams(frame => this.onFrame(frame), () => {
        for (const sessionId of this.summaries.keys()) {
          this.hub.publish({
            type: 'error', sessionId,
            error: { code: 'upstream-unavailable', message: 'DSH 事件连接已断开，正在等待服务恢复。' },
          })
        }
      }, () => this.recoverStreams())
    } catch {
      this.closeStreams = undefined
    }
  }

  stop(): void {
    this.stopped = true
    this.closeStreams?.()
    this.closeStreams = undefined
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer)
    this.recoveryTimer = undefined
  }

  async health(): Promise<Record<string, unknown>> {
    try {
      const description = await this.options.dsh.hostDescribe()
      return { upstream: 'ready', version: description.version ?? 'unknown' }
    } catch (error) {
      throw upstreamError(error)
    }
  }

  async cards(): Promise<Card[]> {
    await this.refreshCards()
    return [...this.cardsById.values()]
  }

  async sessions(): Promise<SessionSummary[]> {
    await this.refreshSessions()
    return [...this.summaries.values()].flatMap(item => {
      const card = item.agentPreset ? this.cardsById.get(item.agentPreset) : undefined
      return card ? [this.toSummary(item, card)] : []
    }).sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async session(sessionId: string): Promise<SessionDetail> {
    await this.refreshSessions()
    const item = this.summaries.get(sessionId)
    if (!item) throw new GatewayError({ code: 'not-found', message: '找不到该 RP 会话。' }, 404)
    const card = item.agentPreset ? this.cardsById.get(item.agentPreset) : undefined
    if (!card) throw new GatewayError({ code: 'card-unavailable', message: '该会话不属于可用的 RP 卡片。' }, 409)
    await this.ensureHistory(sessionId)
    const state = projectPublicState(this.projections.get(sessionId) ?? item.projections?.values['rp-state'])
    return {
      session: { ...this.toSummary(item, card), state },
      card,
      messages: toTranscript(foldSurface(this.events.get(sessionId) ?? [])),
      state,
    }
  }

  async create(cardId: string): Promise<SessionDetail> {
    await this.refreshCards()
    if (!this.cardsById.has(cardId)) throw new GatewayError({ code: 'card-unavailable', message: '所选 RP 卡片不可用。' }, 404)
    try {
      const created = await this.options.dsh.createSession({
        agentPreset: cardId,
        ...(this.options.sessionCwd ? { cwd: this.options.sessionCwd } : {}),
      })
      await this.refreshSessions()
      return this.session(created.sessionId)
    } catch (error) {
      throw upstreamError(error)
    }
  }

  async prompt(sessionId: string, text: string): Promise<Record<string, unknown>> {
    await this.assertOwned(sessionId)
    try {
      await this.options.dsh.prompt(sessionId, text)
      return { accepted: true }
    } catch (error) {
      throw upstreamError(error)
    }
  }

  async cancel(sessionId: string): Promise<Record<string, unknown>> {
    await this.assertOwned(sessionId)
    try {
      await this.options.dsh.cancel(sessionId)
      return { accepted: true }
    } catch (error) {
      throw upstreamError(error)
    }
  }

  async fork(sessionId: string, atSeq?: number): Promise<SessionDetail> {
    await this.assertOwned(sessionId)
    try {
      const child = await this.options.dsh.fork(sessionId, atSeq)
      await this.refreshSessions()
      return this.session(child.sessionId)
    } catch (error) {
      throw upstreamError(error)
    }
  }

  async rollback(sessionId: string): Promise<Record<string, unknown>> {
    try {
      return await this.prompt(sessionId, '/rp-rollback')
    } catch (error) {
      if (error instanceof GatewayError && error.apiError.upstreamCode === 'command-error') {
        throw new GatewayError({
          code: 'rollback-unavailable',
          message: '当前没有可回退的 RP 回合。',
          upstreamCode: 'command-error',
        }, 409)
      }
      throw error
    }
  }

  autoplay(sessionId: string, input: { off?: boolean; rounds?: number; objective?: string }): Promise<Record<string, unknown>> {
    const command = input.off
      ? '/rp-autoplay off'
      : `/rp-autoplay ${input.rounds ?? 8}${input.objective ? ` ${input.objective}` : ''}`
    return this.prompt(sessionId, command)
  }

  subscribe(sessionId: string, listener: (event: StreamEvent) => void): () => void {
    return this.hub.subscribe(sessionId, listener)
  }

  private async refresh(): Promise<void> {
    await this.refreshCards()
    await this.refreshSessions()
  }

  private recoverStreams(): void {
    if (this.stopped || this.recovering) return
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer)
    this.recoveryTimer = undefined
    this.recovering = true
    void this.refresh().then(() => {
      this.recoveryAttempts = 0
      // DSH streams do not support a reliable resume cursor. Force the next
      // public snapshot request to backfill any narrative missed in the outage.
      this.events.clear()
      for (const item of this.summaries.values()) {
        const card = item.agentPreset ? this.cardsById.get(item.agentPreset) : undefined
        if (!card) continue
        const state = projectPublicState(this.projections.get(item.sessionId) ?? item.projections?.values['rp-state'])
        this.hub.publish({ type: 'connected', sessionId: item.sessionId })
        this.hub.publish({ type: 'session.status', sessionId: item.sessionId, running: item.running })
        this.hub.publish({ type: 'state.updated', sessionId: item.sessionId, state })
      }
    }).catch(() => {
      if (this.stopped) return
      const delay = Math.min(500 * (2 ** this.recoveryAttempts), 5_000)
      this.recoveryAttempts++
      this.recoveryTimer = setTimeout(() => {
        this.recoveryTimer = undefined
        this.recoverStreams()
      }, delay)
    }).finally(() => {
      this.recovering = false
    })
  }

  private async ensureHistory(sessionId: string): Promise<void> {
    if (this.events.has(sessionId)) return
    const liveEvents: RawSessionEvent[] = []
    this.events.set(sessionId, liveEvents)
    try {
      const entries = await this.options.dsh.historyAll(sessionId)
      if (this.events.get(sessionId) !== liveEvents) return
      const merged = new Map<number, RawSessionEvent>()
      for (const event of entries.map(entry => rawEvent(entry.event))) merged.set(event.seq, event)
      for (const event of liveEvents) merged.set(event.seq, event)
      this.events.set(sessionId, [...merged.values()].sort((a, b) => a.seq - b.seq))
    } catch (error) {
      if (this.events.get(sessionId) === liveEvents) this.events.delete(sessionId)
      throw upstreamError(error)
    }
  }

  private async refreshCards(): Promise<void> {
    try {
      const cards = await discoverCards(this.options.dsh, this.options.dshHome ? { dshHome: this.options.dshHome } : undefined)
      this.cardsById = new Map(cards.map(card => [card.id, card]))
    } catch (error) {
      throw upstreamError(error)
    }
  }

  private async refreshSessions(): Promise<void> {
    try {
      const items = await this.options.dsh.listSessions()
      this.summaries = new Map(items.map(item => [item.sessionId, item]))
      for (const item of items) {
        const projection = item.projections?.values['rp-state']
        if (projection !== undefined) this.projections.set(item.sessionId, projection)
      }
    } catch (error) {
      throw upstreamError(error)
    }
  }

  private async assertOwned(sessionId: string): Promise<void> {
    await this.refreshSessions()
    const item = this.summaries.get(sessionId)
    if (!item || !item.agentPreset || !this.cardsById.has(item.agentPreset)) {
      throw new GatewayError({ code: 'not-found', message: '找不到该 RP 会话。' }, 404)
    }
  }

  private toSummary(item: DshSessionListItem, card: Card): SessionSummary {
    const titleValue = item.projections?.values.title
    return {
      id: item.sessionId,
      cardId: card.id,
      title: typeof titleValue === 'string' && titleValue.trim() ? titleValue : card.title,
      updatedAt: item.updatedAt,
      running: item.running,
      blank: item.blank,
      ...(item.parentSessionId ? { parentSessionId: item.parentSessionId } : {}),
      state: projectPublicState(this.projections.get(item.sessionId) ?? item.projections?.values['rp-state']),
    }
  }

  private onFrame(frame: DshStreamFrame): void {
    if (frame.type === 'host/session-status') {
      const item = this.summaries.get(frame.sessionId)
      if (item) this.summaries.set(frame.sessionId, { ...item, running: frame.running })
      this.hub.publish({ type: 'session.status', sessionId: frame.sessionId, running: frame.running })
      return
    }
    if (frame.type === 'host/session-removed') {
      this.summaries.delete(frame.sessionId)
      this.events.delete(frame.sessionId)
      this.projections.delete(frame.sessionId)
      return
    }
    if (frame.type === 'session/projection' && frame.key === 'rp-state') {
      this.projections.set(frame.sessionId, frame.value)
      this.hub.publish({ type: 'state.updated', sessionId: frame.sessionId, state: projectPublicState(frame.value) })
      return
    }
    if (frame.type !== 'session/event') return
    const event = rawEvent(frame.event)
    const cached = this.events.get(frame.sessionId)
    if (cached && !cached.some(item => item.seq === event.seq)) cached.push(event)
    if (event.type === 'assistant/chunk') {
      const chunk = record(event.data.chunk)
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
        const turn = typeof event.data.turn === 'number' ? event.data.turn : 0
        const step = typeof event.data.step === 'number' ? event.data.step : 0
        this.hub.publish({ type: 'message.delta', sessionId: frame.sessionId, messageId: `stream-${turn}-${step}`, text: chunk.text })
      }
    }
    if ((event.type === 'assistant/message' || event.type === 'user/message') && cached) {
      const messageId = event.type === 'user/message'
        ? event.data.id
        : record(event.data.message)?.id
      const transcript = toTranscript(foldSurface(cached))
      const message = typeof messageId === 'string' ? transcript.find(item => item.id === messageId) : undefined
      if (message) this.hub.publish({ type: 'message.completed', sessionId: frame.sessionId, message })
    }
    if (event.surfaceOp && typeof event.surfaceOp === 'object' && event.surfaceOp.op === 'replace') {
      this.hub.publish({ type: 'session.rebased', sessionId: frame.sessionId })
    }
  }
}
