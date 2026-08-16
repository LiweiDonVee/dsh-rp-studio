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

export function toTranscript(events: readonly RawSessionEvent[]): TranscriptMessage[] {
  const messages: TranscriptMessage[] = []
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
    if (event.type !== 'assistant/message') continue
    const message = record(event.data.message)
    const source = record(message?.source)
    if (!message || source?.kind !== 'model' || typeof message.id !== 'string') continue
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
