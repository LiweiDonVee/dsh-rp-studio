import test from 'node:test'
import assert from 'node:assert/strict'
import { createStudioActions } from '../src/actions.mjs'

// Contract fixtures only. These tests exercise Studio transport, not native owners.
const ref = { sessionId: 'story', presentationId: 'prose', assistantMessageId: 'assistant', callSeq: 2, baseResultSeq: 3, resultSeq: 9 }
const custom = { scene: { schemaVersion: 1, title: '码头', location: '船边', time: '', presentActorIds: ['traveler'] }, facts: { schemaVersion: 1, items: [{ id: 'letter', text: '信仍由旅人持有。' }] }, summary: '旅人决定留在码头。', packet: { playerAction: '等候', sceneInstruction: '', resolvedChanges: ['留下'], visibleConsequences: [], openHooks: ['船期'], proseConstraints: ['不代替玩家行动'], publicFactRefs: ['letter'], variables: { user: '旅人' } } }
const requests = [
  ['rpGM', 'reviewState', { sessionId: 'story' }, 'factReview'],
  ['rpGM', 'configureReview', { sessionId: 'story', enabled: true, expectedRevision: 7 }, 'factReview'],
  ['rpGM', 'decideFacts', { sessionId: 'story', roundId: 'round', candidateId: 'candidate', action: 'custom', custom, operationId: 'decision', expectedRoundVersion: 4, expectedDatabaseRevision: 13 }, 'factReview'],
  ['rpGM', 'resumeFactDecision', { sessionId: 'story', operationId: 'decision' }, 'factReview'],
  ['rpGM', 'regenerateFacts', { sessionId: 'story', roundId: 'round', operationId: 'generation', expectedRoundVersion: 4, instruction: '保留工具结果' }, 'factRegeneration'],
  ['rpGM', 'cancelFactGeneration', { sessionId: 'story', jobId: 'job' }, 'factRegeneration'],
  ['rpGM', 'resumeFactGeneration', { sessionId: 'story', operationId: 'generation' }, 'factRegeneration'],
  ['rpGM', 'resumeFactPresentation', { sessionId: 'story', roundId: 'round', operationId: 'presentation' }, 'factReview'],
  ['rpLastStep', 'regenerateProse', { sessionId: 'story', basedOn: ref, operationId: 'writer', instruction: '简洁些' }, 'narrativeRevisions'],
  ['rpLastStep', 'storyHistory', { sessionId: 'story' }, 'narrativeRevisions'],
]
const post = input => new Request('http://local/api/rp-studio/actions', { method: 'POST', body: JSON.stringify(input) })
const carrier = (method, input) => method === 'decideFacts' ? { action: method, decision: input } : { ...input, action: method }

for (const [service, method, input, capability] of requests) test(`${method} forwards only its exact public DTO with authorization and signal`, async () => {
  let actual, authorized
  const owner = { apiVersion: 1, capabilities: { [capability]: 1 }, [method]: async args => { actual = args; return { received: true } } }
  const route = createStudioActions({ getService: name => name === service ? owner : undefined, authorize: async id => { authorized = id } })
  const response = await route.request(post(carrier(method, input)))
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { received: true })
  assert.equal(authorized, 'story')
  const { signal, ...forwarded } = actual
  assert.ok(signal instanceof AbortSignal)
  assert.deepEqual(forwarded, input)
})

