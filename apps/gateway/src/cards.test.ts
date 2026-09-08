import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { discoverCards } from './cards.js'

describe('card discovery', () => {
  it('returns no defaults when DSH has no registered user presets', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-rp-empty-'))
    expect(await discoverCards({ listPresets: async () => [] }, { dshHome: home })).toEqual([])
  })

  it('requires registration and accepts a user manifest without artwork or prompt profiles', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-rp-user-'))
    const preset = join(home, '.agent-presets', 'fixture-card')
    await mkdir(preset, { recursive: true })
    await writeFile(join(preset, 'rp-card.json'), JSON.stringify({
      schemaVersion: 1, runtime: 'dsh-rp', id: 'fixture-card',
      title: 'Synthetic card', world: 'Synthetic world', protagonist: 'Synthetic actor', accent: 'graphite',
    }))
    expect(await discoverCards({ listPresets: async () => [] }, { dshHome: home })).toEqual([])
    expect(await discoverCards({ listPresets: async () => [{ id: 'fixture-card', trust: 'user' }] }, { dshHome: home }))
      .toMatchObject([{ id: 'fixture-card', art: 'fixture-card' }])
  })

  it('intersects user presets with valid matching manifests and hides paths', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-rp-card-'))
    await mkdir(join(home, '.agent-presets', 'rp-runtime'), { recursive: true })
    await mkdir(join(home, '.agent-presets', 'runtime-template'), { recursive: true })
    await mkdir(join(home, '.agent-presets', 'stale'), { recursive: true })
    await writeFile(join(home, '.agent-presets', 'rp-runtime', 'rp-card.json'), JSON.stringify({
      schemaVersion: 1, runtime: 'dsh-rp', id: 'rp-runtime', title: '测试世界', world: '测试区域', protagonist: '测试主角', art: 'test-world', accent: 'jade',
    }))
    await writeFile(join(home, '.agent-presets', 'rp-runtime', 'prompt-manifest.json'), JSON.stringify({
      schemaVersion: 1,
      cardId: 'rp-runtime',
      baseProfiles: ['rp-narrative-base'],
      cardProfiles: ['test-world'],
      optionalProfiles: ['fixture-profile'],
    }))
    await writeFile(join(home, '.agent-presets', 'runtime-template', 'rp-card.json'), JSON.stringify({
      schemaVersion: 1, runtime: 'dsh-rp', id: 'runtime-template', kind: 'template', title: 'RP Runtime 基础模板',
      world: null, protagonist: null, art: 'runtime-template', accent: 'graphite',
    }))
    await writeFile(join(home, '.agent-presets', 'runtime-template', 'prompt-manifest.json'), JSON.stringify({
      schemaVersion: 1, cardId: 'runtime-template', baseProfiles: ['rp-narrative-base'], cardProfiles: [], optionalProfiles: [],
    }))
    await writeFile(join(home, '.agent-presets', 'stale', 'rp-card.json'), JSON.stringify({
      schemaVersion: 1, runtime: 'dsh-rp', id: 'wrong-id', title: '错误', world: 'x', protagonist: 'y', art: 'x', accent: 'jade',
    }))
    const diagnostics: string[] = []
    const cards = await discoverCards({
      listPresets: async () => [
        { id: 'rp-runtime', trust: 'user', description: 'desc' },
        { id: 'runtime-template', trust: 'user', description: 'template' },
        { id: 'stale', trust: 'user', description: 'stale' },
        { id: 'standard', trust: 'system' },
        { id: 'broken', trust: 'user', broken: 'invalid config' },
      ],
    }, { dshHome: home, onDiagnostic: message => diagnostics.push(message) })
    expect(cards).toEqual([
      {
        id: 'rp-runtime', title: '测试世界', description: 'desc', world: '测试区域', protagonist: '测试主角', art: 'test-world', accent: 'jade',
        prompt: { coreProfileIds: ['rp-narrative-base', 'test-world'], optionalProfileIds: ['fixture-profile'] },
      },
      {
        id: 'runtime-template', kind: 'template', title: 'RP Runtime 基础模板', description: 'template', world: '未配置世界', protagonist: '未配置角色', art: 'runtime-template', accent: 'graphite',
        prompt: { coreProfileIds: ['rp-narrative-base'], optionalProfileIds: [] },
      },
    ])
    expect(JSON.stringify(cards)).not.toContain(home)
    expect(diagnostics).toEqual(['Ignored invalid RP manifest for preset "stale".'])
    expect(JSON.stringify(diagnostics)).not.toContain(home)
  })
})
