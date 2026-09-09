import { randomUUID } from 'node:crypto'
import NodeWebSocket from 'ws'
import { createWebAuth } from './web-auth.js'
import { RemoteMux, type SocketFactory } from './remote-mux.js'
import {
  assertLoopbackUrl,
  safeDshError, DshRpcError,
  type DshResponse,
} from './wire.js'

export interface DshPresetEntry {
  id: string
  trust: 'system' | 'user'
  isDefault?: boolean
  name?: string
  description?: string
  broken?: string
}

export interface DshSessionListItem {
  sessionId: string
  updatedAt: number
  running: boolean
  blank: boolean
  parentSessionId?: string
  cwd?: string
  agentPreset?: string
  projections?: { asOfSeq: number; values: Record<string, unknown> }
}

export interface DshWorkspace {
  workspaceId: string
  path: string
  title: string
  sessionIds: string[]
  createdAt: string
  updatedAt: string
}

export interface DshWorkspaceList {
  items: DshWorkspace[]
  archivedSessionIds: string[]
}

export interface DshHistoryEntry {
  event: {
    seq: number
    time: number
    type: string
    data: Record<string, unknown>
    surfaceOp?: unknown
    sourceEventSeqs?: number[]
  }
  view?: unknown
}

export interface DshClientOptions {
  baseUrl?: string
  fetchImpl?: typeof fetch
  webSocketFactory?: SocketFactory
  webToken?: string
}

export interface DshClient {
  hostDescribe(signal?: AbortSignal): Promise<Record<string, unknown>>
  listPresets(signal?: AbortSignal): Promise<DshPresetEntry[]>
  listSessions(signal?: AbortSignal): Promise<DshSessionListItem[]>
  listWorkspaces(signal?: AbortSignal): Promise<DshWorkspaceList>
  createWorkspace(path: string, signal?: AbortSignal): Promise<{ workspace: DshWorkspace; created: boolean }>
  renameWorkspace(workspaceId: string, title: string, signal?: AbortSignal): Promise<{ workspace: DshWorkspace }>
  createSession(payload: { agentPreset: string; workspaceId?: string; cwd?: string; sessionId?: string }, signal?: AbortSignal): Promise<{ sessionId: string; agentPreset?: string }>
  history(sessionId: string, payload?: { beforeSeq?: number; maxMessages?: number }, signal?: AbortSignal): Promise<{ events: DshHistoryEntry[]; hasMore: boolean; projections?: { asOfSeq: number; values: Record<string, unknown> } }>
  historyAll(sessionId: string, signal?: AbortSignal): Promise<DshHistoryEntry[]>
  prompt(sessionId: string, text: string, signal?: AbortSignal): Promise<Record<string, unknown>>
  cancel(sessionId: string, signal?: AbortSignal): Promise<Record<string, unknown>>
  fork(sessionId: string, atSeq?: number, signal?: AbortSignal): Promise<{ sessionId: string }>
  connectStreams(onFrame: (frame: DshStreamFrame) => void, onClose?: () => void, onOpen?: () => void): () => void
}

export type DshStreamFrame =
  | { type: 'session/event'; sessionId: string; event: DshHistoryEntry['event'] }
  | { type: 'session/subscribed'; sessionId: string; lastSeq: number }
  | { type: 'session/projection'; sessionId: string; key: string; value: unknown; seq: number }
  | { type: 'host/session-status'; sessionId: string; running: boolean }
  | { type: 'host/session-added'; sessionId: string; blank: boolean; agentPreset?: string; cwd?: string; parentSessionId?: string }
  | { type: 'host/session-removed'; sessionId: string }
  | { type: 'host/attention'; sessionId: string }
  | { type: 'stream/error'; error: unknown }

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function attentionSessionId(value: unknown): string | undefined {
  const direct = record(value)
  if (typeof direct?.sessionId === 'string') return direct.sessionId
  for (const key of ['request', 'question', 'approval', 'context']) {
    const nested = record(direct?.[key])
    if (typeof nested?.sessionId === 'string') return nested.sessionId
  }
  return undefined
}

