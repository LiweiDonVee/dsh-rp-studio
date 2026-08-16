import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { discoverCards } from './cards.js'

describe('card discovery', () => {
  it('intersects user presets with valid matching manifests and hides paths', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-rp-card-'))
    await mkdir(join(home, '.agent-presets', 'rp-runtime'), { recursive: true })
    await mkdir(join(home, '.agent-presets', 'stale'), { recursive: true })
    await writeFile(join(home, '.agent-presets', 'rp-runtime', 'rp-card.json'), JSON.stringify({
      schemaVersion: 1, runtime: 'dsh-rp', id: 'rp-runtime', title: '魔药宗师', world: '营地', protagonist: '加斯帕', art: 'potion-master', accent: 'jade',
    }))
    await writeFile(join(home, '.agent-presets', 'stale', 'rp-card.json'), JSON.stringify({
      schemaVersion: 1, runtime: 'dsh-rp', id: 'wrong-id', title: '错误', world: 'x', protagonist: 'y', art: 'x', accent: 'jade',
    }))
    const cards = await discoverCards({
      listPresets: async () => [
        { id: 'rp-runtime', trust: 'user', description: 'desc' },
        { id: 'stale', trust: 'user', description: 'stale' },
        { id: 'standard', trust: 'system' },
        { id: 'broken', trust: 'user', broken: 'invalid config' },
      ],
    }, { dshHome: home })
    expect(cards).toEqual([{ id: 'rp-runtime', title: '魔药宗师', description: 'desc', world: '营地', protagonist: '加斯帕', art: 'potion-master', accent: 'jade' }])
    expect(JSON.stringify(cards)).not.toContain(home)
  })
})
