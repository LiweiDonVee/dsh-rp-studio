import { describe, expect, it, vi } from 'vitest'
import { createGatewayNotificationSubscriber } from '../src/main/notification-subscriber.js'

describe('Gateway public notification subscriber', () => {
  it('shows only allowlisted public SSE notifications and aborts the stream on stop', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: notification\ndata: {"type":"backup.ready","title":"private"}\n\nevent: notification\ndata: {"type":"secret.event"}\n\n'))
      },
    })
    const request = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      init?.signal?.addEventListener('abort', () => undefined)
      return new Response(stream, { status: 200 })
    }) as typeof fetch
    const show = vi.fn()
    const subscriber = createGatewayNotificationSubscriber(show, request)

    await subscriber.start('http://127.0.0.1:4317/private', '会话-7')
    await Promise.resolve()
    await Promise.resolve()
    subscriber.stop()

    expect(request).toHaveBeenCalledWith('http://127.0.0.1:4317/api/v1/product/notifications/stream?sessionId=%E4%BC%9A%E8%AF%9D-7', expect.objectContaining({ headers: { accept: 'text/event-stream' } }))
    expect(show).toHaveBeenCalledWith({ title: 'DSH RP Studio', body: 'A backup is ready' })
    expect(show).toHaveBeenCalledOnce()
    expect(vi.mocked(request).mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
  })
})