function parseDshResponse<T>(value: unknown): T {
  const response = value as Partial<DshResponse<T>> | null
  if (!response || response.type !== 'server-response' || typeof response.rpcId !== 'string' || !response.result || typeof response.result.ok !== 'boolean') {
    throw new Error('invalid DSH server-response')
  }
  if (!response.result.ok) throw safeDshError(response.result)
  return response.result.value
}

interface HistoryPage {
  records: Array<{ type: 'event' | 'chunks'; event: DshHistoryEntry['event'] }>
  hasMore: boolean
}
interface Snapshot extends HistoryPage {
  type: 'snapshot'
  header: { id: string; agentPreset?: string }
  cursor: number
  projections: { asOfSeq: number; values: Record<string, unknown> }
}

function historyPage(value: unknown): HistoryPage {
  const page = record(value)
  if (!page || !Array.isArray(page.records) || typeof page.hasMore !== 'boolean') throw new Error('invalid DSH history page')
  for (const entry of page.records) {
    const item = record(entry)
    const event = record(item?.event)
    if (!item || !['event', 'chunks'].includes(String(item.type)) || !event || !Number.isSafeInteger(event.seq) || (event.seq as number) < 0 || typeof event.type !== 'string' || !Number.isFinite(event.time) || !record(event.data)) {
      throw new Error('invalid DSH history record')
    }
  }
  return page as unknown as HistoryPage
}

// Packed rows contain only deltas, never surface operations. Final messages remain
// ordinary events, so the player transcript needs no storage-codec dependency.
function entries(page: HistoryPage): DshHistoryEntry[] {
  return page.records.filter(row => row.type === 'event').map(row => ({ event: row.event }))
}

