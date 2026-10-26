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
  lastFactReceipt?: { id: string; kind?: string; factRoundId?: string } | null
  capabilities: { rollback: boolean; fork: boolean; autoplay: boolean }
}
type Request = { sessionId: string; signal?: AbortSignal }
export interface NativeGM {
  apiVersion: number
  capabilities?: { factReview?: number }
  listStories(input: { signal?: AbortSignal }): Promise<{ stories: StorySummary[] }>
  binding(input: Request): Promise<StoryBinding | null>
  storyState(input: Request): Promise<GmStoryState>
  reviewState?(input: Request): Promise<{ latestRound: { pendingCandidateId: string | null } | null; pendingDecision: { status: string } | null; generation: { status: string } | null }>
  forkStory?(input: Request & { atSeq?: number }): Promise<{ sessionId: string; binding: StoryBinding }>
  rollbackStory?(input: Request): Promise<{ sessionId: string; binding: StoryBinding }>
  subscribe?(sessionId: string, listener: (event: Record<string, unknown>) => void): () => void
}
export interface NativeLastStep {
  capabilities?: { narrativeRevisions?: number }
  subscribe?(sessionId: string, listener: (event: Record<string, unknown>) => void): () => void
  narratives?(input: Request): Promise<{ records: NativeNarrative[] }>
  storyHistory?(input: Request): Promise<NativeStoryHistory>
}
interface NativeNarrative { id: string; ref: { sessionId: string; presentationId: string; assistantMessageId: string; callSeq: number; baseResultSeq: number; resultSeq: number }; turn: number; action: string; text: string; createdAt?: string; narrativeVersion?: unknown }
interface NativeStoryHistory { schemaVersion: 1; records: NativeNarrative[]; folded: { groupId: string; activeFactReceiptId: string | null; selectedPresentationId: string | null; pendingFacts: boolean; versions: { presentationId: string; resultSeq: number }[] }[]; projectionKey: string }
export interface NativeDatabase {
  capabilities?: { factReview?: number }
  factReviewProjection?(input: Request): Promise<{ schemaVersion: number; latestRoundId: string | null; groups: { roundId: string; activeReceiptId: string | null; pendingCandidateId: string | null; factRevision: number | null }[] }>
}
interface ReadingOptions { database?: NativeDatabase | undefined; hasVersionedRecords?: boolean }
const unavailableHistory = () => new GatewayError({ code: 'upstream-unavailable', upstreamCode: 'EFFECTIVE_HISTORY_UNAVAILABLE', message: '有效正文暂不可用。请连接支持当前事实版本的 RP 最后一步与 Database；旧版本仍保留审计。' }, 503)
export const reviewPending = (value: Awaited<ReturnType<NonNullable<NativeGM['reviewState']>>>) => !!value.latestRound?.pendingCandidateId || ['recorded', 'interrupted'].includes(value.pendingDecision?.status ?? '') || value.generation?.status === 'running'

export function storyCard(story: StorySummary): Card {
  return { id: 'generic-gm', title: story.title, description: story.character.name, world: '通用 GM 故事', protagonist: story.persona.name, art: 'generic-gm', accent: 'jade' }
}

export function storyPublicState(value: GmStoryState): PublicGameState {
  const { binding, scene, facts, capabilities, lastFactReceipt } = value
  const state = projectPublicState({ started: binding.status === 'active', protagonist: { name: binding.persona.name }, scene: { location: scene.location, currentBeat: { title: scene.title } }, currentTime: scene.time, statusLines: [], meta: {} })
  return { ...state, extensions: { gm: {
    schemaVersion: 1, bindingId: binding.id,
    scene: { schemaVersion: scene.schemaVersion, title: scene.title, location: scene.location, presentActorIds: scene.presentActorIds, ...(typeof scene.time === 'string' ? { time: scene.time } : {}) },
    facts: { schemaVersion: facts.schemaVersion, items: facts.items.map(({ id, text }) => ({ id, text })) },
    ...(lastFactReceipt ? { lastFactReceipt: { id: lastFactReceipt.id, ...(lastFactReceipt.kind ? { kind: lastFactReceipt.kind } : {}), ...(lastFactReceipt.factRoundId ? { factRoundId: lastFactReceipt.factRoundId } : {}) } } : {}),
    capabilities: { rollback: capabilities?.rollback === true, fork: capabilities?.fork === true, autoplay: false },
  } } }
}

