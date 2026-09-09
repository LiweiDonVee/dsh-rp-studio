import { describe, expect, it, vi } from 'vitest'
import { PairingManager } from './pairing.js'

describe('mobile pairing', () => {
  it('uses a one-time code and stores only the token hash', async () => {
    const save = vi.fn(async () => {})
    const manager = new PairingManager({ enabled: true, saveToken: save, now: () => 1_000 })
    const issued = manager.createCode({ clientName: '手机', requestedScopes: ['product:read', 'ledger:write'], sessionIds: ['会话-7'] })
    const paired = await manager.confirm({ code: issued.code, clientName: '手机' }, '192.168.1.9')
    expect(paired.token).toMatch(/^[A-Za-z0-9_-]{40,}$/u)
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ tokenHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u), scopes: ['product:read'], sessionIds: ['会话-7'] }))
    expect(JSON.stringify(save.mock.calls)).not.toContain(paired.token)
    await expect(manager.confirm({ code: issued.code, clientName: '手机' }, '192.168.1.9')).rejects.toMatchObject({ statusCode: 401 })
  })

  it('expires codes and rate limits repeated confirmation attempts', async () => {
    let now = 5_000
    const manager = new PairingManager({ enabled: true, saveToken: async () => {}, now: () => now, maxAttempts: 2, codeTtlMs: 100 })
    const expired = manager.createCode({ clientName: 'tablet', requestedScopes: ['product:read'], sessionIds: ['session-1'] })
    now += 101
    await expect(manager.confirm({ code: expired.code, clientName: 'tablet' }, '10.0.0.2')).rejects.toMatchObject({ statusCode: 401 })
    await expect(manager.confirm({ code: 'invalid-code-0000', clientName: 'tablet' }, '10.0.0.3')).rejects.toMatchObject({ statusCode: 401 })
    await expect(manager.confirm({ code: 'invalid-code-0001', clientName: 'tablet' }, '10.0.0.3')).rejects.toMatchObject({ statusCode: 429 })
  })

  it('stays disabled unless explicitly enabled', () => {
    const manager = new PairingManager({ enabled: false, saveToken: async () => {} })
    expect(() => manager.createCode({ clientName: 'phone', requestedScopes: ['product:read'], sessionIds: ['session-1'] })).toThrow()
    return expect(manager.confirm({ code: 'disabled-code-000000000', clientName: 'phone' }, '127.0.0.1')).rejects.toMatchObject({ statusCode: 403 })
  })
})
