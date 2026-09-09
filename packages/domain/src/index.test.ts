import { describe, expect, it } from 'vitest'
import { foldSurface, projectPublicState, toTranscript, type RawSessionEvent } from './index.js'

const SECRET = 'CANARY_DO_NOT_LEAK_7f3a'

function event(
  seq: number,
  type: string,
  data: Record<string, unknown>,
  surfaceOp?: RawSessionEvent['surfaceOp'],
): RawSessionEvent {
  return { seq, time: 1_700_000_000_000 + seq, type, data, ...(surfaceOp ? { surfaceOp } : {}) }
}

describe('surface folding', () => {
  it('applies append and replace operations by durable event sequence', () => {
    const events = [
      event(0, 'user/message', { id: 'u1' }, 'append'),
      event(1, 'assistant/message', { message: { id: 'a1' } }, 'append'),
      event(2, 'tool/result', { message: { id: 't1' } }, 'append'),
      event(3, 'user/message', { id: 'u2' }, 'append'),
      event(4, 'assistant/message', { message: { id: 'a2' } }, 'append'),
      event(5, 'user/message', { id: 'notice' }, { op: 'replace', start: 1, end: 2 }),
    ]

    expect(foldSurface(events).map(item => item.seq)).toEqual([0, 5, 3, 4])
  })
})

describe('player-safe state projection', () => {
  it.each(['secret', 'PRIVATE', ['scene-public', 'GM-ONLY'], 'offscreen', 'hidden-canonical'])('filters hidden containers before selecting their public fields (%j)', visibility => {
    const state = projectPublicState({ game: {
      scene: { visibility, location: SECRET, region: SECRET },
      protagonist: { visibility, name: SECRET, background: SECRET },
      driver: { visibility, objective: SECRET, armed: true },
      memories: { visibility, public: [{ text: SECRET }] },
      relationships: { visibility, ally: { name: SECRET } },
    } })
    expect(state.scene).toBeUndefined()
    expect(state.protagonist).toBeUndefined()
    expect(state.driver).toBeUndefined()
    expect(state.memories).toEqual([])
    expect(state.relationships).toEqual([])
    expect(JSON.stringify(state)).not.toContain(SECRET)
  })

  it('filters hidden beats and boolean-marked containers inside otherwise public scenes', () => {
    const state = projectPublicState({ game: {
      scene: { visibility: 'scene-public', location: '站台', currentBeat: { private: true, title: SECRET }, completedBeats: [{ hidden: true, title: SECRET }] },
      protagonist: { private: true, name: SECRET },
    } })
    expect(state.scene).toEqual({ location: '站台' })
    expect(state.protagonist).toBeUndefined()
    expect(JSON.stringify(state)).not.toContain(SECRET)
  })

  it('normalizes public collections and rejects every private canary path', () => {
    const state = projectPublicState({
      meta: {
        checkpoints: [
          { id: 'one', turn: 1, parentId: null, snapshot: { secrets: SECRET } },
          { id: 'two', turn: 2, parentId: 'one', snapshot: { offscreen: SECRET } },
        ],
        activeCheckpointId: 'two',
        history: [{ snapshot: SECRET }],
      },
      commit: { tool: SECRET },
      game: {
        schemaVersion: 2,
        started: true,
        currentDate: '2032-04-11',
        currentTime: '18:30',
        scene: {
          location: '雾港车站',
          currentBeat: { title: '断电', objectives: ['找到出口'] },
        },
        protagonist: {
          id: 'hero',
          name: '测试主角',
          publicStatus: ['调查员'],
          conditions: [{ label: '擦伤' }],
          hiddenNote: SECRET,
        },
        relationships: {
          ally: { id: 'ally', name: '林安', trust: 78 },
          hidden: { id: 'spy', name: SECRET, visibility: 'hidden-canonical' },
        },
        faction: [{ id: 'team', name: '救援队' }],
        inventory: [{ id: 'flashlight', name: '手电筒' }],
        memories: {
          public: [{ id: 'm1', title: '车站关闭' }],
          protagonist: [{ id: 'm2', title: '收到警报' }],
          private: [{ id: 'm3', title: SECRET }],
        },
        quests: { escape: { id: 'escape', title: '离开车站', status: 'active' } },
        eventLog: [{ kind: 'scene', summary: '停电范围扩大' }],
        driver: { armed: false, objective: '', maxRounds: 8 },
        statusLines: ['2032-04-11 18:30', '雾港车站'],
        economy: { credits: 80 },
        researchNotebook: { public: { title: '车站调查' } },
        storyAnchors: { future: SECRET },
        secrets: { plot: SECRET },
        offscreen: { events: [SECRET] },
        backendAudit: { trace: SECRET },
      },
    })

    expect(state.relationships).toEqual([{ id: 'ally', name: '林安', trust: 78 }])
    expect(state.memories).toHaveLength(2)
    expect(state.quests).toHaveLength(1)
    expect(state.checkpoints).toEqual({ count: 2, canRollback: true, activeTurn: 2 })
    expect(state.extensions).toHaveProperty('economy')
    expect(state.extensions).not.toHaveProperty('researchNotebook')
    expect(state.extensions).not.toHaveProperty('storyAnchors')
    expect(JSON.stringify(state)).not.toContain(SECRET)
    expect(JSON.stringify(state)).not.toContain('secrets')
    expect(JSON.stringify(state)).not.toContain('offscreen')
  })

  it('reports rollback depth from the active checkpoint lineage', () => {
    const state = projectPublicState({
      game: { started: true, statusLines: [] },
      meta: {
        checkpoints: [
          { id: 'one', turn: 1, parentId: null, snapshot: {} },
          { id: 'two', turn: 2, parentId: 'one', snapshot: {} },
          { id: 'three', turn: 3, parentId: 'two', snapshot: {} },
        ],
        activeCheckpointId: 'two',
      },
    })

    expect(state.checkpoints).toEqual({ count: 2, canRollback: true, activeTurn: 2 })
  })

  it('drops explicit private visibility markers while preserving public labels and legacy public records', () => {
    const state = projectPublicState({
      game: {
        started: true,
        statusLines: [],
        relationships: [
          { id: 'legacy', name: '旧盟友', trust: 4 },
          { id: 'public', name: '公开盟友', visibility: 'scene-public' },
          { id: 'known', name: '已知盟友', visibility: ['PUBLIC', 'protagonist-known'] },
          { id: 'private', summary: SECRET, visibility: 'PrIvAtE' },
          { id: 'secret', summary: SECRET, visibility: ['public', 'SECRET'] },
          { id: 'gm', summary: SECRET, visibility: 'GM-ONLY' },
          { id: 'offscreen', summary: SECRET, visibility: 'offscreen' },
          { id: 'hidden-flag', summary: SECRET, hidden: true },
          { id: 'private-flag', summary: SECRET, private: true },
        ],
      },
    })

    expect(state.relationships.map(item => item.id)).toEqual(['legacy', 'public', 'known'])
    expect(JSON.stringify(state)).not.toContain(SECRET)
  })
})

