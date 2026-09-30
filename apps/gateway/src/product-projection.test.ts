import { describe, expect, it } from 'vitest'
import type { SessionDetail } from '@dsh-rp/protocol'
import { toProductProjection } from './product-projection.js'
import { projectPublicState } from '@dsh-rp/domain'

const detail = {
  session: { id: 'session-7', cardId: 'sample-world', title: '档案', updatedAt: 1, running: false, blank: false },
  card: { id: 'sample-world', title: '世界', description: '', world: '虚构世界', protagonist: '玩家', art: 'sample-world', accent: 'crimson' },
  messages: [],
  state: {
    started: true,
    scene: { region: '北区', location: '旧港口' },
    memories: [{ id: 'memory-1', text: '看见灯塔', emotion: '警惕' }],
    relationships: [{ id: 'edge-1', subject: '玩家', object: '守卫', relation: '互信', status: '谨慎' }],
    faction: [], inventory: [], quests: [], eventLog: [], statusLines: [], extensions: {}, checkpoints: { count: 0, canRollback: false, activeTurn: null },
  },
} satisfies SessionDetail

describe('public product projection', () => {
  it('uses the official source cursor and replaces the whole branch snapshot', () => {
    const projection = toProductProjection(detail, 'branch-7', 44)
    expect(projection).toMatchObject({ branchId: 'branch-7', fromSeq: 0 })
    expect(projection.memories[0]).toMatchObject({ sourceSeq: 44, text: '看见灯塔', emotion: '警惕' })
    expect(projection.relationships[0]).toMatchObject({ sourceSeq: 44, object: '守卫' })
    expect(projection.locations[0]).toMatchObject({ sourceSeq: 44, world: '虚构世界', region: '北区', scene: '旧港口' })
  })

  it('returns legal empty read models when public fields are absent', () => {
    const { scene: _scene, ...state } = detail.state
    const projection = toProductProjection({ ...detail, state: { ...state, memories: [], relationships: [] } }, 'branch-7', 45)
    expect(projection).toEqual({ branchId: 'branch-7', fromSeq: 0, memories: [], relationships: [], locations: [] })
  })

  it('maps the two card public-state relationship shapes without inventing hidden facts', () => {
    const sample = { ...detail, state: projectPublicState({ game: { started: true, scene: { location: '封锁走廊' }, relationships: [{ id: 'r1', name: '阿莫斯', status: '谨慎信任' }], memories: [{ id: 'm1', title: '抵达', summary: '黄昏前抵达当前区域。' }], statusLines: [] } }) }
    const potion = {
      ...detail,
      session: { ...detail.session, id: 'session-potion', cardId: 'sample-potions' },
      card: { ...detail.card, id: 'sample-potions', title: '演示档案', world: '示例世界', protagonist: '测试玩家', art: 'sample-potions', accent: 'jade' as const },
      state: projectPublicState({ game: { started: true, scene: { region: '营地', location: '工作室' }, relationships: [{ id: 'mentor', name: '导师', trust: 72, visibility: 'protagonist-known' }], memories: [{ id: 'recipe', title: '记录', summary: '已掌握公开记录。', visibility: 'public' }], statusLines: [] } }),
    }
    const sampleProjection = toProductProjection(sample, 'session-7', 50)
    const potionProjection = toProductProjection(potion, 'session-potion', 51)
    expect(sampleProjection.relationships[0]).toMatchObject({ subject: '玩家', object: '阿莫斯', relation: '谨慎信任' })
    expect(sampleProjection.memories[0]?.text).toBe('黄昏前抵达当前区域。')
    expect(potionProjection.relationships[0]).toMatchObject({ subject: '测试玩家', object: '导师', relation: 'trust', status: '72' })
    expect(potionProjection.locations[0]).toMatchObject({ region: '营地', scene: '工作室' })
  })
})
