import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import { readFile, realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { failureEnvelope, type PairingScope } from '@dsh-rp/protocol'
import { GatewayError } from './errors.js'
import { ProductService } from './product-service.js'
import { registerProductRoutes } from './product-routes.js'

export interface PairingListenerOptions {
  product: ProductService
  host: string
  port: number
  cert: string | Buffer
  key: string | Buffer
  allowedOrigins: string[]
  companionDir?: string
}

type RemotePolicy = 'public' | 'forbidden' | PairingScope

const companionMimeTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8', '.gif': 'image/gif', '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2',
}
const hashedCompanionAsset = /^[A-Za-z0-9_-]+-[A-Za-z0-9_-]{6,}\.(?:css|gif|jpeg|jpg|js|png|webp|woff2)$/u

function normalizeHostname(raw: string): string {
  return raw.toLowerCase().replace(/^\[|\]$/gu, '')
}

function validateOptions(options: PairingListenerOptions): void {
  if (!options.product.pairingStatus().enabled) throw new Error('Pairing listener requires pairing to be enabled')
  if (!options.cert || !options.key || options.allowedOrigins.length === 0) throw new Error('Pairing listener requires TLS certificate, private key, and allowed origins')
  if (['0.0.0.0', '::', '[::]'].includes(options.host)) throw new Error('Pairing listener must use an explicit LAN host')
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) throw new Error('Invalid pairing listener port')
  for (const origin of options.allowedOrigins) {
    const parsed = new URL(origin)
    if (parsed.protocol !== 'https:' || parsed.origin !== origin) throw new Error('Pairing listener origins must be exact HTTPS origins')
  }
}

export function pairingRoutePolicy(method: string, pathname: string): RemotePolicy {
  if (method === 'GET' && ['/', '/companion'].includes(pathname)) return 'public'
  if (method === 'GET' && pathname.startsWith('/assets/') && hashedCompanionAsset.test(pathname.slice('/assets/'.length))) return 'public'
  if (method === 'POST' && pathname === '/api/v1/product/pairing/confirm') return 'public'
  if (method === 'GET' && ['/api/v1/product/bootstrap', '/api/v1/product/status'].includes(pathname)) return 'product:read'
  if (method === 'GET' && /^\/api\/v1\/product\/assets(?:\/sha256:[a-f0-9]{64})?$/u.test(pathname)) return 'product:read'
  if (method === 'POST' && pathname === '/api/v1/product/assets') return 'assets:write'
  if (['PATCH', 'DELETE'].includes(method) && /^\/api\/v1\/product\/assets\/sha256:[a-f0-9]{64}$/u.test(pathname)) return 'assets:write'
  if (method === 'GET' && ['/api/v1/product/ledger', '/api/v1/product/knowledge', '/api/v1/product/memory', '/api/v1/product/relationships', '/api/v1/product/locations', '/api/v1/product/notifications', '/api/v1/product/notifications/stream'].includes(pathname)) return 'product:read'
  if (method === 'POST' && pathname === '/api/v1/product/ledger') return 'ledger:write'
  if (method === 'POST' && pathname === '/api/v1/product/knowledge') return 'knowledge:write'
  if (['PATCH', 'DELETE'].includes(method) && /^\/api\/v1\/product\/knowledge\/[^/]+$/u.test(pathname)) return 'knowledge:write'
  if (method === 'POST' && /^\/api\/v1\/product\/notifications\/[^/]+\/ack$/u.test(pathname)) return 'notifications:ack'
  return 'forbidden'
}

export function normalizePairingPath(rawUrl: string): string | undefined {
  let encoded: string
  try { encoded = new URL(rawUrl, 'https://pairing.invalid').pathname } catch { return undefined }
  const segments = encoded.split('/').slice(1)
  const decoded: string[] = []
  for (const segment of segments) {
    let value: string
    try { value = decodeURIComponent(segment) } catch { return undefined }
    if (value.includes('/') || value.includes('\\') || value === '.' || value === '..' || value.includes(String.fromCharCode(0))) return undefined
    decoded.push(value)
  }
  return `/${decoded.join('/')}`
}

export function pairingHostMatches(header: string, expectedHost: string): boolean {
  try { return normalizeHostname(new URL(`https://${header}`).hostname) === normalizeHostname(expectedHost) } catch { return false }
}

export async function readCompanionBuildFile(root: string, file: string): Promise<{ bytes: Buffer; contentType: string; immutable: boolean }> {
  if (file !== 'index.html' && (!file.startsWith('assets/') || !hashedCompanionAsset.test(file.slice('assets/'.length)))) throw new GatewayError({ code: 'not-found', message: '找不到 companion 资源。' }, 404)
  const rootPath = await realpath(resolve(root))
  const target = resolve(rootPath, file)
  const path = relative(rootPath, target)
  if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) throw new GatewayError({ code: 'not-found', message: '找不到 companion 资源。' }, 404)
  const canonical = await realpath(target)
  const canonicalPath = relative(rootPath, canonical)
  if (canonicalPath === '..' || canonicalPath.startsWith(`..${sep}`) || isAbsolute(canonicalPath) || !(await stat(canonical)).isFile()) throw new GatewayError({ code: 'not-found', message: '找不到 companion 资源。' }, 404)
  return { bytes: await readFile(canonical), contentType: file === 'index.html' ? 'text/html; charset=utf-8' : companionMimeTypes[extname(file).toLowerCase()] ?? 'application/octet-stream', immutable: file !== 'index.html' }
}

