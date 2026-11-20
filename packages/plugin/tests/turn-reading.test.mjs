import test from 'node:test'
import assert from 'node:assert/strict'
import { createStudioActions } from '../src/actions.mjs'
import { createCompanionBridge } from '../src/companion-bridge.mjs'
import { canReadStory, canReadTurnDetails, readingPage, turnDetails } from '../src/turn-reading.mjs'

const post = input => new Request('http://local/api/rp-studio/actions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })
const ref = (number = 1, sessionId = 'story') => ({ sessionId, presentationId: `presentation-${number}`, assistantMessageId: `assistant-${number}`, callSeq: number * 10, baseResultSeq: number * 10 + 1, resultSeq: number * 10 + 2 })
const record = number => ({ id: JSON.stringify([`presentation-${number}`, number * 10 + 2]), ref: ref(number), turn: number, action: `Action ${number}`, text: `Confirmed ${number}`, factReceiptId: `facts-${number}`, createdAt: '2026-11-18T00:00:00Z' })

function fixture(count = 1) {
  const history = { schemaVersion: 1, projectionKey: `projection-${count}`, records: Array.from({ length: count }, (_, i) => record(i + 1)), folded: [{ candidates: ['PRIVATE_FOLDED'] }] }
  const calls = []
  const material = {
    presentationId: 'presentation-1', factReceiptRef: 'facts-1', status: 'complete',
    packet: { playerAction: 'Action 1', resolvedChanges: ['The gate opened.'], visibleConsequences: ['A light is visible.'], openHooks: ['Who lit it?'], publicFactRefs: ['gate'], sceneInstruction: 'PRIVATE_DIRECTION', variables: { private: 'PRIVATE_VARIABLE' } },
    contextPreparation: {
      id: 'prepared', steps: 2, revision: 12, models: { prepare: { provider: 'context-provider', model: 'preparer', reasoningEffort: 'high', maxTokens: 800, apiKey: 'PRIVATE_KEY' }, summarize: { provider: 'context-provider', model: 'summarizer' }, private: { provider: 'PRIVATE_STAGE', model: 'PRIVATE_MODEL' } },
      materials: {
        entries: [{ id: 'gate', key: '["world","gate"]', title: 'Gate', version: 2, mode: 'required', readOnly: true, ref: { sourceKey: 'world', databaseId: 'world-db', version: 7, entryId: 'gate', private: 'PRIVATE_REF' }, content: 'PRIVATE_ENTRY', notes: 'PRIVATE_NOTES', keywords: ['PRIVATE_KEYWORD'] }],
        history: [{ id: '["old",4]', mode: 'summary', source: { sessionId: 'ancestor', assistantMessageId: 'old-assistant', presentationId: 'old', callSeq: 2, baseResultSeq: 3, resultSeq: 4, sourceEventSeqs: [1, 2], notes: 'PRIVATE_SOURCE' }, content: 'PRIVATE_HISTORY', text: 'PRIVATE_FULL_HISTORY' }],
        recentProse: ['PRIVATE_RECENT'], guidance: 'PRIVATE_GUIDANCE', unresolved: ['PRIVATE_UNRESOLVED'], chars: 3600,
      },
      candidates: [{ text: 'PRIVATE_CANDIDATE' }], authorNote: { text: 'PRIVATE_AUTHOR_NOTE', claimId: 'PRIVATE_CLAIM' },
    },
    compiled: { messages: [{ role: 'system', content: 'PRIVATE_SYSTEM' }] }, storySnapshot: { extensions: 'PRIVATE_SNAPSHOT' },
    models: { assemble: { provider: 'provider', model: 'assembler', reasoningEffort: 'high', maxTokens: 1000, headers: { secret: 'PRIVATE_HEADER' } }, render: { provider: 'writer-provider', model: 'writer' }, private: { provider: 'PRIVATE_MODEL_PROVIDER', model: 'PRIVATE_STAGE' } },
  }
  const owner = {
    apiVersion: 1, capabilities: { narrativeRevisions: 1 },
    async storyHistory(input) { calls.push(['storyHistory', input]); return structuredClone(history) },
    async material(input) { calls.push(['material', input]); return structuredClone(material) },
    async narratives() { throw new Error('Canonical archive must not be used') },
    async drafts() { throw new Error('Draft archive must not be used') },
    async present() { throw new Error('No model work') },
  }
  const signal = new AbortController().signal
  return { owner, history, material, calls, input: { sessionId: 'story', basedOn: ref(), signal } }
}

test('turn details and reading page advertise only the real compatible owner methods', () => {
  const f = fixture()
  assert.equal(canReadStory(f.owner), true)
  assert.equal(canReadTurnDetails(f.owner), true)
  for (const owner of [undefined, { ...f.owner, apiVersion: 2 }, { ...f.owner, capabilities: {} }, { ...f.owner, storyHistory: undefined }]) assert.equal(canReadStory(owner), false)
  assert.equal(canReadTurnDetails({ ...f.owner, material: undefined }), false)
  assert.equal(canReadTurnDetails({ ...f.owner, capabilities: { narrativeRevisions: 1, material: false } }), false)
})

test('turn details show only selected confirmed prose and bounded frozen public metadata', async () => {
  const f = fixture(), before = structuredClone(f.material), value = await turnDetails(f.owner, f.input)
  assert.deepEqual(value.ref, ref())
  assert.equal(value.record.text, 'Confirmed 1')
  assert.equal(value.publicChanges.available, true)
  assert.deepEqual(value.publicChanges.resolvedChanges, ['The gate opened.'])
  assert.equal(value.context.entries[0].version, 2)
  assert.equal(value.context.entries[0].ref.version, 7)
  assert.equal(value.context.history[0].source.sessionId, 'ancestor')
  assert.equal(value.context.history[0].mode, 'summary')
  assert.deepEqual(value.provenance.models.render, { provider: 'writer-provider', model: 'writer' })
  assert.equal(value.provenance.contextModels.prepare.maxTokens, 800)
  assert.equal(value.provenance.steps, 2)
  assert.equal(value.provenance.chars, 3600)
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE/u)
  assert.deepEqual(f.material, before)
  assert.deepEqual(f.calls.map(([method]) => method), ['storyHistory', 'material', 'storyHistory'])
  assert.ok(f.calls.every(([, input]) => input.sessionId === 'story' && input.signal === f.input.signal && !Object.hasOwn(input, 'agent')))
})

