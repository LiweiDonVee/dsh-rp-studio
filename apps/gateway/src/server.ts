import { readFile, stat } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { failureEnvelope } from '@dsh-rp/protocol'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { buildApp } from './app.js'
import { createDshClient } from './dsh/client.js'
import { SessionService } from './session-service.js'
import { createPromptPresetsClient } from './prompt-presets-client.js'
import { ProductService, type ProductDataStore } from './product-service.js'
import { loadDefaultProductStore, type ProductStoreLoadResult } from './local-data-adapter.js'
import { startPairingListener, type PairingListenerOptions } from './pairing-listener.js'
import { loadPairingConfig, type PairingConfig } from './pairing-config.js'

const MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
}

export interface ServerOptions {
  host?: string
  port?: number
  dshUrl?: string
  dshHome?: string
  publicDir?: string
  promptPresetsUrl?: string
  productStore?: ProductDataStore
  pairingEnabled?: boolean
  pairingWriteScopes?: import('@dsh-rp/protocol').PairingScope[]
  dataRoot?: string
  productStoreFactory?: (options: { dshHome?: string; dataRoot?: string }) => Promise<ProductStoreLoadResult>
  pairingListener?: Omit<PairingListenerOptions, 'product'>
  pairingConfig?: PairingConfig
}

function loopbackHostname(value: string): boolean {
  return ['127.0.0.1', 'localhost', '::1'].includes(value.toLowerCase().replace(/^\[|\]$/gu, ''))
}

function isInside(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
}

async function sendFile(reply: FastifyReply, filePath: string, cache: boolean): Promise<void> {
  const info = await stat(filePath)
  if (!info.isFile()) throw new Error('not a file')
  reply
    .header('cache-control', cache ? 'public, max-age=31536000, immutable' : 'no-cache')
    .type(MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream')
    .send(await readFile(filePath))
}

export function registerStaticApp(app: FastifyInstance, publicDir: string): void {
  const root = resolve(publicDir)
  const indexPath = resolve(root, 'index.html')

  app.setNotFoundHandler(async (request, reply) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname
    if (pathname.startsWith('/api/')) {
      return reply.code(404).send(failureEnvelope({ code: 'not-found', message: '找不到该 RP Gateway 路由。' }))
    }

    let requested = indexPath
    try {
      requested = resolve(root, decodeURIComponent(pathname).replace(/^\/+/, ''))
      if (!isInside(root, requested)) requested = indexPath
      await sendFile(reply, requested, pathname.startsWith('/assets/'))
    } catch {
      try {
        await sendFile(reply, indexPath, false)
      } catch {
        return reply.code(503).type('text/plain; charset=utf-8').send('DSH RP Studio 尚未构建。')
      }
    }
  })
}

export async function startServer(options: ServerOptions = {}): Promise<{
  app: FastifyInstance
  service: SessionService
  url: string
}> {
  const host = options.host ?? process.env.DSH_RP_HOST ?? '127.0.0.1'
  if (!loopbackHostname(host)) {
    throw new Error('DSH RP Studio must bind to a loopback host')
  }
  const port = options.port ?? Number(process.env.DSH_RP_PORT ?? 4317)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('Invalid DSH RP Studio port')

  const dsh = createDshClient({ baseUrl: options.dshUrl ?? process.env.DSH_BASE_URL ?? 'http://127.0.0.1:3080' })
  const dshHome = options.dshHome ?? process.env.DSH_HOME
  const promptPresetsUrl = options.promptPresetsUrl ?? process.env.PROMPT_PRESETS_BASE_URL
  const service = new SessionService({
    dsh,
    promptPresets: createPromptPresetsClient(promptPresetsUrl ? { baseUrl: promptPresetsUrl } : {}),
    ...(dshHome ? { dshHome } : {}),
  })
  const runtimeConfig = options.pairingConfig ?? await loadPairingConfig(process.env.DSH_RP_RUNTIME_CONFIG)
  const configuredPairing = runtimeConfig ? {
    host: runtimeConfig.host,
    port: runtimeConfig.port,
    allowedOrigins: runtimeConfig.allowedOrigins,
    cert: await readFile(runtimeConfig.certFile),
    key: await readFile(runtimeConfig.keyFile),
    ...(runtimeConfig.companionDir ? { companionDir: runtimeConfig.companionDir } : {}),
  } : options.pairingListener
  const loadedStore = options.productStore
    ? { store: options.productStore }
    : await (options.productStoreFactory ?? loadDefaultProductStore)({ ...(dshHome ? { dshHome } : {}), ...(options.dataRoot ? { dataRoot: options.dataRoot } : {}) })
  const product = new ProductService({ sessions: service, ...(loadedStore.store ? { store: loadedStore.store } : {}), ...(loadedStore.doctor ? { doctor: loadedStore.doctor } : {}), pairingEnabled: runtimeConfig?.enabled ?? options.pairingEnabled ?? false, ...(runtimeConfig ? { pairingWriteScopes: runtimeConfig.writeScopes } : options.pairingWriteScopes ? { pairingWriteScopes: options.pairingWriteScopes } : {}), ...(configuredPairing ? { pairingListener: 'https-lan' as const } : {}) })
  const app = buildApp({ api: service, product })
  app.addHook('onRequest', async (request, reply) => {
    const requestHost = request.headers.host
    let hostUrl: URL
    try {
      hostUrl = new URL(`http://${requestHost ?? ''}`)
    } catch {
      return reply.code(421).send(failureEnvelope({ code: 'bad-request', message: '请求主机无效。' }))
    }
    if (!loopbackHostname(hostUrl.hostname)) {
      return reply.code(421).send(failureEnvelope({ code: 'bad-request', message: '请求主机无效。' }))
    }
    const origin = request.headers.origin
    if (origin && !['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      let originUrl: URL
      try {
        originUrl = new URL(origin)
      } catch {
        return reply.code(403).send(failureEnvelope({ code: 'bad-request', message: '请求来源无效。' }))
      }
      if (originUrl.protocol !== 'http:' || originUrl.host.toLowerCase() !== hostUrl.host.toLowerCase()) {
        return reply.code(403).send(failureEnvelope({ code: 'bad-request', message: '请求来源无效。' }))
      }
    }
  })
  const defaultPublicDir = fileURLToPath(new URL('../../web/dist/', import.meta.url))
  registerStaticApp(app, options.publicDir ?? process.env.DSH_RP_WEB_DIST ?? defaultPublicDir)
  let pairingApp: FastifyInstance | undefined
  app.addHook('onClose', async () => { if (pairingApp) await pairingApp.close(); service.stop(); await product.close() })

  await service.start()
  await product.start()
  await app.listen({ host, port })
  try {
    if (configuredPairing) pairingApp = (await startPairingListener({ ...configuredPairing, product })).app
  } catch (error) {
    await app.close()
    throw error
  }
  const displayHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  return { app, service, url: `http://${displayHost}:${port}` }
}

const launchedDirectly = process.argv[1] !== undefined
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))

if (launchedDirectly) {
  startServer().then(({ url }) => {
    process.stdout.write(`DSH RP Studio: ${url}\n`)
  }).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
