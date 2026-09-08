import { assertLoopbackUrl, DshRpcError } from './wire.js'

/** A process-local, authority-bound cookie. Never forward credentials to the SPA. */
export function createWebAuth(base: URL, request: typeof fetch, token?: string) {
  assertLoopbackUrl(base.href)
  let cookie: string | undefined
  let pending: Promise<void> | undefined
  return {
    async headers(): Promise<Record<string, string>> {
      if (!cookie && token) {
        pending ??= (async () => {
          const launch = new URL('/', base)
          launch.searchParams.set('token', token)
          let response: Response
          try {
            response = await request(launch, { redirect: 'manual', signal: AbortSignal.timeout(10_000) })
          } catch {
            throw new DshRpcError('authentication-required', 'DSH Web token exchange failed')
          }
          if (response.status !== 303 || response.headers.get('location') !== '/') {
            throw new DshRpcError('authentication-required', 'DSH Web token exchange rejected')
          }
          const cookies = response.headers.getSetCookie().map(value => value.split(';', 1)[0]!)
          if (!cookies.length || cookies.some(value => !/^[^=;\s]+=[^;\r\n]+$/u.test(value))) {
            throw new DshRpcError('authentication-required', 'DSH Web cookie missing')
          }
          cookie = cookies.join('; ')
        })().finally(() => { pending = undefined })
        await pending
      }
      return cookie ? { cookie } : {}
    },
    invalidate(): void { cookie = undefined },
  }
}