test('fact actions reject trusted execution fields and mismatched version domains before calling owners', async () => {
  let calls = 0
  const route = createStudioActions({ getService: () => new Proxy({ apiVersion: 1, capabilities: { factReview: 1, factRegeneration: 1, narrativeRevisions: 1 } }, { get: (owner, key) => owner[key] ?? (() => { calls++; return {} }) }), authorize: async () => {} })
  for (const [, method, input] of requests) for (const field of ['source', 'commandId', 'requestHash', 'hash', 'stage', 'model', 'agent']) {
    assert.equal((await route.request(post({ ...carrier(method, input), [field]: 'forged' }))).status, 400, `${method}.${field}`)
    if (method === 'decideFacts') assert.equal((await route.request(post(carrier(method, { ...input, [field]: 'forged' })))).status, 400, `${method}.decision.${field}`)
  }
  for (const input of [
    { action: 'configureReview', sessionId: 'story', enabled: 'true', expectedRevision: 1 },
    { action: 'configureReview', sessionId: 'story', enabled: true, expectedDatabaseRevision: 1 },
    { action: 'regenerateFacts', sessionId: 'story', roundId: 'round', operationId: 'op', expectedRevision: 1 },
    { action: 'resumeFactGeneration', sessionId: 'story', operationId: 'op', expectedRoundVersion: 1 },
    { action: 'decideFacts', sessionId: 'story', roundId: 'round', candidateId: 'c', actionType: 'approve', operationId: 'op', expectedRoundVersion: 1 },
    carrier('decideFacts', { ...requests[2][2], custom: { ...custom, operations: [] } }),
    carrier('decideFacts', { ...requests[2][2], custom: { ...custom, packet: { ...custom.packet, model: {} } } }),
    carrier('decideFacts', { ...requests[2][2], custom: { ...custom, packet: { ...custom.packet, variables: { cost: 2 } } } }),
    carrier('decideFacts', { ...requests[2][2], custom: { ...custom, scene: { ...custom.scene, source: {} } } }),
    carrier('decideFacts', { ...requests[2][2], action: 'approve' }),
    carrier('decideFacts', { ...requests[2][2], expectedDatabaseRevision: undefined }),
    carrier('decideFacts', { ...requests[2][2], operationId: 'two tokens' }),
    { ...requests[8][2], action: 'regenerateProse', basedOn: { ...ref, sessionId: 'other' } },
  ]) assert.equal((await route.request(post(input))).status, 400)
  assert.equal(calls, 0)
})

test('new controls require the actual method and capability; legacy methods keep working', async () => {
  for (const [service, method, input, capability] of requests) for (const advertised of [undefined, false, 0]) {
    const route = createStudioActions({ getService: name => name === service ? { apiVersion: 1, capabilities: { [capability]: advertised }, [method]: async () => ({}) } : undefined, authorize: async () => {} })
    const flags = await (await route.request(post({ action: 'capabilities', sessionId: 'story' }))).json()
    assert.equal(flags.actions[method], false)
    assert.equal((await route.request(post(carrier(method, input)))).status, 503)
  }
  const route = createStudioActions({ getService: name => name === 'rpLastStep' ? { narratives: async () => ({ records: [] }) } : undefined, authorize: async () => {} })
  assert.equal((await route.request(post({ action: 'narratives', sessionId: 'story' }))).status, 200)
})

test('decision authorization uses only the nested session and approve/cancel cannot smuggle custom payload', async () => {
  let calls = 0
  const owner = { apiVersion: 1, capabilities: { factReview: 1 }, decideFacts: async () => { calls++; return {} } }
  const denied = createStudioActions({ getService: () => owner, authorize: async sessionId => { assert.equal(sessionId, 'story'); throw Object.assign(new Error('denied'), { code: 'PERMISSION_DENIED', status: 403 }) } })
  assert.equal((await denied.request(post(carrier('decideFacts', requests[2][2])))).status, 403)
  assert.equal(calls, 0)
  const route = createStudioActions({ getService: () => owner, authorize: async () => {} })
  for (const action of ['approve', 'cancel']) {
    const { custom: _custom, ...input } = requests[2][2]
    assert.equal((await route.request(post(carrier('decideFacts', { ...input, action })))).status, 200)
    assert.equal((await route.request(post(carrier('decideFacts', { ...input, action, custom })))).status, 400)
  }
  assert.equal(calls, 2)
})

test('advertising a new capability without its real owner method or API cannot enable a route', async () => {
  for (const [service, method, input, capability] of requests) for (const owner of [{ apiVersion: 1, capabilities: { [capability]: 1 } }, { apiVersion: 0, capabilities: { [capability]: 1 }, [method]: async () => ({}) }]) {
    const route = createStudioActions({ getService: name => name === service ? owner : undefined, authorize: async () => {} })
    assert.equal((await route.request(post(carrier(method, input)))).status, 503)
  }
})
