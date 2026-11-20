import test from 'node:test'
import assert from 'node:assert/strict'
import { createStudioActions } from '../src/actions.mjs'
import { createPlayerActionSuggester } from '../src/player-actions.mjs'

const basedOn = { sessionId: 'story', presentationId: 'turn', assistantMessageId: 'writer', callSeq: 2, baseResultSeq: 3, resultSeq: 8 }
const post = input => new Request('http://local/api/rp-studio/actions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })
const receipt = { sessionId: 'child', binding: { sessionId: 'child', status: 'active' }, parentSessionId: 'story', basedOn, branchRef: { ...basedOn, sessionId: 'child' } }

test('reading fork requires its explicit owner capability and passes only an authorized exact ref', async () => {
  const calls = [], authorized = []
  const gm = { apiVersion: 1, capabilities: { forkStoryAtReading: 1 }, forkStoryAtReading: async input => { calls.push(input); return receipt }, forkStory: () => { throw new Error('Latest fork must never be a fallback') } }
  const route = createStudioActions({ getService: name => name === 'rpGM' ? gm : undefined, authorize: async sessionId => { authorized.push(sessionId) } })
  assert.equal((await (await route.request(post({ action: 'capabilities', sessionId: 'story' }))).json()).actions.forkStoryAtReading, true)
  const result = await route.request(post({ action: 'forkStoryAtReading', sessionId: 'story', basedOn }))
  assert.equal(result.status, 200)
  assert.deepEqual(await result.json(), receipt)
  assert.deepEqual(calls[0].basedOn, basedOn)
  assert.equal(calls[0].signal instanceof AbortSignal, true)
  assert.deepEqual(authorized, ['story', 'story'])
  for (const input of [
    { basedOn: undefined }, { basedOn: { ...basedOn, sessionId: 'other' } }, { basedOn: { ...basedOn, resultSeq: 1 } },
    { basedOn: { ...basedOn, extra: true } }, { atSeq: 8 },
  ]) assert.equal((await route.request(post({ action: 'forkStoryAtReading', sessionId: 'story', basedOn, ...input }))).status, 400)
  assert.equal(calls.length, 1)
  for (const change of [{ capabilities: {} }, { capabilities: { forkStoryAtReading: true } }, { forkStoryAtReading: undefined }, { apiVersion: 2 }]) {
    const unavailable = createStudioActions({ getService: name => name === 'rpGM' ? { ...gm, ...change } : undefined, authorize: async () => {} })
    assert.equal((await unavailable.request(post({ action: 'forkStoryAtReading', sessionId: 'story', basedOn }))).status, 503)
    assert.equal((await (await unavailable.request(post({ action: 'capabilities', sessionId: 'story' }))).json()).actions.forkStoryAtReading, false)
  }
})

test('reading fork preserves stable owner conflicts and cannot skip session authorization', async () => {
  let calls = 0
  const gm = { apiVersion: 1, capabilities: { forkStoryAtReading: 1 }, forkStoryAtReading: async () => { calls++; throw Object.assign(new Error('这一幕已被替换。'), { code: 'NARRATIVE_CONFLICT', status: 409 }) } }
  const route = createStudioActions({ getService: name => name === 'rpGM' ? gm : undefined, authorize: async () => {} })
  const result = await route.request(post({ action: 'forkStoryAtReading', sessionId: 'story', basedOn }))
  assert.equal(result.status, 409)
  assert.equal((await result.json()).error.code, 'NARRATIVE_CONFLICT')
  const denied = createStudioActions({ getService: () => gm, authorize: async () => { throw Object.assign(new Error('无法访问该故事。'), { code: 'FORBIDDEN', status: 403 }) } })
  assert.equal((await denied.request(post({ action: 'forkStoryAtReading', sessionId: 'story', basedOn }))).status, 403)
  assert.equal(calls, 1)
})

function fixture() {
  const calls = [], history = { schemaVersion: 1, projectionKey: 'selected', records: [{ id: 'prose', ref: { ...basedOn }, action: '敲门', text: `PRIVATE_PREFIX${'正文'.repeat(3000)}公开结尾。`, factReceiptId: 'fact' }] }
  const options = [{ text: '我查看门边的线索。' }, { text: '我向守门人询问来意。' }]
  const controls = { options, duringStream: () => {}, chunks: null }
  const lastStep = { apiVersion: 1, capabilities: { narrativeRevisions: 1 },
    storyHistory: async () => { calls.push(['history']); return structuredClone(history) },
    material: async () => ({ presentationId: 'turn', factReceiptRef: 'fact', packet: { visibleConsequences: ['门开了。'], openHooks: ['墙上有一张纸条。'], sceneInstruction: 'PRIVATE_DIRECTION', variables: { secret: 'PRIVATE_VARIABLE' } }, contextPreparation: { authorNote: 'PRIVATE_NOTE' }, compiled: 'PRIVATE_COMPILED' }),
  }
  const services = {
    rpLastStep: lastStep,
    agents: { get: sessionId => sessionId === 'story' ? { session: { requestHeader: () => ({ config: { provider: 'story-provider', model: 'story-model', reasoningEffort: 'high', maxTokens: 9000 }, adapterDefaults: {} }) } } : undefined },
    loopStudio: { resolveRoute: async input => { calls.push(['route', input]); return { provider: 'writer-provider', model: 'writer-model' } } },
    llm: { prepareCall: async (config, signal) => {
      calls.push(['prepare', config, signal])
      return { config, stream: async function* (input) {
        calls.push(['stream', input]); controls.duringStream()
        if (controls.chunks) { yield* controls.chunks; return }
        const text = JSON.stringify({ options: controls.options })
        yield { type: 'text-delta', index: 0, text: text.slice(0, 10) }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      } }
    } },
  }
  const getService = name => services[name], playerActions = createPlayerActionSuggester({ getService })
  const route = createStudioActions({ getService, playerActions, authorize: async id => { calls.push(['authorize', id]) } })
  return { route, services, controls, history, calls, options }
}

test('suggestions are optional, passive until clicked, and use one current writer call with public ending data', async () => {
  const f = fixture()
  const capabilities = await (await f.route.request(post({ action: 'capabilities', sessionId: 'story' }))).json()
  assert.equal(capabilities.actions.suggestPlayerActions, true)
  assert.equal(f.calls.some(([name]) => ['prepare', 'stream'].includes(name)), false)
  const response = await f.route.request(post({ action: 'suggestPlayerActions', sessionId: 'story', basedOn, instruction: '先观察再行动' }))
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { sessionId: 'story', basedOn, options: f.options })
  const prepared = f.calls.filter(([name]) => name === 'prepare'), streamed = f.calls.filter(([name]) => name === 'stream')
  assert.equal(prepared.length, 1)
  assert.equal(streamed.length, 1)
  assert.equal(f.calls.filter(([name]) => name === 'history').length, 2)
  assert.deepEqual(prepared[0][1], { provider: 'writer-provider', model: 'writer-model', maxTokens: 1024 })
  assert.equal(Object.hasOwn(streamed[0][1], 'tools'), false)
  assert.equal(streamed[0][1].messages.length, 1)
  const input = JSON.parse(streamed[0][1].messages[0].content[0].text)
  assert.equal(input.proseEnding.length, 5000)
  assert.equal(input.proseEnding.endsWith('公开结尾。'), true)
  assert.deepEqual(input.visibleConsequences, ['门开了。'])
  assert.deepEqual(input.openHooks, ['墙上有一张纸条。'])
  assert.equal(input.instruction, '先观察再行动')
  assert.doesNotMatch(JSON.stringify(input), /PRIVATE/u)
  delete f.services.llm
  const disabled = await (await f.route.request(post({ action: 'capabilities', sessionId: 'story' }))).json()
  assert.equal(disabled.actions.suggestPlayerActions, false)
  assert.equal(disabled.actions.readingPage, true)
  assert.equal((await f.route.request(post({ action: 'suggestPlayerActions', sessionId: 'story', basedOn }))).status, 503)
})