export function createDshClient(options: DshClientOptions = {}): DshClient {
  const base = assertLoopbackUrl(options.baseUrl ?? process.env.DSH_BASE_URL ?? process.env.DSH_URL ?? 'http://127.0.0.1:3080')
  const request = options.fetchImpl ?? fetch
  const auth = createWebAuth(base, request, options.webToken ?? base.searchParams.get('token') ?? process.env.DSH_WEB_TOKEN)
  base.search = ''
  base.hash = ''
  const socketFactory: SocketFactory = options.webSocketFactory ?? ((url, headers) => new NodeWebSocket(url, { headers, handshakeTimeout: 10_000 }) as unknown as WebSocket)
  let onFrame: (frame: DshStreamFrame) => void = () => {}
  let onClose: () => void = () => {}
  let onOpen: () => void = () => {}
  const followers = new Map<string, () => void>()
  const mux = new RemoteMux(new URL('/api/remote.mux', base).href.replace(/^http/, 'ws'), socketFactory, () => auth.headers(), () => onClose(), () => onOpen())

  async function call<T>(method: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const rpcId = randomUUID()
    const headers = await auth.headers()
    let response: Response
    try {
      response = await request(new URL(`/api/${method}`, base), {
        method: 'POST', redirect: 'error',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }),
        signal: signal ?? AbortSignal.timeout(15_000),
      })
    } catch {
      throw new Error('DSH request failed')
    }
    if (response.status === 401) {
      auth.invalidate()
      throw new DshRpcError('authentication-required', 'DSH Web authentication required')
    }
    if (!response.ok) throw new Error(`DSH HTTP ${response.status}`)
    return parseDshResponse<T>(await response.json())
  }

  function firstItem(endpoint: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timeout = AbortSignal.timeout(15_000)
      const lifetime = signal ? AbortSignal.any([signal, timeout]) : timeout
      let close = () => {}
      const finish = (error?: unknown, value?: unknown) => {
        close()
        lifetime.removeEventListener('abort', abort)
        if (error) reject(error)
        else resolve(value)
      }
      const abort = () => finish(lifetime.reason)
      if (lifetime.aborted) { reject(lifetime.reason); return }
      lifetime.addEventListener('abort', abort, { once: true })
      close = mux.open(endpoint, args, value => finish(undefined, value), error => finish(error))
    })
  }

  function followSnapshot(sessionId: string, signal?: AbortSignal): Promise<Snapshot> {
    followers.get(sessionId)?.()
    return new Promise((resolve, reject) => {
      let settled = false
      let first = true
      const lifetime = signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000)
      const done = () => lifetime.removeEventListener('abort', abort)
      const abort = () => { close(); followers.delete(sessionId); done(); reject(lifetime.reason) }
      const fail = (error: unknown) => { done(); if (!settled) { close(); followers.delete(sessionId); reject(error) }; onFrame({ type: 'stream/error', error }) }
      const close = mux.open('session/follow', { request: { address: { kind: 'session', sessionId }, maxMessages: 500 } }, value => {
        try {
          const frame = record(value)
          if (frame?.type === 'snapshot') {
            const page = historyPage(value)
            const snapshot = value as Snapshot
            if (snapshot.header?.id !== sessionId || !Number.isSafeInteger(snapshot.cursor) || snapshot.cursor < -1) throw new Error('invalid DSH snapshot')
            if (!first) onFrame({ type: 'session/subscribed', sessionId, lastSeq: snapshot.cursor })
            first = false
            publishProjections(sessionId, snapshot.projections)
            if (!settled) { settled = true; done(); resolve({ ...snapshot, ...page }) }
          } else if (frame?.type === 'event') {
            const page = historyPage({ records: [frame], hasMore: false })
            onFrame({ type: 'session/event', sessionId, event: page.records[0]!.event })
          }
        } catch (error) { fail(error) }
      }, fail)
      followers.set(sessionId, close)
      if (lifetime.aborted) abort()
      else lifetime.addEventListener('abort', abort, { once: true })
    })
  }

  async function probeSessionPreset(sessionId: string, signal?: AbortSignal): Promise<string | undefined> {
    // Use a separate short-lived stream so discovery cannot cancel an active narrative follower.
    const value = await firstItem('session/follow', { request: { address: { kind: 'session', sessionId }, maxMessages: 1 } }, signal)
    const snapshot = value as Snapshot
    if (snapshot.type !== 'snapshot' || snapshot.header?.id !== sessionId) throw new Error('invalid DSH ownership snapshot')
    const preset = snapshot.projections?.values.agentPreset ?? snapshot.header.agentPreset
    return typeof preset === 'string' ? preset : undefined
  }

  function publishProjections(sessionId: string, baseline: unknown): void {
    const projection = record(baseline)
    const values = record(projection?.values)
    if (!values || !Number.isSafeInteger(projection?.asOfSeq)) return
    // A baseline is complete: absence must clear a stale rp-state projection.
    onFrame({ type: 'session/projection', sessionId, key: 'rp-state', value: values['rp-state'] ?? null, seq: projection!.asOfSeq as number })
  }

  const client: DshClient = {
    // host.describe was removed. Probe a real Remote capability; the host no
    // longer exports a version here, so do not invent a runtime version.
    hostDescribe: async signal => { await call('agentPresets/list', {}, signal); return { version: 'unknown', transport: 'remote', compatibility: '0.1.2-rc.1' } },
    listPresets: async signal => (await call<{ presets: DshPresetEntry[] }>('agentPresets/list', {}, signal)).presets,
    listSessions: async signal => {
      const items = (await call<{ items: DshSessionListItem[] }>('session/list', { _request: {} }, signal)).items
      const resolved: DshSessionListItem[] = []
      // Bound cold activation rather than opening every old session simultaneously.
      for (let offset = 0; offset < items.length; offset += 4) {
        resolved.push(...await Promise.all(items.slice(offset, offset + 4).map(async item => {
        const preset = item.projections?.values.agentPreset
        if (typeof preset === 'string') return { ...item, agentPreset: preset }
        const probed = await probeSessionPreset(item.sessionId, signal)
        const { agentPreset: _legacyPreset, ...summary } = item
        return probed === undefined ? summary : { ...summary, agentPreset: probed }
        })))
      }
      return resolved
    },
    listWorkspaces: async signal => {
      const frame = record(await firstItem('workspace/follow', {}, signal))
      const value = record(frame?.value)
      if (frame?.type !== 'baseline' || !Array.isArray(value?.items) || !Array.isArray(value?.archivedSessionIds)) throw new Error('invalid DSH workspace baseline')
      return value as unknown as DshWorkspaceList
    },
    createWorkspace: (path, signal) => call('workspace/create', { request: { path } }, signal),
    renameWorkspace: (workspaceId, title, signal) => call('workspace/rename', { request: { workspaceId, title } }, signal),
    createSession: (payload, signal) => call('session/create', { request: payload }, signal),
    history: async (sessionId, payload = {}, signal) => {
      const snapshot = await followSnapshot(sessionId, signal)
      const page = payload.beforeSeq === undefined ? snapshot : historyPage(await call('session/page', { request: {
        address: { kind: 'session', sessionId }, throughSeq: snapshot.cursor, ...payload,
      } }, signal))
      return { events: entries(page), hasMore: page.hasMore, projections: snapshot.projections }
    },
    historyAll: async (sessionId, signal) => {
      const snapshot = await followSnapshot(sessionId, signal)
      let page: HistoryPage = snapshot
      const events = new Map<number, DshHistoryEntry>()
      let beforeSeq = snapshot.cursor + 1
      while (true) {
        signal?.throwIfAborted()
        for (const entry of entries(page)) events.set(entry.event.seq, entry)
        if (!page.hasMore) return [...events.values()].sort((a, b) => a.event.seq - b.event.seq)
        const next = Math.min(...page.records.map(row => row.event.seq))
        if (!Number.isSafeInteger(next) || next < 0 || next >= beforeSeq) throw new Error('invalid DSH history pagination cursor')
        beforeSeq = next
        page = historyPage(await call('session/page', { request: {
          address: { kind: 'session', sessionId }, throughSeq: snapshot.cursor, beforeSeq, maxMessages: 500,
        } }, signal))
      }
    },
    prompt: (sessionId, text, signal) => call('session/prompt', { request: { requestId: randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text }] } }, signal),
    cancel: (sessionId, signal) => call('session/cancel', { request: { sessionId } }, signal),
    fork: (sessionId, atSeq, signal) => call('session/fork', { request: { sessionId, ...(atSeq === undefined ? {} : { atSeq }) } }, signal),
    connectStreams: (frameListener, closeListener, openListener) => {
      onFrame = frameListener
      onClose = closeListener ?? (() => {})
      onOpen = openListener ?? (() => {})
      const fail = (error: unknown) => onFrame({ type: 'stream/error', error })
      mux.open('session/control', {}, value => {
        const frame = record(value)
        if (frame?.type === 'baseline') {
          const baselines = record(record(frame.value)?.projections)
          for (const [sessionId, baseline] of Object.entries(baselines ?? {})) publishProjections(sessionId, baseline)
        } else if (frame?.type === 'projection' && typeof frame.sessionId === 'string' && typeof frame.key === 'string' && Number.isSafeInteger(frame.seq)) {
          onFrame({ type: 'session/projection', sessionId: frame.sessionId, key: frame.key, value: frame.value, seq: frame.seq as number })
        }
      }, fail)
      let eventClientId: string | undefined
      mux.open('$events', {}, value => {
        const frame = record(value)
        if (frame?.type === 'ready' && typeof frame.clientId === 'string') eventClientId = frame.clientId
        // Studio does not own approvals/questions. Yield waterfalls so the DSH
        // Web client can handle them; never approve or answer on the player's behalf.
        if (frame?.type === 'waterfall' && eventClientId && typeof frame.eventId === 'string' && Array.isArray(frame.args)) {
          const sessionId = frame.args.map(attentionSessionId).find((value): value is string => value !== undefined)
          if (sessionId) onFrame({ type: 'host/attention', sessionId })
          void call('$events/result', { clientId: eventClientId, eventId: frame.eventId, outcome: { kind: 'next' } }).catch(fail)
        }
        if (frame?.type !== 'emit' || !Array.isArray(frame.args)) return
        const [sessionId, running] = frame.args
        if (frame.event === 'api-session/status' && typeof sessionId === 'string' && typeof running === 'boolean') onFrame({ type: 'host/session-status', sessionId, running })
        if (frame.event === 'api-session/removed' && typeof sessionId === 'string') {
          followers.get(sessionId)?.(); followers.delete(sessionId)
          onFrame({ type: 'host/session-removed', sessionId })
        }
      }, fail)
      return () => { followers.clear(); mux.stop() }
    },
  }
  return client
}
