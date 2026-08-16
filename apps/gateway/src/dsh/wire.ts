import type { ApiError } from '@dsh-rp/protocol'

export interface DshSuccess<T> {
  ok: true
  value: T
}

export interface DshFailure {
  ok: false
  error: { code?: string; message?: string }
}

export type DshResult<T> = DshSuccess<T> | DshFailure

export interface DshResponse<T> {
  type: 'server-response'
  rpcId: string
  result: DshResult<T>
}

export function assertLoopbackUrl(raw: string): URL {
  const url = new URL(raw)
  const host = url.hostname.toLowerCase()
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new Error('DSH upstream must use an HTTP loopback URL')
  }
  return url
}

export function safeDshError(result: DshFailure): Error {
  const message = typeof result.error.message === 'string' && result.error.message.trim()
    ? result.error.message
    : 'DSH rejected the request'
  return new Error(message)
}

export function mapDshError(error: unknown): ApiError {
  const message = error instanceof Error ? error.message : 'DSH upstream unavailable'
  if (/already has active work|agent.*busy|active work/i.test(message)) {
    return { code: 'agent-busy', message: '当前回合仍在运行，请等待它完成。' }
  }
  if (/invalid|malformed|protocol|server-response/i.test(message)) {
    return { code: 'upstream-protocol', message: 'DSH 返回了无法识别的响应。' }
  }
  return { code: 'upstream-unavailable', message: 'DSH 当前不可用，请检查本地 Harness。' }
}
