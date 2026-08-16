import type { StreamEvent } from '@dsh-rp/protocol'

export class EventHub {
  private readonly listeners = new Map<string, Set<(event: StreamEvent) => void>>()

  subscribe(sessionId: string, listener: (event: StreamEvent) => void): () => void {
    const set = this.listeners.get(sessionId) ?? new Set()
    set.add(listener)
    this.listeners.set(sessionId, set)
    return () => {
      set.delete(listener)
      if (set.size === 0) this.listeners.delete(sessionId)
    }
  }

  publish(event: StreamEvent): void {
    for (const listener of this.listeners.get(event.sessionId) ?? []) listener(event)
  }
}
