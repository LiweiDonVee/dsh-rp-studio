import { z } from 'zod'

export const API_PROTOCOL_VERSION = 1 as const

export const apiErrorCodeSchema = z.enum([
  'bad-request',
  'not-found',
  'upstream-unavailable',
  'upstream-protocol',
  'agent-busy',
  'card-unavailable',
  'rollback-unavailable',
  'internal',
  'conflict',
  'payload-too-large',
  'unsupported-media-type',
  'storage-unavailable',
  'unauthorized',
  'forbidden',
  'rate-limited',
])

export * from './product.js'

export const apiErrorSchema = z.object({
  code: apiErrorCodeSchema,
  message: z.string().min(1),
  upstreamCode: z.string().regex(/^[a-z0-9-]+$/u).optional(),
}).strict()

export const apiSuccessEnvelopeSchema = z.object({
  ok: z.literal(true),
  protocolVersion: z.literal(API_PROTOCOL_VERSION),
  data: z.unknown(),
}).strict()

export const apiFailureEnvelopeSchema = z.object({
  ok: z.literal(false),
  protocolVersion: z.literal(API_PROTOCOL_VERSION),
  error: apiErrorSchema,
}).strict()

export const apiEnvelopeSchema = z.discriminatedUnion('ok', [
  apiSuccessEnvelopeSchema,
  apiFailureEnvelopeSchema,
])

export const cardAccentSchema = z.enum(['jade', 'crimson', 'graphite', 'gold'])

export const cardPromptProfilesSchema = z.object({
  coreProfileIds: z.array(z.string().regex(/^[a-z0-9][a-z0-9_-]*$/u)),
  optionalProfileIds: z.array(z.string().regex(/^[a-z0-9][a-z0-9_-]*$/u)),
}).strict()

export const cardSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/u),
  kind: z.enum(['card', 'template']).optional(),
  title: z.string().min(1),
  description: z.string(),
  world: z.string().min(1),
  protagonist: z.string().min(1),
  art: z.string().regex(/^[a-z0-9][a-z0-9-]*$/u),
  accent: cardAccentSchema,
  prompt: cardPromptProfilesSchema.optional(),
}).strict()

export const promptEntrySummarySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  slot: z.string().min(1),
  group: z.string().min(1).optional(),
  selection: z.enum(['single', 'multiple', 'any']),
  tags: z.array(z.string()),
  enabledByDefault: z.boolean(),
  renderOnly: z.boolean(),
}).strict()

export const promptProfileSummarySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  version: z.number().int().positive(),
  entries: z.array(promptEntrySummarySchema),
}).strict()

export const promptSessionSchema = z.object({
  available: z.boolean(),
  message: z.string().min(1).optional(),
  revision: z.number().int().nonnegative(),
  coreProfileIds: z.array(z.string()),
  optionalProfiles: z.array(promptProfileSummarySchema),
  enabledEntryIds: z.array(z.string()),
  appliesFromNextTurn: z.boolean(),
}).strict()

export const promptPresetSelectionSchema = z.object({
  enabledEntryIds: z.array(z.string().min(1)),
  expectedRevision: z.number().int().nonnegative(),
}).strict()

export const publicConditionSchema = z.object({
  id: z.string().optional(),
  label: z.string(),
  severity: z.union([z.string(), z.number()]).optional(),
  description: z.string().optional(),
}).passthrough()

export const publicProtagonistSchema = z.object({
  id: z.string().optional(),
  name: z.string(),
  age: z.number().optional(),
  background: z.string().optional(),
  publicStatus: z.array(z.string()).optional(),
  attributes: z.record(z.string(), z.number()).optional(),
  resources: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  conditions: z.array(publicConditionSchema).default([]),
  stress: z.number().optional(),
  body: z.record(z.string(), z.unknown()).optional(),
  talents: z.array(z.record(z.string(), z.unknown())).optional(),
}).strict()

export const publicBeatSchema = z.object({
  id: z.string().optional(),
  title: z.string().optional(),
  location: z.string().optional(),
  objectives: z.array(z.string()).optional(),
  threats: z.array(z.string()).optional(),
  participants: z.array(z.string()).optional(),
  status: z.string().optional(),
}).strict()

export const publicSceneSchema = z.object({
  location: z.string().optional(),
  region: z.string().optional(),
  weather: z.string().optional(),
  currentBeat: publicBeatSchema.nullable().optional(),
  completedBeats: z.array(z.record(z.string(), z.unknown())).optional(),
}).strict()

