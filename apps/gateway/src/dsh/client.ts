import { randomUUID } from 'node:crypto'
import {
  assertLoopbackUrl,
  safeDshError,
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
  webSocketFactory?: (url: string) => WebSocket
}

export interface DshClient {
  hostDescribe(signal?: AbortSignal): Promise<Record<string, unknown>>
  listPresets(signal?: AbortSignal): Promise<DshPresetEntry[]>
  listSessions(signal?: AbortSignal): Promise<DshSessionListItem[]>
  createSession(payload: { agentPreset: string; cwd?: string }, signal?: AbortSignal): Promise<{ sessionId: string; agentPreset?: string }>
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
  | { type: 'stream/error'; error: unknown }

function parseDshResponse<T>(value: unknown): T {
  if (!value || typeof value !== 'object') throw new Error('invalid DSH server-response')
  const response = value as Partial<DshResponse<T>>
  if (response.type !== 'server-response' || typeof response.rpcId !== 'string' || !response.result) {
    throw new Error('invalid DSH server-response')
  }
  if (!response.result.ok) throw safeDshError(response.result)
  return response.result.value
}

function parseFrame(value: unknown): DshStreamFrame | undefined {
  if (!value || typeof value !== 'object') return undefined
  const frame = value as { payload?: unknown }
  const payload = frame.payload
  if (!payload || typeof payload !== 'object') return undefined
  const candidate = payload as Record<string, unknown>
  if (typeof candidate.type !== 'string') return undefined
  if (candidate.type === 'session/event' && typeof candidate.sessionId === 'string' && candidate.event) {
    return { type: 'session/event', sessionId: candidate.sessionId, event: candidate.event as DshHistoryEntry['event'] }
  }
  if (candidate.type === 'session/subscribed' && typeof candidate.sessionId === 'string' && typeof candidate.lastSeq === 'number') {
    return { type: 'session/subscribed', sessionId: candidate.sessionId, lastSeq: candidate.lastSeq }
  }
  if (candidate.type === 'session/projection' && typeof candidate.sessionId === 'string' && typeof candidate.key === 'string' && typeof candidate.seq === 'number') {
    return { type: 'session/projection', sessionId: candidate.sessionId, key: candidate.key, value: candidate.value, seq: candidate.seq }
  }
  if (candidate.type === 'host/session-status' && typeof candidate.sessionId === 'string' && typeof candidate.running === 'boolean') {
    return { type: 'host/session-status', sessionId: candidate.sessionId, running: candidate.running }
  }
  if (candidate.type === 'host/session-added' && typeof candidate.sessionId === 'string' && typeof candidate.blank === 'boolean') {
    return {
      type: 'host/session-added', sessionId: candidate.sessionId, blank: candidate.blank,
      ...(typeof candidate.agentPreset === 'string' ? { agentPreset: candidate.agentPreset } : {}),
      ...(typeof candidate.cwd === 'string' ? { cwd: candidate.cwd } : {}),
      ...(typeof candidate.parentSessionId === 'string' ? { parentSessionId: candidate.parentSessionId } : {}),
    }
  }
  if (candidate.type === 'host/session-removed' && typeof candidate.sessionId === 'string') return { type: 'host/session-removed', sessionId: candidate.sessionId }
  if (candidate.type === 'stream/error') return { type: 'stream/error', error: candidate.error }
  return undefined
}

export function createDshClient(options: DshClientOptions = {}): DshClient {
  const base = assertLoopbackUrl(options.baseUrl ?? process.env.DSH_URL ?? 'http://127.0.0.1:3080')
  const request = options.fetchImpl ?? fetch
  const socketFactory = options.webSocketFactory ?? ((url: string) => new WebSocket(url))

  async function call<T>(method: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const rpcId = randomUUID()
    let response: Response
    try {
      response = await request(new URL(`/api/${method}`, base), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
        ...(signal ? { signal } : {}),
      })
    } catch (error) {
      throw new Error(`DSH request failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!response.ok) throw new Error(`DSH HTTP ${response.status}`)
    return parseDshResponse<T>(await response.json())
  }

  const client: DshClient = {
    hostDescribe: signal => call('host.describe', {}, signal),
    listPresets: async signal => (await call<{ presets: DshPresetEntry[] }>('agentPreset.list', {}, signal)).presets,
    listSessions: async signal => (await call<{ items: DshSessionListItem[] }>('session.list', {}, signal)).items,
    createSession: (payload, signal) => call('session.create', payload, signal),
    history: (sessionId, payload = {}, signal) => call('session.history', { sessionId, ...payload }, signal),
    historyAll: async (sessionId, signal) => {
      const entries: DshHistoryEntry[] = []
      let beforeSeq: number | undefined
      while (true) {
        const page = await client.history(sessionId, { ...(beforeSeq === undefined ? {} : { beforeSeq }), maxMessages: 500 }, signal)
        entries.unshift(...page.events)
        if (!page.hasMore || page.events.length === 0) return entries.sort((a, b) => a.event.seq - b.event.seq)
        beforeSeq = Math.min(...page.events.map(entry => entry.event.seq))
      }
    },
    prompt: (sessionId, text, signal) => call('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text }] }, signal),
    cancel: (sessionId, signal) => call('session.cancel', { sessionId }, signal),
    fork: (sessionId, atSeq, signal) => call('session.fork', { sessionId, ...(atSeq === undefined ? {} : { atSeq }) }, signal),
    connectStreams: (onFrame, onClose, onOpen) => {
      const slots = ['events.mux', 'events.host'].map(path => ({
        path,
        socket: null as WebSocket | null,
        timer: null as ReturnType<typeof setTimeout> | null,
        attempts: 0,
        open: false,
      }))
      let closed = false
      let outage = false

      const schedule = (slot: (typeof slots)[number]): void => {
        if (closed || slot.timer) return
        const delay = Math.min(250 * (2 ** slot.attempts), 5_000)
        slot.attempts++
        slot.timer = setTimeout(() => {
          slot.timer = null
          open(slot)
        }, delay)
      }

      const open = (slot: (typeof slots)[number]): void => {
        if (closed) return
        let socket: WebSocket
        try {
          socket = socketFactory(new URL(`/api/${slot.path}`, base).toString().replace(/^http/, 'ws'))
        } catch {
          if (!outage) {
            outage = true
            onClose?.()
          }
          schedule(slot)
          return
        }
        slot.socket = socket
        socket.onopen = () => {
          slot.attempts = 0
          slot.open = true
          if (outage && slots.every(candidate => candidate.open)) {
            outage = false
            onOpen?.()
          }
        }
        socket.onmessage = message => {
          try {
            const frame = parseFrame(JSON.parse(String(message.data)))
            if (frame) onFrame(frame)
          } catch {
            onFrame({ type: 'stream/error', error: 'invalid DSH stream frame' })
          }
        }
        socket.onerror = () => {
          // onclose owns retry scheduling; this prevents host-specific error noise.
        }
        socket.onclose = () => {
          slot.socket = null
          slot.open = false
          if (closed) return
          if (!outage) {
            outage = true
            onClose?.()
          }
          schedule(slot)
        }
      }

      slots.forEach(open)
      return () => {
        closed = true
        for (const slot of slots) {
          if (slot.timer) clearTimeout(slot.timer)
          slot.socket?.close()
          slot.timer = null
          slot.socket = null
          slot.open = false
        }
      }
    },
  }
  return client
}
