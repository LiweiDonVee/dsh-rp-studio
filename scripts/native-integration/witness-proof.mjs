import assert from 'node:assert/strict'
export function verifyUnchanged(before, after, { allowAuditRevision = false } = {}) {
  assert.deepEqual(after.sessions, before.sessions, 'occupied Session or related binding changed')
  assert.deepEqual(after.modelCounts, before.modelCounts); assert.equal(after.modelTotal, before.modelTotal)
  for (const owner of ['rpDatabase', 'rpContext', 'rpLastStep', 'rpGM', ...allowAuditRevision ? [] : ['rpStoryKit']]) assert.deepEqual(after.revisions[owner], before.revisions[owner], `${owner} changed`)
  assert.deepEqual(after.audit, before.audit, 'public restore attribution changed')
}
