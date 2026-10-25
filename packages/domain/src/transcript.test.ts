import { describe, expect, it } from 'vitest'
import { foldSurface, toTranscript, type RawSessionEvent } from './index.js'

const PRIVATE = 'MAIN_AGENT_PRIVATE_CANARY'
const marker = JSON.stringify({ contract: 'rp-last-step/v1', enabled: true, profileId: 'story', version: 1 })

function event(seq: number, type: string, data: Record<string, unknown>, surfaceOp: RawSessionEvent['surfaceOp'] = 'append'): RawSessionEvent {
  return { seq, time: 1_700_000_000_000 + seq, type, data, ...(surfaceOp ? { surfaceOp } : {}) }
}

function context(seq: number, text: string | undefined = marker, surfaceOp: RawSessionEvent['surfaceOp'] = 'append'): RawSessionEvent {
  return event(seq, 'user/message', {
    id: `context-${seq}`, role: 'user',
    source: text === undefined ? { kind: 'runtime-context' } : {
      kind: 'runtime-context', form: 'snapshot', sections: [
        { name: 'other-profile-instructions', text: PRIVATE },
        { name: 'rp-last-step-binding', text },
      ],
    },
    content: [{ type: 'text', text: PRIVATE }],
  }, surfaceOp)
}

function assistant(seq: number, turn: number, text: string, callId?: string, name = 'rp_present', step = 1): RawSessionEvent {
  return event(seq, 'assistant/message', { turn, step, message: {
    id: `assistant-${seq}`, role: 'assistant', source: { kind: 'model' },
    content: [{ type: 'reasoning', text: PRIVATE }, { type: 'text', text },
      ...(callId ? [{ type: 'tool-call', id: callId, name, arguments: '{}' }] : [])],
  } })
}

function toolCall(seq: number, turn: number, callId = 'present', name = 'rp_present', step = 1): RawSessionEvent {
  return { seq, time: 1_700_000_000_000 + seq, type: 'tool/call', data: { turn, step, callId, name, arguments: '{}' } }
}

function presentation(seq: number, turn: number, callId = 'present', overrides: Record<string, unknown> = {}, sourceCallSeq = seq - 1, step = 1): RawSessionEvent {
  const result = event(seq, 'tool/result', {
    turn, step,
    message: { id: `tool-${seq}`, role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId, isError: false, content: [{ type: 'text', text: overrides.text ?? '晨光照亮了林间小路。' }] },
    meta: { rpLastStep: { schemaVersion: 1, record: {
      id: 'story-final', text: '晨光照亮了林间小路。', status: 'complete', createdAt: '2026-10-24T00:00:00.000Z',
      profileId: 'story', profileVersion: 1, profileHash: 'profile-hash', ...overrides,
    } } },
  })
  result.sourceEventSeqs = [sourceCallSeq]
  return result
}