/** Native owner projection is authoritative; never silently fall back to a stale body. */
export async function nativeTranscript(service: NativeLastStep | undefined, sessionId: string, fallback: TranscriptMessage[], canonicalIds: string[] = [], options: ReadingOptions = {}): Promise<TranscriptMessage[]> {
  return (await nativeReading(service, sessionId, fallback, canonicalIds, options)).messages
}

export async function nativeReading(service: NativeLastStep | undefined, sessionId: string, fallback: TranscriptMessage[], canonicalIds: string[] = [], options: ReadingOptions = {}): Promise<{ messages: TranscriptMessage[]; history?: NativeStoryHistory }> {
  let history: NativeStoryHistory | undefined
  let records: NativeNarrative[]
  if (typeof service?.storyHistory === 'function' && service.capabilities?.narrativeRevisions === 1) {
    try { history = await service.storyHistory({ sessionId }) }
    catch (error) { if ((error as { code?: string }).code === 'EFFECTIVE_HISTORY_UNAVAILABLE') throw unavailableHistory(); throw error }
    if (history?.schemaVersion !== 1 || !Array.isArray(history.folded) || typeof history.projectionKey !== 'string') throw new GatewayError({ code: 'upstream-protocol', message: '有效正文投影无效。' }, 503)
    records = history.records
  } else {
    records = typeof service?.narratives === 'function' ? (await service.narratives({ sessionId })).records : []
    const database = options.database
    const projection = database?.capabilities?.factReview === 1 && typeof database.factReviewProjection === 'function' ? await database.factReviewProjection({ sessionId }) : undefined
    if (!Array.isArray(records)) throw new GatewayError({ code: 'upstream-protocol', message: '正式正文来源无效，请在 RP 最后一步检查。' }, 503)
    if (options.hasVersionedRecords || records.some(item => item?.narrativeVersion !== undefined) || projection?.groups.some(group => group.activeReceiptId !== null || group.pendingCandidateId !== null)) throw unavailableHistory()
    if (typeof service?.narratives !== 'function') return { messages: fallback }
  }
  if (!Array.isArray(records) || records.some(item => !item?.ref || item.ref.sessionId !== sessionId
    || !item.ref.presentationId || !item.ref.assistantMessageId
    || ![item.ref.callSeq, item.ref.baseResultSeq, item.ref.resultSeq].every(seq => Number.isSafeInteger(seq) && seq >= 0)
    || item.ref.callSeq >= item.ref.baseResultSeq || item.ref.baseResultSeq > item.ref.resultSeq
    || item.id !== JSON.stringify([item.ref.presentationId, item.ref.resultSeq]) || typeof item.text !== 'string' || !item.text.trim())) {
    throw new GatewayError({ code: 'upstream-protocol', message: '正式正文来源无效，请在 RP 最后一步检查。' }, 503)
  }
  const ids = new Set([...canonicalIds, ...records.map(item => item.ref.presentationId)])
  const revisions: TranscriptMessage[] = records.map(item => ({ id: item.id, seq: item.ref.resultSeq, role: 'gm', text: item.text, createdAt: item.createdAt && Number.isFinite(Date.parse(item.createdAt)) ? Math.max(0, Date.parse(item.createdAt)) : 0, status: 'complete' }))
  return { messages: [...fallback.filter(item => history ? item.role !== 'gm' : !ids.has(item.id)), ...revisions].sort((a, b) => a.seq - b.seq), ...(history ? { history } : {}) }
}