test('changing a current database or model route does not replace the frozen turn snapshot', async () => {
  const f = fixture(), first = await turnDetails(f.owner, f.input)
  f.owner.currentDatabase = { entries: [{ title: 'New gate', version: 100, content: 'PRIVATE_CURRENT_DATABASE' }] }
  f.owner.currentModel = { provider: 'new-provider', model: 'new-writer' }
  assert.deepEqual(await turnDetails(f.owner, f.input), first)
  const entries = first.context.entries
  entries[0].title = 'caller edit'
  assert.equal((await turnDetails(f.owner, f.input)).context.entries[0].title, 'Gate')
})

test('all six reference fields must match an effective record before any material read', async () => {
  for (const key of ['presentationId', 'assistantMessageId', 'callSeq', 'baseResultSeq', 'resultSeq']) {
    const f = fixture(), basedOn = ref()
    basedOn[key] = typeof basedOn[key] === 'string' ? `${basedOn[key]}-changed` : basedOn[key] + (key === 'callSeq' ? -1 : 1)
    await assert.rejects(turnDetails(f.owner, { ...f.input, basedOn }), { code: 'NARRATIVE_CONFLICT', status: 409 })
    assert.equal(f.calls.some(([method]) => method === 'material'), false)
  }
  const f = fixture()
  await assert.rejects(turnDetails(f.owner, { ...f.input, basedOn: ref(1, 'other') }), { code: 'INVALID_REQUEST' })
  assert.equal(f.calls.length, 0)
})

test('rebased branches accept only their own exact selected ref and exclude hidden draft history', async () => {
  const f = fixture()
  f.history.records[0].ref = ref(1, 'child')
  const input = { ...f.input, sessionId: 'child', basedOn: ref(1, 'child') }
  const value = await turnDetails(f.owner, input)
  assert.equal(value.ref.sessionId, 'child')
  assert.equal(value.context.history[0].source.sessionId, 'ancestor')
  await assert.rejects(turnDetails(f.owner, { ...input, basedOn: ref() }), { code: 'INVALID_REQUEST' })
  f.history.records = []
  await assert.rejects(turnDetails(f.owner, input), { code: 'NARRATIVE_CONFLICT' })
})

