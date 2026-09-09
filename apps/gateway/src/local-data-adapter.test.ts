import { describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { loadDefaultProductStore } from './local-data-adapter.js'
import type { ProductDataStore } from './product-service.js'

describe('local data adapter loading', () => {
  it('creates the real store below the configured DSH home app-data directory', async () => {
    const store = { close: async () => {} } as ProductDataStore
    const createLocalDataStore = vi.fn(async () => store)
    const loaded = await loadDefaultProductStore({ dshHome: 'E:\\Temp\\dsh-test', importModule: async () => ({ createLocalDataStore }) })
    expect(createLocalDataStore).toHaveBeenCalledWith({ dataDir: join('E:\\Temp\\dsh-test', 'app-data') })
    expect(loaded.store).toBe(store)
    expect(loaded.doctor).toBeUndefined()
  })

  it('returns an explicit doctor result when the adapter cannot load', async () => {
    const loaded = await loadDefaultProductStore({ dshHome: 'E:\\Temp\\dsh-test', importModule: async () => { throw new Error('missing') } })
    expect(loaded.store).toBeUndefined()
    expect(loaded.doctor).toMatchObject({ code: 'local-data-load-failed' })
  })
})