export const publicGameStateSchema = z.object({
  schemaVersion: z.number().int().nonnegative().optional(),
  started: z.boolean(),
  currentDate: z.string().optional(),
  currentTime: z.string().optional(),
  scene: publicSceneSchema.optional(),
  protagonist: publicProtagonistSchema.optional(),
  relationships: z.array(z.record(z.string(), z.unknown())).default([]),
  faction: z.array(z.record(z.string(), z.unknown())).default([]),
  inventory: z.array(z.record(z.string(), z.unknown())).default([]),
  memories: z.array(z.record(z.string(), z.unknown())).default([]),
  quests: z.array(z.record(z.string(), z.unknown())).default([]),
  eventLog: z.array(z.record(z.string(), z.unknown())).default([]),
  driver: z.object({
    armed: z.boolean(),
    objective: z.string().optional(),
    maxRounds: z.number().int().positive().optional(),
  }).strict().optional(),
  statusLines: z.array(z.string()),
  extensions: z.record(z.string(), z.unknown()).default({}),
  checkpoints: z.object({
    count: z.number().int().nonnegative(),
    canRollback: z.boolean(),
    activeTurn: z.number().int().nonnegative().nullable(),
  }).strict(),
}).strict()

export const transcriptMessageSchema = z.object({
  id: z.string().min(1),
  seq: z.number().int().nonnegative(),
  role: z.enum(['player', 'gm', 'system']),
  text: z.string(),
  createdAt: z.number().nonnegative(),
  status: z.enum(['complete', 'streaming', 'cancelled']).default('complete'),
}).strict()

export const sessionSummarySchema = z.object({
  id: z.string().min(1),
  cardId: z.string().min(1),
  title: z.string().min(1),
  updatedAt: z.number().nonnegative(),
  running: z.boolean(),
  blank: z.boolean(),
  parentSessionId: z.string().optional(),
  state: publicGameStateSchema.optional(),
}).strict()

export const sessionDetailSchema = z.object({
  session: sessionSummarySchema,
  card: cardSchema,
  messages: z.array(transcriptMessageSchema),
  state: publicGameStateSchema,
  prompt: promptSessionSchema.optional(),
}).strict()

export const healthStatusSchema = z.object({
  upstream: z.string().min(1),
  version: z.string().min(1),
  transport: z.literal('remote').optional(),
  compatibility: z.literal('0.1.2-rc.1').optional(),
}).strict()

export const acceptedResponseSchema = z.object({ accepted: z.literal(true) }).strict()

export const streamEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('connected'), sessionId: z.string() }).strict(),
  z.object({ type: z.literal('message.delta'), sessionId: z.string(), messageId: z.string(), text: z.string() }).strict(),
  z.object({ type: z.literal('message.completed'), sessionId: z.string(), message: transcriptMessageSchema }).strict(),
  z.object({ type: z.literal('state.updated'), sessionId: z.string(), state: publicGameStateSchema }).strict(),
  z.object({ type: z.literal('session.status'), sessionId: z.string(), running: z.boolean() }).strict(),
  z.object({ type: z.literal('session.rebased'), sessionId: z.string() }).strict(),
  z.object({ type: z.literal('error'), sessionId: z.string(), error: apiErrorSchema }).strict(),
])

export type ApiError = z.infer<typeof apiErrorSchema>
export type Card = z.infer<typeof cardSchema>
export type PromptEntrySummary = z.infer<typeof promptEntrySummarySchema>
export type PromptProfileSummary = z.infer<typeof promptProfileSummarySchema>
export type PromptSession = z.infer<typeof promptSessionSchema>
export type PromptPresetSelection = z.infer<typeof promptPresetSelectionSchema>
export type PublicGameState = z.infer<typeof publicGameStateSchema>
export type TranscriptMessage = z.infer<typeof transcriptMessageSchema>
export type SessionSummary = z.infer<typeof sessionSummarySchema>
export type SessionDetail = z.infer<typeof sessionDetailSchema>
export type StreamEvent = z.infer<typeof streamEventSchema>

export function successEnvelope<T>(data: T): {
  ok: true
  protocolVersion: typeof API_PROTOCOL_VERSION
  data: T
} {
  return { ok: true, protocolVersion: API_PROTOCOL_VERSION, data }
}

export function failureEnvelope(error: ApiError): {
  ok: false
  protocolVersion: typeof API_PROTOCOL_VERSION
  error: ApiError
} {
  return { ok: false, protocolVersion: API_PROTOCOL_VERSION, error }
}