test('a selection superseded while material is awaited cannot return stale details', async () => {
  const f = fixture(), original = f.owner.material
  f.owner.material = async input => { const value = await original(input); f.history.records[0].ref.resultSeq++; f.history.projectionKey = 'changed'; return value }
  await assert.rejects(turnDetails(f.owner, f.input), { code: 'NARRATIVE_CONFLICT', status: 409 })
  const g = fixture()
  g.material.factReceiptRef = 'another-fact'
  await assert.rejects(turnDetails(g.owner, g.input), { code: 'NARRATIVE_CONFLICT' })
})

test('unavailable frozen fields stay explicitly absent and never read current state', async () => {
  const f = fixture()
  f.owner.material = async () => { throw Object.assign(new Error('missing'), { code: 'RECEIPT_NOT_FOUND' }) }
  f.owner.storyState = async () => { throw new Error('Current state is not historical provenance') }
  const value = await turnDetails(f.owner, f.input)
  assert.equal(value.record.text, 'Confirmed 1')
  assert.equal(value.publicChanges.available, false)
  assert.equal(value.context.available, false)
  assert.deepEqual(value.provenance.models, {})
  f.owner.material = async () => { throw Object.assign(new Error('denied'), { code: 'FORBIDDEN', status: 403 }) }
  await assert.rejects(turnDetails(f.owner, f.input), { code: 'FORBIDDEN' })
})

test('bounds retain explicit counts and truncation while omitting all private entry and history bodies', async () => {
  const f = fixture()
  f.history.records[0].text = '文'.repeat(8000)
  f.history.records[0].action = '动'.repeat(3000)
  f.material.packet.resolvedChanges = Array.from({ length: 50 }, () => '事'.repeat(2000))
  f.material.contextPreparation.materials.entries = Array.from({ length: 100 }, (_, i) => ({ id: `entry-${i}`, title: '题'.repeat(500), version: 1, notes: 'PRIVATE' }))
  f.material.contextPreparation.materials.history = Array.from({ length: 100 }, (_, i) => ({ id: `history-${i}`, mode: 'full', source: { assistantMessageId: `assistant-${i}` }, content: 'PRIVATE' }))
  const value = await turnDetails(f.owner, f.input)
  assert.equal(value.record.text.length, 2000)
  assert.equal(value.record.action.length, 1000)
  assert.equal(value.record.textTruncated, true)
  assert.equal(value.record.actionTruncated, true)
  assert.equal(value.publicChanges.resolvedChanges.length, 20)
  assert.equal(value.publicChanges.resolvedChanges[0].length, 500)
  assert.equal(value.publicChanges.truncated, true)
  assert.equal(value.context.entries.length, 32)
  assert.equal(value.context.entriesCount, 100)
  assert.equal(value.context.history.length, 32)
  assert.equal(value.context.historyCount, 100)
  assert.equal(value.context.truncated, true)
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE/u)
  const page = await readingPage(f.owner, { sessionId: 'story' })
  assert.equal(page.records[0].text.length, 8000, 'paging must retain the entire confirmed prose body')
})

test('legacy selected material retains id and version without inventing qualified references', async () => {
  const f = fixture()
  f.material.contextPreparation.materials.entries = [{ id: 'legacy', title: 'Legacy', version: 3, notes: 'PRIVATE', content: 'PRIVATE' }]
  assert.deepEqual((await turnDetails(f.owner, f.input)).context.entries, [{ id: 'legacy', version: 3, title: 'Legacy' }])
})

test('reading pages default to eight, cap at twenty, and prepend without duplicates or lost rounds', async () => {
  const f = fixture(43), pages = []
  let before
  do {
    const page = await readingPage(f.owner, { sessionId: 'story', before })
    assert.equal(page.schemaVersion, 1)
    assert.equal(page.totalCount, 43)
    assert.ok(page.records.length <= 8)
    assert.deepEqual(page.records.map(item => item.turn), page.records.map(item => item.turn).sort((a, b) => a - b))
    pages.unshift(...page.records)
    before = page.nextBefore ?? undefined
    assert.equal(page.hasOlder, before !== undefined)
  } while (before)
  assert.deepEqual(pages.map(item => item.turn), Array.from({ length: 43 }, (_, i) => i + 1))
  assert.equal((await readingPage(f.owner, { sessionId: 'story', limit: 1000 })).records.length, 20)
  assert.equal(f.calls.some(([method]) => method === 'material'), false)
})

