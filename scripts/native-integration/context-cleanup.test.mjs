import test from 'node:test'
import assert from 'node:assert/strict'
import { closeFailedContext } from './contexts.mjs'
test('context startup retains its original error and both owned cleanup failures', async () => {
  const original = new Error('page bootstrap failed'), attempts = []
  const browser = { close: async () => { attempts.push('browser'); throw new Error('browser close failed') } }, host = { child: { pid: 123 }, close: async () => { attempts.push('host'); throw new Error('host close failed') } }
  const result = await closeFailedContext(original, { name: 'home-a', installed: { version: 'rc.3', installed: [] }, errors: ['bootstrap console'], browser, host })
  assert.equal(result, original); assert.equal(result.message, 'page bootstrap failed')
  assert.deepEqual(attempts.sort(), ['browser', 'host']); assert.equal(result.nativeStartup.cleanupErrors.length, 2)
  assert.equal(result.nativeStartup.hostPid, 123); assert.deepEqual(result.nativeStartup.browserErrors, ['bootstrap console'])
})