describe('last-step transcript presentation', () => {
  it('shows player actions and canonical writer prose while preserving earlier legacy narration', () => {
    const events = [
      assistant(0, 0, '旧故事。'), context(1),
      event(2, 'user/message', { id: 'player', source: { kind: 'user' }, content: [{ type: 'text', text: '走向晨光。' }] }),
      assistant(3, 1, PRIVATE, 'present'), toolCall(4, 1), presentation(5, 1),
      presentation(6, 1, 'present', {}, 4),
    ]
    const messages = toTranscript(foldSurface(events), events)
    expect(messages.map(item => [item.id, item.role, item.text])).toEqual([
      ['assistant-0', 'gm', '旧故事。'], ['player', 'player', '走向晨光。'], ['story-final', 'gm', '晨光照亮了林间小路。'],
    ])
    expect(messages[2]).toMatchObject({ seq: 5, createdAt: 1_700_000_000_005, status: 'complete' })
    expect(JSON.stringify(messages)).not.toContain(PRIVATE)
  })

  it('uses raw context history after a later context snapshot shadows the enabling row', () => {
    const events = [context(1), assistant(2, 1, PRIVATE), context(3, marker, { op: 'replace', startSeq: 1, endSeq: 1 }), assistant(4, 2, PRIVATE)]
    expect(foldSurface(events).map(item => item.seq)).toEqual([3, 2, 4])
    expect(toTranscript(foldSurface(events), events)).toEqual([])
  })

  it('clears presentation mode for future messages when a context snapshot loses the marker', () => {
    const cleared = context(4)
    cleared.data.source = { kind: 'runtime-context', form: 'snapshot', sections: [{ name: 'other', text: PRIVATE }] }
    cleared.surfaceOp = { op: 'replace', startSeq: 1, endSeq: 1 }
    const events = [context(1), assistant(2, 1, PRIVATE), cleared, assistant(5, 2, '恢复普通叙事。')]
    expect(toTranscript(foldSurface(events), events).map(item => item.text)).toEqual(['恢复普通叙事。'])
  })

  it('recognizes the SDK kind-only cleared context without rendering its body', () => {
    const cleared = event(3, 'user/message', { id: 'cleared', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: PRIVATE }] })
    const events = [context(1), assistant(2, 1, PRIVATE), cleared, assistant(4, 2, '普通正文。')]
    expect(toTranscript(foldSurface(events), events).map(item => item.text)).toEqual(['普通正文。'])
  })

  it('cannot enable presentation mode from literal player text', () => {
    const events = [
      event(1, 'user/message', { id: 'player', source: { kind: 'user' }, content: [{ type: 'text', text: marker }] }),
      assistant(3, 1, '普通正文。'),
    ]
    expect(toTranscript(foldSurface(events), events).map(item => item.text)).toEqual([marker, '普通正文。'])
    expect(JSON.stringify(toTranscript(foldSurface(events), events))).not.toContain(PRIVATE)
  })

  it.each([
    '{bad marker',
    JSON.stringify({ contract: 'rp-last-step/v2', enabled: true, profileId: 'story', version: 1 }),
    JSON.stringify({ contract: 'rp-last-step/v1', enabled: 'false', profileId: 'story', version: 1 }),
    JSON.stringify({ contract: 'rp-last-step/v1', enabled: true }),
    JSON.stringify([]),
  ])('suppresses private prose when the reserved binding marker is malformed or unknown (%s)', text => {
    const events = [context(1, text), assistant(2, 1, PRIVATE)]
    expect(toTranscript(foldSurface(events), events)).toEqual([])
  })

  it('allows ordinary narration after an explicit valid disabled binding marker', () => {
    const disabled = JSON.stringify({ contract: 'rp-last-step/v1', enabled: false, profileId: 'story', version: 1 })
    const events = [context(1), assistant(2, 1, PRIVATE), context(3, disabled), assistant(4, 2, '恢复普通叙事。')]
    expect(toTranscript(foldSurface(events), events).map(item => item.text)).toEqual(['恢复普通叙事。'])
  })

  it.each(['unrelated', 'error', 'incomplete', 'wrong-schema', 'wrong-source', 'wrong-call'])('rejects unverified presentation metadata (%s)', kind => {
    const call = assistant(2, 1, PRIVATE, 'present', kind === 'unrelated' ? 'lookup_world' : 'rp_present')
    const result = presentation(4, 1, 'present', kind === 'incomplete' ? { status: 'rendered' } : {})
    if (kind === 'error') (result.data.message as Record<string, unknown>).isError = true
    if (kind === 'wrong-schema') (result.data.meta as { rpLastStep: { schemaVersion: number } }).rpLastStep.schemaVersion = 2
    if (kind === 'wrong-source') (result.data.message as Record<string, unknown>).source = { kind: 'plugin', callId: 'present' }
    if (kind === 'wrong-call') (result.data.message as Record<string, unknown>).toolCallId = 'someone-else'
    const events = [context(1), call, toolCall(3, 1, 'present', kind === 'unrelated' ? 'lookup_world' : 'rp_present'), result]
    expect(toTranscript(foldSurface(events), events)).toEqual([])
  })

  it('does not revive a receipt when rollback removes its matching assistant tool call', () => {
    const events = [context(1), assistant(2, 1, PRIVATE, 'present'), toolCall(3, 1), presentation(4, 1),
      event(5, 'user/message', { id: 'rollback', source: { kind: 'plugin' }, content: [{ type: 'text', text: PRIVATE }] }, { op: 'replace', startSeq: 2, endSeq: 2 }),
    ]
    expect(toTranscript(foldSurface(events), events)).toEqual([])
  })

  it('uses a verified presentation turn when its context snapshot is outside the input slice', () => {
    const events = [assistant(1, 0, '旧故事。'), assistant(2, 1, PRIVATE), assistant(3, 1, PRIVATE, 'present'), toolCall(4, 1), presentation(5, 1)]
    expect(toTranscript(foldSurface(events), events).map(item => item.text)).toEqual(['旧故事。', '晨光照亮了林间小路。'])
  })

  it.each(['turn', 'step'])('keeps both canonical presentations when the provider reuses its call ID in another %s', reuse => {
    const turn = reuse === 'turn' ? 2 : 1
    const step = reuse === 'step' ? 2 : 1
    const events = [context(0), assistant(1, 1, PRIVATE, 'same'), toolCall(2, 1, 'same'), presentation(3, 1, 'same', { id: 'first', text: '第一幕。' }),
      assistant(4, turn, PRIVATE, 'same', 'rp_present', step), toolCall(5, turn, 'same', 'rp_present', step), presentation(6, turn, 'same', { id: 'second', text: '第二幕。' }, 5, step),
    ]
    expect(toTranscript(foldSurface(events), events).map(item => [item.id, item.text])).toEqual([['first', '第一幕。'], ['second', '第二幕。']])
  })

  it('rejects metadata from an unrelated tool that reuses a previous presentation call ID', () => {
    const events = [context(0), assistant(1, 1, PRIVATE, 'same'), toolCall(2, 1, 'same'), presentation(3, 1, 'same', { id: 'first', text: '第一幕。' }),
      assistant(4, 2, PRIVATE, 'same', 'lookup_world'), toolCall(5, 2, 'same', 'lookup_world'), presentation(6, 2, 'same', { id: 'spoof', text: PRIVATE }),
    ]
    expect(toTranscript(foldSurface(events), events).map(item => [item.id, item.text])).toEqual([['first', '第一幕。']])
  })

  it('keeps the first receipt while rollback removes only the second reused-ID assistant call', () => {
    const events = [context(0), assistant(1, 1, PRIVATE, 'same'), toolCall(2, 1, 'same'), presentation(3, 1, 'same', { id: 'first', text: '第一幕。' }),
      assistant(4, 2, PRIVATE, 'same'), toolCall(5, 2, 'same'), presentation(6, 2, 'same', { id: 'second', text: PRIVATE }),
      event(7, 'user/message', { id: 'rollback', source: { kind: 'plugin' }, content: [] }, { op: 'replace', startSeq: 4, endSeq: 4 }),
    ]
    expect(toTranscript(foldSurface(events), events).map(item => [item.id, item.text])).toEqual([['first', '第一幕。']])
  })

  it('rejects a receipt linked to a different turn even when its call ID matches', () => {
    const events = [context(0), assistant(1, 1, PRIVATE, 'same'), toolCall(2, 1, 'same'), presentation(3, 1, 'same', { id: 'first', text: '第一幕。' }),
      assistant(4, 2, PRIVATE, 'same'), toolCall(5, 2, 'same'), presentation(6, 2, 'same', { id: 'spoof', text: PRIVATE }, 2),
    ]
    expect(toTranscript(foldSurface(events), events).map(item => [item.id, item.text])).toEqual([['first', '第一幕。']])
  })

  it('requires the canonical durable source tool-call link', () => {
    const result = presentation(3, 1)
    delete result.sourceEventSeqs
    const events = [context(0), assistant(1, 1, PRIVATE, 'present'), toolCall(2, 1), result]
    expect(toTranscript(foldSurface(events), events)).toEqual([])
  })

  it('reads the effective content across two legitimate revisions instead of stale receipt text', () => {
    const base = presentation(4, 1)
    const first = structuredClone(base)
    first.seq = 7
    first.surfaceOp = { op: 'replace', startSeq: 4, endSeq: 4 }
    first.sourceEventSeqs = [3, 4]
    ;(first.data.message as Record<string, unknown>).content = [{ type: 'text', text: '采用稿一。' }]
    const latest = structuredClone(first)
    latest.seq = 10
    latest.surfaceOp = { op: 'replace', startSeq: 7, endSeq: 7 }
    latest.sourceEventSeqs = [3, 4, 7]
    ;(latest.data.message as Record<string, unknown>).content = [{ type: 'text', text: '采用稿二。' }]
    const events = [context(0), assistant(2, 1, PRIVATE, 'present'), toolCall(3, 1), base, first, latest]
    expect(toTranscript(foldSurface(events), events)).toMatchObject([{ id: 'story-final', seq: 10, text: '采用稿二。' }])
  })

  it.each(['missing-source', 'changed-meta', 'unrelated-source', 'wrong-shadow'])('rejects an invalid revision chain (%s)', invalid => {
    const base = presentation(4, 1)
    const changed = structuredClone(base)
    changed.seq = 7
    changed.surfaceOp = { op: 'replace', startSeq: 4, endSeq: 4 }
    changed.sourceEventSeqs = [3, 4]
    ;(changed.data.message as Record<string, unknown>).content = [{ type: 'text', text: PRIVATE }]
    if (invalid === 'missing-source') changed.sourceEventSeqs = [3]
    if (invalid === 'changed-meta') changed.data.meta = { rpLastStep: { schemaVersion: 1, record: { id: 'fake', text: PRIVATE, status: 'complete' } } }
    if (invalid === 'unrelated-source') changed.sourceEventSeqs.push(1)
    if (invalid === 'wrong-shadow') changed.surfaceOp = { op: 'replace', startSeq: 2, endSeq: 4 }
    const events = [context(0), assistant(2, 1, PRIVATE, 'present'), toolCall(3, 1), base, changed]
    expect(toTranscript(foldSurface(events), events)).toEqual([])
  })

  it('preserves canonical prose through compaction and fork prefixes without resurrecting a future revision', () => {
    const base = presentation(4, 1)
    const compact = event(6, 'user/message', { source: { kind: 'compact-checkpoint' }, content: [{ type: 'text', text: PRIVATE }] }, { op: 'replace', startSeq: 2, endSeq: 4 })
    const events = [context(0), assistant(2, 1, PRIVATE, 'present'), toolCall(3, 1), base, compact]
    expect(toTranscript(foldSurface(events), events).map(item => item.text)).toEqual(['晨光照亮了林间小路。'])
    expect(toTranscript(foldSurface(events.slice(0, 4)), events.slice(0, 4)).map(item => item.seq)).toEqual([4])
  })
})
