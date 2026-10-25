import type { Card, PublicGameState, TranscriptMessage } from '@dsh-rp/protocol'
import { projectPublicState } from '@dsh-rp/domain'
import { GatewayError } from './errors.js'

type Asset = { assetId: string; version: number; name: string; description?: string }
export interface StorySummary { sessionId: string; title: string; status: string; character: Asset; persona: Asset }
export interface StoryBinding extends StorySummary { schemaVersion: number; id: string; [key: string]: unknown }
export interface GmStoryState {
  binding: StoryBinding
  scene: { schemaVersion: number; title: string; location: string; time?: string; presentActorIds: string[] }
  facts: { schemaVersion: number; items: { id: string; text: string }[] }
  capabilities: { rollback: boolean; fork: boolean; autoplay: boolean }
}
type Request = { sessionId: string; signal?: AbortSignal }
export interface NativeGM {
  apiVersion: number
  listStories(input: { signal?: AbortSignal }): Promise<{ stories: StorySummary[] }>
  binding(input: Request): Promise<StoryBinding | null>
  storyState(input: Request): Promise<GmStoryState>
  forkStory?(input: Request & { atSeq?: number }): Promise<{ sessionId: string; binding: StoryBinding }>
  rollbackStory?(input: Request): Promise<{ sessionId: string; binding: StoryBinding }>
  subscribe?(sessionId: string, listener: (event: Record<string, unknown>) => void): () => void
}
export interface NativeLastStep {
  subscribe?(sessionId: string, listener: (event: Record<string, unknown>) => void): () => void
  narratives?(input: Request): Promise<{ records: { id: string; ref: { sessionId: string; presentationId: string; assistantMessageId: string; callSeq: number; baseResultSeq: number; resultSeq: number }; turn: number; action: string; text: string; createdAt?: string }[] }>
}

export function storyCard(story: StorySummary): Card {
  return { id: 'generic-gm', title: story.title, description: story.character.name, world: '通用 GM 故事', protagonist: story.persona.name, art: 'generic-gm', accent: 'jade' }
}

export function storyPublicState(value: GmStoryState): PublicGameState {
  const { binding, scene, facts, capabilities } = value
  const state = projectPublicState({ started: binding.status === 'active', protagonist: { name: binding.persona.name }, scene: { location: scene.location, currentBeat: { title: scene.title } }, currentTime: scene.time, statusLines: [], meta: {} })
  return { ...state, extensions: { gm: {
    schemaVersion: 1, bindingId: binding.id,
    scene: { schemaVersion: scene.schemaVersion, title: scene.title, location: scene.location, presentActorIds: scene.presentActorIds, ...(typeof scene.time === 'string' ? { time: scene.time } : {}) },
    facts: { schemaVersion: facts.schemaVersion, items: facts.items.map(({ id, text }) => ({ id, text })) },
    capabilities: { rollback: capabilities?.rollback === true, fork: capabilities?.fork === true, autoplay: false },
  } } }
}

/** Native owner projection is authoritative; never silently fall back to a stale body. */
export async function nativeTranscript(service: NativeLastStep | undefined, sessionId: string, fallback: TranscriptMessage[], canonicalIds: string[] = []): Promise<TranscriptMessage[]> {
  if (typeof service?.narratives !== 'function') return fallback
  const { records } = await service.narratives({ sessionId })
  if (!Array.isArray(records) || records.some(item => !item?.ref || item.ref.sessionId !== sessionId
    || !item.ref.presentationId || !item.ref.assistantMessageId
    || ![item.ref.callSeq, item.ref.baseResultSeq, item.ref.resultSeq].every(seq => Number.isSafeInteger(seq) && seq >= 0)
    || item.ref.callSeq >= item.ref.baseResultSeq || item.ref.baseResultSeq > item.ref.resultSeq
    || item.id !== JSON.stringify([item.ref.presentationId, item.ref.resultSeq]) || typeof item.text !== 'string' || !item.text.trim())) {
    throw new GatewayError({ code: 'upstream-protocol', message: '正式正文来源无效，请在 RP 最后一步检查。' }, 503)
  }
  const ids = new Set([...canonicalIds, ...records.map(item => item.ref.presentationId)])
  const revisions: TranscriptMessage[] = records.map(item => ({ id: item.id, seq: item.ref.resultSeq, role: 'gm', text: item.text, createdAt: item.createdAt && Number.isFinite(Date.parse(item.createdAt)) ? Math.max(0, Date.parse(item.createdAt)) : 0, status: 'complete' }))
  return [...fallback.filter(item => !ids.has(item.id)), ...revisions].sort((a, b) => a.seq - b.seq)
}
