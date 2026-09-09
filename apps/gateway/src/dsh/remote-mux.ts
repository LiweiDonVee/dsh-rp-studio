import { randomUUID } from 'node:crypto'
import { safeDshError } from './wire.js'

export type SocketFactory = (url: string, headers?: Record<string, string>) => WebSocket

/** One authenticated carrier, with cancellable logical streams and bounded reconnects. */
export class RemoteMux {
  private socket: WebSocket | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private opening = false
  private connected = false
  private stopped = false
  private attempts = 0
  private outage = false
  private readonly streams = new Map<string, {
    endpoint: string; args: Record<string, unknown>; item(value: unknown): void; error(error: unknown): void
  }>()

  constructor(
    private readonly url: string,
    private readonly factory: SocketFactory,
    private readonly headers: () => Promise<Record<string, string>>,
    private readonly onClose: () => void,
    private readonly onOpen: () => void,
  ) {}

  open(endpoint: string, args: Record<string, unknown>, item: (value: unknown) => void, error: (error: unknown) => void): () => void {
    const id = randomUUID()
    this.streams.set(id, { endpoint, args, item, error })
    if (this.connected) this.sendOpen(id)
    else void this.connect()
    return () => {
      this.streams.delete(id)
      if (this.connected) this.socket?.send(JSON.stringify({ type: 'cancel', streamId: id }))
    }
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    for (const stream of this.streams.values()) stream.error(new Error('DSH stream stopped'))
    this.streams.clear()
    this.socket?.close()
    this.socket = undefined
    this.connected = false
  }

  private sendOpen(id: string): void {
    const stream = this.streams.get(id)
    if (stream) this.socket?.send(JSON.stringify({ type: 'open', streamId: id, endpoint: stream.endpoint, payload: { args: stream.args } }))
  }

  private retry(): void {
    if (this.stopped || this.timer) return
    if (!this.outage) { this.outage = true; this.onClose() }
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.connect()
    }, Math.min(250 * 2 ** Math.min(this.attempts++, 5), 5_000))
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.opening || this.connected || this.timer) return
    this.opening = true
    try {
      const headers = await this.headers()
      if (this.stopped) return
      const socket = this.factory(this.url, headers)
      this.socket = socket
      socket.onopen = () => {
        if (this.stopped || this.socket !== socket) return
        this.opening = false
        this.connected = true
        this.attempts = 0
        for (const id of this.streams.keys()) this.sendOpen(id)
        if (this.outage) { this.outage = false; this.onOpen() }
      }
      socket.onmessage = message => {
        if (this.stopped || this.socket !== socket) return
        try {
          const frame = JSON.parse(String(message.data))
          const stream = this.streams.get(frame.streamId)
          if (!stream) return
          if (frame.type === 'item') stream.item(frame.value)
          else if (frame.type === 'error' || frame.type === 'end') {
            stream.error(frame.type === 'error' ? safeDshError({ ok: false, error: frame.error }) : new Error('DSH stream ended'))
            // A logical stream may end while its physical connection remains open.
            socket.close()
          }
        } catch {
          for (const stream of this.streams.values()) stream.error(new Error('invalid DSH stream frame'))
          socket.close()
        }
      }
      socket.onerror = () => { socket.close() }
      socket.onclose = () => {
        if (this.socket !== socket) return
        this.socket = undefined
        this.connected = false
        this.opening = false
        this.retry()
      }
    } catch {
      this.opening = false
      this.retry()
    }
  }
}
