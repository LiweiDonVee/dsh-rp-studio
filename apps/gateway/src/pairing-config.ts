import { readFile, stat } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import type { PairingScope } from '@dsh-rp/protocol'

export interface PairingConfig {
  enabled: true
  host: string
  port: number
  allowedOrigins: string[]
  certFile: string
  keyFile: string
  companionDir?: string
  writeScopes: PairingScope[]
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function resolvePath(value: unknown, name: string, root: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 4_096) throw new Error('DSH runtime config ' + name + ' is invalid')
  return isAbsolute(value) ? value : resolve(root, value)
}

export async function loadPairingConfig(filePath: string | undefined): Promise<PairingConfig | undefined> {
  if (!filePath) return undefined
  const absolutePath = resolve(filePath)
  const root = object(JSON.parse(await readFile(absolutePath, 'utf8')))
  const keys = new Set(['enabled', 'host', 'port', 'allowedOrigins', 'certFile', 'keyFile', 'companionDir', 'writeScopes'])
  if (!root || Object.keys(root).some(key => !keys.has(key))) throw new Error('DSH runtime config contains unknown fields')
  if (root.enabled !== true) throw new Error('DSH runtime config enabled must be true to enable the listener')
  if (typeof root.host !== 'string' || root.host.trim() === '' || root.host.length > 255 || ['0.0.0.0', '::', '[::]'].includes(root.host)) throw new Error('DSH runtime config host must be an explicit LAN host')
  if (typeof root.port !== 'number' || !Number.isInteger(root.port) || root.port < 1 || root.port > 65_535) throw new Error('DSH runtime config port is invalid')
  if (!Array.isArray(root.allowedOrigins) || root.allowedOrigins.length < 1 || root.allowedOrigins.length > 32) throw new Error('DSH runtime config allowedOrigins is required')
  const allowedOrigins = root.allowedOrigins.map((origin, index) => {
    if (typeof origin !== 'string' || origin.trim() === '') throw new Error('DSH runtime config allowedOrigins[' + index + '] is invalid')
    const parsed = new URL(origin)
    if (parsed.protocol !== 'https:' || parsed.origin !== origin) throw new Error('DSH runtime config allowedOrigins must be exact HTTPS origins')
    return origin
  })
  const writeScopes = root.writeScopes === undefined ? [] : root.writeScopes
  if (!Array.isArray(writeScopes) || writeScopes.length > 4 || writeScopes.some(scope => !['assets:write', 'ledger:write', 'knowledge:write', 'notifications:ack'].includes(String(scope)))) throw new Error('DSH runtime config writeScopes is invalid')
  const configRoot = dirname(absolutePath)
  const certFile = resolvePath(root.certFile, 'certFile', configRoot)
  const keyFile = resolvePath(root.keyFile, 'keyFile', configRoot)
  const companionDir = root.companionDir === undefined ? undefined : resolvePath(root.companionDir, 'companionDir', configRoot)
  const [certInfo, keyInfo] = await Promise.all([stat(certFile), stat(keyFile)])
  if (!certInfo.isFile() || !keyInfo.isFile()) throw new Error('DSH runtime config certFile and keyFile must be regular files')
  return { enabled: true, host: root.host, port: root.port, allowedOrigins, certFile, keyFile, ...(companionDir ? { companionDir } : {}), writeScopes: [...writeScopes] as PairingScope[] }
}
