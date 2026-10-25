import test from 'node:test'
import assert from 'node:assert/strict'
import { assessServices } from './requirements.mjs'

test('actual method presence cannot substitute for a missing explicit owner API version', () => {
  const assessment = assessServices({ services: { gm: { available: true, apiVersion: null, methods: { storyState: true } } }, storyKitCapabilities: {} })
  assert.equal(assessment.interfacesReady, false)
  assert.ok(assessment.deferred.some(row => row.code === 'API_VERSION_MISMATCH' && row.service === 'gm' && row.expected === 1 && row.actual === null))
  assert.ok(assessment.deferred.some(row => row.code === 'METHOD_MISSING' && row.service === 'gm' && row.method === 'rollbackStory'))
})
test('capability inspection never promotes unexecuted native scenarios to passed', () => {
  const assessment = assessServices({ services: {}, storyKitCapabilities: { savedStoryRestore: false } })
  assert.ok(assessment.deferred.some(row => row.code === 'CAPABILITY_UNAVAILABLE' && row.capability === 'savedStoryRestore'))
  assert.equal(assessment.scenarios.length, 9)
  assert.equal(assessment.scenarios.every(row => row.status === 'not-run'), true)
})
