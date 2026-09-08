import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { registerStaticApp, startServer } from './server.js'

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolveListen())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test server has no TCP port')
  return address.port
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()))
}

const apps: ReturnType<typeof Fastify>[] = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()))
})

describe('production static app', () => {
  it('serves hashed assets, SPA deep links, and JSON API misses', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-rp-web-'))
    await mkdir(join(root, 'assets'))
    await writeFile(join(root, 'index.html'), '<main>RP STUDIO</main>')
    await writeFile(join(root, 'assets', 'app.js'), 'window.STUDIO = true')
    const app = Fastify()
    apps.push(app)
    registerStaticApp(app, root)

    const asset = await app.inject({ method: 'GET', url: '/assets/app.js' })
    expect(asset.statusCode).toBe(200)
    expect(asset.headers['cache-control']).toContain('immutable')
    expect(asset.body).toContain('STUDIO')

    const deepLink = await app.inject({ method: 'GET', url: '/campaign/session-1' })
    expect(deepLink.statusCode).toBe(200)
    expect(deepLink.body).toContain('RP STUDIO')

    const apiMiss = await app.inject({ method: 'GET', url: '/api/v1/not-real' })
    expect(apiMiss.statusCode).toBe(404)
    expect(apiMiss.json()).toMatchObject({ ok: false, protocolVersion: 1, error: { code: 'not-found' } })
  })

  it('rejects non-loopback binding before creating a server', async () => {
    await expect(startServer({ host: '0.0.0.0', port: 4317 })).rejects.toThrow('loopback')
  })

  it('rejects non-loopback host headers and cross-origin writes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-rp-host-'))
    await writeFile(join(root, 'index.html'), '<main>LOCAL ONLY</main>')
    const reserved = createServer()
    const dshPort = await listen(reserved)
    await close(reserved)
    const portProbe = createServer()
    const port = await listen(portProbe)
    await close(portProbe)
    const result = await startServer({ host: '127.0.0.1', port, dshUrl: `http://127.0.0.1:${dshPort}`, dshHome: root, publicDir: root })
    apps.push(result.app)

    const rebound = await result.app.inject({ method: 'GET', url: '/', headers: { host: 'attacker.example' } })
    expect(rebound.statusCode).toBe(421)
    const crossOrigin = await result.app.inject({
      method: 'POST',
      url: '/api/v1/sessions/session-1/cancel',
      headers: { host: `127.0.0.1:${port}`, origin: 'http://attacker.example' },
      payload: {},
    })
    expect(crossOrigin.statusCode).toBe(403)
  })

  it('keeps the built shell available while DSH is unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-rp-shell-'))
    await writeFile(join(root, 'index.html'), '<main>OFFLINE SHELL</main>')
    const reserved = createServer()
    const dshPort = await listen(reserved)
    await close(reserved)
    const portProbe = createServer()
    const port = await listen(portProbe)
    await close(portProbe)
    const result = await startServer({ host: '127.0.0.1', port, dshUrl: `http://127.0.0.1:${dshPort}`, dshHome: root, publicDir: root })
    apps.push(result.app)
    const health = await fetch(`${result.url}/api/v1/health`)
    expect(health.status).toBe(503)
    expect(await health.json()).toMatchObject({ ok: false, error: { code: 'upstream-unavailable' } })
    const shell = await fetch(`${result.url}/campaign/offline`)
    expect(shell.status).toBe(200)
    expect(await shell.text()).toContain('OFFLINE SHELL')
  })

})
