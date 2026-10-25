import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import Fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { registerStaticApp, startServer } from './server.js'

const execFileAsync = promisify(execFile)
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const launcherPortProbe = join(projectRoot, 'scripts', 'launcher-ports.mjs')

async function listen(server: Server, port = 0): Promise<number> {
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolveListen())
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

  it('selects another loopback port when the preferred launcher port is occupied', async () => {
    const blocker = createServer((_request, response) => {
      response.statusCode = 404
      response.end('occupied')
    })
    const occupiedPort = await listen(blocker)
    try {
      const { stdout } = await execFileAsync(process.execPath, [launcherPortProbe, String(occupiedPort), '3080', '3091'], { cwd: projectRoot, timeout: 10_000 })
      const result = JSON.parse(stdout.trim().split(/\r?\n/u).at(-1) ?? '{}') as {
        studioUrl?: string
        dshUrl?: string
        promptPresetsUrl?: string
        existing?: boolean
      }
      expect(result.existing).toBe(false)
      expect(result.dshUrl).toBe('http://127.0.0.1:3080')
      expect(result.promptPresetsUrl).toBe('http://127.0.0.1:3091/prompt-presets/api')
      expect(result.studioUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u)
      expect(result.studioUrl).not.toBe(`http://127.0.0.1:${occupiedPort}`)
    } finally {
      await close(blocker)
    }
  }, 15_000)

  it.each([0, 6000])('reuses an existing Studio without changing launcher upstream ports (requested port %i)', async requestedPort => {
    const healthRequests: string[] = []
    const existing = createServer((request, response) => {
      healthRequests.push(request.url ?? '')
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ protocolVersion: 1 }))
    })
    const port = await listen(existing, requestedPort)
    try {
      const { stdout } = await execFileAsync(process.execPath, [launcherPortProbe, String(port), '3082', '3093'], { cwd: projectRoot, timeout: 10_000 })
      expect(JSON.parse(stdout)).toEqual({
        studioUrl: `http://127.0.0.1:${port}`,
        dshUrl: 'http://127.0.0.1:3082',
        promptPresetsUrl: 'http://127.0.0.1:3093/prompt-presets/api',
        existing: true,
      })
      expect(healthRequests).toEqual(['/api/v1/health'])
    } finally {
      await close(existing)
    }
  })
})
