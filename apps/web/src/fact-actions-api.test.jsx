import { expect, it } from 'vitest'
import { createNativeApi } from '../../../packages/plugin/src/api.js'

it('puts decideFacts in the frozen nested carrier without losing its owner action', async () => {
  let actual
  const client = createNativeApi(async (_url, request) => { actual = JSON.parse(request.body); return { ok: true, json: async () => ({ status: 'approved' }) } })
  const input = { sessionId: 'story', roundId: 'round', candidateId: 'candidate', action: 'approve', operationId: 'operation', expectedRoundVersion: 4, expectedDatabaseRevision: 13 }
  await client.action('decideFacts', input)
  expect(actual).toEqual({ action: 'decideFacts', decision: input })
  await client.action('resumeFactGeneration', { sessionId: 'story', operationId: 'generation' })
  expect(actual).toEqual({ action: 'resumeFactGeneration', sessionId: 'story', operationId: 'generation' })
})
