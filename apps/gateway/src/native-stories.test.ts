import { describe, expect, it } from 'vitest'
import { nativeTranscript, storyPublicState } from './native-stories.js'

const ref = { sessionId: 'story', presentationId: 'prose', assistantMessageId: 'assistant', callSeq: 2, baseResultSeq: 3, resultSeq: 9 }
const narrative = { id: '["prose",9]', ref, turn: 1, action: '开门', text: '采用的正文。' }
describe('native owner projection boundaries', () => {
  it('does not revive fallback receipt text when the owner excludes its canonical root', async () => {
    const fallback = [{ id: 'prose', seq: 3, role: 'gm' as const, text: '过期正文。', status: 'complete' as const, createdAt: 1 }]
    expect(await nativeTranscript({ narratives: async () => ({ records: [] }) }, 'story', fallback, ['prose'])).toEqual([])
  })
  it.each(['foreign-session', 'bad-ref', 'wrong-revision-key'])('rejects malformed owner narrative identity (%s)', invalid => {
    const item = structuredClone(narrative)
    if (invalid === 'foreign-session') item.ref.sessionId = 'other'
    if (invalid === 'bad-ref') item.ref.resultSeq = 1
    if (invalid === 'wrong-revision-key') item.id = 'prose'
    return expect(nativeTranscript({ narratives: async () => ({ records: [item] }) }, 'story', [])).rejects.toThrow(/来源无效/u)
  })
  it('projects only the frozen public GM fields instead of arbitrary owner payload fields', () => {
    const state = storyPublicState({ binding: { schemaVersion: 1, id: 'binding', sessionId: 'story', title: '港口', status: 'active', character: { assetId: 'actor', version: 1, name: '林', private: 'PRIVATE_CANARY' }, persona: { assetId: 'persona', version: 1, name: '玩家' } }, scene: { schemaVersion: 1, title: '抵港', location: '码头', presentActorIds: [], private: 'PRIVATE_CANARY' }, facts: { schemaVersion: 1, items: [{ id: 'f1', text: '船已到港。', hidden: 'PRIVATE_CANARY' }] }, capabilities: { rollback: false, fork: true, autoplay: false } } as unknown as Parameters<typeof storyPublicState>[0])
    expect(JSON.stringify(state)).not.toContain('PRIVATE_CANARY')
    expect(state.extensions.gm).toMatchObject({ facts: { items: [{ id: 'f1', text: '船已到港。' }] } })
  })
})
