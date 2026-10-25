import test from 'node:test'
import assert from 'node:assert/strict'
import { scenarioState } from './scenario-state.mjs'

test('a failed or deferred step never promotes later unexecuted native scenarios', async () => {
  const state = scenarioState(['one', 'two', 'three'])
  await state.run('one', async () => ({ verified: true }))
  await assert.rejects(state.run('two', async () => { throw new Error('actual owner rejected') }), /actual owner rejected/u)
  assert.deepEqual(state.snapshot().map(row => row.status), ['passed', 'failed', 'not-run'])
  const waiting = scenarioState(['one', 'two'])
  await assert.rejects(waiting.run('one', async () => { throw Object.assign(new Error('pending actual restore'), { deferred: true }) }))
  assert.deepEqual(waiting.snapshot().map(row => row.status), ['deferred', 'not-run'])
})
