export interface SessionNotificationMonitor { stop(): void }

export function createSessionNotificationMonitor(
  readSessionId: () => string | null,
  subscribe: (sessionId: string) => Promise<unknown>,
  schedule: (callback: () => void, milliseconds: number) => ReturnType<typeof setInterval> = setInterval,
  cancel: (timer: ReturnType<typeof setInterval>) => void = clearInterval,
): SessionNotificationMonitor {
  let subscribed = ''
  let active = true
  let polling = false
  const synchronize = async () => {
    if (!active || polling) return
    const sessionId = readSessionId()?.trim() || ''
    if (!sessionId || sessionId === subscribed) return
    polling = true
    try {
      await subscribe(sessionId)
      if (active) subscribed = sessionId
    } catch {
      if (active) subscribed = ''
    } finally {
      polling = false
    }
  }
  const timer = schedule(() => { void synchronize() }, 500)
  void synchronize()
  return {
    stop() {
      if (!active) return
      active = false
      cancel(timer)
    },
  }
}
