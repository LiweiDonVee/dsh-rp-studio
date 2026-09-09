import { foldSurface, projectPublicState, toTranscript, type RawSessionEvent, type SurfaceOperation } from '@dsh-rp/domain'
import type { Card, ProductScope, PromptPresetSelection, PromptSession, SessionDetail, SessionSummary, StreamEvent } from '@dsh-rp/protocol'
import { mkdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { discoverCards } from './cards.js'
import type { DshClient, DshHistoryEntry, DshSessionListItem, DshStreamFrame, DshWorkspace } from './dsh/client.js'
import { mapDshError, statusForDshError } from './dsh/wire.js'
import { GatewayError } from './errors.js'
import { EventHub } from './event-hub.js'
import type { ProductSourceEvent, SessionApi } from './app.js'
import { PromptPresetsClientError, type PromptPresetsClient, type PromptProfileView } from './prompt-presets-client.js'

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
  promptPresets?: PromptPresetsClient
}

export class SessionService implements SessionApi {
  private readonly hub = new EventHub()
  private cardsById = new Map<string, Card>()
  private summaries = new Map<string, DshSessionListItem>()
  private events = new Map<string, RawSessionEvent[]>()
  private historyLoads = new Map<string, Promise<void>>()
  private projections = new Map<string, unknown>()
  private projectionSeqs = new Map<string, number>()
  private workspacesBySession = new Map<string, string>()
  private closeStreams: (() => void) | undefined
  private recovering = false
  private recoveryAttempts = 0
  private recoveryTimer: ReturnType<typeof setTimeout> | undefined
  private stopped = false
  private readonly productListeners = new Set<(event: ProductSourceEvent) => void>()

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
      return {
        upstream: 'ready', version: description.version ?? 'unknown',
        ...(description.transport === 'remote' ? { transport: 'remote', compatibility: '0.1.2-rc.1' } : {}),
      }
    } catch (error) {
      throw upstreamError(error)
    }
  }

  async cards(): Promise<Card[]> {
    await this.refreshCards()
    return [...this.cardsById.values()].filter(card => card.kind !== 'template')
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
    const prompt = await this.promptSettingsFor(sessionId, card)
    return {
      session: { ...this.toSummary(item, card), state },
      card,
      messages: toTranscript(foldSurface(this.events.get(sessionId) ?? [])),
      state,
      prompt,
    }
  }

  async create(cardId: string): Promise<SessionDetail> {
    await this.refreshCards()
    const card = this.cardsById.get(cardId)
    if (!card || card.kind === 'template') throw new GatewayError({ code: 'card-unavailable', message: '所选 RP 卡片不可用。' }, 404)
    try {
      const workspace = await this.ensureCardWorkspace(card)
      const created = await this.options.dsh.createSession({
        agentPreset: cardId,
        workspaceId: workspace.workspaceId,
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

  async promptSettings(sessionId: string): Promise<PromptSession> {
    const card = await this.ownedCard(sessionId)
    return this.promptSettingsFor(sessionId, card)
  }

  async applyPromptSettings(sessionId: string, input: PromptPresetSelection): Promise<PromptSession> {
    const card = await this.ownedCard(sessionId)
    const settings = await this.promptSettingsFor(sessionId, card)
    const client = this.options.promptPresets
    if (!settings.available || !client) throw this.promptUnavailable()

    const requested = [...new Set(input.enabledEntryIds)]
    const entries = new Map(settings.optionalProfiles.flatMap(profile => profile.entries.map(entry => [entry.id, { entry, profileId: profile.id }] as const)))
    if (requested.some(id => !entries.has(id))) {
      throw new GatewayError({ code: 'bad-request', message: '包含该卡片不允许使用的叙事方法。' }, 400)
    }
    const selectedGroups = new Set<string>()
    for (const id of requested) {
      const selected = entries.get(id)
      if (!selected?.entry.group || selected.entry.selection !== 'single') continue
      const groupKey = `${selected.profileId}:${selected.entry.group}`
      if (selectedGroups.has(groupKey)) throw new GatewayError({ code: 'bad-request', message: '同一单选分组只能启用一种叙事方法。' }, 400)
      selectedGroups.add(groupKey)
    }

    try {
      if (requested.length === 0) {
        const reset = await client.resetOverlay(sessionId, input.expectedRevision)
        return { ...settings, revision: reset.revision, enabledEntryIds: [], appliesFromNextTurn: true }
      }
      const selectedProfileIds = settings.optionalProfiles
        .filter(profile => requested.some(id => profile.entries.some(entry => entry.id === id)))
        .map(profile => profile.id)
      const profileIds = [...new Set([...settings.coreProfileIds, ...selectedProfileIds])]
      const saved = await client.setOverlay(sessionId, profileIds, requested, input.expectedRevision)
      return { ...settings, revision: saved.revision, enabledEntryIds: requested, appliesFromNextTurn: true }
    } catch (error) {
      throw this.promptWriteError(error)
    }
  }

  async resetPromptSettings(sessionId: string, expectedRevision: number): Promise<PromptSession> {
    return this.applyPromptSettings(sessionId, { enabledEntryIds: [], expectedRevision })
  }

  subscribe(sessionId: string, listener: (event: StreamEvent) => void): () => void {
    return this.hub.subscribe(sessionId, listener)
  }

  subscribeProduct(listener: (event: ProductSourceEvent) => void): () => void {
    this.productListeners.add(listener)
    return () => this.productListeners.delete(listener)
  }

  async getProductScope(sessionId: string): Promise<ProductScope> {
    const card = await this.ownedCard(sessionId)
    const workspaceId = this.workspacesBySession.get(sessionId)
    if (!workspaceId) throw new GatewayError({ code: 'storage-unavailable', message: '无法解析该 RP 会话的工作区归属。' }, 503)
    return { workspaceId, cardId: card.id, sessionId, branchId: sessionId }
  }

  async productSnapshots(): Promise<Array<{ detail: SessionDetail; scope: ProductScope; sourceSeq: number }>> {
    await this.refreshSessions()
    const sessionIds = [...this.summaries.keys()].filter(sessionId => this.projectionSeqs.has(sessionId) && this.workspacesBySession.has(sessionId))
    return Promise.all(sessionIds.map(async sessionId => ({ detail: await this.session(sessionId), scope: await this.getProductScope(sessionId), sourceSeq: this.projectionSeqs.get(sessionId)! })))
  }

  private async refresh(): Promise<void> {
    await this.refreshCards()
    await this.refreshSessions()
    await this.reconcileCardWorkspaces()
  }

  private async ensureCardWorkspace(card: Card): Promise<DshWorkspace> {
    const home = this.options.dshHome ?? process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh')
    const requestedPath = join(home, 'rp-workspaces', card.id)
    await mkdir(requestedPath, { recursive: true })
    const path = await realpath(requestedPath)
    const result = await this.options.dsh.createWorkspace(path)
    const title = `${card.title} [${card.id}]`
    if (result.workspace.title === title) return result.workspace
    return (await this.options.dsh.renameWorkspace(result.workspace.workspaceId, title)).workspace
  }

  private async reconcileCardWorkspaces(): Promise<void> {
    for (const card of this.cardsById.values()) {
      const workspace = await this.ensureCardWorkspace(card)
      const accounted = new Set(workspace.sessionIds)
      for (const session of this.summaries.values()) {
        if (
          session.agentPreset !== card.id
          || session.cwd !== workspace.path
          || accounted.has(session.sessionId)
        ) continue
        await this.options.dsh.createSession({
          sessionId: session.sessionId,
          agentPreset: card.id,
          workspaceId: workspace.workspaceId,
        })
        accounted.add(session.sessionId)
      }
    }
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
        this.publishProduct({ type: 'projection', sessionId: item.sessionId, branchId: item.sessionId, sourceSeq: this.projectionSeqs.get(item.sessionId) ?? item.projections?.asOfSeq ?? 0, state })
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
    const pending = this.historyLoads.get(sessionId)
    if (pending) {
      await pending
      if (!this.events.has(sessionId)) await this.ensureHistory(sessionId)
      return
    }
    if (this.events.has(sessionId)) return
    const liveEvents: RawSessionEvent[] = []
    this.events.set(sessionId, liveEvents)
    const load = this.loadHistory(sessionId, liveEvents)
    this.historyLoads.set(sessionId, load)
    try { await load } finally {
      if (this.historyLoads.get(sessionId) === load) this.historyLoads.delete(sessionId)
    }
    if (!this.events.has(sessionId)) await this.ensureHistory(sessionId)
  }

  private async loadHistory(sessionId: string, liveEvents: RawSessionEvent[]): Promise<void> {
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
      const [listedSessions, workspaces] = await Promise.all([
        this.options.dsh.listSessions(),
        this.options.dsh.listWorkspaces(),
      ])
      const archivedSessionIds = new Set(workspaces.archivedSessionIds)
      const items = listedSessions.filter(item => !archivedSessionIds.has(item.sessionId))
      this.summaries = new Map(items.map(item => [item.sessionId, item]))
      this.workspacesBySession = new Map(workspaces.items.flatMap(workspace => workspace.sessionIds.map(sessionId => [sessionId, workspace.workspaceId] as const)))
      for (const item of items) {
        if (this.workspacesBySession.has(item.sessionId) || !item.cwd) continue
        const workspace = workspaces.items.find(candidate => candidate.path === item.cwd)
        if (workspace) this.workspacesBySession.set(item.sessionId, workspace.workspaceId)
      }
      const activeSessionIds = new Set(items.map(item => item.sessionId))
      for (const sessionId of this.projectionSeqs.keys()) {
        if (activeSessionIds.has(sessionId)) continue
        this.projectionSeqs.delete(sessionId)
        this.projections.delete(sessionId)
      }
      for (const item of items) {
        const baseline = item.projections
        if (!baseline) continue
        const cachedSeq = this.projectionSeqs.get(item.sessionId)
        if (cachedSeq !== undefined && baseline.asOfSeq < cachedSeq) continue
        if (Object.prototype.hasOwnProperty.call(baseline.values, 'rp-state')) {
          this.projections.set(item.sessionId, baseline.values['rp-state'])
        } else {
          this.projections.delete(item.sessionId)
        }
        this.projectionSeqs.set(item.sessionId, baseline.asOfSeq)
      }
    } catch (error) {
      throw upstreamError(error)
    }
  }

  private async assertOwned(sessionId: string): Promise<void> {
    await this.ownedCard(sessionId)
  }

  private async ownedCard(sessionId: string): Promise<Card> {
    await this.refreshSessions()
    const item = this.summaries.get(sessionId)
    const card = item?.agentPreset ? this.cardsById.get(item.agentPreset) : undefined
    if (!item || !card) throw new GatewayError({ code: 'not-found', message: '找不到该 RP 会话。' }, 404)
    return card
  }

  private async promptSettingsFor(sessionId: string, card: Card): Promise<PromptSession> {
    const coreProfileIds = card.prompt?.coreProfileIds ?? []
    const optionalProfileIds = card.prompt?.optionalProfileIds ?? []
    if (optionalProfileIds.length === 0) {
      return { available: true, revision: 0, coreProfileIds, optionalProfiles: [], enabledEntryIds: [], appliesFromNextTurn: false }
    }
    const client = this.options.promptPresets
    if (!client) return { available: false, message: '叙事方法服务暂不可用；Agent runtime 核心仍保持启用。', revision: 0, coreProfileIds, optionalProfiles: [], enabledEntryIds: [], appliesFromNextTurn: false }
    try {
      const [catalog, effective] = await Promise.all([client.catalog(), client.effective(sessionId)])
      const metadata = new Map(catalog.profiles.map(profile => [profile.id, profile]))
      const profiles = await Promise.all(optionalProfileIds.map(async (id) => {
        const item = metadata.get(id)
        if (!item) throw new PromptPresetsClientError('Declared optional profile is unavailable', 502)
        const profile = await client.profile(id, item.version)
        if (profile.id !== id || profile.version !== item.version) {
          throw new PromptPresetsClientError('Prompt profile identity does not match the catalog', 502)
        }
        return profile
      }))
      const optionalProfiles = profiles.map(profile => this.publicPromptProfile(profile))
      const allowed = new Set(optionalProfiles.flatMap(profile => profile.entries.map(entry => entry.id)))
      return {
        available: true,
        revision: Math.max(catalog.revision, effective.revision),
        coreProfileIds,
        optionalProfiles,
        enabledEntryIds: effective.enabledEntryIds.filter(id => allowed.has(id)),
        appliesFromNextTurn: effective.appliesFromNextTurn,
      }
    } catch {
      return { available: false, message: '叙事方法服务暂不可用；Agent runtime 核心仍保持启用。', revision: 0, coreProfileIds, optionalProfiles: [], enabledEntryIds: [], appliesFromNextTurn: false }
    }
  }

  private publicPromptProfile(profile: PromptProfileView): PromptSession['optionalProfiles'][number] {
    return {
      id: profile.id,
      name: profile.name,
      description: profile.description,
      version: profile.version,
      entries: profile.entries.map(entry => ({
        id: entry.id,
        name: entry.name,
        slot: entry.slot,
        ...(entry.group ? { group: entry.group } : {}),
        selection: entry.selection,
        tags: entry.tags,
        enabledByDefault: entry.enabled,
        renderOnly: entry.renderOnly,
      })),
    }
  }

  private promptUnavailable(): GatewayError {
    return new GatewayError({ code: 'upstream-unavailable', message: '叙事方法服务暂不可用，未应用任何修改。' }, 503)
  }

  private promptWriteError(error: unknown): GatewayError {
    if (error instanceof PromptPresetsClientError && error.status === 409) {
      return new GatewayError({ code: 'bad-request', message: '叙事方法已在其他窗口更新，请刷新后重试。' }, 409)
    }
    return this.promptUnavailable()
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
    if (frame.type === 'session/subscribed') {
      this.events.delete(frame.sessionId)
      this.hub.publish({ type: 'session.rebased', sessionId: frame.sessionId })
      this.publishProduct({ type: 'rebase', sessionId: frame.sessionId, branchId: frame.sessionId, sourceSeq: Math.max(frame.lastSeq, 0) })
      return
    }
    if (frame.type === 'stream/error') {
      for (const sessionId of this.summaries.keys()) this.hub.publish({
        type: 'error', sessionId, error: mapDshError(frame.error),
      })
      return
    }
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
      this.projectionSeqs.delete(frame.sessionId)
      this.workspacesBySession.delete(frame.sessionId)
      return
    }
    if (frame.type === 'host/attention') {
      this.publishProduct({ type: 'attention.required', sessionId: frame.sessionId, sourceSeq: this.projectionSeqs.get(frame.sessionId) ?? 0 })
      return
    }
    if (frame.type === 'session/projection' && frame.key === 'rp-state') {
      const cachedSeq = this.projectionSeqs.get(frame.sessionId)
      if (cachedSeq !== undefined && frame.seq < cachedSeq) return
      const previous = projectPublicState(this.projections.get(frame.sessionId))
      this.projections.set(frame.sessionId, frame.value)
      this.projectionSeqs.set(frame.sessionId, frame.seq)
      const state = projectPublicState(frame.value)
      this.hub.publish({ type: 'state.updated', sessionId: frame.sessionId, state })
      this.publishProduct({ type: 'projection', sessionId: frame.sessionId, branchId: frame.sessionId, sourceSeq: frame.seq, state })
      if (previous.driver?.armed && !state.driver?.armed) this.publishProduct({ type: 'autoplay.completed', sessionId: frame.sessionId, sourceSeq: frame.seq })
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
      if (message?.role === 'gm') this.publishProduct({ type: 'turn.completed', sessionId: frame.sessionId, sourceSeq: event.seq })
    }
    if (event.surfaceOp && typeof event.surfaceOp === 'object' && event.surfaceOp.op === 'replace') {
      this.hub.publish({ type: 'session.rebased', sessionId: frame.sessionId })
      this.publishProduct({ type: 'rebase', sessionId: frame.sessionId, branchId: frame.sessionId, sourceSeq: event.seq })
    }
  }

  private publishProduct(event: ProductSourceEvent): void {
    for (const listener of this.productListeners) listener(event)
  }
}
