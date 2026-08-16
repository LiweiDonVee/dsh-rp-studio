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
        currentDate: '1994-08-22',
        currentTime: '02:30',
        scene: {
          location: '营地',
          currentBeat: { title: '余烬', objectives: ['找到出口'] },
        },
        protagonist: {
          id: 'hero',
          name: '加斯帕',
          publicStatus: ['世界杯 MVP'],
          conditions: [{ label: '擦伤' }],
          hiddenNote: SECRET,
        },
        relationships: {
          ally: { id: 'ally', name: '安托万', trust: 78 },
          hidden: { id: 'spy', name: SECRET, visibility: 'hidden-canonical' },
        },
        faction: [{ id: 'team', name: '法国队' }],
        inventory: [{ id: 'wand', name: '魔杖' }],
        memories: {
          public: [{ id: 'm1', title: '夺冠' }],
          protagonist: [{ id: 'm2', title: '惊醒' }],
          private: [{ id: 'm3', title: SECRET }],
        },
        quests: { escape: { id: 'escape', title: '离开营地', status: 'active' } },
        eventLog: [{ kind: 'scene', summary: '火势蔓延' }],
        driver: { armed: false, objective: '', maxRounds: 8 },
        statusLines: ['1994-08-22 02:30', '营地'],
        economy: { galleons: 80 },
        potionResearch: {
          projects: {
            public: { name: '拉尚斯滴剂', visibility: 'protagonist-known' },
            private: { name: SECRET, visibility: ['hidden-canonical'] },
          },
        },
        storyAnchors: { future: SECRET },
        secrets: { plot: SECRET },
        offscreen: { events: [SECRET] },
        backendAudit: { trace: SECRET },
      },
    })

    expect(state.relationships).toEqual([{ id: 'ally', name: '安托万', trust: 78 }])
    expect(state.memories).toHaveLength(2)
    expect(state.quests).toHaveLength(1)
    expect(state.checkpoints).toEqual({ count: 2, canRollback: true, activeTurn: 2 })
    expect(state.extensions).toHaveProperty('economy')
    expect(state.extensions).toHaveProperty('potionResearch')
    expect(state.extensions).not.toHaveProperty('storyAnchors')
    expect(JSON.stringify(state)).not.toContain(SECRET)
    expect(JSON.stringify(state)).not.toContain('secrets')
    expect(JSON.stringify(state)).not.toContain('offscreen')
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
            { type: 'tool-call', id: 'call', name: 'lookup_world', arguments: `{\"secret\":\"${SECRET}\"}` },
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
