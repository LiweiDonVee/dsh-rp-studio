import test from 'node:test'
import assert from 'node:assert/strict'
import { verifyUnchanged } from './witness-proof.mjs'
test('conflict proof includes the occupied parent, owner revisions and public task attribution', () => {
  const before = { sessions: [{ sessionId: 'parent', events: [1], gm: { status: 'active' } }, { sessionId: 'child', events: [2] }], modelCounts: { gm: 0 }, modelTotal: 0, revisions: { rpDatabase: 1, rpContext: 2, rpLastStep: 3, rpGM: 4, rpStoryKit: 5 }, audit: [] }
  verifyUnchanged(before, structuredClone(before))
  for (const mutate of [value => value.sessions[0].events.push(3), value => value.revisions.rpContext++, value => value.audit.push({ restoreId: 'new-conflict' })]) {
    const after = structuredClone(before); mutate(after)
    assert.throws(() => verifyUnchanged(before, after, { allowAuditRevision: true }))
  }
})
