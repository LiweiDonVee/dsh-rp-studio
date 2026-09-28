import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildOutputDirectories } from './clean-build.mjs'

test('build cleanup contains only explicit repository output directories', () => {
  assert.deepEqual(buildOutputDirectories('C:/repo').map(path => path.replaceAll('\\', '/')), [
    'C:/repo/apps/desktop/dist',
    'C:/repo/apps/gateway/dist',
    'C:/repo/apps/web/dist',
    'C:/repo/packages/domain/dist',
    'C:/repo/packages/local-data/dist',
    'C:/repo/packages/protocol/dist',
    'C:/repo/packages/supervisor/dist',
  ])
})