test('suggestion schema and stale refs fail before a model request, and later changes invalidate the result', async () => {
  const f = fixture()
  for (const input of [{ basedOn: { ...basedOn, sessionId: 'other' } }, { basedOn: undefined }, { instruction: {} }, { tools: [] }]) {
    assert.equal((await f.route.request(post({ action: 'suggestPlayerActions', sessionId: 'story', basedOn, ...input }))).status, 400)
  }
  const stale = await f.route.request(post({ action: 'suggestPlayerActions', sessionId: 'story', basedOn: { ...basedOn, resultSeq: 7 } }))
  assert.equal(stale.status, 409)
  assert.equal(f.calls.some(([name]) => name === 'prepare'), false)
  f.controls.duringStream = () => { f.history.records[0].ref.resultSeq++ }
  const changed = await f.route.request(post({ action: 'suggestPlayerActions', sessionId: 'story', basedOn }))
  assert.equal(changed.status, 409)
  assert.equal((await changed.json()).error.code, 'NARRATIVE_CONFLICT')
  assert.equal(f.calls.filter(([name]) => name === 'stream').length, 1)
})

test('invalid or tool-using suggestion models fail without tool execution or automatic retries', async () => {
  for (const chunks of [
    [{ type: 'tool-call-delta', index: 0, input: '{}' }],
    [{ type: 'text-delta', index: 0, text: '{"options":[{"text":"one"}]}' }, { type: 'finish', reason: { kind: 'stop' } }],
    [{ type: 'text-delta', index: 0, text: '{"options":[{"text":"one"},{"text":"two"}]}' }],
  ]) {
    const f = fixture(); f.controls.chunks = chunks
    const response = await f.route.request(post({ action: 'suggestPlayerActions', sessionId: 'story', basedOn }))
    assert.equal(response.status, 502)
    assert.equal(f.calls.filter(([name]) => name === 'prepare').length, 1)
    assert.equal(f.calls.filter(([name]) => name === 'stream').length, 1)
  }
  const f = fixture()
  f.services.llm.prepareCall = async () => { throw Object.assign(new Error('PRIVATE_PROVIDER_ERROR'), { status: 401, code: 'PROVIDER_DENIED' }) }
  const response = await f.route.request(post({ action: 'suggestPlayerActions', sessionId: 'story', basedOn }))
  assert.equal(response.status, 502)
  assert.doesNotMatch(JSON.stringify(await response.json()), /PRIVATE_PROVIDER_ERROR/u)
})
