import { describe, expect, it, vi } from 'vitest'
import { createSessionNotificationMonitor } from '../src/preload/session-notifications.js'

describe('renderer session notification monitor', () => {
  it('subscribes after the renderer stores a session and stops its bounded poller on cleanup', async () => {
    let sessionId: string | null = null
    let poll: (() => void) | undefined
    const clear = vi.fn()
    const subscribe = vi.fn(async () => undefined)
    const monitor = createSessionNotificationMonitor(
      () => sessionId,
      subscribe,
      callback => { poll = callback; return 47 as never },
      clear,
    )
    sessionId = '会话-7'

    poll?.()
    await Promise.resolve()
    poll?.()
    await Promise.resolve()
    monitor.stop()

    expect(subscribe).toHaveBeenCalledOnce()
    expect(subscribe).toHaveBeenCalledWith('会话-7')
    expect(clear).toHaveBeenCalledWith(47)
  })
})
