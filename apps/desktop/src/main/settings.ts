import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { z } from 'zod'
import { publicSettingsSchema, type PublicSettings, type RuntimePathField } from '../shared/ipc-schema.js'

const settingsSchema = z.object({
  nodeExecutable: z.string().max(4096),
  dshBin: z.string().max(4096),
  gatewayEntry: z.string().max(4096),
  dshHome: z.string().max(4096),
  dshPort: z.number().int().min(0).max(65_535),
  studioPort: z.number().int().min(0).max(65_535),
  runtimeRoot: z.string().max(4096),
}).strict()

const envelopeSchema = z.discriminatedUnion('encrypted', [
  z.object({ version: z.literal(1), encrypted: z.literal(true), payload: z.string().min(1) }).strict(),
  z.object({ version: z.literal(1), encrypted: z.literal(false), settings: settingsSchema }).strict(),
])

export type DesktopSettings = z.infer<typeof settingsSchema>

export interface SafeStoragePort {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

export interface SettingsStore {
  load(): Promise<DesktopSettings>
  save(settings: DesktopSettings): Promise<void>
}

export interface PathSelectionVault {
  select(field: RuntimePathField, path: string): { selectionId: string; label: string }
  expose(settings: DesktopSettings): PublicSettings
  consume(current: DesktopSettings, selections: Partial<Record<RuntimePathField, string>>, dshPort: number, studioPort: number): DesktopSettings
}

export function defaultSettings(): DesktopSettings {
  return { nodeExecutable: '', dshBin: '', gatewayEntry: '', dshHome: '', dshPort: 0, studioPort: 0, runtimeRoot: '' }
}

export function parseDesktopSettings(value: unknown): DesktopSettings {
  return settingsSchema.parse(value)
}

export function createSettingsStore(userData: string, safeStorage: SafeStoragePort): SettingsStore {
  const path = join(userData, 'desktop-settings.v1.json')
  return {
    async load() {
      try {
        const envelope = envelopeSchema.parse(JSON.parse(await readFile(path, 'utf8')))
        if (!envelope.encrypted) return envelope.settings
        if (!safeStorage.isEncryptionAvailable()) return defaultSettings()
        return settingsSchema.parse(JSON.parse(safeStorage.decryptString(Buffer.from(envelope.payload, 'base64'))))
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return defaultSettings()
        return defaultSettings()
      }
    },
    async save(settings) {
      const validated = settingsSchema.parse(settings)
      const envelope = safeStorage.isEncryptionAvailable()
        ? { version: 1 as const, encrypted: true as const, payload: safeStorage.encryptString(JSON.stringify(validated)).toString('base64') }
        : { version: 1 as const, encrypted: false as const, settings: validated }
      await mkdir(userData, { recursive: true })
      const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
      await writeFile(temporary, JSON.stringify(envelope), { encoding: 'utf8', mode: 0o600 })
      await rename(temporary, path)
    },
  }
}

export function createPathSelectionVault(): PathSelectionVault {
  const selections = new Map<string, { field: RuntimePathField; path: string }>()
  const register = (field: RuntimePathField, path: string) => {
    const selectionId = randomUUID()
    selections.set(selectionId, { field, path })
    return { selectionId, label: basename(path) || path.replace(/^.*[\\/]/u, '') || field }
  }
  return {
    select: register,
    expose(settings) {
      const exposed: PublicSettings['selections'] = {}
      for (const field of ['nodeExecutable', 'dshBin', 'gatewayEntry', 'dshHome', 'runtimeRoot'] as const) {
        if (settings[field]) exposed[field] = register(field, settings[field])
      }
      return publicSettingsSchema.parse({ selections: exposed, dshPort: settings.dshPort, studioPort: settings.studioPort })
    },
    consume(current, requested, dshPort, studioPort) {
      const next = { ...current, dshPort, studioPort }
      const consumed: string[] = []
      for (const field of ['nodeExecutable', 'dshBin', 'gatewayEntry', 'dshHome', 'runtimeRoot'] as const) {
        const id = requested[field]
        if (!id) continue
        const selected = selections.get(id)
        if (!selected || selected.field !== field) throw new Error(`Invalid ${field} selection`)
        next[field] = selected.path
        consumed.push(id)
      }
      const validated = settingsSchema.parse(next)
      for (const id of consumed) selections.delete(id)
      return validated
    },
  }
}
