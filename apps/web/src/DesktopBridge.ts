import { z } from 'zod'
import { ProductApiError } from './ProductApi.js'

const diagnosticSchema = z.object({ code: z.string().min(1).max(100), message: z.string().min(1).max(500) }).strict()
const assetResultSchema = z.union([
  z.object({ selected: z.literal(false) }).strict(),
  z.object({ selected: z.literal(true), ok: z.literal(true), assetId: z.string().min(1).max(200) }).strict(),
  z.object({ selected: z.literal(true), ok: z.literal(false), diagnostic: diagnosticSchema }).strict(),
])
const backupResultSchema = z.union([
  z.object({ selected: z.literal(false) }).strict(),
  z.object({ selected: z.literal(true), ok: z.literal(true), backupId: z.string().min(1).max(200) }).strict(),
  z.object({ selected: z.literal(true), ok: z.literal(false), diagnostic: diagnosticSchema }).strict(),
])

type DesktopHost = {
  importAsset(sessionId: string): Promise<unknown>
  exportBackup(sessionId: string): Promise<unknown>
  importBackup(sessionId: string): Promise<unknown>
}

declare global { var dshDesktop: DesktopHost | undefined }

export type DesktopBridge = {
  importAsset(sessionId: string): Promise<z.infer<typeof assetResultSchema>>
  exportBackup(sessionId: string): Promise<z.infer<typeof backupResultSchema>>
  importBackup(sessionId: string): Promise<z.infer<typeof backupResultSchema>>
}

function sessionScope(sessionId: string): string {
  const value = sessionId.trim()
  if (!value) throw new ProductApiError('桌面操作缺少故事档案范围。', 'invalid-scope', 400)
  return value
}

async function invoke<T>(operation: string, sessionId: string, call: (scope: string) => Promise<unknown>, schema: z.ZodType<T>): Promise<T> {
  try {
    const parsed = schema.safeParse(await call(sessionScope(sessionId)))
    if (!parsed.success) throw new ProductApiError(`桌面${operation}返回了无效响应。`, 'invalid-desktop-response', 502)
    return parsed.data
  } catch (error) {
    if (error instanceof ProductApiError) throw error
    throw new ProductApiError(`桌面${operation}失败。`, 'desktop-operation-failed', 502)
  }
}

export function getDesktopBridge(): DesktopBridge | null {
  const host = globalThis.dshDesktop
  if (!host || typeof host.importAsset !== 'function' || typeof host.exportBackup !== 'function' || typeof host.importBackup !== 'function') return null
  return {
    importAsset: sessionId => invoke('资产导入', sessionId, host.importAsset.bind(host), assetResultSchema),
    exportBackup: sessionId => invoke('备份导出', sessionId, host.exportBackup.bind(host), backupResultSchema),
    importBackup: sessionId => invoke('备份导入', sessionId, host.importBackup.bind(host), backupResultSchema),
  }
}
