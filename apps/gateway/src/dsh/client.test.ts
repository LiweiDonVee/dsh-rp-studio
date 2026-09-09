import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDshClient } from './client.js'
import { assertLoopbackUrl, DshRpcError, mapDshError, statusForDshError } from './wire.js'

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
    expect(body).toMatchObject({ type: 'client-request', method: 'agentPresets/list', payload: { args: {} } })
    expect(typeof body.rpcId).toBe('string')
  })

  it('creates and renames DSH workspaces and adopts a preallocated session', async () => {
    const requests: Array<Record<string, unknown>> = []
    const client = createDshClient({
      baseUrl: 'http://127.0.0.1:3080',
      fetchImpl: async (input, init) => {
        const request = new Request(input, init)
        const body = await request.json() as Record<string, unknown>
        requests.push(body)
        if (body.method === 'workspace/create') {
          return response({
            workspace: {
              workspaceId: 'workspace-rp-runtime', path: 'C:\\dsh\\rp-workspaces\\rp-runtime',
              title: 'rp-runtime', sessionIds: [], createdAt: '2026-08-19T00:00:00.000Z', updatedAt: '2026-08-19T00:00:00.000Z',
            },
            created: true,
          })
        }
        return response({
          workspace: {
            workspaceId: 'workspace-rp-runtime', path: 'C:\\dsh\\rp-workspaces\\rp-runtime',
              title: 'RP Runtime 基础模板 [rp-runtime]', sessionIds: [], createdAt: '2026-08-19T00:00:00.000Z', updatedAt: '2026-08-19T00:00:00.000Z',
          },
        })
      },
    })

    const created = await client.createWorkspace('C:\\dsh\\rp-workspaces\\rp-runtime')
    await client.renameWorkspace(created.workspace.workspaceId, 'RP Runtime 基础模板 [rp-runtime]')
    await client.createSession({
      sessionId: 'session-rp-1',
      agentPreset: 'rp-runtime',
      workspaceId: created.workspace.workspaceId,
    })

    expect(requests.map(item => ({ method: item.method, payload: (item.payload as { args: { request: unknown } }).args.request }))).toEqual([
      { method: 'workspace/create', payload: { path: 'C:\\dsh\\rp-workspaces\\rp-runtime' } },
      { method: 'workspace/rename', payload: { workspaceId: 'workspace-rp-runtime', title: 'RP Runtime 基础模板 [rp-runtime]' } },
      {
        method: 'session/create',
        payload: { sessionId: 'session-rp-1', agentPreset: 'rp-runtime', workspaceId: 'workspace-rp-runtime' },
      },
    ])
  })

  it('preserves stable DSH business error codes without exposing details', async () => {
    const client = createDshClient({
      baseUrl: 'http://127.0.0.1:3080',
      fetchImpl: async () => new Response(JSON.stringify({
        type: 'server-response',
        rpcId: 'r',
        result: {
          ok: false,
          error: { code: 'agent-busy', message: 'raw active-work detail', details: { reason: 'private' } },
        },
      }), { status: 200 }),
    })
    let caught: unknown
    try { await client.listSessions() } catch (error) { caught = error }
    expect(caught).toBeInstanceOf(DshRpcError)
    expect(caught).toMatchObject({ code: 'agent-busy' })
    const mapped = mapDshError(caught)
    expect(mapped).toEqual({ code: 'agent-busy', message: '当前回合仍在运行，请等待它完成。', upstreamCode: 'agent-busy' })
    expect(statusForDshError(mapped)).toBe(409)
    expect(JSON.stringify(mapped)).not.toContain('private')
    expect(JSON.stringify(mapped)).not.toContain('raw active-work detail')
  })

  it('distinguishes unavailable and malformed upstream responses', async () => {
    const unavailable = createDshClient({
      baseUrl: 'http://127.0.0.1:3080',
      fetchImpl: async () => { throw new Error('ECONNREFUSED C:\\private\\socket') },
    })
    await expect(unavailable.hostDescribe()).rejects.toThrow('DSH request failed')

    const malformed = createDshClient({
      baseUrl: 'http://127.0.0.1:3080',
      fetchImpl: async () => new Response(JSON.stringify({ type: 'wrong' }), { status: 200 }),
    })
    await expect(malformed.hostDescribe()).rejects.toThrow('invalid DSH server-response')
  })

  it('fails closed for non-loopback upstreams', () => {
    expect(() => assertLoopbackUrl('http://[::1]:3080')).not.toThrow()
    expect(() => assertLoopbackUrl('https://example.com')).toThrow('loopback')
    expect(() => assertLoopbackUrl('http://192.168.1.2:3080')).toThrow('loopback')
  })

  it.each([
    ['session/agent-busy', 'agent-busy', 409],
    ['session/not-found', 'not-found', 404],
    ['agent-preset/invalid', 'card-unavailable', 409],
    ['gateway/bad-request', 'bad-request', 400],
  ])('maps RemoteError %s without exposing its details', async (code, publicCode, status) => {
    const client = createDshClient({ fetchImpl: async () => new Response(JSON.stringify({
      type: 'server-response', rpcId: 'r', result: { ok: false, error: { code, message: 'secret-canary', details: { token: 'secret-canary' } } },
    })) })
    let caught: unknown
    try { await client.hostDescribe() } catch (error) { caught = error }
    const mapped = mapDshError(caught)
    expect(mapped.code).toBe(publicCode)
    expect(statusForDshError(mapped)).toBe(status)
    expect(JSON.stringify(mapped)).not.toContain('secret-canary')
  })

  it('reopens logical streams on a single reconnecting Remote mux and stops retries', async () => {
    vi.useFakeTimers()
    const sockets: Array<{
      onopen: (() => void) | null; onclose: (() => void) | null
      send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>
    }> = []
    const client = createDshClient({ webSocketFactory: () => {
      const socket = { onopen: null, onclose: null, send: vi.fn(), close: vi.fn() }
      sockets.push(socket)
      return socket as unknown as WebSocket
    } })
    const onClose = vi.fn()
    const onOpen = vi.fn()
    const stop = client.connectStreams(vi.fn(), onClose, onOpen)
    await vi.advanceTimersByTimeAsync(0)
    expect(sockets).toHaveLength(1)
    sockets[0]!.onopen?.()
    expect(sockets[0]!.send.mock.calls.map(call => JSON.parse(call[0]).endpoint)).toEqual(['session/control', '$events'])
    sockets[0]!.onclose?.()
    expect(onClose).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(250)
    expect(sockets).toHaveLength(2)
    sockets[1]!.onopen?.()
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(sockets[1]!.send).toHaveBeenCalledTimes(2)
    stop()
    sockets[1]!.onclose?.()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(sockets).toHaveLength(2)
  })
})
