import { buildApp } from '../../../apps/gateway/src/app.js'
import { createDshClient } from '../../../apps/gateway/src/dsh/client.js'
import { SessionService } from '../../../apps/gateway/src/session-service.js'
import { ProductService } from '../../../apps/gateway/src/product-service.js'
import { loadDefaultProductStore } from '../../../apps/gateway/src/local-data-adapter.js'
import { createNativeTransport } from './transport.mjs'
import { createNativeRoutes } from './routes.mjs'

export const name = 'rp-studio'
export const inject = ['connection', 'typertGateway']

export function apply(ctx) {
  const routes = createNativeRoutes(async () => {
    const transport = createNativeTransport(ctx)
    const service = new SessionService({ dsh: createDshClient({ transport }) })
    const loaded = await loadDefaultProductStore({})
    const product = new ProductService({ sessions: service, ...loaded, pairingEnabled: false })
    const app = buildApp({ api: service, product })
    const close = async () => { service.stop(); transport.stop(); await app.close(); await product.close() }
    try {
      await service.start()
      await product.start()
      await app.ready()
      return { app, service, close }
    } catch (error) { await close(); throw error }
  })
  ctx.connection.fetch.register({ path: '/api/rp-studio/request', methods: ['POST'], requestBody: 'buffered', fetch: request => routes.request(request) })
  ctx.connection.fetch.register({ path: '/api/rp-studio/events', methods: ['GET'], requestBody: 'buffered', fetch: request => routes.events(request) })
  ctx.effect(() => () => routes.close(), 'RP Studio runtime')
}
