import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createPathSelectionVault, createSettingsStore, type DesktopSettings } from '../src/main/settings.js'

const directories: string[] = []
afterEach(async () => Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))))

function settings(): DesktopSettings {
  return {
    nodeExecutable: 'C:/运行时/node.exe', dshBin: 'C:/运行时/dsh.js', gatewayEntry: 'C:/运行时/gateway.js',
    dshHome: 'C:/用户/档案', dshPort: 0, studioPort: 0, runtimeRoot: 'C:/运行时',
  }
}

describe('desktop settings persistence', () => {
  it('encrypts settings atomically and reloads them after restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'desktop-settings-'))
    directories.push(directory)
    const safeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(`encrypted:${value}`, 'utf8'),
      decryptString: (value: Buffer) => value.toString('utf8').replace(/^encrypted:/u, ''),
    }
    await createSettingsStore(directory, safeStorage).save(settings())

    await expect(createSettingsStore(directory, safeStorage).load()).resolves.toEqual(settings())
    expect(await readFile(join(directory, 'desktop-settings.v1.json'), 'utf8')).not.toContain('node.exe')
  })

  it('uses validated secret-free JSON when operating system encryption is unavailable', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'desktop-settings-'))
    directories.push(directory)
    const safeStorage = { isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => '' }
    await createSettingsStore(directory, safeStorage).save(settings())

    await expect(createSettingsStore(directory, safeStorage).load()).resolves.toEqual(settings())
    expect(JSON.parse(await readFile(join(directory, 'desktop-settings.v1.json'), 'utf8'))).toMatchObject({ version: 1, encrypted: false, settings: settings() })
  })

  it('exposes only opaque ids and display labels while rejecting forged selections', () => {
    const vault = createPathSelectionVault()
    const exposed = vault.expose(settings())

    expect(JSON.stringify(exposed)).not.toContain('C:/运行时')
    expect(exposed.selections.nodeExecutable?.label).toBe('node.exe')
    expect(() => vault.consume(settings(), { nodeExecutable: '00000000-0000-4000-8000-000000000099' }, 0, 0)).toThrow()
  })
})
