import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { DataConflictError, DataIntegrityError, DataValidationError, StoreClosedError } from './errors.js'
import { assetPath, prepareStorage, readRegular, writeAtomic, type StoragePaths } from './files.js'
import { migrate } from './schema.js'
import {
  LOCAL_DATA_SCHEMA_VERSION,
  MAX_ASSET_BYTES,
  type AssetMetadata,
  type AssetRead,
  type BackupRecord,
  type CardRecord,
  type CardUpsert,
  type DataScope,
  type KnowledgeCreate,
  type KnowledgeItem,
  type LedgerCreate,
  type LedgerEntry,
  type LocalDataStatus,
  type LocalDataStoreOptions,
  type LocationProjection,
  type MemoryProjection,
  type Notification,
  type NotificationBatch,
  type NotificationInput,
  type NotificationListener,
  type Page,
  type PageQuery,
  type PairingClient,
  type PairingScope,
  type PairingTokenRecord,
  type ProjectionReplacement,
  type RelationshipProjection,
} from './types.js'
import { assertAsset, assertAssetMetadata, assertIsoDate, assertLedger, assertProjection, assertQuery, assertScope, equalHash, sha256, stableJson, validBase64 } from './validation.js'

type Row = Record<string, string | number | bigint | null | Uint8Array>

interface PageCursor {
  kind: string
  workspaceId: string
  cardId: string
  sessionId: string
  branchId?: string
  primary: string | number
  id: string
}

interface NotificationCursor {
  kind: 'notifications'
  workspaceId: string
  cardId: string
  sessionId: string
  branchId: string
  seq: number
}

interface BackupManifest {
  format: 'dsh-rp-local-data-backup'
  schemaVersion: 1
  scope: DataScope
  createdAt: string
  includes: { authoritativeAppData: true; rpProjections: true; dshSessions: false; pairingTokens: false; authorizationState: false }
  rows: {
    cards: Row[]
    assets: Row[]
    ledgerEntries: Row[]
    knowledgeItems: Row[]
    memoryIndex: Row[]
    relationshipEdges: Row[]
    locationSnapshots: Row[]
    commandJournal: Row[]
  }
  assetBlobs: Array<{ id: string; bytesBase64: string }>
}

interface BackupFile {
  manifestHash: string
  manifest: BackupManifest
}

const MAX_BACKUP_BYTES = 32 * 1024 * 1024
const PAIRING_SCOPES = new Set<PairingScope>(['product:read', 'assets:write', 'ledger:write', 'knowledge:write', 'notifications:ack'])
const RESTORABLE_JOURNAL_DOMAINS = new Set(['asset.create', 'asset.update', 'asset.delete', 'ledger.append', 'knowledge.create', 'knowledge.update', 'knowledge.delete'])

export class LocalDataStore {
  private closed = false
  private closing = false
  private closePromise: Promise<void> | undefined
  private writeTail: Promise<void> = Promise.resolve()
  private readonly listeners = new Set<NotificationListener>()
  private readonly now: () => number
  private readonly restoreTtlMs: number
  private readonly notificationRetention: number
  private readonly cursorSecret: Buffer
  private readonly stagedHashes = new Set<string>()
  private quarantineCause: unknown

  private constructor(
    private readonly database: DatabaseSync,
    private readonly paths: StoragePaths,
    options: LocalDataStoreOptions,
  ) {
    this.now = options.now ?? Date.now
    this.restoreTtlMs = options.restoreTtlMs ?? 5 * 60_000
    this.notificationRetention = options.notificationRetention ?? 1_000
    if (!Number.isSafeInteger(this.restoreTtlMs) || this.restoreTtlMs < 1 || !Number.isSafeInteger(this.notificationRetention) || this.notificationRetention < 1) throw new DataValidationError('Retention and restore TTL options must be positive integers')
    const existing = this.database.prepare('SELECT value FROM local_metadata WHERE key = ?').get('cursor_secret')
    let secret = existing ? stringValue(existing, 'value') : ''
    if (!secret) {
      const candidate = randomBytes(32).toString('base64url')
      this.database.prepare('INSERT OR IGNORE INTO local_metadata(key, value) VALUES (?, ?)').run('cursor_secret', candidate)
      secret = stringValue(this.database.prepare('SELECT value FROM local_metadata WHERE key = ?').get('cursor_secret'), 'value')
    }
    this.cursorSecret = Buffer.from(secret, 'base64url')
    this.database.prepare('DELETE FROM restore_stages WHERE expires_at <= ?').run(this.isoNow())
  }

  static async open(options: LocalDataStoreOptions): Promise<LocalDataStore> {
    const paths = await prepareStorage(options.dataDir)
    const database = new DatabaseSync(paths.database, { allowExtension: false, timeout: 5_000 })
    try {
      database.exec('PRAGMA journal_mode = WAL')
      database.exec('PRAGMA synchronous = FULL')
      database.exec('PRAGMA foreign_keys = ON')
      database.exec('PRAGMA busy_timeout = 5000')
      migrate(database, new Date((options.now ?? Date.now)()).toISOString())
      return new LocalDataStore(database, paths, options)
    } catch (error) {
      database.close()
      throw error
    }
  }

  async status(): Promise<LocalDataStatus> {
    this.assertOpen()
    const row = this.database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()
    return { storage: 'ready', schemaVersion: numberValue(row, 'version'), projection: 'current' }
  }

