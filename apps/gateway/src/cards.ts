import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { cardSchema, type Card } from '@dsh-rp/protocol'
import type { DshPresetEntry } from './dsh/client.js'

const SAFE_PRESET_ID = /^[a-z0-9][a-z0-9-]*$/u

export interface CardManifest {
  schemaVersion: number
  runtime: string
  id: string
  title: string
  world: string
  protagonist: string
  art: string
  accent: Card['accent']
  description?: string
}

export interface PresetRoster {
  listPresets(): Promise<DshPresetEntry[]>
}

export async function discoverCards(
  roster: PresetRoster,
  options: { dshHome?: string; onDiagnostic?: (message: string) => void } = {},
): Promise<Card[]> {
  const home = options.dshHome ?? process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh')
  const diagnose = options.onDiagnostic ?? ((message: string) => process.stderr.write(`[DSH RP Studio] ${message}\n`))
  const presets = await roster.listPresets()
  const cards: Card[] = []
  for (const preset of presets) {
    if (preset.trust !== 'user' || preset.broken || !SAFE_PRESET_ID.test(preset.id)) continue
    try {
      const raw = JSON.parse(await readFile(join(home, '.agent-presets', preset.id, 'rp-card.json'), 'utf8')) as CardManifest
      if (raw.id !== preset.id || raw.runtime !== 'dsh-rp' || raw.schemaVersion !== 1) {
        diagnose(`Ignored invalid RP manifest for preset "${preset.id}".`)
        continue
      }
      cards.push(cardSchema.parse({
        id: raw.id,
        title: raw.title,
        description: raw.description ?? preset.description ?? `${raw.world} · ${raw.protagonist}`,
        world: raw.world,
        protagonist: raw.protagonist,
        art: raw.art,
        accent: raw.accent,
      }))
    } catch (error) {
      const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined
      if (code !== 'ENOENT') diagnose(`Ignored unreadable RP manifest for preset "${preset.id}".`)
    }
  }
  return cards.sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'))
}
