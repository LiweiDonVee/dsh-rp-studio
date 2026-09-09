import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { createLocalDataStore, DataConflictError, type LocalDataStore, type ProjectionReplacement } from './index.js'
import { stableJson } from './validation.js'
import { writeAtomic } from './files.js'

const scopes = { workspaceId: 'workspace-a', sessionId: 'session-a', cardId: 'card-a', branchId: 'branch-a' }
const otherScope = { workspaceId: 'workspace-b', sessionId: 'session-b', cardId: 'card-b', branchId: 'branch-b' }
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

describe('LocalDataStore', () => {
  const directories: string[] = []
  const stores: LocalDataStore[] = []
  afterEach(async () => {
    await Promise.all(stores.splice(0).map(value => value.close()))
    await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
  })

  async function store() {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-local-data-'))
    directories.push(directory)
    const value = await createLocalDataStore({ dataDir: directory })
    stores.push(value)
    return { value, directory }
  }

  it('opens a real node:sqlite database and applies typed migrations', async () => {
    const { value, directory } = await store()
    expect(await value.status()).toMatchObject({ storage: 'ready', schemaVersion: expect.any(Number), projection: 'current' })
    expect(await value.schemaTables()).toEqual(expect.arrayContaining(['cards', 'assets', 'ledger_entries', 'memory_index', 'relationship_edges', 'knowledge_items', 'location_snapshots', 'backups', 'notifications', 'pairing_tokens']))
    expect(directory).toContain('dsh-local-data-')
    await value.close()
  })

  it('isolates scopes and uses opaque, scope-bound cursors', async () => {
    const { value } = await store()
    await value.appendLedger(scopes, { commandId: 'one', amountMinor: 1, currency: 'USD', description: 'one', occurredAt: '2026-09-08T00:00:00.000Z' })
    await value.appendLedger(scopes, { commandId: 'one-more', amountMinor: 3, currency: 'USD', description: 'one-more', occurredAt: '2026-09-08T00:00:01.000Z' })
    await value.appendLedger(otherScope, { commandId: 'two', amountMinor: 2, currency: 'USD', description: 'two', occurredAt: '2026-09-08T00:00:00.000Z' })
    const page = await value.listLedger(scopes, { sessionId: scopes.sessionId, limit: 1 })
    expect(page.items).toHaveLength(1)
    expect(page.nextCursor).toBeTruthy()
    expect((await value.listLedger(scopes, { sessionId: scopes.sessionId, limit: 10 })).items.map(item => item.description)).toEqual(expect.arrayContaining(['one', 'one-more']))
    await expect(value.listLedger(otherScope, { sessionId: otherScope.sessionId, cursor: page.nextCursor!, limit: 10 })).rejects.toThrow()
  })

  it('makes ledger and knowledge commands idempotent, rejecting payload conflicts', async () => {
    const { value } = await store()
    const input = { commandId: 'same', amountMinor: -1250, currency: 'USD', description: 'inn', occurredAt: '2026-09-08T12:00:00.000Z' }
    const first = await value.appendLedger(scopes, input)
    expect(await value.appendLedger(scopes, input)).toEqual(first)
    await expect(value.appendLedger(scopes, { ...input, amountMinor: -1251 })).rejects.toBeInstanceOf(DataConflictError)
    const note = { commandId: 'note-1', text: 'remember this' }
    const created = await value.createKnowledge(scopes, note)
    expect(await value.createKnowledge(scopes, note)).toEqual(created)
    await expect(value.createKnowledge(scopes, { ...note, text: 'changed' })).rejects.toBeInstanceOf(DataConflictError)
  })

  it('replaces RP projections by branch and sequence without deleting user knowledge', async () => {
    const { value } = await store()
    await value.createKnowledge(scopes, { commandId: 'user-note', text: 'authoritative note' })
    const replacement: ProjectionReplacement = {
      branchId: 'branch-new',
      fromSeq: 2,
      memories: [{ id: 'memory-2', sessionId: scopes.sessionId, branchId: 'branch-new', sourceSeq: 2, text: 'public memory' }],
      relationships: [{ id: 'edge-2', sessionId: scopes.sessionId, branchId: 'branch-new', sourceSeq: 2, subject: 'A', object: 'B', relation: 'trust' }],
      locations: [{ id: 'loc-2', sessionId: scopes.sessionId, branchId: 'branch-new', sourceSeq: 2, world: 'fiction', scene: 'harbor' }],
    }
    await value.replaceProjections(scopes, replacement)
    expect((await value.listMemories(scopes, { sessionId: scopes.sessionId, limit: 100 })).items.map(item => item.id)).toEqual(['memory-2'])
    expect((await value.listKnowledge(scopes, { sessionId: scopes.sessionId, limit: 100 })).items.map(item => item.text)).toEqual(['authoritative note'])
    await expect(value.replaceProjections(scopes, { ...replacement, memories: [{ ...replacement.memories[0]!, text: 'private', private: true } as never] })).rejects.toThrow()
  })

  it('preserves rows before fromSeq while clearing stale branches and replacement tails', async () => {
    const { value } = await store()
    await value.replaceProjections(scopes, { branchId: scopes.branchId, fromSeq: 0, memories: [
      { id: 'm1', sessionId: scopes.sessionId, branchId: scopes.branchId, sourceSeq: 1, text: 'keep' },
      { id: 'm2', sessionId: scopes.sessionId, branchId: scopes.branchId, sourceSeq: 2, text: 'stale tail' },
    ], relationships: [], locations: [] })
    await value.replaceProjections(scopes, { branchId: scopes.branchId, fromSeq: 2, memories: [
      { id: 'm3', sessionId: scopes.sessionId, branchId: scopes.branchId, sourceSeq: 2, text: 'new tail' },
    ], relationships: [], locations: [] })
    expect((await value.listMemories(scopes, { sessionId: scopes.sessionId, limit: 10 })).items.map(item => item.id)).toEqual(['m1', 'm3'])
    await value.replaceProjections(scopes, { branchId: 'new-branch', fromSeq: 0, memories: [
      { id: 'm4', sessionId: scopes.sessionId, branchId: 'new-branch', sourceSeq: 0, text: 'new branch' },
    ], relationships: [], locations: [] })
    expect((await value.listMemories(scopes, { sessionId: scopes.sessionId, limit: 10 })).items.map(item => item.id)).toEqual(['m4'])
  })

  it('stores hash-addressed assets with magic validation and rejects path names', async () => {
    const { value } = await store()
    const metadata = { id: 'sha256:' + '0'.repeat(64), fileName: 'portrait.png', mimeType: 'image/png' as const, category: 'portrait' as const, bytes: png.byteLength, createdAt: '2026-09-08T00:00:00.000Z' }
    const id = 'sha256:' + (await import('node:crypto')).createHash('sha256').update(png).digest('hex')
    const saved = await value.putAsset({ scope: scopes, metadata: { ...metadata, id }, bytes: png })
    expect(saved.id).toBe(id)
    expect((await value.readAsset(scopes, id))?.bytes).toEqual(png)
    await expect(value.putAsset({ scope: scopes, metadata: { ...metadata, id, fileName: '../escape.png' }, bytes: png })).rejects.toThrow()
    await expect(value.putAsset({ scope: scopes, metadata: { ...metadata, id, mimeType: 'image/jpeg' }, bytes: png })).rejects.toThrow()
  })

  it('allows delete and re-upload of the same content hash', async () => {
    const { value } = await store()
    const id = `sha256:${createHash('sha256').update(png).digest('hex')}`
    const metadata = { id, fileName: 'portrait.png', mimeType: 'image/png' as const, category: 'portrait' as const, bytes: png.byteLength, createdAt: '2026-09-08T00:00:00.000Z' }
    await value.putAsset({ scope: scopes, metadata, bytes: png })
    expect(await value.deleteAsset(scopes, id)).toBe(true)
    await expect(value.readAsset(scopes, id)).resolves.toBeUndefined()
    await expect(value.putAsset({ scope: scopes, metadata: { ...metadata, createdAt: '2026-09-08T00:00:01.000Z' }, bytes: png })).resolves.toEqual({ ...metadata, createdAt: '2026-09-08T00:00:01.000Z' })
  })

  it('snapshots an asset label before an asynchronous queued update', async () => {
    const { value } = await store()
    const id = `sha256:${createHash('sha256').update(png).digest('hex')}`
    await value.putAsset({ scope: scopes, metadata: { id, fileName: 'portrait.png', mimeType: 'image/png', category: 'portrait', bytes: png.byteLength, createdAt: '2026-09-08T00:00:00.000Z' }, bytes: png })
    const patch = { label: 'captured' }
    const update = value.updateAsset(scopes, id, patch)
    patch.label = 'mutated-after-call'
    await update
    expect((await value.readAsset(scopes, id))?.metadata.label).toBe('captured')
  })

  it('requires exact compensating ledger entries and rejects repeated reversals', async () => {
    const { value } = await store()
    const original = await value.appendLedger(scopes, { commandId: 'charge', amountMinor: -1250, currency: 'USD', description: 'charge', occurredAt: '2026-09-08T00:00:00.000Z' })
    const correction = { commandId: 'refund', amountMinor: 1250, currency: 'USD', description: 'refund', occurredAt: '2026-09-08T00:00:01.000Z', reversesEntryId: original.id }
    const first = await value.appendLedger(scopes, correction)
    expect(await value.appendLedger(scopes, correction)).toEqual(first)
    await expect(value.appendLedger(scopes, { ...correction, commandId: 'refund-again' })).rejects.toBeInstanceOf(DataConflictError)
    await expect(value.appendLedger(scopes, { ...correction, commandId: 'wrong-currency', currency: 'EUR' })).rejects.toThrow()
    await expect(value.appendLedger(scopes, { ...correction, commandId: 'wrong-amount', amountMinor: 1249 })).rejects.toThrow()
    await expect(value.appendLedger(scopes, { ...correction, commandId: 'reverse-refund', amountMinor: -1250, reversesEntryId: first.id })).rejects.toThrow()
  })

  it('creates, validates, stages, and commits a consistent restore with rollback', async () => {
    const { value } = await store()
    await value.appendLedger(scopes, { commandId: 'before', amountMinor: 1, currency: 'USD', description: 'before', occurredAt: '2026-09-08T00:00:00.000Z' })
    const backup = await value.createBackup(scopes, 'backup-command')
    await value.appendLedger(scopes, { commandId: 'after', amountMinor: 2, currency: 'USD', description: 'after', occurredAt: '2026-09-08T00:00:00.000Z' })
    const staged = await value.stageRestore(scopes, backup.id)
    expect(staged?.restoreToken).toBeTruthy()
    const committed = await value.commitRestore(scopes, backup.id, staged!.restoreToken)
    expect(committed!.restored).toBe(true)
    expect((await value.listLedger(scopes, { sessionId: scopes.sessionId, limit: 100 })).items.map(item => item.description)).toEqual(['before'])
    expect(committed!.rollbackBackupId).toBeTruthy()
  })

  it('rejects a restore after concurrent writes and keeps data intact', async () => {
    const { value } = await store()
    const backup = await value.createBackup(scopes, 'concurrent-backup')
    const staged = await value.stageRestore(scopes, backup.id)
    await value.appendLedger(scopes, { commandId: 'concurrent', amountMinor: 9, currency: 'USD', description: 'keep', occurredAt: '2026-09-08T00:00:00.000Z' })
    await expect(value.commitRestore(scopes, backup.id, staged!.restoreToken)).rejects.toBeInstanceOf(DataConflictError)
    expect((await value.listLedger(scopes, { sessionId: scopes.sessionId, limit: 100 })).items.map(item => item.description)).toEqual(['keep'])
  })

  it('reopens an existing database and idempotently reuses an asset shard', async () => {
    const { value, directory } = await store()
    const id = `sha256:${createHash('sha256').update(png).digest('hex')}`
    const metadata = { id, fileName: 'portrait.png', mimeType: 'image/png' as const, category: 'portrait' as const, bytes: png.byteLength, createdAt: '2026-09-08T00:00:00.000Z' }
    await value.putAsset({ scope: scopes, metadata, bytes: png })
    await value.close()
    const reopened = await createLocalDataStore({ dataDir: directory })
    stores.push(reopened)
    const duplicate = await reopened.putAsset({ scope: scopes, metadata: { ...metadata, createdAt: '2026-09-08T01:00:00.000Z' }, bytes: png })
    expect(duplicate).toEqual(metadata)
    expect((await reopened.readAsset(scopes, id))?.bytes).toEqual(png)
  })

  it('copies mutable asset and projection inputs before queued writes', async () => {
    const { value } = await store()
    const bytes = Buffer.from(png)
    const id = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
    const writing = value.putAsset({ scope: scopes, metadata: { id, fileName: 'copy.png', mimeType: 'image/png', category: 'portrait', bytes: bytes.byteLength, createdAt: '2026-09-08T00:00:00.000Z' }, bytes })
    bytes[0] = 0
    await writing
    expect((await value.readAsset(scopes, id))?.bytes[0]).toBe(0x89)

    const replacement: ProjectionReplacement = { branchId: scopes.branchId, fromSeq: 1, memories: [{ id: 'stable-memory', sessionId: scopes.sessionId, branchId: scopes.branchId, sourceSeq: 1, text: 'stable' }], relationships: [], locations: [] }
    const replacing = value.replaceProjections(scopes, replacement)
    replacement.memories[0]!.text = 'mutated'
    await replacing
    expect((await value.listMemories(scopes, { sessionId: scopes.sessionId, limit: 10 })).items[0]?.text).toBe('stable')
  })

  it('restores only one session and never restores shared cards or pairing revocation', async () => {
    const { value } = await store()
    const sessionB = { ...scopes, sessionId: 'session-b', branchId: 'branch-b' }
    await value.upsertCard(scopes, { commandId: 'card-a', id: scopes.cardId, title: 'old card', data: { revision: 1 } })
    await value.appendLedger(scopes, { commandId: 'a-before', amountMinor: 1, currency: 'USD', description: 'a-before', occurredAt: '2026-09-08T00:00:00.000Z' })
    const backup = await value.createBackup(scopes, 'scope-backup')
    await value.upsertCard(sessionB, { commandId: 'card-b', id: scopes.cardId, title: 'shared current card', data: { revision: 2 } })
    await value.appendLedger(sessionB, { commandId: 'b-entry', amountMinor: 7, currency: 'USD', description: 'b-keep', occurredAt: '2026-09-08T00:00:00.000Z' })
    await value.createKnowledge(sessionB, { commandId: 'b-note', text: 'b-note-keep' })
    const bBytes = Buffer.concat([png, Buffer.from([1])])
    const bId = `sha256:${createHash('sha256').update(bBytes).digest('hex')}`
    await value.putAsset({ scope: sessionB, metadata: { id: bId, fileName: 'b.png', mimeType: 'image/png', category: 'portrait', bytes: bBytes.byteLength, createdAt: '2026-09-08T00:00:00.000Z' }, bytes: bBytes })
    const tokenHash = `sha256:${'a'.repeat(64)}`
    await value.savePairingToken({ clientId: 'client-b', clientName: 'phone', tokenHash, scopes: ['product:read'], sessionIds: [sessionB.sessionId], createdAt: '2026-09-08T00:00:00.000Z', expiresAt: '2026-10-08T00:00:00.000Z' })
    await value.revokePairingClient('client-b')
    await value.appendLedger(scopes, { commandId: 'a-after', amountMinor: 2, currency: 'USD', description: 'a-after', occurredAt: '2026-09-08T00:00:01.000Z' })
    const staged = await value.stageRestore(scopes, backup.id)
    await value.commitRestore(scopes, backup.id, staged!.restoreToken)

    expect((await value.listLedger(scopes, { sessionId: scopes.sessionId, limit: 10 })).items.map(item => item.description)).toEqual(['a-before'])
    expect((await value.listLedger(sessionB, { sessionId: sessionB.sessionId, limit: 10 })).items.map(item => item.description)).toEqual(['b-keep'])
    expect((await value.listKnowledge(sessionB, { sessionId: sessionB.sessionId, limit: 10 })).items[0]?.text).toBe('b-note-keep')
    expect((await value.readAsset(sessionB, bId))?.bytes).toEqual(bBytes)
    expect((await value.getCard(scopes))?.title).toBe('shared current card')
    expect((await value.findPairingToken(tokenHash))?.revoked).toBe(true)
    expect((await value.findPairingToken(tokenHash))?.sessionIds).toEqual([sessionB.sessionId])
  })

  it('restores stable user data after a branch rebase and clears stale projections', async () => {
    const { value } = await store()
    await value.appendLedger(scopes, { commandId: 'before-rebase', amountMinor: 12, currency: 'USD', description: 'authoritative-before-rebase', occurredAt: '2026-09-08T00:00:00.000Z' })
    await value.createKnowledge(scopes, { commandId: 'note-before-rebase', text: 'user fact' })
    await value.replaceProjections(scopes, { branchId: 'old-branch', fromSeq: 0, memories: [{ id: 'old-memory', sessionId: scopes.sessionId, branchId: 'old-branch', sourceSeq: 1, text: 'rebuildable old fact' }], relationships: [], locations: [] })
    const backup = await value.createBackup(scopes, 'before-rebase-backup')
    await value.appendLedger({ ...scopes, branchId: 'rebased-branch' }, { commandId: 'after-rebase', amountMinor: 99, currency: 'USD', description: 'new-branch-entry', occurredAt: '2026-09-08T00:00:01.000Z' })
    const rebasedScope = { ...scopes, branchId: 'rebased-branch' }
    const staged = await value.stageRestore(rebasedScope, backup.id)
    await value.commitRestore(rebasedScope, backup.id, staged!.restoreToken)
    expect((await value.listLedger(rebasedScope, { sessionId: rebasedScope.sessionId, limit: 10 })).items.map(item => item.description)).toEqual(['authoritative-before-rebase'])
    expect((await value.listKnowledge(rebasedScope, { sessionId: rebasedScope.sessionId, limit: 10 })).items.map(item => item.text)).toEqual(['user fact'])
    expect((await value.listMemories(rebasedScope, { sessionId: rebasedScope.sessionId, limit: 10 })).items).toEqual([])
    await expect(value.stageRestore({ ...rebasedScope, sessionId: 'other-session' }, backup.id)).resolves.toBeUndefined()
  })

  it('invalidates staged restore hashes across restart', async () => {
    let now = Date.parse('2026-09-08T00:00:00.000Z')
    const directory = await mkdtemp(join(tmpdir(), 'dsh-local-data-expiry-'))
    directories.push(directory)
    const first = await createLocalDataStore({ dataDir: directory, now: () => now, restoreTtlMs: 1_000 })
    stores.push(first)
    const backup = await first.createBackup(scopes, 'expiring')
    const staged = await first.stageRestore(scopes, backup.id)
    await first.close()
    const second = await createLocalDataStore({ dataDir: directory, now: () => now, restoreTtlMs: 1_000 })
    stores.push(second)
    expect(await second.commitRestore(scopes, backup.id, staged!.restoreToken)).toBeUndefined()
  })

  it('expires a staged restore without changing data', async () => {
    let now = Date.parse('2026-09-08T00:00:00.000Z')
    const directory = await mkdtemp(join(tmpdir(), 'dsh-local-data-expiry-'))
    directories.push(directory)
    const value = await createLocalDataStore({ dataDir: directory, now: () => now, restoreTtlMs: 1_000 })
    stores.push(value)
    const backup = await value.createBackup(scopes, 'expiring-live')
    const staged = await value.stageRestore(scopes, backup.id)
    now += 1_001
    expect(await value.commitRestore(scopes, backup.id, staged!.restoreToken)).toBeUndefined()
  })

  it('publishes session-bound notifications and requests reset after retention loss', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-local-data-notifications-'))
    directories.push(directory)
    const value = await createLocalDataStore({ dataDir: directory, notificationRetention: 2 })
    stores.push(value)
    const batches: string[][] = []
    const unsubscribe = value.subscribeNotifications((_scope, batch) => batches.push(batch.items.map(item => item.id)))
    await value.appendNotification(scopes, { id: 'n1', type: 'state', title: 'one', body: '', createdAt: '2026-09-08T00:00:00.000Z' })
    const first = await value.readNotifications(scopes)
    await value.appendNotification(scopes, { id: 'n2', type: 'state', title: 'two', body: '', createdAt: '2026-09-08T00:00:01.000Z' })
    await value.appendNotification(scopes, { id: 'n3', type: 'state', title: 'three', body: '', createdAt: '2026-09-08T00:00:02.000Z' })
    await value.appendNotification(scopes, { id: 'n4', type: 'state', title: 'four', body: '', createdAt: '2026-09-08T00:00:03.000Z' })
    const reset = await value.readNotifications(scopes, first.cursor)
    expect(reset).toMatchObject({ resetRequired: true, items: [], snapshot: [{ id: 'n3' }, { id: 'n4' }] })
    expect(batches.at(-1)).toEqual(['n3', 'n4'])
    unsubscribe()
  })

  it('exports and imports a validated backup as bytes without restoring authorization', async () => {
    const { value: source } = await store()
    await source.appendLedger(scopes, { commandId: 'portable-ledger', amountMinor: 4, currency: 'USD', description: 'portable', occurredAt: '2026-09-08T00:00:00.000Z' })
    const id = `sha256:${createHash('sha256').update(png).digest('hex')}`
    await source.putAsset({ scope: scopes, metadata: { id, fileName: 'portable.png', mimeType: 'image/png', category: 'portrait', bytes: png.byteLength, createdAt: '2026-09-08T00:00:00.000Z' }, bytes: png })
    await source.updateAsset(scopes, id, { label: 'portable asset' })
    const note = await source.createKnowledge(scopes, { commandId: 'portable-note', text: 'draft note' })
    await source.updateKnowledge(scopes, note.id, 'portable note')
    const backup = await source.createBackup(scopes, 'portable-backup')
    const exported = await source.exportBackup(scopes, backup.id)
    expect(exported).toBeInstanceOf(Uint8Array)
    const envelope = JSON.parse(Buffer.from(exported!).toString('utf8')) as { manifest: { rows: { commandJournal: Array<{ domain: string }> } } }
    expect(envelope.manifest.rows.commandJournal.map(row => row.domain)).toEqual(expect.arrayContaining(['asset.create', 'asset.update', 'ledger.append', 'knowledge.create', 'knowledge.update']))

    const { value: target } = await store()
    const tokenHash = `sha256:${'b'.repeat(64)}`
    await target.savePairingToken({ clientId: 'target-client', clientName: 'target phone', tokenHash, scopes: ['product:read'], sessionIds: [scopes.sessionId], createdAt: '2026-09-08T00:00:00.000Z', expiresAt: '2026-10-08T00:00:00.000Z' })
    const imported = await target.importBackup(scopes, exported!, 'import-portable')
    expect((await target.listLedger(scopes, { sessionId: scopes.sessionId, limit: 10 })).items).toEqual([])
    const staged = await target.stageRestore(scopes, imported.id)
    await target.commitRestore(scopes, imported.id, staged!.restoreToken)
    expect((await target.listLedger(scopes, { sessionId: scopes.sessionId, limit: 10 })).items[0]?.description).toBe('portable')
    expect((await target.readAsset(scopes, id))?.bytes).toEqual(png)
    expect((await target.findPairingToken(tokenHash))?.revoked).toBe(false)

    const tampered = Buffer.from(exported!)
    const tamperIndex = tampered.byteLength - 2
    tampered[tamperIndex] = tampered[tamperIndex]! ^ 1
    await expect(target.importBackup(scopes, tampered, 'import-tampered')).rejects.toThrow()
    await expect(target.importBackup(otherScope, exported!, 'import-other-scope')).rejects.toThrow()
  })

  it('rejects a backup whose ledger compensation does not match its target entry', async () => {
    const { value: source } = await store()
    await source.appendLedger(scopes, { commandId: 'ledger-source', amountMinor: -7, currency: 'USD', description: 'source', occurredAt: '2026-09-08T00:00:00.000Z' })
    const backup = await source.createBackup(scopes, 'ledger-backup')
    const exported = await source.exportBackup(scopes, backup.id)
    const envelope = JSON.parse(Buffer.from(exported!).toString('utf8')) as { manifest: { rows: { ledgerEntries: Array<Record<string, unknown>> } }; manifestHash: string }
    envelope.manifest.rows.ledgerEntries[0]!.reverses_entry_id = 'ledger-does-not-exist'
    envelope.manifestHash = `sha256:${createHash('sha256').update(stableJson(envelope.manifest)).digest('hex')}`
    const bytes = Buffer.from(stableJson(envelope))

    const { value: target } = await store()
    await expect(target.importBackup(scopes, bytes, 'ledger-invalid-backup')).rejects.toThrow()
  })

  it('requires every scope dimension and does not swallow atomic rename failures', async () => {
    const { value, directory } = await store()
    await expect(value.listLedger({} as never, { sessionId: scopes.sessionId, limit: 1 })).rejects.toThrow()
    const path = join(directory, 'atomic-test.bin')
    await writeAtomic(path, Buffer.from('old'))
    const renameFailure = Object.assign(new Error('injected rename failure'), { code: 'EACCES' })
    await expect(writeAtomic(path, Buffer.from('new'), { rename: async () => { throw renameFailure } })).rejects.toBe(renameFailure)
    expect(await readFile(path, 'utf8')).toBe('old')
    await expect(writeAtomic(path, Buffer.from('old'), { rename: async () => { throw renameFailure } })).resolves.toBeUndefined()
  })

  it('serializes concurrent writes from two handles without losing commands', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-local-data-concurrent-'))
    directories.push(directory)
    const [first, second] = await Promise.all([createLocalDataStore({ dataDir: directory }), createLocalDataStore({ dataDir: directory })])
    stores.push(first, second)
    await Promise.all(Array.from({ length: 20 }, (_, index) => (index % 2 === 0 ? first : second).appendLedger(scopes, { commandId: `parallel-${index}`, amountMinor: index, currency: 'USD', description: `entry-${index}`, occurredAt: '2026-09-08T00:00:00.000Z' })))
    expect((await first.listLedger(scopes, { sessionId: scopes.sessionId, limit: 100 })).items).toHaveLength(20)
  })
})
