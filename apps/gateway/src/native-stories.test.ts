import { describe, expect, it, vi } from 'vitest'
import { nativeReading, nativeTranscript, storyPublicState } from './native-stories.js'
import capturedEmptyLegacyHistory from './fixtures/last-step-empty-legacy-history.json'

const ref = { sessionId: 'story', presentationId: 'prose', assistantMessageId: 'assistant', callSeq: 2, baseResultSeq: 3, resultSeq: 9 }
const narrative = { id: '["prose",9]', ref, turn: 1, action: '开门', text: '采用的正文。' }
const emptyLegacyHistory = { ...capturedEmptyLegacyHistory, schemaVersion: 1 as const }
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
  it.each([false, true])('never revives folded prose before current facts have writing (pending=%s)', async pendingFacts => {
    const fallback = [{ id: 'player', seq: 0, role: 'player' as const, text: '开门', status: 'complete' as const, createdAt: 1 }, { id: 'prose', seq: 3, role: 'gm' as const, text: '旧事实正文', status: 'complete' as const, createdAt: 1 }]
    const service = { capabilities: { narrativeRevisions: 1 }, narratives: async () => ({ records: [narrative] }), storyHistory: async () => ({ schemaVersion: 1 as const, records: [], folded: [{ groupId: 'round', activeFactReceiptId: 'fact-new', selectedPresentationId: null, pendingFacts, versions: [{ presentationId: 'prose', resultSeq: 9 }] }], projectionKey: 'selected-new-facts' }) }
    expect(await nativeTranscript(service, 'story', fallback, [], { isPureLegacy: async () => true })).toEqual([fallback[0]])
  })
  it('keeps a valid selected effective record authoritative without checking legacy eligibility', async () => {
    const fallback = [{ id: 'gm-old', seq: 0, role: 'gm' as const, text: '旧正文。', status: 'complete' as const, createdAt: 1 }]
    const history = { schemaVersion: 1 as const, records: [narrative], folded: [{ groupId: 'prose', activeFactReceiptId: null, selectedPresentationId: 'prose', pendingFacts: false, versions: [{ presentationId: 'prose', resultSeq: 9 }] }], projectionKey: 'typed-consumer-selection' }
    const isPureLegacy = vi.fn(async () => true)
    expect(await nativeReading({ capabilities: { narrativeRevisions: 1 }, storyHistory: async () => history }, 'story', fallback, [], { isPureLegacy })).toMatchObject({ messages: [{ id: '["prose",9]', text: '采用的正文。' }], history })
    expect(isPureLegacy).not.toHaveBeenCalled()
  })
  it.each(['unconfirmed', 'canonical', 'versioned'])('keeps empty effective selection authoritative for %s sources', async source => {
    const fallback = [{ id: 'prose', seq: 3, role: 'gm' as const, text: '不得复活的正文。', status: 'complete' as const, createdAt: 1 }]
    const service = { capabilities: { narrativeRevisions: 1 }, storyHistory: async () => structuredClone(emptyLegacyHistory) }
    const options = source === 'unconfirmed' ? {} : { isPureLegacy: async () => true, hasVersionedRecords: source === 'versioned' }
    expect(await nativeTranscript(service, 'story', fallback, source === 'canonical' ? ['prose'] : [], options)).toEqual([])
  })
  it.each(['schema', 'folded', 'records', 'foreign-source'])('rejects malformed effective owner DTOs before allowing legacy prose (%s)', async invalid => {
    const value: Record<string, unknown> = structuredClone(emptyLegacyHistory)
    if (invalid === 'schema') value.schemaVersion = 2
    if (invalid === 'folded') value.folded = null
    if (invalid === 'records') value.records = undefined
    if (invalid === 'foreign-source') value.records = [{ ...narrative, ref: { ...ref, sessionId: 'other' } }]
    const isPureLegacy = vi.fn(async () => true)
    const service = { capabilities: { narrativeRevisions: 1 }, storyHistory: async () => value } as unknown as NonNullable<Parameters<typeof nativeReading>[0]>
    await expect(nativeReading(service, 'story', [], [], { isPureLegacy })).rejects.toMatchObject({ apiError: { code: 'upstream-protocol' } })
    expect(isPureLegacy).not.toHaveBeenCalled()
  })
  it.each(['NOT_BOUND', 'PERMISSION_DENIED', 'SOURCE_CORRUPT'])('propagates effective owner %s without a legacy retry', async code => {
    const error = Object.assign(new Error(code), { code })
    const isPureLegacy = vi.fn(async () => true)
    const service = { capabilities: { narrativeRevisions: 1 }, storyHistory: async () => { throw error } }
    await expect(nativeReading(service, 'story', [], [], { isPureLegacy })).rejects.toBe(error)
    expect(isPureLegacy).not.toHaveBeenCalled()
  })
  it('does not fall back to canonical narratives after an effective reader fails', async () => {
    const service = { capabilities: { narrativeRevisions: 1 }, narratives: async () => ({ records: [narrative] }), storyHistory: async () => { throw Object.assign(new Error('database missing'), { code: 'EFFECTIVE_HISTORY_UNAVAILABLE' }) } }
    await expect(nativeTranscript(service, 'story', [])).rejects.toMatchObject({ apiError: { upstreamCode: 'EFFECTIVE_HISTORY_UNAVAILABLE' } })
  })
  it('requires an effective reader for actual versioned canonical records even without advertised capabilities', async () => {
    const service = { narratives: async () => ({ records: [{ ...narrative, narrativeVersion: { schemaVersion: 1, groupId: 'round', kind: 'original' } }] }) }
    await expect(nativeTranscript(service, 'story', [])).rejects.toMatchObject({ apiError: { upstreamCode: 'EFFECTIVE_HISTORY_UNAVAILABLE' } })
  })
  it('requires effective reading for captured facts before their first canonical prose exists', async () => {
    const database = { capabilities: { factReview: 1 }, factReviewProjection: async () => ({ schemaVersion: 1, latestRoundId: 'round', groups: [{ roundId: 'round', activeReceiptId: 'fact', pendingCandidateId: null, factRevision: 1 }] }) }
    await expect(nativeTranscript(undefined, 'story', [], [], { database })).rejects.toMatchObject({ apiError: { upstreamCode: 'EFFECTIVE_HISTORY_UNAVAILABLE' } })
  })
  it('keeps legacy reading with a real empty projection and propagates projection authorization errors', async () => {
    const service = { narratives: async () => ({ records: [narrative] }) }
    const database = { capabilities: { factReview: 1 }, factReviewProjection: async () => ({ schemaVersion: 1, latestRoundId: null, groups: [] }) }
    expect(await nativeTranscript(service, 'story', [], [], { database })).toMatchObject([{ text: '采用的正文。' }])
    database.factReviewProjection = async () => { throw Object.assign(new Error('not authorized'), { code: 'PERMISSION_DENIED' }) }
    await expect(nativeTranscript(service, 'story', [], [], { database })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
  })
  it('carries only recorded current receipt identity for the Studio legacy eligibility explanation', () => {
    const state = storyPublicState({ binding: { schemaVersion: 1, id: 'binding', sessionId: 'story', title: '港口', status: 'active', character: { assetId: 'actor', version: 1, name: '林' }, persona: { assetId: 'persona', version: 1, name: '玩家' } }, scene: { schemaVersion: 1, title: '抵港', location: '码头', presentActorIds: [] }, facts: { schemaVersion: 1, items: [] }, lastFactReceipt: { id: 'legacy', kind: 'turn', privateData: 'PRIVATE_CANARY' }, capabilities: { rollback: false, fork: false, autoplay: false } } as unknown as Parameters<typeof storyPublicState>[0])
    expect(state.extensions.gm).toMatchObject({ lastFactReceipt: { id: 'legacy', kind: 'turn' } })
    expect(JSON.stringify(state)).not.toContain('PRIVATE_CANARY')
  })
  it.each([undefined, [null]])('reports malformed canonical owner records as a protocol error (%j)', async records => {
    const service = { narratives: async () => ({ records }) } as unknown as NonNullable<Parameters<typeof nativeTranscript>[0]>
    await expect(nativeTranscript(service, 'story', [])).rejects.toMatchObject({ apiError: { code: 'upstream-protocol' } })
  })
})