test('reading cursors bind the exact projection and composite location rather than an offset', async () => {
  const f = fixture(9), first = await readingPage(f.owner, { sessionId: 'story' })
  assert.deepEqual(first.nextBefore, { projectionKey: 'projection-9', callSeq: 20, presentationId: 'presentation-2' })
  const other = { ...first.nextBefore, presentationId: 'presentation-1' }
  await assert.rejects(readingPage(f.owner, { sessionId: 'story', before: other }), { code: 'STALE_READING', status: 409 })
  f.history.records[0].ref.resultSeq++
  f.history.projectionKey = 'adopted-or-restored-projection'
  await assert.rejects(readingPage(f.owner, { sessionId: 'story', before: first.nextBefore }), { code: 'STALE_READING', status: 409 })
})

test('invalid effective history cannot silently fall back to canonical narratives or drafts', async () => {
  const f = fixture()
  f.history.records[0].ref.sessionId = 'other'
  await assert.rejects(readingPage(f.owner, { sessionId: 'story' }), { code: 'EFFECTIVE_HISTORY_UNAVAILABLE', status: 503 })
  assert.deepEqual(f.calls.map(([method]) => method), ['storyHistory'])
  f.owner.storyHistory = async () => { throw Object.assign(new Error('fact projection unavailable'), { code: 'EFFECTIVE_HISTORY_UNAVAILABLE', status: 503 }) }
  await assert.rejects(turnDetails(f.owner, f.input), { code: 'EFFECTIVE_HISTORY_UNAVAILABLE' })
})

test('Studio validates scopes and known exact fields before owner reads and preserves passive error codes', async () => {
  const f = fixture(9), authorized = []
  const route = createStudioActions({ getService: name => name === 'rpLastStep' ? f.owner : undefined, authorize: async id => { authorized.push(id); if (id === 'denied') throw Object.assign(new Error('denied'), { code: 'FORBIDDEN', status: 403 }) } })
  for (const input of [
    { action: 'turnDetails', sessionId: 'story', basedOn: { ...ref(), signal: {} } },
    { action: 'turnDetails', sessionId: 'other', basedOn: ref() },
    { action: 'turnDetails', sessionId: 'story', basedOn: ref(), candidateId: 'private' },
    { action: 'readingPage', sessionId: 'story', before: { projectionKey: 'projection-9', callSeq: 10, presentationId: 'presentation-1', offset: 0 } },
    { action: 'readingPage', sessionId: 'story', limit: 0 },
    { action: 'readingPage', sessionId: 'story', limit: 1.5 },
  ]) assert.equal((await route.request(post(input))).status, 400)
  assert.equal(f.calls.length, 0)
  assert.equal(authorized.length, 0)
  assert.equal((await route.request(post({ action: 'readingPage', sessionId: 'denied' }))).status, 403)
  assert.equal(f.calls.length, 0)
  const page = await (await route.request(post({ action: 'readingPage', sessionId: 'story' }))).json()
  f.history.projectionKey = 'new'
  const stale = await route.request(post({ action: 'readingPage', sessionId: 'story', before: page.nextBefore }))
  assert.equal(stale.status, 409)
  assert.equal((await stale.json()).error.code, 'STALE_READING')
})

function companionFixture(owner) {
  const agent = { id: 'manager', session: { id: 'manager' }, ctx: {} }, auth = []
  let composed = 'rp-companion'
  const services = { rpLastStep: owner, agents: { get: id => id === 'manager' ? agent : undefined }, agentPresets: { inspectCompositions: () => [{ id: composed }] }, connection: { browserPeer: {} }, typertGateway: { async stream(input) { const id = input.args.request.address.sessionId; auth.push(id); if (id === 'denied') throw Object.assign(new Error('denied'), { code: 'FORBIDDEN', status: 403 }); return (async function* () { yield { header: { id } } })() } } }
  const bridge = createCompanionBridge({ get: name => services[name] })
  return { bridge, auth, exec: { agent, signal: new AbortController().signal }, setComposed: value => { composed = value } }
}

