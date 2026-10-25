import { apiEnvelopeSchema, cardSchema, rollbackResultSchema, sessionDetailSchema, sessionSummarySchema, streamEventSchema } from '@dsh-rp/protocol'

export class NativeApiError extends Error {
  constructor(error) { super(error.message); this.code = error.code }
}

export function createNativeApi(send = globalThis.fetch.bind(globalThis)) {
  async function request(method, path, body, signal) {
    const response = await send(new URL('api/rp-studio/request', document.baseURI), {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal,
      body: JSON.stringify({ method, path, ...(body === undefined ? {} : { body }) }),
    })
    let envelope
    try { envelope = apiEnvelopeSchema.parse(await response.json()) }
    catch { throw new Error('RP Studio 暂不可用，请确认插件已启用并刷新页面。') }
    if (!envelope.ok) throw new NativeApiError(envelope.error)
    if (!response.ok) throw new Error('RP 请求失败，请重试。')
    return envelope.data
  }
  const route = id => `/api/v1/sessions/${encodeURIComponent(id)}`
  return {
    async action(action, input = {}, signal) {
      const response = await send(new URL('api/rp-studio/actions', document.baseURI), {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal,
        body: JSON.stringify({ ...input, action }),
      })
      let result
      try { result = await response.json() } catch { throw new Error('无法读取 RP 操作响应，请检查插件是否启用。') }
      if (!response.ok || result?.error) throw Object.assign(new Error(result?.error?.message || 'RP 操作失败，请刷新后重试。'), { code: result?.error?.code, status: response.status })
      return result
    },
    cards: async signal => cardSchema.array().parse(await request('GET', '/api/v1/cards', undefined, signal)),
    sessions: async signal => sessionSummarySchema.array().parse(await request('GET', '/api/v1/sessions', undefined, signal)),
    session: async (id, signal) => sessionDetailSchema.parse(await request('GET', route(id), undefined, signal)),
    create: async cardId => sessionDetailSchema.parse(await request('POST', '/api/v1/sessions', { cardId })),
    send: (id, text) => request('POST', `${route(id)}/messages`, { text }),
    cancel: id => request('POST', `${route(id)}/cancel`),
    rollback: async id => rollbackResultSchema.parse(await request('POST', `${route(id)}/rollback`)),
    fork: async id => sessionDetailSchema.parse(await request('POST', `${route(id)}/fork`, {})),
    autoplay: (id, off) => request('PUT', `${route(id)}/autoplay`, off ? { off: true } : { rounds: 3 }),
    subscribe(id, onEvent, onError) {
      const url = new URL('api/rp-studio/events', document.baseURI)
      url.searchParams.set('sessionId', id)
      const source = new EventSource(url)
      const types = ['connected', 'message.delta', 'message.completed', 'state.updated', 'session.status', 'session.rebased', 'error']
      for (const type of types) source.addEventListener(type, event => {
        try { const parsed = streamEventSchema.safeParse(JSON.parse(event.data)); if (parsed.success && parsed.data.sessionId === id) onEvent(parsed.data) } catch { /* Ignore malformed carrier frames. */ }
      })
      source.onerror = onError
      return () => source.close()
    },
  }
}
