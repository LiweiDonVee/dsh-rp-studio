import {
  apiEnvelopeSchema,
  cardSchema,
  promptSessionSchema,
  sessionDetailSchema,
  sessionSummarySchema,
  streamEventSchema,
  type Card,
  type PromptSession,
  type SessionDetail,
  type SessionSummary,
  type StreamEvent,
} from '@dsh-rp/protocol'
import { z } from 'zod'

async function request<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  })
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new Error(`RP Gateway 返回了无效响应 (${response.status})`)
  }
  const envelope = apiEnvelopeSchema.parse(payload)
  if (!envelope.ok) throw new Error(envelope.error.message)
  return schema.parse(envelope.data)
}

const acceptedSchema = z.object({ accepted: z.literal(true) }).passthrough()

export const api = {
  cards: (): Promise<Card[]> => request('/api/v1/cards', z.array(cardSchema)),
  sessions: (): Promise<SessionSummary[]> => request('/api/v1/sessions', z.array(sessionSummarySchema)),
  session: (id: string): Promise<SessionDetail> => request(`/api/v1/sessions/${encodeURIComponent(id)}`, sessionDetailSchema),
  create: (cardId: string): Promise<SessionDetail> => request('/api/v1/sessions', sessionDetailSchema, { method: 'POST', body: JSON.stringify({ cardId }) }),
  prompt: (id: string, text: string) => request(`/api/v1/sessions/${encodeURIComponent(id)}/messages`, acceptedSchema, { method: 'POST', body: JSON.stringify({ text }) }),
  cancel: (id: string) => request(`/api/v1/sessions/${encodeURIComponent(id)}/cancel`, acceptedSchema, { method: 'POST', body: '{}' }),
  rollback: (id: string) => request(`/api/v1/sessions/${encodeURIComponent(id)}/rollback`, acceptedSchema, { method: 'POST', body: '{}' }),
  fork: (id: string) => request(`/api/v1/sessions/${encodeURIComponent(id)}/fork`, sessionDetailSchema, { method: 'POST', body: '{}' }),
  autoplay: (id: string, input: { off?: boolean; rounds?: number; objective?: string }) => request(`/api/v1/sessions/${encodeURIComponent(id)}/autoplay`, acceptedSchema, { method: 'PUT', body: JSON.stringify(input) }),
  promptSettings: (id: string): Promise<PromptSession> => request(`/api/v1/sessions/${encodeURIComponent(id)}/prompt-presets`, promptSessionSchema),
  applyPromptSettings: (id: string, enabledEntryIds: string[], expectedRevision: number): Promise<PromptSession> => request(`/api/v1/sessions/${encodeURIComponent(id)}/prompt-presets`, promptSessionSchema, {
    method: 'PUT', body: JSON.stringify({ enabledEntryIds, expectedRevision }),
  }),
  resetPromptSettings: (id: string, expectedRevision: number): Promise<PromptSession> => request(`/api/v1/sessions/${encodeURIComponent(id)}/prompt-presets`, promptSessionSchema, {
    method: 'DELETE', body: JSON.stringify({ expectedRevision }),
  }),
}

export function connectEvents(
  sessionId: string,
  onEvent: (event: StreamEvent) => void,
  onDisconnect: () => void,
): () => void {
  const source = new EventSource(`/api/v1/sessions/${encodeURIComponent(sessionId)}/events`)
  const eventTypes = ['connected', 'message.delta', 'message.completed', 'state.updated', 'session.status', 'session.rebased', 'error'] as const
  const listeners = eventTypes.map((type) => {
    const listener = (event: Event): void => {
      if (!(event instanceof MessageEvent)) return
      try {
        const parsed = streamEventSchema.safeParse(JSON.parse(String(event.data)))
        if (parsed.success) onEvent(parsed.data)
      } catch {
        // Invalid upstream events are ignored and never enter application state.
      }
    }
    source.addEventListener(type, listener)
    return [type, listener] as const
  })
  source.onerror = () => onDisconnect()
  return () => {
    listeners.forEach(([type, listener]) => source.removeEventListener(type, listener))
    source.close()
  }
}