test('Companion reads the identical DTO under retained preset scope and target authorization without apply or model work', async () => {
  const f = fixture(), h = companionFixture(f.owner), input = { sessionId: 'story', basedOn: ref() }
  const expected = await turnDetails(f.owner, { ...input, signal: h.exec.signal })
  const result = await h.bridge.inspect({ operation: 'story.turnDetails', input }, h.exec)
  assert.deepEqual(result.result, expected)
  assert.deepEqual(result.target, { sessionId: 'story' })
  assert.deepEqual(h.auth, ['story'])
  h.setComposed('rp-gm')
  const calls = f.calls.length
  await assert.rejects(h.bridge.inspect({ operation: 'story.turnDetails', input }, h.exec), { code: 'COMPANION_SCOPE_REQUIRED' })
  assert.equal(f.calls.length, calls)
  h.setComposed('rp-companion')
  await assert.rejects(h.bridge.inspect({ operation: 'story.turnDetails', input: { ...input, sessionId: 'other' } }, h.exec), { code: 'INVALID_ARGUMENTS' })
  await assert.rejects(h.bridge.inspect({ operation: 'story.turnDetails', input: { sessionId: 'denied', basedOn: ref(1, 'denied') } }, h.exec), { code: 'FORBIDDEN' })
  await assert.rejects(h.bridge.inspect({ operation: 'story.turnDetails', input: { ...input, agent: {} } }, h.exec), { code: 'INVALID_ARGUMENTS' })
  assert.equal(f.calls.length, calls)
})

test('authorNoteState returns the aggregate CAS revision and leaves legacy authorNote unchanged', async () => {
  const note = { id: 'note', version: 2, text: 'Next round only', status: 'pending' }, calls = []
  const owner = { state: async input => { calls.push(input); return { revision: 19, authorNote: note, history: ['PRIVATE_HISTORY'], plans: ['PRIVATE_PLAN'] } }, authorNote: async () => note, setAuthorNote: async input => { assert.equal(input.expectedRevision, 19); return { revision: 20, note: { ...note, version: 3, text: input.text } } } }
  const route = createStudioActions({ getService: name => name === 'rpContext' ? owner : undefined, authorize: async () => {} })
  const state = await (await route.request(post({ action: 'authorNoteState', sessionId: 'story' }))).json()
  assert.deepEqual(state, { schemaVersion: 1, revision: 19, note })
  assert.deepEqual(await (await route.request(post({ action: 'authorNote', sessionId: 'story' }))).json(), note)
  assert.equal((await route.request(post({ action: 'setAuthorNote', sessionId: 'story', text: 'New guidance', expectedRevision: state.revision }))).status, 200)
  assert.ok(calls[0].signal instanceof AbortSignal)
})

test('forkStory exposes only a live completed supported current prefix and forwards no arbitrary sequence', async () => {
  const f = fixture(), agent = { status: 'idle' }, calls = []
  const state = { binding: { status: 'active' }, capabilities: { fork: true }, lastFactReceipt: { id: 'facts-1' }, review: { latestRound: null, pendingDecision: null, generation: null } }
  const gm = { apiVersion: 1, binding: async () => ({ id: 'gm-story' }), storyState: async () => structuredClone(state), forkStory: async input => { calls.push(input); return { sessionId: 'child', binding: { title: 'A branch' } } } }
  const services = { rpGM: gm, rpLastStep: f.owner, agents: { get: () => agent } }, authorized = []
  const route = createStudioActions({ getService: name => services[name], authorize: async id => { authorized.push(id) } })
  assert.equal((await route.request(post({ action: 'forkStory', sessionId: 'story', atSeq: 12 }))).status, 400)
  const flags = await (await route.request(post({ action: 'capabilities', sessionId: 'story' }))).json()
  assert.equal(flags.actions.forkStory, true)
  const result = await route.request(post({ action: 'forkStory', sessionId: 'story' }))
  assert.equal(result.status, 200)
  assert.deepEqual(await result.json(), { sessionId: 'child', binding: { title: 'A branch' } })
  assert.deepEqual(Object.keys(calls[0]).sort(), ['sessionId', 'signal'])
  assert.equal(calls[0].sessionId, 'story')
  for (const mutate of [() => { agent.status = 'running' }, () => { delete services.agents }, () => { state.review.latestRound = { pendingCandidateId: 'pending' } }, () => { state.review.pendingDecision = { status: 'recorded' } }, () => { state.review.generation = { status: 'running' } }, () => { state.lastFactReceipt.id = 'unpresented-facts' }, () => { state.binding.status = 'restoring' }]) {
    agent.status = 'idle'; services.agents = { get: () => agent }; state.review = { latestRound: null, pendingDecision: null, generation: null }; state.lastFactReceipt.id = 'facts-1'; state.binding.status = 'active'
    mutate()
    assert.equal((await route.request(post({ action: 'forkStory', sessionId: 'story' }))).status, 409)
    assert.equal((await (await route.request(post({ action: 'capabilities', sessionId: 'story' }))).json()).actions.forkStory, false)
  }
  assert.equal(calls.length, 1)
  assert.ok(authorized.every(id => id === 'story'))
})
