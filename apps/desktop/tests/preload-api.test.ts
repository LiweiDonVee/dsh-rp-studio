import { describe, expect, it, vi } from 'vitest'
import { createDesktopApi } from '../src/preload/api.js'

describe('preload API', () => {
  it('exposes named operations and validates request and response schemas', async () => {
    const invoke = vi.fn(async () => ({ state: 'stopped', processes: {} }))
    const api = createDesktopApi(invoke)

    await expect(api.status()).resolves.toEqual({ state: 'stopped', processes: {} })
    expect(invoke).toHaveBeenCalledWith('desktop:request', { type: 'status' })
    await expect(api.importAsset('')).rejects.toThrow()
  })

  it('rejects a main-process response containing secret fields', async () => {
    const api = createDesktopApi(async () => ({ state: 'running', processes: {}, token: 'secret' }))

    await expect(api.status()).rejects.toThrow()
  })
})
