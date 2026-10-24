import type { TranscriptMessage } from '@dsh-rp/protocol'
import type { RawSessionEvent } from './surface.js'

type UnknownRecord = Record<string, unknown>

function record(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined
}

function textContent(value: unknown): string {
  if (!Array.isArray(value)) return ''
  return value.flatMap((block) => {
    const item = record(block)
    return item?.type === 'text' && typeof item.text === 'string' ? [item.text] : []
  }).join('\n\n').trim()
}

function contextMode(event: RawSessionEvent): boolean | undefined {
  if (event.type !== 'user/message') return undefined
  const source = record(event.data.source)
  if (source?.kind !== 'runtime-context') return undefined
  // The SDK emits a kind-only source when all dynamic context is cleared.
  if (!Array.isArray(source.sections)) return false
  const sections = source.sections.map(record).filter(item => item?.name === 'rp-last-step-binding')
  if (sections.length === 0) return false
  // A reserved marker declares private orchestration even if this reader cannot
  // understand it. Only a valid v1 disable or an absent marker releases prose.
  const section = sections[0]
  if (source.form !== 'snapshot' || sections.length !== 1 || typeof section?.text !== 'string') return true
  try {
    const binding = record(JSON.parse(section.text))
    if (binding?.contract !== 'rp-last-step/v1' || typeof binding.enabled !== 'boolean'
      || typeof binding.profileId !== 'string' || binding.profileId.length === 0
      || typeof binding.version !== 'number' || !Number.isSafeInteger(binding.version) || binding.version < 1) return true
    return binding.enabled
  } catch { return true }
}

/** The last SDK context decision at a durable sequence; undefined means no context was seen. */
export function presentationModeAt(events: readonly RawSessionEvent[], seq = Infinity): boolean | undefined {
  let mode: boolean | undefined
  let latest = -1
  for (const event of events) {
    if (event.seq > seq || event.seq < latest) continue
    const next = contextMode(event)
    if (next === undefined) continue
    latest = event.seq
    mode = next
  }
  return mode
}

function modelMessage(event: RawSessionEvent): UnknownRecord | undefined {
  if (event.type !== 'assistant/message') return undefined
  const message = record(event.data.message)
  return record(message?.source)?.kind === 'model' && typeof message?.id === 'string' ? message : undefined
}

function stepIdentity(event: RawSessionEvent): string | undefined {
  const { turn, step } = event.data
  return typeof turn === 'number' && Number.isSafeInteger(turn) && turn >= 0
    && typeof step === 'number' && Number.isSafeInteger(step) && step >= 0 ? `${turn}:${step}` : undefined
}

function presentationCalls(events: readonly RawSessionEvent[], sourceEvents: readonly RawSessionEvent[]): Map<number, RawSessionEvent> {
  const visibleAssistants = new Set(events.filter(event => modelMessage(event)).map(event => event.seq))
  const latestAssistantByStep = new Map<string, RawSessionEvent>()
  const calls = new Map<number, RawSessionEvent>()
  for (const event of [...sourceEvents].sort((a, b) => a.seq - b.seq)) {
    const identity = stepIdentity(event)
    if (identity === undefined) continue
    if (modelMessage(event)) {
      latestAssistantByStep.set(identity, event)
      continue
    }
    if (event.type !== 'tool/call' || event.data.name !== 'rp_present' || typeof event.data.callId !== 'string') continue
    const assistant = latestAssistantByStep.get(identity)
    if (!assistant || !visibleAssistants.has(assistant.seq)) continue
    const content = modelMessage(assistant)?.content
    if (!Array.isArray(content) || !content.some(block => {
      const call = record(block)
      return call?.type === 'tool-call' && call.id === event.data.callId && call.name === event.data.name
    })) continue
    calls.set(event.seq, event)
  }
  return calls
}

function completedPresentation(event: RawSessionEvent, calls: ReadonlyMap<number, RawSessionEvent>): UnknownRecord | undefined {
  if (event.type !== 'tool/result' || event.surfaceOp !== 'append' || event.sourceEventSeqs?.length !== 1) return undefined
  const message = record(event.data.message)
  const source = record(message?.source)
  if (!message || message.isError === true || source?.kind !== 'tool' || typeof source.callId !== 'string'
    || message.toolCallId !== source.callId) return undefined
  const call = calls.get(event.sourceEventSeqs[0] ?? -1)
  if (!call || call.seq >= event.seq || call.data.callId !== source.callId || stepIdentity(call) !== stepIdentity(event)) return undefined
  const meta = record(record(event.data.meta)?.rpLastStep)
  const item = record(meta?.record)
  if (meta?.schemaVersion !== 1 || item?.status !== 'complete'
    || typeof item.id !== 'string' || !item.id.trim()
    || typeof item.text !== 'string' || !item.text.trim()
    || typeof item.createdAt !== 'string' || !Number.isFinite(Date.parse(item.createdAt))
    || typeof item.profileId !== 'string' || !item.profileId
    || typeof item.profileVersion !== 'number' || !Number.isSafeInteger(item.profileVersion) || item.profileVersion < 1
    || typeof item.profileHash !== 'string' || !item.profileHash) return undefined
  return item
}

export function toTranscript(events: readonly RawSessionEvent[], sourceEvents: readonly RawSessionEvent[] = events): TranscriptMessage[] {
  const calls = presentationCalls(events, sourceEvents)
  const presentations = new Map<number, UnknownRecord>()
  const presentationTurns = new Set<number>()
  for (const event of events) {
    const item = completedPresentation(event, calls)
    if (!item) continue
    presentations.set(event.seq, item)
    if (typeof event.data.turn === 'number') presentationTurns.add(event.data.turn)
  }
  const messages: TranscriptMessage[] = []
  const presentationIds = new Set<string>()
  for (const event of events) {
    if (event.type === 'user/message') {
      const source = record(event.data.source)
      if (source?.kind !== 'user') continue
      const text = textContent(event.data.content)
      if (!text || typeof event.data.id !== 'string') continue
      messages.push({
        id: event.data.id,
        seq: event.seq,
        role: 'player',
        text,
        createdAt: Math.max(0, event.time),
        status: 'complete',
      })
      continue
    }
    const presentation = presentations.get(event.seq)
    if (presentation && typeof presentation.id === 'string' && typeof presentation.text === 'string') {
      if (presentationIds.has(presentation.id)) continue
      presentationIds.add(presentation.id)
      messages.push({ id: presentation.id, seq: event.seq, role: 'gm', text: presentation.text, createdAt: Math.max(0, event.time), status: 'complete' })
      continue
    }
    const message = modelMessage(event)
    if (!message || typeof message.id !== 'string') continue
    // Context replacements shadow older surface rows. Their historical mode
    // still controls prose at that time, so read the raw log, not the fold.
    const mode = presentationModeAt(sourceEvents, event.seq)
    if (mode === true || (mode === undefined && typeof event.data.turn === 'number' && presentationTurns.has(event.data.turn))) continue
    const text = textContent(message.content)
    if (!text) continue
    messages.push({
      id: message.id,
      seq: event.seq,
      role: 'gm',
      text,
      createdAt: Math.max(0, event.time),
      status: 'complete',
    })
  }
  return messages
}
