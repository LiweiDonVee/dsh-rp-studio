const failure = (status, code, message) => Response.json({ ok: false, protocolVersion: 1, error: { code, message } }, { status })

/** Exact Connection routes; authentication and the Origin fence belong to DSH. */
export function createNativeRoutes(createRuntime) {
  let pending
  let stopped = false
  const streams = new Set()
  const runtime = () => {
    if (stopped) throw new Error('unloaded')
    return pending ??= Promise.resolve().then(createRuntime).catch(error => { pending = undefined; throw error })
  }
  return {
    async request(request) {
      if (stopped) return failure(503, 'upstream-unavailable', 'RP Studio 已停用。')
      try {
        const input = await request.json()
        const decoded = typeof input.path === 'string' ? decodeURIComponent(input.path) : ''
        if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(input.method)
          || !/^\/api\/v1\/(?:health|cards|sessions|product)(?:[/?]|$)/u.test(decoded)
          || decoded.split(/[/?#]/u).some(part => part === '.' || part === '..')
          || decoded.includes('\\') || decoded.includes('#') || /\/events(?:\?|$)/u.test(decoded)) {
          return failure(400, 'bad-request', 'RP 请求路径无效。')
        }
        const current = await runtime()
        const reply = await current.app.inject({ method: input.method, url: input.path,
          ...(input.body === undefined ? {} : { payload: input.body, headers: { 'content-type': 'application/json' } }),
        })
        return new Response(new Uint8Array(reply.rawPayload), { status: reply.statusCode, headers: {
          'content-type': reply.headers['content-type'] ?? 'application/json', 'cache-control': 'no-store',
        } })
      } catch {
        return failure(400, 'bad-request', '无法处理 RP 请求，请刷新重试。')
      }
    },
    async events(request) {
      if (stopped) return failure(503, 'upstream-unavailable', 'RP Studio 已停用。')
      const id = new URL(request.url).searchParams.get('sessionId')
      if (!id || id.length > 256) return failure(400, 'bad-request', '会话 ID 无效。')
      try {
        const current = await runtime()
        await current.service.session(id)
        if (request.signal.aborted || stopped) return new Response(null, { status: 204 })
        let cleanup = () => {}
        const body = new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder()
            let closed = false
            let unsubscribe = () => {}
            const write = event => { if (!closed) controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)) }
            const timer = setInterval(() => { if (!closed) controller.enqueue(encoder.encode(': heartbeat\n\n')) }, 15_000)
            timer.unref?.()
            cleanup = cancelled => {
              if (closed) return
              closed = true
              clearInterval(timer)
              unsubscribe()
              streams.delete(cleanup)
              request.signal.removeEventListener('abort', cleanup)
              if (cancelled !== true) controller.close()
            }
            streams.add(cleanup)
            request.signal.addEventListener('abort', cleanup, { once: true })
            unsubscribe = current.service.subscribe(id, write)
            write({ type: 'connected', sessionId: id })
          },
          cancel() { cleanup(true) },
        })
        return new Response(body, { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' } })
      } catch (error) {
        const known = error?.apiError
        return failure(known ? error.statusCode : 503, known?.code ?? 'upstream-unavailable', known?.message ?? 'RP 会话暂不可用。')
      }
    },
    async close() {
      if (stopped) return
      stopped = true
      for (const close of streams) close()
      if (pending) { const current = await pending.catch(() => undefined); await current?.close() }
    },
  }
}
