import { homedir } from 'node:os'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { cardSchema, type Card } from '@dsh-rp/protocol'
import type { DshPresetEntry } from './dsh/client.js'

const SAFE_PRESET_ID = /^[a-z0-9][a-z0-9-]*$/u

export interface CardManifest {
  schemaVersion: number
  runtime: string
  id: string
  kind?: 'card' | 'template'
  title: string
  world: string | null
  protagonist: string | null
  art?: string
  accent: Card['accent']
  description?: string
}

interface PromptManifest {
  schemaVersion: number
  cardId: string
  baseProfiles?: unknown
  cardProfiles?: unknown
  optionalProfiles?: unknown
}

export interface PresetRoster {
  listPresets(): Promise<DshPresetEntry[]>
}

export async function discoverCards(
  roster: PresetRoster,
  options: { dshHome?: string; onDiagnostic?: (message: string) => void } = {},
): Promise<Card[]> {
  const home = options.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
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
      const template = raw.kind === 'template'
      if (!template && (!raw.world?.trim() || !raw.protagonist?.trim())) {
        diagnose(`Ignored invalid RP manifest for preset "${preset.id}".`)
        continue
      }
      let prompt: Card['prompt']
      try {
        const manifest = JSON.parse(await readFile(join(home, '.agent-presets', preset.id, 'prompt-manifest.json'), 'utf8')) as PromptManifest
        const baseProfiles = Array.isArray(manifest.baseProfiles) ? manifest.baseProfiles : []
        const cardProfiles = Array.isArray(manifest.cardProfiles) ? manifest.cardProfiles : []
        const optionalProfiles = Array.isArray(manifest.optionalProfiles) ? manifest.optionalProfiles : []
        const profileIds = [...baseProfiles, ...cardProfiles, ...optionalProfiles]
        if (manifest.schemaVersion !== 1 || manifest.cardId !== preset.id || profileIds.some(id => typeof id !== 'string' || !SAFE_PRESET_ID.test(id))) {
          diagnose(`Ignored invalid prompt manifest for preset "${preset.id}".`)
        } else {
          prompt = {
            coreProfileIds: [...new Set([...baseProfiles, ...cardProfiles] as string[])],
            optionalProfileIds: [...new Set(optionalProfiles as string[])],
          }
        }
      } catch (error) {
        const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined
        if (code !== 'ENOENT') diagnose(`Ignored unreadable prompt manifest for preset "${preset.id}".`)
      }
      cards.push(cardSchema.parse({
        id: raw.id,
        ...(template ? { kind: 'template' as const } : {}),
        title: raw.title,
        description: raw.description ?? preset.description ?? (template ? '卡片无关的 RP 运行时基础模板' : `${raw.world} · ${raw.protagonist}`),
        world: template ? '未配置世界' : raw.world,
        protagonist: template ? '未配置角色' : raw.protagonist,
        art: raw.art ?? raw.id,
        accent: raw.accent,
        ...(prompt ? { prompt } : {}),
      }))
    } catch (error) {
      const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined
      if (code !== 'ENOENT') diagnose(`Ignored unreadable RP manifest for preset "${preset.id}".`)
    }
  }
  return cards.sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'))
}
