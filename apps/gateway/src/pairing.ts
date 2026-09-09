import { createHash, randomBytes } from 'node:crypto'
import { GatewayError } from './errors.js'
import type { PairingClient, PairingCodeRequest, PairingScope, ProductStatus } from '@dsh-rp/protocol'

export interface PairingTokenRecord {
  clientId: string
  clientName: string
  tokenHash: string
  scopes: PairingScope[]
  sessionIds: string[]
  createdAt: string
  expiresAt: string
}

export interface PairingManagerOptions {
  enabled: boolean
  saveToken: (record: PairingTokenRecord) => Promise<void>
  listClients?: () => Promise<PairingClient[]>
  revokeClient?: (clientId: string) => Promise<boolean>
  now?: () => number
  codeTtlMs?: number
  maxAttempts?: number
  allowedWriteScopes?: PairingScope[]
  listener?: 'loopback' | 'https-lan' | 'disabled'
}

interface PendingCode {
  expiresAt: number
  clientName: string
  requestedScopes: PairingScope[]
  sessionIds: string[]
}

export class PairingManager {
  private readonly codes = new Map<string, PendingCode>()
  private readonly attempts = new Map<string, { count: number; resetAt: number }>()
  private readonly now: () => number
  private readonly codeTtlMs: number
  private readonly maxAttempts: number
  private readonly maxPendingCodes = 128
  private readonly maxAttemptBuckets = 1_024

  constructor(private readonly options: PairingManagerOptions) {
    this.now = options.now ?? Date.now
    this.codeTtlMs = options.codeTtlMs ?? 5 * 60_000
    this.maxAttempts = options.maxAttempts ?? 5
  }

  status(): ProductStatus['pairing'] {
    return { enabled: this.options.enabled, listener: this.options.enabled ? this.options.listener ?? 'loopback' : 'disabled' }
  }

  createCode(input: PairingCodeRequest): { code: string; expiresAt: string; requestedScopes: PairingScope[]; sessionIds: string[] } {
    this.assertEnabled()
    this.prune()
    if (this.codes.size >= this.maxPendingCodes) throw new GatewayError({ code: 'rate-limited', message: '待确认的配对请求过多，请稍后重试。' }, 429)
    const code = randomBytes(24).toString('base64url')
    const expiresAt = this.now() + this.codeTtlMs
    const requestedScopes = [...new Set(input.requestedScopes)]
    const sessionIds = [...new Set(input.sessionIds)]
    this.codes.set(this.digest(code), { expiresAt, clientName: input.clientName, requestedScopes, sessionIds })
    return { code, expiresAt: new Date(expiresAt).toISOString(), requestedScopes, sessionIds }
  }

  async confirm(input: { code: string; clientName: string }, source: string): Promise<{ clientId: string; token: string; scopes: PairingScope[]; sessionIds: string[]; expiresAt: string }> {
    this.assertEnabled()
    const key = this.digest(input.code)
    this.recordAttempt(source, key)
    const pending = this.codes.get(key)
    this.codes.delete(key)
    if (!pending || pending.expiresAt <= this.now()) throw new GatewayError({ code: 'unauthorized', message: '配对码无效或已过期。' }, 401)
    if (pending.clientName !== input.clientName) throw new GatewayError({ code: 'unauthorized', message: '配对码无效或已过期。' }, 401)
    const token = randomBytes(32).toString('base64url')
    const clientId = `client-${randomBytes(12).toString('hex')}`
    const scopes: PairingScope[] = ['product:read']
    const allowed = new Set<PairingScope>(this.options.allowedWriteScopes ?? [])
    for (const scope of pending.requestedScopes) if (scope !== 'product:read' && allowed.has(scope)) scopes.push(scope)
    const expiresAt = new Date(this.now() + 30 * 24 * 60 * 60_000).toISOString()
    await this.options.saveToken({ clientId, clientName: pending.clientName, tokenHash: this.digest(token), scopes, sessionIds: pending.sessionIds, createdAt: new Date(this.now()).toISOString(), expiresAt })
    return { clientId, token, scopes, sessionIds: pending.sessionIds, expiresAt }
  }

  async clients(): Promise<PairingClient[]> {
    return this.options.listClients ? this.options.listClients() : []
  }

  async revoke(clientId: string): Promise<boolean> {
    return this.options.revokeClient ? this.options.revokeClient(clientId) : false
  }

  private assertEnabled(): void {
    if (!this.options.enabled) throw new GatewayError({ code: 'forbidden', message: '移动配对默认未启用。' }, 403)
  }

  private recordAttempt(source: string, codeHash: string): void {
    this.prune()
    for (const key of [`source:${source}`, `code:${codeHash}`]) this.incrementAttempt(key)
  }

  private incrementAttempt(key: string): void {
    const current = this.attempts.get(key)
    if (!current || current.resetAt <= this.now()) {
      if (this.attempts.size >= this.maxAttemptBuckets) this.attempts.delete(this.attempts.keys().next().value as string)
      this.attempts.set(key, { count: 1, resetAt: this.now() + 60_000 })
      return
    }
    if (current.count >= this.maxAttempts - 1) throw new GatewayError({ code: 'rate-limited', message: '配对尝试过于频繁，请稍后重试。' }, 429)
    current.count++
  }

  private prune(): void {
    const now = this.now()
    for (const [key, value] of this.codes) if (value.expiresAt <= now) this.codes.delete(key)
    for (const [key, value] of this.attempts) if (value.resetAt <= now) this.attempts.delete(key)
  }

  private digest(value: string): string {
    return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`
  }
}
