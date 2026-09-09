import { describe, expect, it, vi } from 'vitest'
import type { ProductSourceEvent, SessionApi } from './app.js'
import { ProductService } from './product-service.js'
import { fakeProductStore, productDetail } from './product-test-fixture.js'

describe('product projection source', () => {
  it('loads the official projection cursor and replaces from sequence zero', async () => {
    const data = fakeProductStore()
    const replace = vi.spyOn(data, 'replaceProjections')
    const scope = { workspaceId: 'workspace-1', cardId: productDetail.card.id, sessionId: productDetail.session.id, branchId: productDetail.session.id }
    const sessions = {
      session: async () => productDetail,
      getProductScope: async () => scope,
      productSnapshots: async () => [{ detail: productDetail, scope, sourceSeq: 91 }],
      subscribeProduct: () => () => {},
    }
    const service = new ProductService({ sessions, store: data })
    await service.start()
    expect(replace).toHaveBeenCalledWith(scope, expect.objectContaining({ fromSeq: 0, branchId: productDetail.session.id, memories: [expect.objectContaining({ sourceSeq: 91 })] }))
    await service.close()
  })

  it('projects live public state and emits real completion notifications', async () => {
    const data = fakeProductStore()
    const replace = vi.spyOn(data, 'replaceProjections')
    const append = vi.spyOn(data, 'appendNotification')
    let publish: (event: ProductSourceEvent) => void = () => {}
    const scope = { workspaceId: 'workspace-1', cardId: productDetail.card.id, sessionId: productDetail.session.id, branchId: productDetail.session.id }
    const sessions: Pick<SessionApi, 'session'> & Partial<SessionApi> = {
      session: async () => productDetail,
      getProductScope: async () => scope,
      productSnapshots: async () => [],
      subscribeProduct: listener => { publish = listener; return () => {} },
    }
    const service = new ProductService({ sessions, store: data })
    await service.start()
    publish({ type: 'projection', sessionId: scope.sessionId, branchId: scope.branchId, sourceSeq: 92, state: productDetail.state })
    publish({ type: 'turn.completed', sessionId: scope.sessionId, sourceSeq: 93 })
    await vi.waitFor(() => expect(append).toHaveBeenCalledOnce())
    expect(replace).toHaveBeenCalledWith(scope, expect.objectContaining({ fromSeq: 0, memories: [expect.objectContaining({ sourceSeq: 92 })] }))
    expect(append).toHaveBeenCalledWith(scope, expect.objectContaining({ id: `dsh:turn.completed:${scope.sessionId}:93`, type: 'turn.completed' }))
    await service.close()
  })
})
