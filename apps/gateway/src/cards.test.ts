import { describe, expect, it } from 'vitest'
import { discoverCards } from './cards.js'

describe('card discovery', () => {
  it('intersects user presets with valid matching manifests and hides paths', async () => {
    const diagnostics: string[] = []
    const cards = await discoverCards({
      listPresets: async () => [
        { id: 'rp-runtime', isDefault: false, name: '测试世界', description: 'desc' },
        { id: 'runtime-template', isDefault: false, name: 'RP Runtime 基础模板', description: 'template' },
        { id: 'stale', isDefault: false, name: 'stale', description: 'stale' },
        { id: 'standard', isDefault: true, name: 'system' },
        { id: 'broken', isDefault: false, name: 'broken', broken: 'invalid config' },
      ],
      readPreset: async id => ({ agentPreset: id, content: JSON.stringify(id === 'stale' ? { schemaVersion: 1, runtime: 'dsh-rp', id: 'wrong-id' } : {
        schemaVersion: 1, runtime: 'dsh-rp', id, kind: id === 'runtime-template' ? 'template' : 'card',
        title: id === 'runtime-template' ? 'RP Runtime 基础模板' : '测试世界',
        world: id === 'runtime-template' ? null : '测试区域', protagonist: id === 'runtime-template' ? null : '测试主角',
        art: id === 'runtime-template' ? 'runtime-template' : 'test-world', accent: id === 'runtime-template' ? 'graphite' : 'jade',
        prompt: { coreProfileIds: ['rp-narrative-base', ...(id === 'runtime-template' ? [] : ['test-world'])], optionalProfileIds: id === 'runtime-template' ? [] : ['dreamwhale-v3-agent'] },
      }) }),
    }, { onDiagnostic: message => diagnostics.push(message) })
    expect(cards).toEqual([
      {
        id: 'rp-runtime', title: '测试世界', description: 'desc', world: '测试区域', protagonist: '测试主角', art: 'test-world', accent: 'jade',
        prompt: { coreProfileIds: ['rp-narrative-base', 'test-world'], optionalProfileIds: ['dreamwhale-v3-agent'] },
      },
      {
        id: 'runtime-template', kind: 'template', title: 'RP Runtime 基础模板', description: 'template', world: '未配置世界', protagonist: '未配置角色', art: 'runtime-template', accent: 'graphite',
        prompt: { coreProfileIds: ['rp-narrative-base'], optionalProfileIds: [] },
      },
    ])
    expect(diagnostics).toEqual([])
  })
})
