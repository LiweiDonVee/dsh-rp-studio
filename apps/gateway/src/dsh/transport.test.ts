import { createServer } from 'node:http'
import { once } from 'node:events'
import { WebSocketServer } from 'ws'
import { describe, expect, it, vi } from 'vitest'
import { createDshClient, type DshStreamFrame } from './client.js'
import { mapDshError } from './wire.js'

describe('authenticated HTTP and WebSocket transport', () => {
  it('exchanges a server-only cookie, reads workspace baselines, and follows live messages', async () => {
    const requests: Array<{ path: string; cookie?: string }> = []
    const server = createServer((request, response) => {
      requests.push({ path: request.url!, ...(request.headers.cookie ? { cookie: request.headers.cookie } : {}) })
      if (request.url === '/?token=server-only-canary') {
        response.writeHead(303, { location: '/', 'set-cookie': 'dsh_session=authorized; Path=/; HttpOnly; SameSite=Strict' }).end()
        return
      }
      if (request.headers.cookie !== 'dsh_session=authorized') { response.writeHead(401).end(); return }
      let body = ''
      request.on('data', chunk => { body += String(chunk) })
      request.on('end', () => {
        const rpc = JSON.parse(body)
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ type: 'server-response', rpcId: rpc.rpcId, result: { ok: true, value: { presets: [] } } }))
      })
    })
    const wsServer = new WebSocketServer({ noServer: true })
    server.on('upgrade', (request, socket, head) => {
      requests.push({ path: request.url!, ...(request.headers.cookie ? { cookie: request.headers.cookie } : {}) })
      if (request.url !== '/api/remote.mux' || request.headers.cookie !== 'dsh_session=authorized') { socket.destroy(); return }
      wsServer.handleUpgrade(request, socket, head, ws => wsServer.emit('connection', ws))
    })
    wsServer.on('connection', socket => socket.on('message', data => {
      const message = JSON.parse(String(data))
      if (message.type !== 'open') return
      const send = (value: unknown) => socket.send(JSON.stringify({ type: 'item', streamId: message.streamId, value }))
      if (message.endpoint === 'workspace/follow') send({ type: 'baseline', value: { items: [], archivedSessionIds: ['archived'] } })
      if (message.endpoint === 'session/follow') {
        send({ type: 'snapshot', header: { id: 's1' }, cursor: -1, records: [], hasMore: false, projections: { asOfSeq: -1, values: {} } })
        send({ type: 'event', event: { seq: 0, time: 1, type: 'assistant/chunk', data: { turn: 1, step: 0, chunk: { type: 'text-delta', text: 'hello' } } } })
      }
    }))
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test server address unavailable')
    const frames: DshStreamFrame[] = []
    const client = createDshClient({ baseUrl: `http://127.0.0.1:${address.port}/?token=server-only-canary` })
    const stop = client.connectStreams(frame => frames.push(frame))
    try {
      await expect(client.listPresets()).resolves.toEqual([])
      await expect(client.listWorkspaces()).resolves.toEqual({ items: [], archivedSessionIds: ['archived'] })
      await expect(client.historyAll('s1')).resolves.toEqual([])
      await vi.waitFor(() => expect(frames).toContainEqual(expect.objectContaining({ type: 'session/event', sessionId: 's1' })))
      expect(requests.filter(request => request.path.startsWith('/?token='))).toHaveLength(1)
      expect(requests.filter(request => request.path.startsWith('/api/')).every(request => request.cookie === 'dsh_session=authorized')).toBe(true)
      expect(JSON.stringify(frames)).not.toContain('server-only-canary')
    } finally {
      stop()
      for (const socket of wsServer.clients) socket.terminate()
      wsServer.close()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it('reports missing Web authentication without relaying the upstream body', async () => {
    const client = createDshClient({ fetchImpl: async () => new Response('secret-canary', { status: 401 }) })
    let caught: unknown
    try { await client.hostDescribe() } catch (error) { caught = error }
    expect(mapDshError(caught)).toMatchObject({ code: 'upstream-unavailable', upstreamCode: 'authentication-required' })
    expect(JSON.stringify(mapDshError(caught))).not.toContain('secret-canary')
  })
})
