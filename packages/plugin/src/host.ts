import { buildApp } from '../../../apps/gateway/src/app.js'
import { createDshClient } from '../../../apps/gateway/src/dsh/client.js'
import { SessionService } from '../../../apps/gateway/src/session-service.js'
import { ProductService } from '../../../apps/gateway/src/product-service.js'
import { loadDefaultProductStore } from '../../../apps/gateway/src/local-data-adapter.js'
import { createNativeTransport } from './transport.mjs'
import { createNativeRoutes } from './routes.mjs'
import { createStudioActions } from './actions.mjs'
import { createCompanionStatusRoute } from './companion-status.mjs'

export const name = 'rp-studio'
export const inject = ['connection', 'typertGateway']

export function apply(ctx) {
  const routes = createNativeRoutes(async () => {
    const transport = createNativeTransport(ctx)
    const service = new SessionService({
      dsh: createDshClient({ transport }),
      isPresentationSession: sessionId => ctx.get('rpLastStep')?.isEnabled(sessionId) === true,
      getGM: () => ctx.get('rpGM'),
      getLastStep: () => ctx.get('rpLastStep'),
      getDatabase: () => ctx.get('rpDatabase'),
    })
    const loaded = await loadDefaultProductStore({})
    const product = new ProductService({ sessions: service, ...loaded, pairingEnabled: false })
    const app = buildApp({ api: service, product })
    let stopPresentation = () => {}
    const close = async () => { stopPresentation(); service.stop(); transport.stop(); await app.close(); await product.close() }
    try {
      stopPresentation = ctx.on('rp-last-step/presentation', event => {
        if (typeof event?.sessionId !== 'string') return
        if (event.status === 'failed' || event.status === 'cancelled') {
          service.publishPresentationError(event.sessionId, event.status)
        } else if (event.stageId === 'rp-last-step.render' && event.status === 'rendering'
          && typeof event.presentationId === 'string' && typeof event.delta === 'string') {
          service.publishPresentationDelta(event.sessionId, event.presentationId, event.delta)
        }
      })
      await service.start()
      await product.start()
      await app.ready()
      return { app, service, close }
    } catch (error) { await close(); throw error }
  })
  const actions = createStudioActions({ getService: name => ctx.get(name), authorize: (sessionId, signal) => routes.authorize(sessionId, signal) })
  const companion = createCompanionStatusRoute(ctx)
  ctx.connection.fetch.register({ path: '/api/rp-studio/request', methods: ['POST'], requestBody: 'buffered', fetch: request => routes.request(request) })
  ctx.connection.fetch.register({ path: '/api/rp-studio/events', methods: ['GET'], requestBody: 'buffered', fetch: request => routes.events(request) })
  ctx.connection.fetch.register({ path: '/api/rp-studio/actions', methods: ['POST'], requestBody: 'buffered', fetch: request => actions.request(request) })
  ctx.connection.fetch.register({ path: '/api/rp-studio/companion', methods: ['POST'], requestBody: 'buffered', fetch: request => companion.request(request) })
  ctx.effect(() => () => { companion.close(); actions.close(); return routes.close() }, 'RP Studio runtime')
}
