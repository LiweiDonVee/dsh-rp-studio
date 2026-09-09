export const LOCAL_DATA_SCHEMA_VERSION = 1 as const
export const MAX_ASSET_BYTES = 10 * 1024 * 1024

export interface DataScope {
  workspaceId: string
  cardId: string
  sessionId: string
  branchId: string
}

export interface PageQuery {
  sessionId: string
  cursor?: string | undefined
  limit?: number
  category?: AssetCategory
}

export interface Page<T> {
  items: T[]
  nextCursor: string | null
}

export type AssetCategory = 'portrait' | 'background' | 'audio' | 'sticker' | 'attachment'
export type AssetMimeType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | 'audio/mpeg' | 'audio/ogg' | 'audio/wav' | 'application/pdf'

export interface AssetMetadata {
  id: string
  fileName: string
  mimeType: AssetMimeType
  category: AssetCategory
  label?: string
  bytes: number
  createdAt: string
}

export interface AssetRead {
  metadata: AssetMetadata
  bytes: Uint8Array
}

export interface CardRecord {
  id: string
  title: string
  data: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface CardUpsert {
  commandId: string
  id: string
  title: string
  data?: Record<string, unknown>
}

export interface LedgerCreate {
  commandId: string
  amountMinor: number
  currency: string
  description: string
  occurredAt: string
  reversesEntryId?: string
}

export interface LedgerEntry extends LedgerCreate {
  id: string
  createdAt: string
}

export interface KnowledgeCreate {
  commandId: string
  text: string
}

export interface KnowledgeItem {
  id: string
  text: string
  source: 'user' | 'rp-projection'
  provenance?: { branchId: string; sourceSeq: number }
  createdAt: string
  updatedAt: string
}

export interface ProjectionBase {
  id: string
  sessionId: string
  branchId: string
  sourceSeq: number
}

export interface MemoryProjection extends ProjectionBase {
  text: string
  emotion?: string
}

export interface RelationshipProjection extends ProjectionBase {
  subject: string
  object: string
  relation: string
  status?: string
}

export interface LocationProjection extends ProjectionBase {
  world: string
  region?: string
  scene?: string
  landmark?: string
}

export interface ProjectionReplacement {
  branchId: string
  fromSeq: number
  memories: MemoryProjection[]
  relationships: RelationshipProjection[]
  locations: LocationProjection[]
}

export interface NotificationInput {
  id?: string
  type: string
  title: string
  body: string
  createdAt?: string
}

export interface Notification {
  id: string
  cursor: string
  type: string
  title: string
  body: string
  createdAt: string
  acknowledged: boolean
}

export interface NotificationBatch {
  items: Notification[]
  cursor: string
  resetRequired: boolean
  snapshot?: Notification[]
}

export interface BackupRecord {
  id: string
  schemaVersion: number
  scope: DataScope
  createdAt: string
  state: 'staging' | 'ready' | 'failed'
  manifestHash: string
  includes: { authoritativeAppData: true; rpProjections: true; dshSessions: false }
}

export type PairingScope = 'product:read' | 'assets:write' | 'ledger:write' | 'knowledge:write' | 'notifications:ack'

export interface PairingTokenRecord {
  clientId: string
  clientName: string
  tokenHash: string
  scopes: PairingScope[]
  sessionIds: string[]
  createdAt: string
  expiresAt: string
}

export interface PairingClient {
  clientId: string
  clientName: string
  scopes: PairingScope[]
  sessionIds: string[]
  createdAt: string
  expiresAt: string
  revoked: boolean
}

export interface LocalDataStoreOptions {
  dataDir: string
  now?: () => number
  restoreTtlMs?: number
  notificationRetention?: number
}

export interface LocalDataStatus {
  storage: 'ready'
  schemaVersion: number
  projection: 'current'
}

export interface NotificationListener {
  (scope: DataScope, batch: NotificationBatch): void
}
