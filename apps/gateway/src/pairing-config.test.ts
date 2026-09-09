import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadPairingConfig } from './pairing-config.js'

const directories: string[] = []
afterEach(async () => Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))))

describe('main-only pairing configuration', () => {
  it('resolves certificate, key, and companion paths relative to the config file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-pairing-config-'))
    directories.push(root)
    const path = join(root, 'pairing.json')
    await mkdir(join(root, 'tls'))
    await writeFile(join(root, 'tls', 'cert.pem'), 'certificate')
    await writeFile(join(root, 'tls', 'key.pem'), 'private key')
    await writeFile(path, JSON.stringify({ enabled: true, host: '192.168.1.7', port: 4319, allowedOrigins: ['https://phone.example'], certFile: 'tls/cert.pem', keyFile: 'tls/key.pem', companionDir: '../web/dist', writeScopes: ['ledger:write'] }))
    await expect(loadPairingConfig(path)).resolves.toEqual({ enabled: true, host: '192.168.1.7', port: 4319, allowedOrigins: ['https://phone.example'], certFile: join(root, 'tls/cert.pem'), keyFile: join(root, 'tls/key.pem'), companionDir: join(root, '..', 'web/dist'), writeScopes: ['ledger:write'] })
  })

  it('rejects disabled, wildcard, non-HTTPS, and unknown configuration values', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-pairing-config-invalid-'))
    directories.push(root)
    const path = join(root, 'pairing.json')
    await writeFile(path, JSON.stringify({ enabled: false, host: '0.0.0.0', port: 4319, allowedOrigins: ['http://phone.example'], certFile: 'cert', keyFile: 'key', unexpected: true }))
    await expect(loadPairingConfig(path)).rejects.toThrow()
  })
})
