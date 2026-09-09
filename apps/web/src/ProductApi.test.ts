import { describe, expect, it, vi } from 'vitest'
import { ProductApi, ProductApiError } from './ProductApi.js'

const scope = 'session-1'
const status = {
  apiVersion: 1 as const,
  dshCompatibility: '0.1.2-rc.1' as const,
  storage: 'ready' as const,
  schemaVersion: 1,
  projection: 'current' as const,
  pairing: { enabled: true, listener: 'https-lan' as const },
}

function response(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify({ ok: true, protocolVersion: 1, data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })
}

describe('ProductApi', () => {
  it('parses the strict product envelope and scopes collection calls to a session', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ items: [], nextCursor: null }))
    const product = new ProductApi(fetcher)

    await expect(product.knowledge(scope)).resolves.toEqual({ items: [], nextCursor: null })
    expect(fetcher.mock.calls[0]?.[0]).toBe('/api/v1/product/knowledge?sessionId=session-1&limit=20')
    const headers = fetcher.mock.calls[0]?.[1]?.headers
    expect(headers).toBeInstanceOf(Headers)
    expect((headers as Headers).get('accept')).toBe('application/json')
  })

  it('surfaces the contract error code for unavailable storage and rejects malformed DTOs', async () => {
    const unavailable = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      ok: false, protocolVersion: 1, error: { code: 'storage-unavailable', message: '本地产品数据服务尚未就绪。' },
    }), { status: 503, headers: { 'content-type': 'application/json' } }))
    await expect(new ProductApi(unavailable).status()).rejects.toMatchObject({ code: 'storage-unavailable', status: 503 })

    const malformed = vi.fn<typeof fetch>().mockResolvedValue(response({ unexpected: true }))
    await expect(new ProductApi(malformed).status()).rejects.toBeInstanceOf(ProductApiError)
  })

  it('rejects unsafe asset files before a request and enforces the 10 MiB decoded limit', async () => {
    const fetcher = vi.fn<typeof fetch>()
    const product = new ProductApi(fetcher)
    const oversized = new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'big.png', { type: 'image/png' })
    const svg = new File(['<svg></svg>'], 'icon.svg', { type: 'image/svg+xml' })

    await expect(product.uploadAsset(scope, oversized, 'portrait')).rejects.toMatchObject({ code: 'payload-too-large' })
    await expect(product.uploadAsset(scope, svg, 'portrait')).rejects.toMatchObject({ code: 'unsupported-media-type' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('keeps restore two-phase and never persists a bearer token', async () => {
    const restoreToken = 'restore-token-that-is-long-enough'
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(status))
      .mockResolvedValueOnce(response({ backupId: 'b1', restoreToken, expiresAt: '2026-09-08T12:00:00.000Z', manifestHash: 'sha256:' + 'a'.repeat(64) }))
      .mockResolvedValueOnce(response({ restored: true, rollbackBackupId: 'b2' }))
    const product = new ProductApi(fetcher)

    await product.status()
    const staged = await product.stageRestore(scope, 'b1')
    await expect(product.commitRestore(scope, staged.backupId, staged.restoreToken)).resolves.toEqual({ restored: true, rollbackBackupId: 'b2' })
    expect(fetcher.mock.calls[1]?.[0]).toContain('/stage-restore')
    expect(fetcher.mock.calls[2]?.[0]).toContain('/commit-restore')
    expect(JSON.stringify(fetcher.mock.calls)).toContain(restoreToken)
    expect(localStorage.getItem('restoreToken')).toBeNull()
  })

  it('uses an in-memory bearer and exposes revoked/expired authentication as unauthorized', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ clientId: 'client-1', token: 'a'.repeat(48), scopes: ['product:read'], sessionIds: ['session-1'], expiresAt: '2026-09-08T12:00:00.000Z' }))
    const product = new ProductApi(fetcher).withBearer('a'.repeat(48))
    await product.confirmPairing('code-code-code-code-code', 'companion')
    const headers = fetcher.mock.calls[0]?.[1]?.headers as Headers
    expect(headers.get('authorization')).toBe('Bearer ' + 'a'.repeat(48))
    expect(localStorage.length).toBe(0)

    const revoked = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      ok: false, protocolVersion: 1, error: { code: 'unauthorized', message: '移动端认证无效。' },
    }), { status: 401, headers: { 'content-type': 'application/json' } }))
    await expect(new ProductApi(revoked).withBearer('b'.repeat(48)).status()).rejects.toMatchObject({ code: 'unauthorized' })
  })

  it('reconnects notification fetch with the last cursor and clears revoked bearer authentication', async () => {
    vi.useFakeTimers()
    const notification = { id: 'n1', cursor: 'cursor-1', type: 'story', title: '更新', body: '内容', createdAt: '2026-09-08T12:00:00.000Z', acknowledged: false }
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(`id: cursor-1\nevent: notification\ndata: ${JSON.stringify(notification)}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, protocolVersion: 1, error: { code: 'unauthorized', message: '已撤销' } }), { status: 401, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(response(status))
    const product = new ProductApi(fetcher).withBearer('a'.repeat(48)); const events: unknown[] = []; const errors: ProductApiError[] = []
    const stop = product.subscribeNotifications(scope, event => events.push(event), error => errors.push(error))
    await vi.advanceTimersByTimeAsync(600)
    expect(events).toHaveLength(1)
    expect(fetcher.mock.calls[1]?.[0]).toContain('cursor=cursor-1')
    expect(errors[0]?.code).toBe('unauthorized')
    await product.status()
    const headers = fetcher.mock.calls[2]?.[1]?.headers
    expect(headers).toBeInstanceOf(Headers)
    expect((headers as Headers).has('authorization')).toBe(false)
    stop(); vi.useRealTimers()
  })
})
