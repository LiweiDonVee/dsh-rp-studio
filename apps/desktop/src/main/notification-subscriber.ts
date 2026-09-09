export interface PublicNotification { title: string; body: string }
export interface GatewayNotificationSubscriber { start(origin: string, sessionId: string): Promise<void>; stop(): void }

const publicNotifications: Record<string, PublicNotification> = {
  'backup.ready': { title: 'DSH RP Studio', body: 'A backup is ready' },
  'backup.failed': { title: 'DSH RP Studio', body: 'A backup operation failed' },
  'storage.warning': { title: 'DSH RP Studio', body: 'Local storage needs attention' },
}

export function createGatewayNotificationSubscriber(show: (notification: PublicNotification) => void, request: typeof fetch = fetch): GatewayNotificationSubscriber {
  let controller: AbortController | undefined
  return {
    async start(origin, sessionId) {
      controller?.abort()
      controller = new AbortController()
      const response = await request(`${new URL(origin).origin}/api/v1/product/notifications/stream?sessionId=${encodeURIComponent(sessionId)}`, {
        headers: { accept: 'text/event-stream' }, signal: controller.signal,
      })
      if (!response.ok || !response.body) throw new Error('Gateway notification stream is unavailable')
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      void (async () => {
        let buffer = ''
        try {
          while (true) {
            const chunk = await reader.read()
            if (chunk.done) break
            buffer += decoder.decode(chunk.value, { stream: true })
            const frames = buffer.split(/\r?\n\r?\n/u)
            buffer = frames.pop() ?? ''
            for (const frame of frames) {
              if (!frame.includes('event: notification')) continue
              const data = frame.split(/\r?\n/u).find(line => line.startsWith('data: '))?.slice(6)
              if (!data) continue
              const parsed: unknown = JSON.parse(data)
              const type = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>).type : undefined
              if (typeof type === 'string' && publicNotifications[type]) show(publicNotifications[type])
            }
          }
        } catch (error) {
          if (!controller?.signal.aborted) void error
        }
      })()
    },
    stop() { controller?.abort(); controller = undefined },
  }
}
