import { LoopError } from './core.mjs'

const failure = (status, code, message) => Response.json({ error: { code, message } }, { status, headers: { 'cache-control': 'no-store' } })
function errorResponse(error) {
  if (error instanceof LoopError || ['bad-request', 'revision-conflict', 'unsupported-node'].includes(error?.code)) {
    return failure(error.status ?? 400, error.code, error.message)
  }
  if (error?.code === 'session/not-found' || error?.code === 'session-query/not-found') return failure(404, 'not-found', 'Session is unavailable.')
  if (error?.code === 'gateway/forbidden' || error?.code === 'gateway/access-denied') return failure(403, 'forbidden', 'Session access was denied.')
  if (error?.name === 'AbortError' || error?.code === 'gateway/cancelled') return failure(499, 'cancelled', 'The request was cancelled.')
  return failure(503, 'unavailable', 'Loop Studio is temporarily unavailable.')
}

/** Exact Connection-authenticated operations. No generic Remote proxy exists. */
export function createLoopRoutes(service) {
  let stopped = false
  const streams = new Set()
  return {
    async request(request) {
      if (stopped) return failure(503, 'unavailable', 'Loop Studio has been unloaded.')
      let input
      try { input = await request.json() } catch { return failure(400, 'bad-request', 'A JSON request is required.') }
      const keys = { inspect: ['action', 'sessionId'], savePolicy: ['action', 'sessionId', 'scope', 'presetId', 'expectedRevision', 'policy'], resetPolicy: ['action', 'sessionId', 'scope', 'presetId', 'expectedRevision'] }
      if (!input || !Object.hasOwn(keys, input.action) || typeof input.sessionId !== 'string' || !input.sessionId || input.sessionId.length > 256
        || Object.keys(input).some(key => !keys[input.action].includes(key))) return failure(400, 'bad-request', 'Invalid Loop Studio operation.')
      if (input.action !== 'inspect' && (!['session', 'preset'].includes(input.scope)
        || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0)) return failure(400, 'bad-request', 'A policy scope and expectedRevision are required.')
      try {
        request.signal.throwIfAborted()
        const { action, ...args } = input
        const result = action === 'inspect' ? await service.inspect(input.sessionId, request.signal) : await service[action](args, request.signal)
        return Response.json(result, { headers: { 'cache-control': 'no-store' } })
      } catch (error) { return errorResponse(error) }
    },
    async events(request) {
      if (stopped) return failure(503, 'unavailable', 'Loop Studio has been unloaded.')
      const sessionId = new URL(request.url).searchParams.get('sessionId')
      if (!sessionId || sessionId.length > 256) return failure(400, 'bad-request', 'A sessionId is required.')
      try {
        await service.authorize(sessionId, request.signal)
        if (request.signal.aborted || stopped) return new Response(null, { status: 204 })
        let cleanup = () => {}
        const body = new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder()
            let closed = false
            let unsubscribe = () => {}
            const write = type => {
              if (closed) return
              const bytes = encoder.encode(`event: ${type}\ndata: ${JSON.stringify({ type, sessionId })}\n\n`)
              // Close a stalled connection instead of growing its queue. The
              // normal EventSource reconnect obtains a fresh inspect snapshot.
              if (controller.desiredSize < bytes.byteLength) { cleanup(); return }
              controller.enqueue(bytes)
            }
            const timer = setInterval(() => {
              if (closed) return
              const bytes = encoder.encode(': heartbeat\n\n')
              if (controller.desiredSize < bytes.byteLength) { cleanup(); return }
              controller.enqueue(bytes)
            }, 15_000)
            timer.unref?.()
            const aborted = () => cleanup()
            cleanup = cancelled => {
              if (closed) return
              closed = true
              clearInterval(timer)
              unsubscribe()
              streams.delete(cleanup)
              request.signal.removeEventListener('abort', aborted)
              if (cancelled !== true) controller.close()
            }
            streams.add(cleanup)
            request.signal.addEventListener('abort', aborted, { once: true })
            unsubscribe = service.subscribe(sessionId, () => write('changed'))
            if (request.signal.aborted || stopped) cleanup()
            else write('connected')
          },
          cancel() { cleanup(true) },
        }, { highWaterMark: 16_384, size: chunk => chunk.byteLength })
        return new Response(body, { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' } })
      } catch (error) { return errorResponse(error) }
    },
    close() {
      if (stopped) return
      stopped = true
      for (const close of streams) close()
    },
  }
}
