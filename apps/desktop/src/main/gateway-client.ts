import { mkdir, open, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

export interface GatewayResult { ok: boolean; assetId?: string; backupId?: string; diagnostic?: { code: string; message: string } }
export interface GatewayClient {
  uploadAsset(origin: string, sessionId: string, selectedPath: string): Promise<GatewayResult>
  exportBackup(origin: string, sessionId: string, selectedDirectory: string): Promise<GatewayResult>
  importBackup(origin: string, sessionId: string, selectedPath: string): Promise<GatewayResult>
}

const mimeTypes: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.pdf': 'application/pdf' }
const MAX_ASSET_BYTES = 10 * 1024 * 1024
const MAX_BACKUP_BYTES = 32 * 1024 * 1024
const SAFE_BACKUP_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u
const BACKUP_EXTENSION = '.dsh-rp-backup'

async function readBoundedFile(path: string, limit: number): Promise<Buffer | undefined> {
  const info = await stat(path)
  if (!info.isFile() || info.size > limit) return undefined
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(limit + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    if (bytesRead > limit) return undefined
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

export function createGatewayClient(request: typeof fetch = fetch): GatewayClient {
  return {
    async uploadAsset(origin, sessionId, selectedPath) {
      const mimeType = mimeTypes[extname(selectedPath).toLowerCase()]
      if (!mimeType) return { ok: false, diagnostic: { code: 'asset-type-unsupported', message: 'The selected asset type is not supported' } }
      let content: Buffer | undefined
      try { content = await readBoundedFile(selectedPath, MAX_ASSET_BYTES) } catch { return { ok: false, diagnostic: { code: 'asset-read-failed', message: 'The selected asset could not be read' } } }
      if (!content) return { ok: false, diagnostic: { code: 'asset-too-large', message: 'The selected asset exceeds the 10 MiB limit' } }
      const response = await request(`${new URL(origin).origin}/api/v1/product/assets?sessionId=${encodeURIComponent(sessionId)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fileName: basename(selectedPath), mimeType, category: 'attachment', contentBase64: content.toString('base64') }),
        signal: AbortSignal.timeout(30_000),
      })
      const value: unknown = await response.json()
      const record = value && typeof value === 'object' ? value as Record<string, unknown> : {}
      const data = record.data && typeof record.data === 'object' ? record.data as Record<string, unknown> : {}
      if (response.ok && record.ok === true && typeof data.id === 'string') return { ok: true, assetId: data.id }
      return { ok: false, diagnostic: { code: 'asset-upload-failed', message: 'Gateway rejected the selected asset' } }
    },
    async exportBackup(origin, sessionId, selectedDirectory) {
      const commandId = randomUUID()
      const created = await request(`${new URL(origin).origin}/api/v1/product/backups?sessionId=${encodeURIComponent(sessionId)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ commandId }), signal: AbortSignal.timeout(30_000),
      })
      const createdValue = await created.json() as Record<string, unknown>
      const createdData = createdValue.data && typeof createdValue.data === 'object' ? createdValue.data as Record<string, unknown> : {}
      const backupId = typeof createdData.id === 'string' ? createdData.id : ''
      if (!created.ok || createdValue.ok !== true || !SAFE_BACKUP_ID.test(backupId)) return { ok: false, diagnostic: { code: 'backup-create-failed', message: 'Gateway returned an invalid backup identifier' } }
      const exported = await request(`${new URL(origin).origin}/api/v1/product/backups/${encodeURIComponent(backupId)}/export?sessionId=${encodeURIComponent(sessionId)}`, { signal: AbortSignal.timeout(30_000) })
      if (!exported.ok) return { ok: false, diagnostic: { code: 'backup-export-failed', message: 'Gateway could not export the backup bytes' } }
      await mkdir(selectedDirectory, { recursive: true })
      const bytes = Buffer.from(await exported.arrayBuffer())
      if (bytes.byteLength > MAX_BACKUP_BYTES) return { ok: false, diagnostic: { code: 'backup-too-large', message: 'The exported backup exceeds the 32 MiB limit' } }
      await writeFile(join(selectedDirectory, `${backupId}.dsh-rp-backup`), bytes)
      return { ok: true, backupId }
    },
    async importBackup(origin, sessionId, selectedPath) {
      if (extname(selectedPath).toLowerCase() !== BACKUP_EXTENSION) return { ok: false, diagnostic: { code: 'backup-type-unsupported', message: 'The selected file is not a DSH RP Studio backup' } }
      let content: Buffer | undefined
      try { content = await readBoundedFile(selectedPath, MAX_BACKUP_BYTES) } catch { return { ok: false, diagnostic: { code: 'backup-read-failed', message: 'The selected backup could not be read' } } }
      if (!content) return { ok: false, diagnostic: { code: 'backup-too-large', message: 'The selected backup exceeds the 32 MiB limit' } }
      const commandId = randomUUID()
      const response = await request(`${new URL(origin).origin}/api/v1/product/backups/import?sessionId=${encodeURIComponent(sessionId)}&commandId=${encodeURIComponent(commandId)}`, {
        method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: content as unknown as BodyInit, signal: AbortSignal.timeout(30_000),
      })
      const value = await response.json() as Record<string, unknown>
      const data = value.data && typeof value.data === 'object' ? value.data as Record<string, unknown> : {}
      const backupId = typeof data.id === 'string' ? data.id : ''
      if (!response.ok || value.ok !== true || !SAFE_BACKUP_ID.test(backupId)) return { ok: false, diagnostic: { code: 'backup-import-failed', message: 'Gateway could not stage the backup bytes' } }
      return { ok: true, backupId }
    },
  }
}
