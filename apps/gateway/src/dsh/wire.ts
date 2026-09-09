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
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/gu, '')
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new Error('DSH upstream must use an HTTP loopback URL')
  }
  if (url.username || url.password) throw new Error('DSH upstream must not contain URL credentials')
  return url
}

export class DshRpcError extends Error {
  override readonly name = 'DshRpcError'

  constructor(readonly code: string, message: string) {
    super(message)
  }
}

export function safeDshError(result: DshFailure): DshRpcError {
  const aliases: Record<string, string> = {
    'session/agent-busy': 'agent-busy', 'session/not-found': 'session-not-found',
    'session/fork-unavailable': 'fork-unavailable', 'gateway/bad-request': 'bad-request',
    'gateway/internal': 'internal', 'agent-preset/not-found': 'agent-preset-not-found',
    'agent-preset/invalid': 'agent-preset-invalid', 'commands/command-error': 'command-error',
  }
  const rawCode = result.error?.code
  const code = typeof rawCode === 'string' && /^[a-z0-9-]+(?:\/[a-z0-9-]+)?$/u.test(rawCode)
    ? aliases[rawCode] ?? rawCode.replace('/', '-')
    : 'internal'
  const message = typeof result.error?.message === 'string' && result.error.message.trim()
    ? result.error.message
    : 'DSH rejected the request'
  return new DshRpcError(code, message)
}

export function mapDshError(error: unknown): ApiError {
  const message = error instanceof Error ? error.message : 'DSH upstream unavailable'
  if (error instanceof DshRpcError) {
    const upstreamCode = error.code
    switch (upstreamCode) {
      case 'authentication-required':
        return { code: 'upstream-unavailable', message: 'DSH Web 认证已失效，请用启动 URL 中的 token 更新 Gateway 配置并重启。', upstreamCode }
      case 'agent-busy':
        return { code: 'agent-busy', message: '当前回合仍在运行，请等待它完成。', upstreamCode }
      case 'session-not-found':
        return { code: 'not-found', message: '找不到该 RP 会话。', upstreamCode }
      case 'bad-request':
        return { code: 'bad-request', message: 'DSH 拒绝了无效请求。', upstreamCode }
      case 'command-error':
        return { code: 'bad-request', message: '该 RP 命令当前无法执行。', upstreamCode }
      case 'fork-unavailable':
        return { code: 'bad-request', message: '当前节点无法创建分支。', upstreamCode }
      case 'agent-preset-not-found':
      case 'agent-preset-invalid':
        return { code: 'card-unavailable', message: '所选 RP 卡片当前不可用。', upstreamCode }
      case 'internal':
        return { code: 'internal', message: 'DSH 处理请求时发生内部错误。', upstreamCode }
      default:
        return { code: 'upstream-unavailable', message: 'DSH 当前无法完成该请求。', upstreamCode }
    }
  }
  if (/already has active work|agent.*busy|active work/i.test(message)) {
    return { code: 'agent-busy', message: '当前回合仍在运行，请等待它完成。' }
  }
  if (/invalid|malformed|protocol|server-response/i.test(message)) {
    return { code: 'upstream-protocol', message: 'DSH 返回了无法识别的响应。' }
  }
  return { code: 'upstream-unavailable', message: 'DSH 当前不可用，请检查本地 Harness。' }
}

export function statusForDshError(error: ApiError): number {
  if (error.code === 'not-found') return 404
  if (error.code === 'bad-request') return 400
  if (error.code === 'agent-busy' || error.code === 'card-unavailable' || error.code === 'rollback-unavailable') return 409
  return 503
}
