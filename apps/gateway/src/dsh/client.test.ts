import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDshClient } from './client.js'
import { assertLoopbackUrl } from './wire.js'

function response(value: unknown): Response {
  return new Response(JSON.stringify({ type: 'server-response', rpcId: 'r', result: { ok: true, value } }), { status: 200 })
}

describe('DSH HTTP adapter', () => {
  afterEach(() => vi.useRealTimers())
  it('sends the version-independent client-request envelope and unwraps the value', async () => {
    let request: Request | undefined
    const client = createDshClient({
      baseUrl: 'http://127.0.0.1:3080',
      fetchImpl: async (input, init) => {
        request = new Request(input, init)
        return response({ presets: [] })
      },
    })
    await expect(client.listPresets()).resolves.toEqual([])
    const body = await request?.json() as Record<string, unknown>
    expect(body).toMatchObject({ type: 'client-request', method: 'agentPreset.list', payload: {} })
    expect(typeof body.rpcId).toBe('string')
  })

  it('fails closed for non-loopback upstreams', () => {
    expect(() => assertLoopbackUrl('https://example.com')).toThrow('loopback')
    expect(() => assertLoopbackUrl('http://192.168.1.2:3080')).toThrow('loopback')
  })

  it('reconnects a closed DSH stream with bounded backoff', async () => {
    vi.useFakeTimers()
    const sockets: Array<{
      onopen: (() => void) | null
      onmessage: ((event: MessageEvent) => void) | null
      onclose: (() => void) | null
      close: ReturnType<typeof vi.fn>
    }> = []
    const client = createDshClient({
      baseUrl: 'http://127.0.0.1:3080',
      webSocketFactory: () => {
        const socket = { onopen: null, onmessage: null, onclose: null, close: vi.fn() }
        sockets.push(socket)
        return socket as unknown as WebSocket
      },
    })
    const onClose = vi.fn()
    const onOpen = vi.fn()
    const stop = client.connectStreams(vi.fn(), onClose, onOpen)
    expect(sockets).toHaveLength(2)

    sockets[0]!.onopen?.()
    sockets[1]!.onopen?.()
    sockets[0]!.onclose?.()
    expect(onClose).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(250)
    expect(sockets).toHaveLength(3)
    sockets[2]!.onopen?.()
    expect(onOpen).toHaveBeenCalledTimes(1)

    sockets[1]!.onclose?.()
    sockets[2]!.onclose?.()
    expect(onClose).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(250)
    expect(sockets).toHaveLength(5)
    sockets[3]!.onopen?.()
    expect(onOpen).toHaveBeenCalledTimes(1)
    sockets[4]!.onopen?.()
    expect(onOpen).toHaveBeenCalledTimes(2)

    stop()
    expect(sockets[3]!.close).toHaveBeenCalledTimes(1)
    expect(sockets[4]!.close).toHaveBeenCalledTimes(1)
  })
})
