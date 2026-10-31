import test from 'node:test'
import assert from 'node:assert/strict'
import { checkDatabaseProtection, checkProfileProtection } from '../src/companion-guards.mjs'

const profile = { id: 'p', version: 1, name: 'style', sourceId: 'src', status: 'draft', entries: [
  { id: 'required', name: 'required', content: 'keep', enabled: true, phase: 'agent', locked: false, required: true, source: { entryId: 'required' } },
  { id: 'disabled', name: 'disabled', content: 'optional', enabled: false, phase: 'render', locked: false, required: false, source: { entryId: 'disabled' } },
] }
test('required, source and default-off policy cannot be silently weakened', () => {
  const check = change => assert.throws(() => checkProfileProtection(profile, change))
  check({ ...profile, entries: profile.entries.slice(1) })
  check({ ...profile, entries: profile.entries.map(entry => entry.id === 'required' ? { ...entry, content: '' } : entry) })
  check({ ...profile, entries: profile.entries.map(entry => entry.id === 'required' ? { ...entry, required: false } : entry) })
  check({ ...profile, entries: profile.entries.map(entry => entry.id === 'disabled' ? { ...entry, enabled: true } : entry) })
  check({ ...profile, entries: [...profile.entries, { id: 'split', source: { entryId: 'made-up' }, content: 'x' }] })
  assert.doesNotThrow(() => checkProfileProtection(profile, { ...profile, entries: profile.entries.map(entry => entry.id === 'disabled' ? { ...entry, enabled: true } : entry), migrationReport: { changes: [{ entryId: 'disabled', enabled: true, reason: '用户明确要求启用' }] } }))
})

test('original migration diagnostics, validation and source stay in the saved draft', () => {
  const original = { ...profile, migrationReport: { source: { id: 'src', sha256: 'actual-owner-hash' }, validation: 'Structure checked', diagnostics: [{ code: 'UNKNOWN_MACRO' }], blocked: [] } }
  assert.throws(() => checkProfileProtection(original, { ...original, migrationReport: { ...original.migrationReport, diagnostics: [] } }), { code: 'MIGRATION_REPORT_REQUIRED' })
  assert.doesNotThrow(() => checkProfileProtection(original, structuredClone(original)))
})

const database = { id: 'db', version: 1, name: 'world', entries: [
  { id: 'readonly', title: 'keep', content: 'keep', keywords: [], tags: [], notes: '', version: 1, readOnly: true, mode: 'auto' },
  { id: 'disabled', title: 'off', content: 'off', keywords: [], tags: [], notes: '', version: 1, readOnly: false, mode: 'disabled' },
  { id: 'required', title: 'req', content: 'req', keywords: [], tags: [], notes: '', version: 1, readOnly: false, mode: 'required', provenance: { documentId: 'doc', chunkId: 'c' } },
  { id: 'editable', title: 'edit', content: 'old', keywords: [], tags: [], notes: '', version: 1, readOnly: false, mode: 'auto' },
] }
test('database source save cannot bypass readOnly, disabled, required or document provenance', () => {
  for (const id of ['readonly', 'disabled']) assert.throws(() => checkDatabaseProtection(database, { ...database, entries: database.entries.map(entry => entry.id === id ? { ...entry, content: 'changed' } : entry) }))
  assert.throws(() => checkDatabaseProtection(database, { ...database, entries: database.entries.filter(entry => entry.id !== 'required') }), { code: 'REQUIRED' })
  assert.throws(() => checkDatabaseProtection(database, { ...database, entries: database.entries.map(entry => entry.id === 'required' ? { ...entry, provenance: { documentId: 'fake' } } : entry) }), { code: 'PROTECTED_FIELD' })
  assert.throws(() => checkDatabaseProtection(database, { ...database, entries: [...database.entries, { id: 'new', content: 'fake', provenance: { documentId: 'fake' } }] }), { code: 'PROTECTED_FIELD' })
  assert.doesNotThrow(() => checkDatabaseProtection(database, { ...database, entries: database.entries.map(entry => entry.id === 'editable' ? { ...entry, content: 'new' } : entry) }))
})
