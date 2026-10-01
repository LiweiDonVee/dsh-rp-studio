import { cardSchema, type Card } from '@dsh-rp/protocol'
import type { DshPresetEntry, DshPresetDocument } from './dsh/client.js'

const SAFE_PRESET_ID = /^[a-z0-9][a-z0-9-]*$/u
const RP_RUNTIME_MARKER = /(?:rp-runtime|rp-context-runtime|runtime:\s*dsh-rp)/u

export interface CardManifest {
  schemaVersion: number
  runtime: string
  id: string
  kind?: 'card' | 'template'
  title: string
  world: string | null
  protagonist: string | null
  art: string
  accent: Card['accent']
  description?: string
  prompt?: Card['prompt']
}

export interface PresetRoster {
  listPresets(): Promise<DshPresetEntry[]>
  readPreset(agentPreset: string): Promise<DshPresetDocument>
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function parseSyntheticCardMetadata(document: DshPresetDocument, preset: DshPresetEntry): CardManifest | undefined {
  let value: unknown
  try { value = JSON.parse(document.content) } catch { return undefined }
  const raw = record(value)
  if (!raw || raw.runtime !== 'dsh-rp' || raw.schemaVersion !== 1 || raw.id !== preset.id) return undefined
  if (typeof raw.title !== 'string' || (typeof raw.world !== 'string' && raw.world !== null) || (typeof raw.protagonist !== 'string' && raw.protagonist !== null) || typeof raw.art !== 'string' || typeof raw.accent !== 'string') return undefined
  return raw as unknown as CardManifest
}

function genericCard(preset: DshPresetEntry, document: DshPresetDocument): Card | undefined {
  if (!RP_RUNTIME_MARKER.test(document.content)) return undefined
  const template = preset.id === 'rp-runtime'
  return cardSchema.parse({
    id: preset.id,
    ...(template ? { kind: 'template' as const } : {}),
    title: preset.name ?? preset.id,
    description: preset.description ?? 'DSH RP plugin bundle',
    world: template ? '未配置世界' : 'DSH RP 世界',
    protagonist: template ? '未配置角色' : '玩家',
    art: preset.id,
    accent: template ? 'graphite' : 'jade',
  })
}

export async function discoverCards(
  roster: PresetRoster,
  options: { onDiagnostic?: (message: string) => void } = {},
): Promise<Card[]> {
  const diagnose = options.onDiagnostic ?? ((message: string) => process.stderr.write(`[DSH RP Studio] ${message}\n`))
  const presets = await roster.listPresets()
  const cards: Card[] = []
  for (const preset of presets) {
    if (preset.broken || !SAFE_PRESET_ID.test(preset.id)) continue
    if (preset.isDefault && preset.id !== 'standard' && !preset.id.includes('card') && preset.id !== 'rp-runtime') continue
    if (preset.isDefault && preset.id === 'standard') continue
    try {
      const document = await roster.readPreset(preset.id)
      const manifest = parseSyntheticCardMetadata(document, preset)
      if (manifest) {
        const template = manifest.kind === 'template'
        if (!template && (!manifest.world?.trim() || !manifest.protagonist?.trim())) {
          diagnose(`Ignored invalid RP bundle metadata for preset "${preset.id}".`)
          continue
        }
        cards.push(cardSchema.parse({
          id: manifest.id,
          ...(template ? { kind: 'template' as const } : {}),
          title: manifest.title,
          description: manifest.description ?? preset.description ?? 'DSH RP plugin bundle',
          world: template ? '未配置世界' : manifest.world,
          protagonist: template ? '未配置角色' : manifest.protagonist,
          art: manifest.art,
          accent: manifest.accent,
          ...(manifest.prompt ? { prompt: manifest.prompt } : {}),
        }))
        continue
      }
      const card = genericCard(preset, document)
      if (card) cards.push(card)
    } catch {
      diagnose(`Ignored unreadable RP bundle "${preset.id}".`)
    }
  }
  return cards.sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'))
}
