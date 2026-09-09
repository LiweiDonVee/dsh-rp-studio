import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizePairingPath, pairingHostMatches, pairingRoutePolicy, readCompanionBuildFile, startPairingListener } from './pairing-listener.js'
import { ProductService } from './product-service.js'
import { pairingCertificate, pairingPrivateKey } from './test-fixtures/pairing-certificate.js'

const sessions = { session: async () => { throw new Error('not owned') } }
const product = new ProductService({ sessions, pairingEnabled: true })

describe('pairing listener boundaries', () => {
  it('rejects wildcard binding before creating a listener', async () => {
    await expect(startPairingListener({ product, host: '0.0.0.0', port: 43_17, cert: 'cert', key: 'key', allowedOrigins: ['https://phone.example'] })).rejects.toThrow('explicit LAN host')
  })

  it('requires TLS and an explicit origin allowlist', async () => {
    await expect(startPairingListener({ product, host: '192.168.1.2', port: 43_17, cert: '', key: 'key', allowedOrigins: [] })).rejects.toThrow('TLS certificate')
  })

  it('refuses to start when pairing is disabled', async () => {
    const disabled = new ProductService({ sessions, pairingEnabled: false })
    await expect(startPairingListener({ product: disabled, host: '192.168.1.2', port: 43_17, cert: 'cert', key: 'key', allowedOrigins: ['https://phone.example'] })).rejects.toThrow('enabled')
  })

  it('uses an exact remote method and route allowlist', () => {
    expect(pairingRoutePolicy('GET', '/api/v1/product/bootstrap')).toBe('product:read')
    expect(pairingRoutePolicy('GET', '/api/v1/product/backups')).toBe('forbidden')
    expect(pairingRoutePolicy('POST', '/api/v1/product/backups/backup-1/commit-restore')).toBe('forbidden')
    expect(pairingRoutePolicy('GET', '/api/v1/product/pairing/clients')).toBe('forbidden')
    expect(pairingRoutePolicy('POST', '/api/v1/product/notifications/n-1/ack')).toBe('notifications:ack')
  })

  it('parses IPv6 host headers without splitting on colons', () => {
    expect(pairingHostMatches('[fd00::7]:4319', 'fd00::7')).toBe(true)
    expect(pairingHostMatches('[fd00::8]:4319', 'fd00::7')).toBe(false)
  })

  it('decodes each path segment once for hash IDs and rejects encoded separators', () => {
    const asset = normalizePairingPath(`/api/v1/product/assets/${encodeURIComponent(`sha256:${'a'.repeat(64)}`)}`)
    expect(asset).toBe(`/api/v1/product/assets/sha256:${'a'.repeat(64)}`)
    expect(pairingRoutePolicy('GET', asset!)).toBe('product:read')
    expect(normalizePairingPath('/api/v1/product/assets/sha256%252Fescape')).toBe('/api/v1/product/assets/sha256%2Fescape')
    expect(normalizePairingPath('/api/v1/product/assets/sha256%2Fescape')).toBeUndefined()
  })

  it('serves only the real Vite index and hashed asset files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-companion-'))
    await mkdir(join(root, 'assets'))
    await writeFile(join(root, 'index.html'), '<div id="root"></div><script src="/assets/index-AbC123xy.js"></script>')
    await writeFile(join(root, 'assets', 'index-AbC123xy.js'), 'window.companion=true')
    expect((await readCompanionBuildFile(root, 'index.html')).contentType).toContain('text/html')
    expect((await readCompanionBuildFile(root, 'assets/index-AbC123xy.js')).immutable).toBe(true)
    await expect(readCompanionBuildFile(root, 'assets/index.js')).rejects.toMatchObject({ statusCode: 404 })
    await expect(readCompanionBuildFile(root, '../secret.txt')).rejects.toMatchObject({ statusCode: 404 })
  })

  it('redirects the HTTPS root to the companion pathname used by the shared React build', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-companion-redirect-'))
    await mkdir(join(root, 'assets'))
    await writeFile(join(root, 'index.html'), '<div id="root"></div>')
    const app = (await import('./pairing-listener.js')).buildPairingApp({ product, host: '127.0.0.1', port: 4319, cert: pairingCertificate, key: pairingPrivateKey, allowedOrigins: ['https://phone.example'], companionDir: root })
    const response = await app.inject({ method: 'GET', url: '/', headers: { host: '127.0.0.1:4319' } })
    await app.close()
    expect(response.statusCode).toBe(302)
    expect(response.headers.location).toBe('/companion')
  })
})