  async schemaTables(): Promise<string[]> {
    this.assertOpen()
    return this.database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => stringValue(row, 'name'))
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    if (this.closed) return
    this.closing = true
    this.closePromise = (async () => {
      await this.writeTail
      if (this.closed) return
      this.closed = true
      this.listeners.clear()
      try {
        for (const hash of this.stagedHashes) this.database.prepare('DELETE FROM restore_stages WHERE token_hash = ?').run(hash)
      } finally {
        this.database.close()
      }
    })()
    return this.closePromise
  }

  async upsertCard(scope: DataScope, input: CardUpsert): Promise<CardRecord> {
    const stableScope = copyScope(scope)
    const stableInput = structuredClone(input)
    assertScope(stableScope)
    if (stableInput.id !== stableScope.cardId || !stableInput.title || !stableInput.commandId) throw new DataValidationError('Card upsert does not match its scope')
    const payload = { id: stableInput.id, title: stableInput.title, data: stableInput.data ?? {} }
    return this.write(() => this.command(stableScope, 'card.upsert', stableInput.commandId, payload, () => {
      const existing = this.database.prepare('SELECT * FROM cards WHERE workspace_id = ? AND card_id = ?').get(stableScope.workspaceId, stableScope.cardId)
      const now = this.isoNow()
      if (existing) {
        this.database.prepare('UPDATE cards SET title = ?, data_json = ?, updated_at = ? WHERE workspace_id = ? AND card_id = ?').run(stableInput.title, stableJson(stableInput.data ?? {}), now, stableScope.workspaceId, stableScope.cardId)
      } else {
        this.database.prepare('INSERT INTO cards(workspace_id, card_id, title, data_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(stableScope.workspaceId, stableScope.cardId, stableInput.title, stableJson(stableInput.data ?? {}), now, now)
      }
      return this.card(stableScope)!
    }))
  }

  async getCard(scope: DataScope): Promise<CardRecord | undefined> {
    assertScope(scope)
    await this.pendingWrites()
    return this.card(scope)
  }

  async listAssets(scope: DataScope, query: PageQuery): Promise<Page<AssetMetadata>> {
    const limit = assertQuery(scope, query)
    await this.pendingWrites()
    const cursor = query.cursor ? this.decodePageCursor(query.cursor, scope, 'assets') : undefined
    const categorySql = query.category === undefined ? '' : ' AND category = ?'
    const cursorSql = cursor === undefined ? '' : ' AND (created_at < ? OR (created_at = ? AND id < ?))'
    const parameters: SQLInputValue[] = [scope.workspaceId, scope.cardId, scope.sessionId]
    if (query.category !== undefined) parameters.push(query.category)
    if (cursor !== undefined) parameters.push(String(cursor.primary), String(cursor.primary), cursor.id)
    parameters.push(limit + 1)
    const rows = this.database.prepare(`SELECT * FROM assets WHERE workspace_id = ? AND card_id = ? AND session_id = ?${categorySql}${cursorSql} ORDER BY created_at DESC, id DESC LIMIT ?`).all(...parameters)
    return this.createdPage(rows, limit, scope, 'assets', row => assetFromRow(row))
  }

  async putAsset(input: { scope: DataScope; metadata: AssetMetadata; bytes: Uint8Array }): Promise<AssetMetadata> {
    const scope = copyScope(input.scope)
    const metadata = structuredClone(input.metadata)
    const bytes = Buffer.from(input.bytes)
    assertScope(scope)
    assertAsset(metadata, bytes)
    return this.write(async () => {
      const path = await assetPath(this.paths.assets, metadata.id, true)
      try {
        const existingBytes = await readRegular(path, this.paths.assets)
        if (sha256(existingBytes) !== metadata.id) throw new DataIntegrityError('Existing asset blob does not match its id')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        await writeAtomic(path, bytes)
      }
      return this.transaction(() => {
        const existing = this.database.prepare('SELECT * FROM assets WHERE workspace_id = ? AND card_id = ? AND session_id = ? AND id = ?').get(scope.workspaceId, scope.cardId, scope.sessionId, metadata.id)
        if (existing) return assetFromRow(existing)
        this.database.prepare('INSERT INTO assets(workspace_id, card_id, session_id, id, file_name, mime_type, category, label, byte_length, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(scope.workspaceId, scope.cardId, scope.sessionId, metadata.id, metadata.fileName, metadata.mimeType, metadata.category, metadata.label ?? null, metadata.bytes, metadata.createdAt)
        this.insertJournal(scope, 'asset.create', `operation-${randomUUID()}`, { assetId: metadata.id }, metadata)
        this.bumpRevision(scope)
        return metadata
      })
    })
  }

  async readAsset(scope: DataScope, assetId: string): Promise<AssetRead | undefined> {
    assertScope(scope)
    await this.pendingWrites()
    const row = this.database.prepare('SELECT * FROM assets WHERE workspace_id = ? AND card_id = ? AND session_id = ? AND id = ?').get(scope.workspaceId, scope.cardId, scope.sessionId, assetId)
    if (!row) return undefined
    const metadata = assetFromRow(row)
    const path = await assetPath(this.paths.assets, assetId)
    const bytes = await readRegular(path, this.paths.assets, MAX_ASSET_BYTES)
    assertAsset(metadata, bytes)
    return { metadata, bytes }
  }

  async updateAsset(scope: DataScope, assetId: string, patch: { label: string | null }): Promise<AssetMetadata | undefined> {
    const stableScope = copyScope(scope)
    const label = patch.label
    assertScope(stableScope)
    if (label !== null && (typeof label !== 'string' || label.length > 500)) throw new DataValidationError('Asset label is invalid')
    return this.write(() => this.transaction(() => {
      const result = this.database.prepare('UPDATE assets SET label = ? WHERE workspace_id = ? AND card_id = ? AND session_id = ? AND id = ?').run(label, stableScope.workspaceId, stableScope.cardId, stableScope.sessionId, assetId)
      if (Number(result.changes) === 0) return undefined
      this.bumpRevision(stableScope)
      const row = this.database.prepare('SELECT * FROM assets WHERE workspace_id = ? AND card_id = ? AND session_id = ? AND id = ?').get(stableScope.workspaceId, stableScope.cardId, stableScope.sessionId, assetId)
      const updated = row ? assetFromRow(row) : undefined
      if (updated) this.insertJournal(stableScope, 'asset.update', `operation-${randomUUID()}`, { assetId, label }, updated)
      return updated
    }))
  }

  async deleteAsset(scope: DataScope, assetId: string): Promise<boolean> {
    const stableScope = copyScope(scope)
    assertScope(stableScope)
    return this.write(() => {
      return this.transaction(() => {
        const result = this.database.prepare('DELETE FROM assets WHERE workspace_id = ? AND card_id = ? AND session_id = ? AND id = ?').run(stableScope.workspaceId, stableScope.cardId, stableScope.sessionId, assetId)
        if (Number(result.changes) > 0) {
          this.insertJournal(stableScope, 'asset.delete', `operation-${randomUUID()}`, { assetId }, { assetId, deleted: true })
          this.bumpRevision(stableScope)
        }
        return Number(result.changes) > 0
      })
    })
  }

  async listLedger(scope: DataScope, query: PageQuery): Promise<Page<LedgerEntry>> {
    const limit = assertQuery(scope, query)
    await this.pendingWrites()
    const cursor = query.cursor ? this.decodePageCursor(query.cursor, scope, 'ledger') : undefined
    const cursorSql = cursor === undefined ? '' : ' AND (created_at < ? OR (created_at = ? AND id < ?))'
    const parameters: SQLInputValue[] = [scope.workspaceId, scope.cardId, scope.sessionId]
    if (cursor !== undefined) parameters.push(String(cursor.primary), String(cursor.primary), cursor.id)
    parameters.push(limit + 1)
    const rows = this.database.prepare(`SELECT * FROM ledger_entries WHERE workspace_id = ? AND card_id = ? AND session_id = ?${cursorSql} ORDER BY created_at DESC, id DESC LIMIT ?`).all(...parameters)
    return this.createdPage(rows, limit, scope, 'ledger', ledgerFromRow)
  }

  async appendLedger(scope: DataScope, input: LedgerCreate): Promise<LedgerEntry> {
    const stableScope = copyScope(scope)
    const commandInput = structuredClone(input)
    assertScope(stableScope)
    assertLedger(commandInput)
    return this.write(() => this.command(stableScope, 'ledger.append', commandInput.commandId, commandInput, () => {
      if (commandInput.reversesEntryId) {
        const target = this.database.prepare('SELECT id, amount_minor, currency, reverses_entry_id FROM ledger_entries WHERE workspace_id = ? AND card_id = ? AND session_id = ? AND id = ?').get(stableScope.workspaceId, stableScope.cardId, stableScope.sessionId, commandInput.reversesEntryId)
        if (!target) throw new DataValidationError('The reversed ledger entry is outside this scope')
        if (target.reverses_entry_id !== null) throw new DataValidationError('A compensating ledger entry cannot reverse another compensation')
        if (target.currency !== commandInput.currency || Number(target.amount_minor) !== -commandInput.amountMinor) throw new DataValidationError('A compensating ledger entry must use the same currency and exact opposite amount')
        const existingReversal = this.database.prepare('SELECT id FROM ledger_entries WHERE workspace_id = ? AND card_id = ? AND session_id = ? AND reverses_entry_id = ?').get(stableScope.workspaceId, stableScope.cardId, stableScope.sessionId, commandInput.reversesEntryId)
        if (existingReversal) throw new DataConflictError('This ledger entry already has a compensating entry')
      }
      const entry: LedgerEntry = { id: `ledger-${randomUUID()}`, ...commandInput, createdAt: this.isoNow() }
      this.database.prepare('INSERT INTO ledger_entries(workspace_id, card_id, session_id, id, command_id, amount_minor, currency, description, occurred_at, created_at, reverses_entry_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(stableScope.workspaceId, stableScope.cardId, stableScope.sessionId, entry.id, entry.commandId, entry.amountMinor, entry.currency, entry.description, entry.occurredAt, entry.createdAt, entry.reversesEntryId ?? null)
      return entry
    }))
  }

  async listKnowledge(scope: DataScope, query: PageQuery): Promise<Page<KnowledgeItem>> {
    const limit = assertQuery(scope, query)
    await this.pendingWrites()
    const cursor = query.cursor ? this.decodePageCursor(query.cursor, scope, 'knowledge') : undefined
    const cursorSql = cursor === undefined ? '' : ' AND (created_at < ? OR (created_at = ? AND id < ?))'
    const parameters: SQLInputValue[] = [scope.workspaceId, scope.cardId, scope.sessionId]
    if (cursor !== undefined) parameters.push(String(cursor.primary), String(cursor.primary), cursor.id)
    parameters.push(limit + 1)
    const rows = this.database.prepare(`SELECT * FROM knowledge_items WHERE workspace_id = ? AND card_id = ? AND session_id = ?${cursorSql} ORDER BY created_at DESC, id DESC LIMIT ?`).all(...parameters)
    return this.createdPage(rows, limit, scope, 'knowledge', knowledgeFromRow)
  }

  async createKnowledge(scope: DataScope, input: KnowledgeCreate): Promise<KnowledgeItem> {
    const stableScope = copyScope(scope)
    const stableInput = { ...input }
    assertScope(stableScope)
    if (!stableInput.commandId || !stableInput.text || stableInput.text.length > 20_000) throw new DataValidationError('Invalid knowledge command')
    return this.write(() => this.command(stableScope, 'knowledge.create', stableInput.commandId, stableInput, () => {
      const now = this.isoNow()
      const item: KnowledgeItem = { id: `knowledge-${randomUUID()}`, text: stableInput.text, source: 'user', createdAt: now, updatedAt: now }
      this.database.prepare('INSERT INTO knowledge_items(workspace_id, card_id, session_id, id, text, source, branch_id, source_seq, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(stableScope.workspaceId, stableScope.cardId, stableScope.sessionId, item.id, item.text, item.source, null, null, now, now)
      return item
    }))
  }

  async updateKnowledge(scope: DataScope, knowledgeId: string, text: string): Promise<KnowledgeItem | undefined> {
    const stableScope = copyScope(scope)
    assertScope(stableScope)
    if (!text || text.length > 20_000) throw new DataValidationError('Invalid knowledge text')
    return this.write(() => this.transaction(() => {
      const result = this.database.prepare("UPDATE knowledge_items SET text = ?, updated_at = ? WHERE workspace_id = ? AND card_id = ? AND session_id = ? AND id = ? AND source = 'user'").run(text, this.isoNow(), stableScope.workspaceId, stableScope.cardId, stableScope.sessionId, knowledgeId)
      if (Number(result.changes) === 0) return undefined
      this.bumpRevision(stableScope)
      const row = this.database.prepare('SELECT * FROM knowledge_items WHERE workspace_id = ? AND card_id = ? AND session_id = ? AND id = ?').get(stableScope.workspaceId, stableScope.cardId, stableScope.sessionId, knowledgeId)
      const updated = row ? knowledgeFromRow(row) : undefined
      if (updated) this.insertJournal(stableScope, 'knowledge.update', `operation-${randomUUID()}`, { knowledgeId, text }, updated)
      return updated
    }))
  }

  async deleteKnowledge(scope: DataScope, knowledgeId: string): Promise<boolean> {
    const stableScope = copyScope(scope)
    assertScope(stableScope)
    return this.write(() => this.transaction(() => {
      const result = this.database.prepare("DELETE FROM knowledge_items WHERE workspace_id = ? AND card_id = ? AND session_id = ? AND id = ? AND source = 'user'").run(stableScope.workspaceId, stableScope.cardId, stableScope.sessionId, knowledgeId)
      if (Number(result.changes) > 0) {
        this.insertJournal(stableScope, 'knowledge.delete', `operation-${randomUUID()}`, { knowledgeId }, { deleted: true, knowledgeId })
        this.bumpRevision(stableScope)
      }
      return Number(result.changes) > 0
    }))
  }

  async listMemories(scope: DataScope, query: PageQuery): Promise<Page<MemoryProjection>> {
    return this.listProjection(scope, query, 'memories')
  }

  async listRelationships(scope: DataScope, query: PageQuery): Promise<Page<RelationshipProjection>> {
    return this.listProjection(scope, query, 'relationships')
  }

  async listLocations(scope: DataScope, query: PageQuery): Promise<Page<LocationProjection>> {
    return this.listProjection(scope, query, 'locations')
  }

  async replaceProjections(scope: DataScope, replacement: ProjectionReplacement): Promise<void> {
    const stableScope = copyScope(scope)
    const stableReplacement = structuredClone(replacement)
    assertProjection(stableScope, stableReplacement)
    await this.write(() => this.transaction(() => {
      const base = [stableScope.workspaceId, stableScope.cardId, stableScope.sessionId, stableReplacement.branchId, stableReplacement.fromSeq] as const
      this.database.prepare('DELETE FROM memory_index WHERE workspace_id = ? AND card_id = ? AND session_id = ? AND (branch_id <> ? OR source_seq >= ?)').run(...base)
      this.database.prepare('DELETE FROM relationship_edges WHERE workspace_id = ? AND card_id = ? AND session_id = ? AND (branch_id <> ? OR source_seq >= ?)').run(...base)
      this.database.prepare('DELETE FROM location_snapshots WHERE workspace_id = ? AND card_id = ? AND session_id = ? AND (branch_id <> ? OR source_seq >= ?)').run(...base)
      const memory = this.database.prepare('INSERT INTO memory_index(workspace_id, card_id, session_id, branch_id, source_seq, id, text, emotion) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      for (const item of stableReplacement.memories) memory.run(stableScope.workspaceId, stableScope.cardId, stableScope.sessionId, item.branchId, item.sourceSeq, item.id, item.text, item.emotion ?? null)
      const relationship = this.database.prepare('INSERT INTO relationship_edges(workspace_id, card_id, session_id, branch_id, source_seq, id, subject, object, relation, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      for (const item of stableReplacement.relationships) relationship.run(stableScope.workspaceId, stableScope.cardId, stableScope.sessionId, item.branchId, item.sourceSeq, item.id, item.subject, item.object, item.relation, item.status ?? null)
      const location = this.database.prepare('INSERT INTO location_snapshots(workspace_id, card_id, session_id, branch_id, source_seq, id, world, region, scene, landmark) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      for (const item of stableReplacement.locations) location.run(stableScope.workspaceId, stableScope.cardId, stableScope.sessionId, item.branchId, item.sourceSeq, item.id, item.world, item.region ?? null, item.scene ?? null, item.landmark ?? null)
      this.bumpRevision(stableScope)
    }))
  }

  async readNotifications(scope: DataScope, cursor?: string): Promise<NotificationBatch> {
    scope = copyScope(scope)
    assertScope(scope)
    await this.pendingWrites()
    return this.transaction(() => this.notificationBatch(scope, cursor), false)
  }

  private notificationBatch(scope: DataScope, cursor?: string): NotificationBatch {
    const decoded = cursor ? this.decodeNotificationCursor(cursor, scope) : undefined
    const parameters = [scope.workspaceId, scope.cardId, scope.sessionId, scope.branchId] as const
    const rows = this.database.prepare('SELECT * FROM notifications WHERE workspace_id = ? AND card_id = ? AND session_id = ? AND branch_id = ? ORDER BY seq ASC').all(...parameters)
    const floorRow = this.database.prepare('SELECT pruned_through FROM notification_cursors WHERE workspace_id = ? AND card_id = ? AND session_id = ? AND branch_id = ?').get(...parameters)
    const floor = floorRow ? numberValue(floorRow, 'pruned_through') : 0
    const maximum = rows.length ? numberValue(rows.at(-1), 'seq') : floor
    const resetRequired = decoded !== undefined && (decoded.seq < floor || decoded.seq > maximum)
    if (resetRequired) {
      const snapshot = rows.map(row => this.notificationFromRow(row, scope))
      return { items: [], cursor: this.encodeNotificationCursor(scope, maximum), resetRequired: true, snapshot }
    }
    const after = decoded?.seq ?? 0
    return { items: rows.filter(row => numberValue(row, 'seq') > after).map(row => this.notificationFromRow(row, scope)), cursor: this.encodeNotificationCursor(scope, maximum), resetRequired: false }
  }

  async appendNotification(scope: DataScope, input: NotificationInput & { id: string; createdAt: string }): Promise<Notification> {
    const stableScope = copyScope(scope)
    const stableInput = { ...input }
    assertScope(stableScope)
    if (!stableInput.id || !stableInput.type || stableInput.type.length > 100 || !stableInput.title || stableInput.title.length > 500 || stableInput.body.length > 5_000) throw new DataValidationError('Invalid notification')
    assertIsoDate(stableInput.createdAt, 'createdAt')
    const result = await this.write(() => this.transaction(() => {
      const parameters = [stableScope.workspaceId, stableScope.cardId, stableScope.sessionId, stableScope.branchId] as const
      const existing = this.database.prepare('SELECT * FROM notifications WHERE workspace_id = ? AND card_id = ? AND session_id = ? AND branch_id = ? AND id = ?').get(...parameters, stableInput.id)
      if (existing) {
        const current = this.notificationFromRow(existing, stableScope)
        if (current.type !== stableInput.type || current.title !== stableInput.title || current.body !== stableInput.body || current.createdAt !== stableInput.createdAt) throw new DataConflictError('Notification id already exists with different content')
        return current
      }
      this.database.prepare('INSERT INTO notifications(workspace_id, card_id, session_id, branch_id, id, type, title, body, created_at, acknowledged) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)').run(...parameters, stableInput.id, stableInput.type, stableInput.title, stableInput.body, stableInput.createdAt)
      const sequenceRow = this.database.prepare('SELECT seq FROM notifications WHERE workspace_id = ? AND card_id = ? AND session_id = ? AND branch_id = ? AND id = ?').get(...parameters, stableInput.id)
      const sequence = numberValue(sequenceRow, 'seq')
      const cutoffRow = this.database.prepare('SELECT seq FROM notifications WHERE workspace_id = ? AND card_id = ? AND session_id = ? AND branch_id = ? ORDER BY seq DESC LIMIT 1 OFFSET ?').get(...parameters, this.notificationRetention)
      if (cutoffRow) {
        const floor = numberValue(cutoffRow, 'seq')
        this.database.prepare('DELETE FROM notifications WHERE workspace_id = ? AND card_id = ? AND session_id = ? AND branch_id = ? AND seq <= ?').run(...parameters, floor)
        this.database.prepare('INSERT INTO notification_cursors(workspace_id, card_id, session_id, branch_id, pruned_through) VALUES (?, ?, ?, ?, ?) ON CONFLICT(workspace_id, card_id, session_id, branch_id) DO UPDATE SET pruned_through = excluded.pruned_through').run(...parameters, floor)
      }
      this.bumpRevision(stableScope)
      return { id: stableInput.id, cursor: this.encodeNotificationCursor(stableScope, sequence), type: stableInput.type, title: stableInput.title, body: stableInput.body, createdAt: stableInput.createdAt, acknowledged: false }
    }))
    await this.emit(stableScope)
    return result
  }

  async createNotification(scope: DataScope, input: NotificationInput): Promise<Notification> {
    const value = { ...input, id: input.id ?? `notification-${randomUUID()}`, createdAt: input.createdAt ?? this.isoNow() }
    return this.appendNotification(scope, value)
  }

  async acknowledgeNotification(scope: DataScope, notificationId: string): Promise<boolean> {
    const stableScope = copyScope(scope)
    assertScope(stableScope)
    const changed = await this.write(() => this.transaction(() => {
      const parameters = [stableScope.workspaceId, stableScope.cardId, stableScope.sessionId, stableScope.branchId, notificationId] as const
      const row = this.database.prepare('SELECT acknowledged FROM notifications WHERE workspace_id = ? AND card_id = ? AND session_id = ? AND branch_id = ? AND id = ?').get(...parameters)
      if (!row) return false
      if (numberValue(row, 'acknowledged') === 0) {
        this.database.prepare('UPDATE notifications SET acknowledged = 1 WHERE workspace_id = ? AND card_id = ? AND session_id = ? AND branch_id = ? AND id = ?').run(...parameters)
        this.bumpRevision(stableScope)
      }
      return true
    }))
    if (changed) await this.emit(stableScope)
    return changed
  }

  subscribeNotifications(listener: NotificationListener): () => void {
    this.assertOpen()
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async listBackups(scope: DataScope, query: PageQuery): Promise<Page<BackupRecord>> {
    const limit = assertQuery(scope, query)
    await this.pendingWrites()
    const cursor = query.cursor ? this.decodePageCursor(query.cursor, scope, 'backups') : undefined
    const cursorSql = cursor === undefined ? '' : ' AND (created_at < ? OR (created_at = ? AND id < ?))'
    const parameters: SQLInputValue[] = [scope.workspaceId, scope.cardId, scope.sessionId]
    if (cursor !== undefined) parameters.push(String(cursor.primary), String(cursor.primary), cursor.id)
    parameters.push(limit + 1)
    const rows = this.database.prepare(`SELECT * FROM backups WHERE workspace_id = ? AND card_id = ? AND session_id = ?${cursorSql} ORDER BY created_at DESC, id DESC LIMIT ?`).all(...parameters)
    return this.createdPage(rows, limit, scope, 'backups', row => backupFromRow(row, scope))
  }

  async exportBackup(scope: DataScope, backupId: string): Promise<Uint8Array | undefined> {
    const stableScope = copyScope(scope)
    assertScope(stableScope)
    await this.pendingWrites()
    const row = this.backupRow(stableScope, backupId)
    if (!row || stringValue(row, 'state') !== 'ready') return undefined
    const path = join(this.paths.backups, stringValue(row, 'file_name'))
    const bytes = await readRegular(path, this.paths.backups)
    await this.parseBackupBytes(bytes, stringValue(row, 'manifest_hash'), stableScope)
    return Buffer.from(bytes)
  }

  async importBackup(scope: DataScope, bytes: Uint8Array, commandId: string): Promise<BackupRecord> {
    const stableScope = copyScope(scope)
    const stableBytes = Buffer.from(bytes)
    assertScope(stableScope)
    if (!commandId || commandId.length > 200) throw new DataValidationError('Invalid backup import command id')
    if (stableBytes.byteLength > MAX_BACKUP_BYTES) throw new DataValidationError('Backup exceeds the 32 MiB limit')
    const file = await this.parseBackupBytes(stableBytes, undefined, stableScope)
    const payload = { contentHash: sha256(stableBytes) }
    return this.write(async () => {
      const replay = this.readJournal<BackupRecord>(stableScope, 'backup.import', commandId, payload)
      if (replay) return replay
      const id = `backup-${randomUUID()}`
      const fileName = `${id}.json`
      const path = join(this.paths.backups, fileName)
      await writeAtomic(path, stableBytes)
      await this.readBackupFile(path, file.manifestHash, stableScope)
      const record: BackupRecord = { id, schemaVersion: LOCAL_DATA_SCHEMA_VERSION, scope: { ...stableScope }, createdAt: file.manifest.createdAt, state: 'ready', manifestHash: file.manifestHash, includes: { authoritativeAppData: true, rpProjections: true, dshSessions: false } }
      try {
        const result = this.transaction(() => {
          const concurrentReplay = this.readJournal<BackupRecord>(stableScope, 'backup.import', commandId, payload)
          if (concurrentReplay) return concurrentReplay
          this.insertBackup(stableScope, record, commandId, fileName)
          this.insertJournal(stableScope, 'backup.import', commandId, payload, record)
          this.bumpRevision(stableScope)
          return record
        })
        if (result.id !== record.id) await rm(path, { force: true })
        return result
      } catch (error) {
        await rm(path, { force: true })
        throw error
      }
    })
  }

  async createBackup(scope: DataScope, commandId: string): Promise<BackupRecord> {
    const stableScope = copyScope(scope)
    assertScope(stableScope)
    if (!commandId || commandId.length > 200) throw new DataValidationError('Invalid backup command id')
    return this.write(async () => {
      const replay = this.readJournal<BackupRecord>(stableScope, 'backup.create', commandId, { commandId })
      if (replay) return replay
      const captured = this.captureManifest(stableScope)
      const file = await this.materializeManifest(captured.manifest)
      const id = `backup-${randomUUID()}`
      const fileName = `${id}.json`
      const filePath = join(this.paths.backups, fileName)
      await writeAtomic(filePath, Buffer.from(stableJson(file)))
      await this.readBackupFile(filePath, file.manifestHash, stableScope)
      const record: BackupRecord = {
        id,
        schemaVersion: LOCAL_DATA_SCHEMA_VERSION,
        scope: { ...stableScope },
        createdAt: file.manifest.createdAt,
        state: 'ready',
        manifestHash: file.manifestHash,
        includes: { authoritativeAppData: true, rpProjections: true, dshSessions: false },
      }
      try {
        const result = this.transaction(() => {
          const concurrentReplay = this.readJournal<BackupRecord>(stableScope, 'backup.create', commandId, { commandId })
          if (concurrentReplay) return concurrentReplay
          if (this.revision(stableScope) !== captured.revision) throw new DataConflictError('Data changed while the backup snapshot was being finalized')
          this.insertBackup(stableScope, record, commandId, fileName)
          this.insertJournal(stableScope, 'backup.create', commandId, { commandId }, record)
          this.bumpRevision(stableScope)
          return record
        })
        if (result.id !== record.id) await rm(filePath, { force: true })
        return result
      } catch (error) {
        await rm(filePath, { force: true })
        throw error
      }
    })
  }

  async stageRestore(scope: DataScope, backupId: string): Promise<{ backupId: string; restoreToken: string; expiresAt: string; manifestHash: string } | undefined> {
    const stableScope = copyScope(scope)
    assertScope(stableScope)
    return this.write(async () => {
      const backup = this.backupRow(stableScope, backupId)
      if (!backup || stringValue(backup, 'state') !== 'ready') return undefined
      const file = await this.readBackupFile(join(this.paths.backups, stringValue(backup, 'file_name')), stringValue(backup, 'manifest_hash'), stableScope)
      const restoreToken = randomBytes(32).toString('base64url')
      const tokenHash = sha256(restoreToken)
      const expiresAt = new Date(this.now() + this.restoreTtlMs).toISOString()
      this.transaction(() => {
        this.database.prepare('DELETE FROM restore_stages WHERE expires_at <= ?').run(this.isoNow())
        this.database.prepare('INSERT INTO restore_stages(workspace_id, card_id, session_id, backup_id, token_hash, manifest_hash, base_revision, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(workspace_id, card_id, session_id, backup_id) DO UPDATE SET token_hash = excluded.token_hash, manifest_hash = excluded.manifest_hash, base_revision = excluded.base_revision, expires_at = excluded.expires_at').run(stableScope.workspaceId, stableScope.cardId, stableScope.sessionId, backupId, tokenHash, file.manifestHash, this.revision(stableScope), expiresAt)
      })
      this.stagedHashes.add(tokenHash)
      return { backupId, restoreToken, expiresAt, manifestHash: file.manifestHash }
    })
  }

  async commitRestore(scope: DataScope, backupId: string, restoreToken: string): Promise<{ restored: true; rollbackBackupId: string } | undefined> {
    const stableScope = copyScope(scope)
    assertScope(stableScope)
    return this.write(async () => {
      const initialStage = this.restoreStage(stableScope, backupId)
      const tokenHash = sha256(restoreToken)
      if (!initialStage || !this.stagedHashes.has(tokenHash) || Date.parse(stringValue(initialStage, 'expires_at')) <= this.now() || !equalHash(stringValue(initialStage, 'token_hash'), tokenHash)) return undefined
      const sourceRow = this.backupRow(stableScope, backupId)
      if (!sourceRow) return undefined
      const sourceFile = await this.readBackupFile(join(this.paths.backups, stringValue(sourceRow, 'file_name')), stringValue(initialStage, 'manifest_hash'), stableScope)
      await this.ensureManifestAssets(sourceFile.manifest)

      const rollbackCapture = this.captureManifest(stableScope)
      const rollbackFile = await this.materializeManifest(rollbackCapture.manifest)
      const rollbackId = `backup-${randomUUID()}`
      const rollbackFileName = `${rollbackId}.json`
      const rollbackPath = join(this.paths.backups, rollbackFileName)
      await writeAtomic(rollbackPath, Buffer.from(stableJson(rollbackFile)))
      await this.readBackupFile(rollbackPath, rollbackFile.manifestHash, stableScope)
      const rollbackRecord: BackupRecord = {
        id: rollbackId,
        schemaVersion: LOCAL_DATA_SCHEMA_VERSION,
        scope: { ...stableScope },
        createdAt: rollbackFile.manifest.createdAt,
        state: 'ready',
        manifestHash: rollbackFile.manifestHash,
        includes: { authoritativeAppData: true, rpProjections: true, dshSessions: false },
      }

      try {
        const result = this.transaction(() => {
          const stage = this.restoreStage(stableScope, backupId)
          if (!stage || !this.stagedHashes.has(tokenHash) || Date.parse(stringValue(stage, 'expires_at')) <= this.now() || !equalHash(stringValue(stage, 'token_hash'), tokenHash)) return undefined
          if (this.revision(stableScope) !== numberValue(stage, 'base_revision') || rollbackCapture.revision !== numberValue(stage, 'base_revision')) throw new DataConflictError('Data changed after restore validation')
          const currentBackup = this.backupRow(stableScope, backupId)
          if (!currentBackup || stringValue(currentBackup, 'manifest_hash') !== sourceFile.manifestHash) throw new DataIntegrityError('The staged backup changed before restore')
          this.insertBackup(stableScope, rollbackRecord, `rollback:${backupId}:${rollbackId}`, rollbackFileName)
          this.restoreManifest(stableScope, sourceFile.manifest, sourceFile.manifest.scope.branchId === stableScope.branchId)
          this.database.prepare('INSERT INTO restore_audit(id, workspace_id, card_id, session_id, source_backup_id, rollback_backup_id, source_manifest_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(`restore-${randomUUID()}`, stableScope.workspaceId, stableScope.cardId, stableScope.sessionId, backupId, rollbackId, sourceFile.manifestHash, this.isoNow())
          this.database.prepare('DELETE FROM restore_stages WHERE workspace_id = ? AND card_id = ? AND session_id = ? AND backup_id = ?').run(stableScope.workspaceId, stableScope.cardId, stableScope.sessionId, backupId)
          this.stagedHashes.delete(tokenHash)
          this.bumpRevision(stableScope)
          return { restored: true as const, rollbackBackupId: rollbackId }
        })
        if (!result) await rm(rollbackPath, { force: true })
        return result
      } catch (error) {
        await rm(rollbackPath, { force: true })
        throw error
      }
    })
  }

  async savePairingToken(record: PairingTokenRecord): Promise<void> {
    const stableRecord = structuredClone(record)
    this.assertPairingRecord(stableRecord)
    await this.write(() => this.transaction(() => {
      const existing = this.database.prepare('SELECT * FROM pairing_tokens WHERE token_hash = ?').get(stableRecord.tokenHash)
      if (existing) {
        const current = pairingRecordFromRow(existing)
        if (stableJson(current) !== stableJson({ ...stableRecord, revoked: Boolean(numberValue(existing, 'revoked')) })) throw new DataConflictError('Pairing token hash already belongs to another record')
        return
      }
      this.database.prepare('INSERT INTO pairing_tokens(token_hash, client_id, client_name, scopes_json, session_ids_json, created_at, expires_at, revoked) VALUES (?, ?, ?, ?, ?, ?, ?, 0)').run(stableRecord.tokenHash, stableRecord.clientId, stableRecord.clientName, stableJson(stableRecord.scopes), stableJson(stableRecord.sessionIds), stableRecord.createdAt, stableRecord.expiresAt)
    }))
  }

  async findPairingToken(tokenHash: string): Promise<(PairingTokenRecord & { revoked: boolean }) | undefined> {
    this.assertOpen()
    if (!/^sha256:[a-f0-9]{64}$/u.test(tokenHash)) return undefined
    await this.pendingWrites()
    const row = this.database.prepare('SELECT * FROM pairing_tokens WHERE token_hash = ?').get(tokenHash)
    return row ? pairingRecordFromRow(row) : undefined
  }

  async listPairingClients(): Promise<PairingClient[]> {
    this.assertOpen()
    await this.pendingWrites()
    const rows = this.database.prepare('SELECT * FROM pairing_tokens ORDER BY created_at DESC, token_hash DESC').all()
    const clients = new Map<string, PairingClient>()
    for (const row of rows) {
      const record = pairingRecordFromRow(row)
      if (!clients.has(record.clientId)) clients.set(record.clientId, { clientId: record.clientId, clientName: record.clientName, scopes: record.scopes, sessionIds: record.sessionIds, createdAt: record.createdAt, expiresAt: record.expiresAt, revoked: record.revoked })
    }
    return [...clients.values()]
  }

  async revokePairingClient(clientId: string): Promise<boolean> {
    this.assertOpen()
    if (!clientId) throw new DataValidationError('clientId is required')
    return this.write(() => this.transaction(() => Number(this.database.prepare('UPDATE pairing_tokens SET revoked = 1 WHERE client_id = ? AND revoked = 0').run(clientId).changes) > 0))
  }

  private async listProjection<T extends MemoryProjection | RelationshipProjection | LocationProjection>(scope: DataScope, query: PageQuery, kind: 'memories' | 'relationships' | 'locations'): Promise<Page<T>> {
    const limit = assertQuery(scope, query)
    await this.pendingWrites()
    const cursor = query.cursor ? this.decodePageCursor(query.cursor, scope, kind) : undefined
    const table = kind === 'memories' ? 'memory_index' : kind === 'relationships' ? 'relationship_edges' : 'location_snapshots'
    const cursorSql = cursor === undefined ? '' : ' AND (source_seq > ? OR (source_seq = ? AND id > ?))'
    const parameters: SQLInputValue[] = [scope.workspaceId, scope.cardId, scope.sessionId]
    if (cursor !== undefined) parameters.push(Number(cursor.primary), Number(cursor.primary), cursor.id)
    parameters.push(limit + 1)
    const rows = this.database.prepare(`SELECT * FROM ${table} WHERE workspace_id = ? AND card_id = ? AND session_id = ?${cursorSql} ORDER BY source_seq ASC, id ASC LIMIT ?`).all(...parameters)
    const selected = rows.slice(0, limit)
    const items = selected.map(row => {
      if (kind === 'memories') return memoryFromRow(row)
      if (kind === 'relationships') return relationshipFromRow(row)
      return locationFromRow(row)
    }) as T[]
    const last = selected.at(-1)
    const nextCursor = rows.length > limit && last ? this.encodePageCursor({ kind, ...scopeIdentity(scope), primary: numberValue(last, 'source_seq'), id: stringValue(last, 'id') }) : null
    return { items, nextCursor }
  }

  private card(scope: DataScope): CardRecord | undefined {
    const row = this.database.prepare('SELECT * FROM cards WHERE workspace_id = ? AND card_id = ?').get(scope.workspaceId, scope.cardId)
    if (!row) return undefined
    return { id: stringValue(row, 'card_id'), title: stringValue(row, 'title'), data: jsonObject(stringValue(row, 'data_json')), createdAt: stringValue(row, 'created_at'), updatedAt: stringValue(row, 'updated_at') }
  }

  private command<T>(scope: DataScope, domain: string, commandId: string, payload: unknown, create: () => T): T {
    return this.transaction(() => {
      const replay = this.readJournal<T>(scope, domain, commandId, payload)
      if (replay !== undefined) return replay
      const result = create()
      this.insertJournal(scope, domain, commandId, payload, result)
      this.bumpRevision(scope)
      return result
    })
  }

  private readJournal<T>(scope: DataScope, domain: string, commandId: string, payload: unknown): T | undefined {
    const row = this.database.prepare('SELECT payload_hash, result_json FROM command_journal WHERE workspace_id = ? AND card_id = ? AND session_id = ? AND domain = ? AND command_id = ?').get(scope.workspaceId, scope.cardId, scope.sessionId, domain, commandId)
    if (!row) return undefined
    if (!equalHash(stringValue(row, 'payload_hash'), sha256(stableJson(payload)))) throw new DataConflictError(`Command ${commandId} was already used with a different payload`)
    return JSON.parse(stringValue(row, 'result_json')) as T
  }

  private insertJournal(scope: DataScope, domain: string, commandId: string, payload: unknown, result: unknown): void {
    this.database.prepare('INSERT INTO command_journal(workspace_id, card_id, session_id, domain, command_id, payload_hash, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(scope.workspaceId, scope.cardId, scope.sessionId, domain, commandId, sha256(stableJson(payload)), stableJson(result), this.isoNow())
  }

  private captureManifest(scope: DataScope): { manifest: Omit<BackupManifest, 'assetBlobs'>; revision: number } {
    return this.transaction(() => {
      const parameters = [scope.workspaceId, scope.cardId, scope.sessionId] as const
      const manifest: Omit<BackupManifest, 'assetBlobs'> = {
        format: 'dsh-rp-local-data-backup',
        schemaVersion: LOCAL_DATA_SCHEMA_VERSION,
        scope: { ...scope },
        createdAt: this.isoNow(),
        includes: { authoritativeAppData: true, rpProjections: true, dshSessions: false, pairingTokens: false, authorizationState: false },
        rows: {
          cards: [],
          assets: this.database.prepare('SELECT * FROM assets WHERE workspace_id = ? AND card_id = ? AND session_id = ? ORDER BY id').all(...parameters),
          ledgerEntries: this.database.prepare('SELECT * FROM ledger_entries WHERE workspace_id = ? AND card_id = ? AND session_id = ? ORDER BY id').all(...parameters),
          knowledgeItems: this.database.prepare('SELECT * FROM knowledge_items WHERE workspace_id = ? AND card_id = ? AND session_id = ? ORDER BY id').all(...parameters),
          memoryIndex: this.database.prepare('SELECT * FROM memory_index WHERE workspace_id = ? AND card_id = ? AND session_id = ? ORDER BY branch_id, source_seq, id').all(...parameters),
          relationshipEdges: this.database.prepare('SELECT * FROM relationship_edges WHERE workspace_id = ? AND card_id = ? AND session_id = ? ORDER BY branch_id, source_seq, id').all(...parameters),
          locationSnapshots: this.database.prepare('SELECT * FROM location_snapshots WHERE workspace_id = ? AND card_id = ? AND session_id = ? ORDER BY branch_id, source_seq, id').all(...parameters),
          commandJournal: this.database.prepare("SELECT * FROM command_journal WHERE workspace_id = ? AND card_id = ? AND session_id = ? AND domain IN ('asset.create', 'asset.update', 'asset.delete', 'ledger.append', 'knowledge.create', 'knowledge.update', 'knowledge.delete') ORDER BY domain, command_id").all(...parameters),
        },
      }
      return { manifest, revision: this.revision(scope) }
    }, false)
  }

  private async materializeManifest(captured: Omit<BackupManifest, 'assetBlobs'>): Promise<BackupFile> {
    const assetBlobs: BackupManifest['assetBlobs'] = []
    for (const row of captured.rows.assets) {
      const metadata = assetFromRow(row)
      const bytes = await readRegular(await assetPath(this.paths.assets, metadata.id), this.paths.assets, MAX_ASSET_BYTES)
      assertAsset(metadata, bytes)
      assetBlobs.push({ id: metadata.id, bytesBase64: bytes.toString('base64') })
    }
    const manifest: BackupManifest = { ...captured, assetBlobs }
    const manifestHash = sha256(stableJson(manifest))
    const encoded = Buffer.from(stableJson({ manifestHash, manifest }))
    if (encoded.byteLength > MAX_BACKUP_BYTES) throw new DataValidationError('Backup exceeds the 32 MiB limit')
    return { manifestHash, manifest }
  }

  private async readBackupFile(path: string, expectedHash: string, expectedScope: DataScope): Promise<BackupFile> {
    const bytes = await readRegular(path, this.paths.backups)
    return this.parseBackupBytes(bytes, expectedHash, expectedScope)
  }

  private async parseBackupBytes(bytes: Uint8Array, expectedHash: string | undefined, expectedScope: DataScope): Promise<BackupFile> {
    if (bytes.byteLength > MAX_BACKUP_BYTES) throw new DataIntegrityError('Backup exceeds its size limit')
    let parsed: unknown
    try { parsed = JSON.parse(Buffer.from(bytes).toString('utf8')) } catch (error) { throw new DataIntegrityError('Backup is not valid JSON', { cause: error }) }
    if (!isRecord(parsed) || !exactKeys(parsed, ['manifest', 'manifestHash']) || typeof parsed.manifestHash !== 'string' || !isRecord(parsed.manifest)) throw new DataIntegrityError('Backup envelope is invalid')
    const manifest = parsed.manifest as unknown as BackupManifest
    if (!/^sha256:[a-f0-9]{64}$/u.test(parsed.manifestHash) || (expectedHash !== undefined && parsed.manifestHash !== expectedHash) || sha256(stableJson(manifest)) !== parsed.manifestHash) throw new DataIntegrityError('Backup manifest hash does not match')
    this.validateManifest(manifest, expectedScope)
    return { manifestHash: parsed.manifestHash, manifest }
  }

  private validateManifest(manifest: BackupManifest, expectedScope: DataScope): void {
    if (!exactKeys(manifest as unknown as Record<string, unknown>, ['assetBlobs', 'createdAt', 'format', 'includes', 'rows', 'schemaVersion', 'scope'])) throw new DataIntegrityError('Backup manifest has unknown fields')
    if (manifest.format !== 'dsh-rp-local-data-backup' || manifest.schemaVersion !== LOCAL_DATA_SCHEMA_VERSION) throw new DataIntegrityError('Backup format or schema is unsupported')
    assertIsoDate(manifest.createdAt, 'createdAt')
    assertScope(manifest.scope)
    if (manifest.scope.workspaceId !== expectedScope.workspaceId || manifest.scope.cardId !== expectedScope.cardId || manifest.scope.sessionId !== expectedScope.sessionId) throw new DataIntegrityError('Backup belongs to another stable scope')
    if (!isRecord(manifest.includes) || !exactKeys(manifest.includes, ['authorizationState', 'authoritativeAppData', 'dshSessions', 'pairingTokens', 'rpProjections']) || manifest.includes.authoritativeAppData !== true || manifest.includes.rpProjections !== true || manifest.includes.dshSessions !== false || manifest.includes.pairingTokens !== false || manifest.includes.authorizationState !== false) throw new DataIntegrityError('Backup inclusion boundary is invalid')
    if (!isRecord(manifest.rows) || !exactKeys(manifest.rows, ['assets', 'cards', 'commandJournal', 'knowledgeItems', 'ledgerEntries', 'locationSnapshots', 'memoryIndex', 'relationshipEdges']) || !Array.isArray(manifest.rows.cards) || manifest.rows.cards.length !== 0 || !Array.isArray(manifest.rows.assets) || !Array.isArray(manifest.rows.ledgerEntries) || !Array.isArray(manifest.rows.knowledgeItems) || !Array.isArray(manifest.rows.memoryIndex) || !Array.isArray(manifest.rows.relationshipEdges) || !Array.isArray(manifest.rows.locationSnapshots) || !Array.isArray(manifest.rows.commandJournal) || !Array.isArray(manifest.assetBlobs)) throw new DataIntegrityError('Backup row sets are invalid')
    const rowShapes: Array<[Row[], string[]]> = [
      [manifest.rows.assets, ['workspace_id', 'card_id', 'session_id', 'id', 'file_name', 'mime_type', 'category', 'label', 'byte_length', 'created_at']],
      [manifest.rows.ledgerEntries, ['workspace_id', 'card_id', 'session_id', 'id', 'command_id', 'amount_minor', 'currency', 'description', 'occurred_at', 'created_at', 'reverses_entry_id']],
      [manifest.rows.knowledgeItems, ['workspace_id', 'card_id', 'session_id', 'id', 'text', 'source', 'branch_id', 'source_seq', 'created_at', 'updated_at']],
      [manifest.rows.memoryIndex, ['workspace_id', 'card_id', 'session_id', 'branch_id', 'source_seq', 'id', 'text', 'emotion']],
      [manifest.rows.relationshipEdges, ['workspace_id', 'card_id', 'session_id', 'branch_id', 'source_seq', 'id', 'subject', 'object', 'relation', 'status']],
      [manifest.rows.locationSnapshots, ['workspace_id', 'card_id', 'session_id', 'branch_id', 'source_seq', 'id', 'world', 'region', 'scene', 'landmark']],
      [manifest.rows.commandJournal, ['workspace_id', 'card_id', 'session_id', 'domain', 'command_id', 'payload_hash', 'result_json', 'created_at']],
    ]
    for (const [rows, keys] of rowShapes) for (const row of rows) if (!isRecord(row) || !exactKeys(row, keys)) throw new DataIntegrityError('Backup row shape is invalid')
    const scopedRows = rowShapes.map(([rows]) => rows)
    for (const rows of scopedRows) for (const row of rows) this.assertManifestRowScope(row, expectedScope)
    for (const row of manifest.rows.commandJournal) if (!RESTORABLE_JOURNAL_DOMAINS.has(stringValue(row, 'domain'))) throw new DataIntegrityError('Backup contains a non-restorable journal domain')
    for (const row of manifest.rows.knowledgeItems) if (stringValue(row, 'source') !== 'user' || row.branch_id !== null || row.source_seq !== null) throw new DataIntegrityError('Backup knowledge rows must be authoritative user data')
    for (const row of manifest.rows.assets) assertAssetMetadata(assetFromRow(row))
    validateLedgerRows(manifest.rows.ledgerEntries)
    for (const row of manifest.rows.knowledgeItems) knowledgeFromRow(row)
    for (const row of manifest.rows.memoryIndex) memoryFromRow(row)
    for (const row of manifest.rows.relationshipEdges) relationshipFromRow(row)
    for (const row of manifest.rows.locationSnapshots) locationFromRow(row)
    for (const row of manifest.rows.commandJournal) {
      if (!/^sha256:[a-f0-9]{64}$/u.test(stringValue(row, 'payload_hash'))) throw new DataIntegrityError('Backup journal hash is invalid')
      JSON.parse(stringValue(row, 'result_json'))
    }
    for (const blob of manifest.assetBlobs) if (!isRecord(blob) || !exactKeys(blob, ['bytesBase64', 'id']) || typeof blob.id !== 'string' || typeof blob.bytesBase64 !== 'string') throw new DataIntegrityError('Backup asset entry is invalid')
    const blobIds = new Set(manifest.assetBlobs.map(blob => blob.id))
    const assetIds = new Set(manifest.rows.assets.map(row => stringValue(row, 'id')))
    if (blobIds.size !== manifest.assetBlobs.length || stableJson([...blobIds].sort()) !== stableJson([...assetIds].sort())) throw new DataIntegrityError('Backup asset manifest is inconsistent')
    const metadataById = new Map(manifest.rows.assets.map(row => {
      const metadata = assetFromRow(row)
      return [metadata.id, metadata] as const
    }))
    for (const blob of manifest.assetBlobs) {
      const metadata = metadataById.get(blob.id)
      if (!metadata || !validBase64(blob.bytesBase64)) throw new DataIntegrityError('Backup asset payload is invalid')
      assertAsset(metadata, Buffer.from(blob.bytesBase64, 'base64'))
    }
  }

  private async ensureManifestAssets(manifest: BackupManifest): Promise<void> {
    const metadataById = new Map(manifest.rows.assets.map(row => {
      const metadata = assetFromRow(row)
      return [metadata.id, metadata] as const
    }))
    for (const blob of manifest.assetBlobs) {
      const metadata = metadataById.get(blob.id)
      if (!metadata || !validBase64(blob.bytesBase64)) throw new DataIntegrityError('Backup asset payload is invalid')
      const bytes = Buffer.from(blob.bytesBase64, 'base64')
      assertAsset(metadata, bytes)
      const path = await assetPath(this.paths.assets, blob.id, true)
      try {
        const existing = await readRegular(path, this.paths.assets, MAX_ASSET_BYTES)
        assertAsset(metadata, existing)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        await writeAtomic(path, bytes)
      }
    }
  }

  private restoreManifest(scope: DataScope, manifest: BackupManifest, restoreProjection: boolean): void {
    const parameters = [scope.workspaceId, scope.cardId, scope.sessionId] as const
    for (const table of ['assets', 'ledger_entries', 'knowledge_items'] as const) this.database.prepare(`DELETE FROM ${table} WHERE workspace_id = ? AND card_id = ? AND session_id = ?`).run(...parameters)
    for (const table of ['memory_index', 'relationship_edges', 'location_snapshots'] as const) this.database.prepare(`DELETE FROM ${table} WHERE workspace_id = ? AND card_id = ? AND session_id = ?`).run(...parameters)
    this.database.prepare("DELETE FROM command_journal WHERE workspace_id = ? AND card_id = ? AND session_id = ? AND domain IN ('asset.create', 'asset.update', 'asset.delete', 'ledger.append', 'knowledge.create', 'knowledge.update', 'knowledge.delete')").run(...parameters)

    const asset = this.database.prepare('INSERT INTO assets(workspace_id, card_id, session_id, id, file_name, mime_type, category, label, byte_length, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    for (const row of manifest.rows.assets) asset.run(...pick(row, ['workspace_id', 'card_id', 'session_id', 'id', 'file_name', 'mime_type', 'category', 'label', 'byte_length', 'created_at']))
    const ledger = this.database.prepare('INSERT INTO ledger_entries(workspace_id, card_id, session_id, id, command_id, amount_minor, currency, description, occurred_at, created_at, reverses_entry_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    for (const row of manifest.rows.ledgerEntries) ledger.run(...pick(row, ['workspace_id', 'card_id', 'session_id', 'id', 'command_id', 'amount_minor', 'currency', 'description', 'occurred_at', 'created_at', 'reverses_entry_id']))
    const knowledge = this.database.prepare('INSERT INTO knowledge_items(workspace_id, card_id, session_id, id, text, source, branch_id, source_seq, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    for (const row of manifest.rows.knowledgeItems) knowledge.run(...pick(row, ['workspace_id', 'card_id', 'session_id', 'id', 'text', 'source', 'branch_id', 'source_seq', 'created_at', 'updated_at']))
    if (restoreProjection) {
      const memory = this.database.prepare('INSERT INTO memory_index(workspace_id, card_id, session_id, branch_id, source_seq, id, text, emotion) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      for (const row of manifest.rows.memoryIndex) memory.run(...pick(row, ['workspace_id', 'card_id', 'session_id', 'branch_id', 'source_seq', 'id', 'text', 'emotion']))
      const relationship = this.database.prepare('INSERT INTO relationship_edges(workspace_id, card_id, session_id, branch_id, source_seq, id, subject, object, relation, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      for (const row of manifest.rows.relationshipEdges) relationship.run(...pick(row, ['workspace_id', 'card_id', 'session_id', 'branch_id', 'source_seq', 'id', 'subject', 'object', 'relation', 'status']))
      const location = this.database.prepare('INSERT INTO location_snapshots(workspace_id, card_id, session_id, branch_id, source_seq, id, world, region, scene, landmark) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      for (const row of manifest.rows.locationSnapshots) location.run(...pick(row, ['workspace_id', 'card_id', 'session_id', 'branch_id', 'source_seq', 'id', 'world', 'region', 'scene', 'landmark']))
    }
    const journal = this.database.prepare('INSERT INTO command_journal(workspace_id, card_id, session_id, domain, command_id, payload_hash, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    for (const row of manifest.rows.commandJournal) journal.run(...pick(row, ['workspace_id', 'card_id', 'session_id', 'domain', 'command_id', 'payload_hash', 'result_json', 'created_at']))
  }

  private insertBackup(scope: DataScope, record: BackupRecord, commandId: string, fileName: string): void {
    this.database.prepare('INSERT INTO backups(workspace_id, card_id, session_id, id, command_id, schema_version, created_at, state, manifest_hash, file_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(scope.workspaceId, scope.cardId, scope.sessionId, record.id, commandId, record.schemaVersion, record.createdAt, record.state, record.manifestHash, fileName)
  }

  private backupRow(scope: DataScope, backupId: string): Row | undefined {
    return this.database.prepare('SELECT * FROM backups WHERE workspace_id = ? AND card_id = ? AND session_id = ? AND id = ?').get(scope.workspaceId, scope.cardId, scope.sessionId, backupId)
  }

  private restoreStage(scope: DataScope, backupId: string): Row | undefined {
    return this.database.prepare('SELECT * FROM restore_stages WHERE workspace_id = ? AND card_id = ? AND session_id = ? AND backup_id = ?').get(scope.workspaceId, scope.cardId, scope.sessionId, backupId)
  }

  private assertManifestRowScope(row: Row, scope: DataScope): void {
    if (!isRecord(row) || stringValue(row, 'workspace_id') !== scope.workspaceId || stringValue(row, 'card_id') !== scope.cardId || stringValue(row, 'session_id') !== scope.sessionId) throw new DataIntegrityError('Backup contains a row from another scope')
  }

  private assertPairingRecord(record: PairingTokenRecord): void {
    if (!/^sha256:[a-f0-9]{64}$/u.test(record.tokenHash) || !record.clientId || !record.clientName) throw new DataValidationError('Pairing records require ids and a token hash')
    if (!Array.isArray(record.scopes) || record.scopes.some(scope => !PAIRING_SCOPES.has(scope)) || new Set(record.scopes).size !== record.scopes.length || !Array.isArray(record.sessionIds) || record.sessionIds.length < 1 || record.sessionIds.length > 32 || new Set(record.sessionIds).size !== record.sessionIds.length || record.sessionIds.some(id => typeof id !== 'string' || id.length === 0 || id.length > 512)) throw new DataValidationError('Pairing capabilities are invalid')
    assertIsoDate(record.createdAt, 'createdAt')
    assertIsoDate(record.expiresAt, 'expiresAt')
  }

  private revision(scope: DataScope): number {
    const row = this.database.prepare('SELECT revision FROM scope_revisions WHERE workspace_id = ? AND card_id = ? AND session_id = ?').get(scope.workspaceId, scope.cardId, scope.sessionId)
    return row ? numberValue(row, 'revision') : 0
  }

  private bumpRevision(scope: DataScope): void {
    this.database.prepare('INSERT INTO scope_revisions(workspace_id, card_id, session_id, revision) VALUES (?, ?, ?, 1) ON CONFLICT(workspace_id, card_id, session_id) DO UPDATE SET revision = revision + 1').run(scope.workspaceId, scope.cardId, scope.sessionId)
  }

  private transaction<T>(operation: () => T, immediate = true): T {
    this.database.exec(immediate ? 'BEGIN IMMEDIATE' : 'BEGIN')
    try {
      const result = operation()
      this.database.exec('COMMIT')
      return result
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  private createdPage<T>(rows: Row[], limit: number, scope: DataScope, kind: string, convert: (row: Row) => T): Page<T> {
    const selected = rows.slice(0, limit)
    const last = selected.at(-1)
    return {
      items: selected.map(convert),
      nextCursor: rows.length > limit && last ? this.encodePageCursor({ kind, ...scopeIdentity(scope), primary: stringValue(last, 'created_at'), id: stringValue(last, 'id') }) : null,
    }
  }

  private encodePageCursor(cursor: PageCursor): string {
    return this.signCursor(cursor)
  }

  private decodePageCursor(value: string, scope: DataScope, kind: string): PageCursor {
    const cursor = this.verifyCursor(value)
    if (!isRecord(cursor) || cursor.kind !== kind || cursor.workspaceId !== scope.workspaceId || cursor.cardId !== scope.cardId || cursor.sessionId !== scope.sessionId || (typeof cursor.primary !== 'string' && typeof cursor.primary !== 'number') || typeof cursor.id !== 'string') throw new DataValidationError('Cursor does not belong to this collection scope')
    return cursor as unknown as PageCursor
  }

  private encodeNotificationCursor(scope: DataScope, seq: number): string {
    return this.signCursor({ kind: 'notifications', ...scopeIdentity(scope), seq })
  }

  private decodeNotificationCursor(value: string, scope: DataScope): NotificationCursor {
    const cursor = this.verifyCursor(value)
    if (!isRecord(cursor) || cursor.kind !== 'notifications' || cursor.workspaceId !== scope.workspaceId || cursor.cardId !== scope.cardId || cursor.sessionId !== scope.sessionId || typeof cursor.seq !== 'number' || !Number.isSafeInteger(cursor.seq) || cursor.seq < 0) throw new DataValidationError('Notification cursor does not belong to this scope')
    return cursor as unknown as NotificationCursor
  }

  private signCursor(value: object): string {
    const payload = Buffer.from(stableJson(value)).toString('base64url')
    const signature = createHmac('sha256', this.cursorSecret).update(payload).digest('base64url')
    return `${payload}.${signature}`
  }

  private verifyCursor(value: string): unknown {
    const [payload, signature, extra] = value.split('.')
    if (!payload || !signature || extra !== undefined) throw new DataValidationError('Malformed cursor')
    const expected = createHmac('sha256', this.cursorSecret).update(payload).digest('base64url')
    if (!equalText(signature, expected)) throw new DataValidationError('Invalid cursor signature')
    try { return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) } catch (error) { throw new DataValidationError('Malformed cursor payload', { cause: error }) }
  }

  private notificationFromRow(row: Row, scope: DataScope): Notification {
    return { id: stringValue(row, 'id'), cursor: this.encodeNotificationCursor(scope, numberValue(row, 'seq')), type: stringValue(row, 'type'), title: stringValue(row, 'title'), body: stringValue(row, 'body'), createdAt: stringValue(row, 'created_at'), acknowledged: numberValue(row, 'acknowledged') !== 0 }
  }

  private async emit(scope: DataScope): Promise<void> {
    if (this.listeners.size === 0) return
    const batch = await this.readNotifications(scope)
    for (const listener of this.listeners) {
      try { listener({ ...scope }, batch) } catch { /* Subscribers cannot roll back an already committed notification. */ }
    }
  }

  private write<T>(operation: () => T | Promise<T>): Promise<T> {
    this.assertOpen()
    const result = this.writeTail.then(async () => {
      if (this.closed) throw new StoreClosedError('LocalDataStore is closed')
      return operation()
    })
    this.writeTail = result.then(() => undefined, () => undefined)
    return result
  }

  private async pendingWrites(): Promise<void> {
    this.assertOpen()
    await this.writeTail
    this.assertOpen()
  }

  private assertOpen(): void {
    if (this.closed || this.closing) throw new StoreClosedError('LocalDataStore is closed')
  }

  private isoNow(): string {
    return new Date(this.now()).toISOString()
  }
}

export async function createLocalDataStore(options: LocalDataStoreOptions): Promise<LocalDataStore> {
  return LocalDataStore.open(options)
}

function copyScope(scope: DataScope): DataScope {
  return { workspaceId: scope.workspaceId, cardId: scope.cardId, sessionId: scope.sessionId, branchId: scope.branchId }
}

function scopeIdentity(scope: DataScope): Pick<PageCursor, 'workspaceId' | 'cardId' | 'sessionId'> {
  return { workspaceId: scope.workspaceId, cardId: scope.cardId, sessionId: scope.sessionId }
}

function stringValue(row: Row | undefined, key: string): string {
  const value = row?.[key]
  if (typeof value !== 'string') throw new DataIntegrityError(`Expected string column ${key}`)
  return value
}

function numberValue(row: Row | undefined, key: string): number {
  const value = row?.[key]
  if (typeof value !== 'number' && typeof value !== 'bigint') throw new DataIntegrityError(`Expected numeric column ${key}`)
  const number = Number(value)
  if (!Number.isSafeInteger(number)) throw new DataIntegrityError(`Column ${key} is outside the safe integer range`)
  return number
}

function nullableNumber(row: Row | undefined, key: string): number | undefined {
  if (row?.[key] === null || row?.[key] === undefined) return undefined
  return numberValue(row, key)
}

function optionalString(row: Row, key: string): string | undefined {
  const value = row[key]
  if (value === null || value === undefined) return undefined
  if (typeof value !== 'string') throw new DataIntegrityError(`Expected optional string column ${key}`)
  return value
}

function jsonObject(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value)
  if (!isRecord(parsed)) throw new DataIntegrityError('Expected a JSON object')
  return parsed
}

function jsonStrings(value: string): string[] {
  const parsed: unknown = JSON.parse(value)
  if (!Array.isArray(parsed) || parsed.some(item => typeof item !== 'string')) throw new DataIntegrityError('Expected a JSON string array')
  return parsed
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index])
}

function pick(row: Row, keys: string[]): SQLInputValue[] {
  return keys.map(key => {
    const value = row[key]
    if (value === undefined) throw new DataIntegrityError(`Backup row is missing ${key}`)
    return value
  })
}

function equalText(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return leftBuffer.byteLength === rightBuffer.byteLength && leftBuffer.equals(rightBuffer)
}

function assetFromRow(row: Row): AssetMetadata {
  const label = optionalString(row, 'label')
  return { id: stringValue(row, 'id'), fileName: stringValue(row, 'file_name'), mimeType: stringValue(row, 'mime_type') as AssetMetadata['mimeType'], category: stringValue(row, 'category') as AssetMetadata['category'], ...(label === undefined ? {} : { label }), bytes: numberValue(row, 'byte_length'), createdAt: stringValue(row, 'created_at') }
}

function ledgerFromRow(row: Row): LedgerEntry {
  const reversesEntryId = optionalString(row, 'reverses_entry_id')
  return { id: stringValue(row, 'id'), commandId: stringValue(row, 'command_id'), amountMinor: numberValue(row, 'amount_minor'), currency: stringValue(row, 'currency'), description: stringValue(row, 'description'), occurredAt: stringValue(row, 'occurred_at'), createdAt: stringValue(row, 'created_at'), ...(reversesEntryId === undefined ? {} : { reversesEntryId }) }
}

function knowledgeFromRow(row: Row): KnowledgeItem {
  const source = stringValue(row, 'source') as KnowledgeItem['source']
  const branchId = optionalString(row, 'branch_id')
  const sourceSeq = nullableNumber(row, 'source_seq')
  return { id: stringValue(row, 'id'), text: stringValue(row, 'text'), source, ...(branchId === undefined || sourceSeq === undefined ? {} : { provenance: { branchId, sourceSeq } }), createdAt: stringValue(row, 'created_at'), updatedAt: stringValue(row, 'updated_at') }
}

function memoryFromRow(row: Row): MemoryProjection {
  const emotion = optionalString(row, 'emotion')
  return { id: stringValue(row, 'id'), sessionId: stringValue(row, 'session_id'), branchId: stringValue(row, 'branch_id'), sourceSeq: numberValue(row, 'source_seq'), text: stringValue(row, 'text'), ...(emotion === undefined ? {} : { emotion }) }
}

function relationshipFromRow(row: Row): RelationshipProjection {
  const status = optionalString(row, 'status')
  return { id: stringValue(row, 'id'), sessionId: stringValue(row, 'session_id'), branchId: stringValue(row, 'branch_id'), sourceSeq: numberValue(row, 'source_seq'), subject: stringValue(row, 'subject'), object: stringValue(row, 'object'), relation: stringValue(row, 'relation'), ...(status === undefined ? {} : { status }) }
}

function locationFromRow(row: Row): LocationProjection {
  const region = optionalString(row, 'region')
  const scene = optionalString(row, 'scene')
  const landmark = optionalString(row, 'landmark')
  return { id: stringValue(row, 'id'), sessionId: stringValue(row, 'session_id'), branchId: stringValue(row, 'branch_id'), sourceSeq: numberValue(row, 'source_seq'), world: stringValue(row, 'world'), ...(region === undefined ? {} : { region }), ...(scene === undefined ? {} : { scene }), ...(landmark === undefined ? {} : { landmark }) }
}

function backupFromRow(row: Row, scope: DataScope): BackupRecord {
  return { id: stringValue(row, 'id'), schemaVersion: numberValue(row, 'schema_version'), scope: { ...scope }, createdAt: stringValue(row, 'created_at'), state: stringValue(row, 'state') as BackupRecord['state'], manifestHash: stringValue(row, 'manifest_hash'), includes: { authoritativeAppData: true, rpProjections: true, dshSessions: false } }
}

function pairingRecordFromRow(row: Row): PairingTokenRecord & { revoked: boolean } {
  return { clientId: stringValue(row, 'client_id'), clientName: stringValue(row, 'client_name'), tokenHash: stringValue(row, 'token_hash'), scopes: jsonStrings(stringValue(row, 'scopes_json')) as PairingScope[], sessionIds: jsonStrings(stringValue(row, 'session_ids_json')), createdAt: stringValue(row, 'created_at'), expiresAt: stringValue(row, 'expires_at'), revoked: numberValue(row, 'revoked') !== 0 }
}

function validateLedgerRows(rows: Row[]): void {
  const ids = new Set<string>()
  const commandIds = new Set<string>()
  const reversalTargets = new Set<string>()
  const entries = new Map<string, { id: string; commandId: string; amountMinor: number; currency: string; reversesEntryId?: string }>()
  for (const row of rows) {
    const entry = validateLedgerRow(row)
    if (ids.has(entry.id) || commandIds.has(entry.commandId)) throw new DataIntegrityError('Backup ledger entries are not unique')
    ids.add(entry.id)
    commandIds.add(entry.commandId)
    entries.set(entry.id, entry)
  }
  for (const entry of entries.values()) {
    if (entry.reversesEntryId === undefined) continue
    const target = entries.get(entry.reversesEntryId)
    if (!target || entry.reversesEntryId === entry.id || target.reversesEntryId !== undefined || target.currency !== entry.currency || target.amountMinor !== -entry.amountMinor) throw new DataIntegrityError('Backup ledger compensation is invalid')
    if (reversalTargets.has(entry.reversesEntryId)) throw new DataIntegrityError('Backup ledger compensation is duplicated')
    reversalTargets.add(entry.reversesEntryId)
  }
}

function validateLedgerRow(row: Row): LedgerEntry {
  const id = stringValue(row, 'id')
  const commandId = stringValue(row, 'command_id')
  const currency = stringValue(row, 'currency')
  const description = stringValue(row, 'description')
  const occurredAt = stringValue(row, 'occurred_at')
  const createdAt = stringValue(row, 'created_at')
  const amount = numberValue(row, 'amount_minor')
  if (!id || !commandId || commandId.length > 200 || !/^[A-Z]{3}$/u.test(currency) || !description || description.length > 2_000 || !Number.isSafeInteger(amount)) throw new DataIntegrityError('Backup ledger row is invalid')
  assertIsoDate(occurredAt, 'occurred_at')
  assertIsoDate(createdAt, 'created_at')
  const reversal = row.reverses_entry_id
  if (reversal !== null && (typeof reversal !== 'string' || !reversal)) throw new DataIntegrityError('Backup reversal id is invalid')
  try {
    assertLedger({ commandId, amountMinor: amount, currency, description, occurredAt, ...(reversal === null ? {} : { reversesEntryId: reversal }) })
  } catch (error) {
    throw new DataIntegrityError('Backup ledger row is invalid', { cause: error })
  }
  return { id, commandId, amountMinor: amount, currency, description, occurredAt, createdAt, ...(reversal === null ? {} : { reversesEntryId: reversal }) }
}
