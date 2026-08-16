import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { registerStaticApp } from './server.js'

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
})
