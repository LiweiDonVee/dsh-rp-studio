/** In-process Remote carrier. DSH keeps ownership, access checks and session locks. */
export function createNativeTransport(ctx) {
  let stopped = false
  const active = new Set()
  function request(endpoint, args, signal) {
    const slash = endpoint.indexOf('/')
    if (slash < 1) throw new Error('Invalid Remote endpoint')
    return { namespace: endpoint.slice(0, slash), method: endpoint.slice(slash + 1), args, peer: ctx.connection.browserPeer, signal }
  }
  return {
    call(endpoint, args, signal) {
      if (stopped) return Promise.reject(new Error('RP Studio has been unloaded'))
      return ctx.typertGateway.invoke(request(endpoint, args, signal))
    },
    open(endpoint, args, item, error) {
      const lifetime = new AbortController()
      const disposers = []
      const close = () => {
        if (lifetime.signal.aborted) return
        lifetime.abort()
        active.delete(close)
        for (const dispose of disposers) dispose()
      }
      if (stopped) { lifetime.abort(); return close }
      active.add(close)
      if (endpoint === '$events') {
        // The normal DSH client owns approvals/questions. This carrier only observes notifications.
        for (const event of ['api-session/status', 'api-session/removed']) {
          disposers.push(ctx.on(event, (...values) => { if (!lifetime.signal.aborted) item({ type: 'emit', event, args: values }) }))
        }
      } else {
        void (async () => {
          try {
            const stream = await ctx.typertGateway.stream(request(endpoint, args, lifetime.signal))
            for await (const value of stream) {
              if (lifetime.signal.aborted) break
              item(value)
            }
          } catch (cause) {
            if (!lifetime.signal.aborted) error(cause)
          } finally { close() }
        })()
      }
      const handle = Object.assign(close, { cancel: close, end: close, send() { throw new Error('RP observer streams do not accept uplink items') } })
      return handle
    },
    stop() { stopped = true; for (const close of active) close() },
  }
}
