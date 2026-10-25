import test from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { assertRunDirectory, redact } from './host.mjs'

test('native run ownership does not include workspace root, sibling homes or path-prefix lookalikes', () => {
  const workspace = resolve('workspace')
  assert.equal(assertRunDirectory(workspace, resolve(workspace, '.runtime', 'one')), resolve(workspace, '.runtime', 'one'))
  for (const directory of [workspace, resolve(workspace, '.runtime-other', 'one'), resolve(workspace, '..', 'another', 'home')]) assert.throws(() => assertRunDirectory(workspace, directory), /RUN_DIRECTORY_OUTSIDE_WORKSPACE/u)
})
test('launch credentials are removed before host logs become evidence', () => {
  assert.equal(redact('http://127.0.0.1:1/?token=synthetic-secret\nBearer synthetic-key'), 'http://127.0.0.1:1/?token=[REDACTED]\nBearer [REDACTED]')
})
