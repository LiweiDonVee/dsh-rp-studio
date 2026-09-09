import { describe, expect, it, vi } from 'vitest'
import { createDshClient } from './client.js'

function response(value: unknown): Response {
  return new Response(JSON.stringify({ type: 'server-response', rpcId: 'r', result: { ok: true, value } }))
}

describe('DSH 0.1.2 Remote contract', () => {
  it('uses named Remote arguments and a durable prompt request identity', async () => {
    const requests: Record<string, unknown>[] = []
    const client = createDshClient({ fetchImpl: async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)))
      return response({ accepted: true })
    } })
    await client.prompt('s1', 'hello')
    expect(requests[0]).toMatchObject({ method: 'session/prompt', payload: { args: { request: {
      sessionId: 's1', requestId: expect.any(String), mode: 'queue', content: [{ type: 'text', text: 'hello' }],
    } } } })
  })

  it('takes session ownership from the durable preset projection', async () => {
    const client = createDshClient({ fetchImpl: async () => response({ items: [
      { sessionId: 's1', projections: { asOfSeq: 8, values: { agentPreset: 'zombie-world' } } },
    ] }) })
    expect(await client.listSessions()).toMatchObject([{ agentPreset: 'zombie-world' }])
  })

  it('completes unknown session ownership from the follow snapshot header and closes the probe', async () => {
    const sockets: Array<{ onopen: (() => void) | null; onmessage: ((event: { data: string }) => void) | null; close: ReturnType<typeof vi.fn> }> = []
    const client = createDshClient({
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body))
        if (body.method === 'session/list') return response({ items: [{ sessionId: 'cold-rp', updatedAt: 1, running: false, blank: false }] })
        return response({ records: [], hasMore: false })
      },
      webSocketFactory: () => {
        const socket: { onopen: (() => void) | null; onmessage: ((event: { data: string }) => void) | null; close: ReturnType<typeof vi.fn> } = { onopen: null, onmessage: null, close: vi.fn() }
        sockets.push(socket)
        queueMicrotask(() => socket.onopen?.())
        const original = socket
        const send = (text: string) => {
          const message = JSON.parse(text)
          if (message.type === 'open' && message.endpoint === 'session/follow') queueMicrotask(() => original.onmessage?.({ data: JSON.stringify({ type: 'item', streamId: message.streamId, value: { type: 'snapshot', header: { id: 'cold-rp', agentPreset: 'zombie-world' }, cursor: -1, records: [], hasMore: false, projections: { asOfSeq: -1, values: {} } } }) }))
        }
        return Object.assign(socket, { send }) as unknown as WebSocket
      },
    })
    expect(await client.listSessions()).toMatchObject([{ sessionId: 'cold-rp', agentPreset: 'zombie-world' }])
    const stop = client.connectStreams(vi.fn())
    stop()
    expect(sockets[0]?.close).toHaveBeenCalled()
  })

  it('exchanges the launch token once and sends only the cookie to Remote HTTP', async () => {
    const requests: Request[] = []
    const client = createDshClient({ baseUrl: 'http://127.0.0.1:3080/?token=secret-canary', fetchImpl: async (url, init) => {
      const request = new Request(url, init)
      requests.push(request)
      if (request.method === 'GET') return new Response(null, { status: 303, headers: { 'set-cookie': 'dsh_session=test; HttpOnly; Path=/', location: '/' } })
      return response({ presets: [] })
    } })
    await Promise.all([client.listPresets(), client.listPresets()])
    expect(requests.filter(request => request.method === 'GET')).toHaveLength(1)
    for (const request of requests.filter(request => request.method === 'POST')) {
      expect(request.headers.get('cookie')).toBe('dsh_session=test')
      expect(request.url).not.toContain('secret-canary')
    }
  })

  it('reads follow snapshots and pages at a fixed cursor, ignoring packed private chunks', async () => {
    const opens: Record<string, unknown>[] = []
    const pages: Record<string, unknown>[] = []
    const event = (seq: number) => ({ type: 'event', event: { seq, time: 1, type: 'user/message', data: {} } })
    const socket = {
      onopen: null as null | (() => void), onmessage: null as null | ((event: { data: string }) => void),
      onclose: null, onerror: null, close: vi.fn(),
      send: (text: string) => {
        const message = JSON.parse(text)
        if (message.type !== 'open') return
        opens.push(message)
        if (message.endpoint === 'session/follow') queueMicrotask(() => socket.onmessage?.({ data: JSON.stringify({ type: 'item', streamId: message.streamId, value: {
          type: 'snapshot', header: { id: 's1' }, cursor: 20, hasMore: true, projections: { asOfSeq: 20, values: {} },
          records: [event(10), { type: 'chunks', event: { seq: 11, time: 1, type: 'chunkrow/reasoning-chunks', data: { texts: ['private'] } } }, event(20)],
        } }) }))
      },
    }
    const client = createDshClient({
      webSocketFactory: () => { queueMicrotask(() => socket.onopen?.()); return socket as unknown as WebSocket },
      fetchImpl: async (_url, init) => { pages.push(JSON.parse(String(init?.body))); return response({ records: [event(0)], hasMore: false }) },
    })
    const stop = client.connectStreams(vi.fn())
    try {
      expect((await client.historyAll('s1')).map(entry => entry.event.seq)).toEqual([0, 10, 20])
      expect(opens).toContainEqual(expect.objectContaining({ endpoint: 'session/follow', payload: { args: { request: { address: { kind: 'session', sessionId: 's1' }, maxMessages: 500 } } } }))
      expect(pages).toEqual([expect.objectContaining({ method: 'session/page', payload: { args: { request: { address: { kind: 'session', sessionId: 's1' }, throughSeq: 20, beforeSeq: 10, maxMessages: 500 } } } })])
    } finally { stop() }
  })
})