function requestPath(request: FastifyRequest): { pathname: string; sessionId?: string } {
  const url = new URL(request.url, 'https://pairing.invalid')
  const pathname = normalizePairingPath(request.url)
  if (!pathname) throw new GatewayError({ code: 'bad-request', message: '请求路径无效。' }, 400)
  const sessionId = url.searchParams.get('sessionId') ?? undefined
  return { pathname, ...(sessionId ? { sessionId } : {}) }
}

function bearerToken(request: FastifyRequest): string {
  const authorization = request.headers.authorization
  if (!authorization?.startsWith('Bearer ') || authorization.length <= 7) throw new GatewayError({ code: 'unauthorized', message: '需要移动端认证。' }, 401)
  return authorization.slice(7)
}

async function authorizeRemote(options: PairingListenerOptions, request: FastifyRequest): Promise<void> {
  const { pathname, sessionId } = requestPath(request)
  const policy = pairingRoutePolicy(request.method, pathname)
  if (policy === 'forbidden') throw new GatewayError({ code: 'forbidden', message: '该移动端路由未获授权。' }, 403)
  if (policy === 'public') return
  const authorized = await options.product.authorizePairingToken(bearerToken(request))
  if (!authorized.scopes.includes(policy)) throw new GatewayError({ code: 'forbidden', message: '移动端权限不足。' }, 403)
  if (!['/api/v1/product/bootstrap', '/api/v1/product/status'].includes(pathname)) {
    if (!sessionId || !authorized.sessionIds.includes(sessionId)) throw new GatewayError({ code: 'forbidden', message: '该会话未授权给此移动端。' }, 403)
  }
}

function allowedPreflightMethod(request: FastifyRequest): string | undefined {
  const requested = request.headers['access-control-request-method']
  if (typeof requested !== 'string') return undefined
  return pairingRoutePolicy(requested.toUpperCase(), requestPath(request).pathname) === 'forbidden' ? undefined : requested.toUpperCase()
}

export function buildPairingApp(options: PairingListenerOptions): FastifyInstance {
  validateOptions(options)
  const app = Fastify({ logger: false, https: { cert: options.cert, key: options.key }, bodyLimit: 14_100_000 })
  app.addHook('onRequest', async (request, reply) => {
    if (!pairingHostMatches(request.headers.host ?? '', options.host)) return reply.code(421).send(failureEnvelope({ code: 'bad-request', message: '请求主机无效。' }))
    const origin = request.headers.origin
    if (origin !== undefined && (typeof origin !== 'string' || !options.allowedOrigins.includes(origin))) return reply.code(403).send(failureEnvelope({ code: 'forbidden', message: '请求来源未获授权。' }))
    if (typeof origin === 'string') reply.header('access-control-allow-origin', origin).header('vary', 'Origin')
    if (request.method === 'OPTIONS') {
      const method = allowedPreflightMethod(request)
      if (!origin || !method) return reply.code(403).send(failureEnvelope({ code: 'forbidden', message: '跨域预检请求无效。' }))
      return reply.header('access-control-allow-methods', method).header('access-control-allow-headers', 'authorization, content-type, last-event-id').header('access-control-max-age', '600').code(204).send()
    }
    try { await authorizeRemote(options, request) } catch (error) {
      if (error instanceof GatewayError) return reply.code(error.statusCode).send(failureEnvelope(error.apiError))
      throw error
    }
  })
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof GatewayError) {
      void reply.code(error.statusCode).send(failureEnvelope(error.apiError))
      return
    }
    void reply.code(500).send(failureEnvelope({ code: 'internal', message: '配对服务处理请求时发生错误。' }))
  })
  const root = resolve(options.companionDir ?? fileURLToPath(new URL('../../web/dist/', import.meta.url)))
  const sendCompanion = async (reply: import('fastify').FastifyReply, file: string) => {
    const asset = await readCompanionBuildFile(root, file)
    return reply.header('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' blob:; media-src 'self' blob:; base-uri 'none'; frame-ancestors 'none'").header('x-content-type-options', 'nosniff').header('cache-control', asset.immutable ? 'public, max-age=31536000, immutable' : 'no-cache').type(asset.contentType).send(asset.bytes)
  }
  const companion = async (_request: FastifyRequest, reply: import('fastify').FastifyReply) => sendCompanion(reply, 'index.html')
  app.get('/', async (_request, reply) => reply.redirect('/companion', 302))
  app.get('/companion', companion)
  app.get('/assets/:file', async (request, reply) => {
    const file = (request.params as { file?: unknown }).file
    if (typeof file !== 'string' || !hashedCompanionAsset.test(file)) throw new GatewayError({ code: 'not-found', message: '找不到 companion 资源。' }, 404)
    return sendCompanion(reply, `assets/${file}`)
  })
  registerProductRoutes(app, options.product, { reauthorize: request => authorizeRemote(options, request) })
  return app
}

export async function startPairingListener(options: PairingListenerOptions): Promise<{ app: FastifyInstance; url: string }> {
  const app = buildPairingApp(options)
  await app.listen({ host: options.host, port: options.port })
  const displayHost = options.host.includes(':') && !options.host.startsWith('[') ? `[${options.host}]` : options.host
  return { app, url: `https://${displayHost}:${options.port}` }
}