describe('transcript projection', () => {
  it('keeps only player text and GM prose from the folded surface', () => {
    const events = [
      event(0, 'user/message', {
        id: 'player-1', role: 'user', source: { kind: 'user' },
        content: [{ type: 'text', text: '我走出帐篷。' }],
      }, 'append'),
      event(1, 'assistant/message', {
        turn: 1, step: 1,
        message: {
          id: 'gm-1', role: 'assistant', source: { kind: 'model', provider: 'x', model: 'y' },
          content: [
            { type: 'reasoning', text: SECRET },
            { type: 'text', text: '冷风卷着灰烬扑来。' },
            { type: 'tool-call', id: 'call', name: 'lookup_world', arguments: `{"secret":"${SECRET}"}` },
          ],
        },
      }, 'append'),
      event(2, 'tool/result', {
        meta: { rp: { secrets: SECRET } },
        message: { id: 'result', content: [{ type: 'tool-result', content: [{ type: 'text', text: SECRET }] }] },
      }, 'append'),
      event(3, 'user/message', {
        id: 'control', role: 'user', source: { kind: 'plugin', plugin: 'dsh-rp-runtime' },
        content: [{ type: 'text', text: SECRET }],
      }, 'append'),
    ]

    const messages = toTranscript(foldSurface(events))
    expect(messages.map(message => [message.role, message.text])).toEqual([
      ['player', '我走出帐篷。'],
      ['gm', '冷风卷着灰烬扑来。'],
    ])
    expect(JSON.stringify(messages)).not.toContain(SECRET)
  })
})
