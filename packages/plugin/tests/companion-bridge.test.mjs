import test from 'node:test'
import assert from 'node:assert/strict'
import { createCompanionBridge } from '../src/companion-bridge.mjs'

function harness(owners = {}, options = {}) {
  const agent = { id: 'manager', session: { id: 'manager', header: { agentPreset: 'standard' } }, ctx: {} }
  const calls = [], permissions = [], observed = []
  let composed = options.composed ?? 'rp-companion'
  const services = {
    ...owners,
    agents: { get: id => id === agent.id ? agent : undefined },
    agentPresets: { inspectCompositions: () => [{ id: composed }] },
    sandboxPolicy: { resolve: input => { assert.equal(input.session, agent.session); return { mode: options.mode ?? 'danger-full-access' } } },
    connection: { browserPeer: { id: 'peer' } },
    typertGateway: { async stream(input) { calls.push(input); if (input.args.request.address.sessionId === 'missing') throw Object.assign(new Error('missing target'), { code: 'session/not-found' }); return (async function* () { yield { header: { id: input.args.request.address.sessionId } } })() } },
    workingDirectory: { ensure: async (actual, signal) => { assert.equal(actual, agent); assert.ok(signal instanceof AbortSignal); return 'C:/RP' } },
    fs: options.fs,
  }
  const ctx = { get: name => services[name], emit: (...args) => observed.push(args) }
  const bridge = createCompanionBridge(ctx, { approveEscalation: async (request, approval) => { permissions.push({ request, approval }); if (options.denied) throw new Error('the user rejected escalating this operation'); return 'danger-full-access' } })
  const exec = { agent, signal: new AbortController().signal, callId: 'call-1', name: 'rp_companion_apply' }
  return { bridge, exec, calls, permissions, observed, services, setComposed: id => { composed = id } }
}

test('retained composed preset controls access, independent of a stale header', async () => {
  let reads = 0
  const h = harness({ rpStoryKit: { apiVersion: 1, state: async () => { reads++; return { revision: 1 } } } })
  const value = await h.bridge.inspect({ operation: 'assets.state', input: {} }, h.exec)
  assert.equal(value.result.revision, 1)
  h.exec.agent.session.header.agentPreset = 'rp-companion'
  h.setComposed('rp-gm')
  await assert.rejects(h.bridge.inspect({ operation: 'assets.state', input: {} }, h.exec), { code: 'COMPANION_SCOPE_REQUIRED' })
  assert.equal(reads, 1)
  assert.equal(h.permissions.length, 0)
})

test('unknown operation, forged execution fields and resetOverlay true never reach owners', async () => {
  let writes = 0
  const h = harness({ rpDatabase: { apiVersion: 2, bindSources: async () => { writes++; return {} } } })
  for (const args of [
    { operation: 'configureReview', input: { sessionId: 'story' } },
    { operation: 'database.bindSources', input: { sessionId: 'story', sources: [], expectedRevision: 1, resetOverlay: true } },
    { operation: 'database.bindSources', input: { sessionId: 'story', sources: [], expectedRevision: 1, resetOverlay: false, agent: {} } },
    { operation: 'database.bindSources', input: { sessionId: 'story', sources: [], expectedRevision: 1, resetOverlay: false, signal: {} } },
    { operation: 'database.bindSources', input: { sessionId: 'story', sources: [], expectedRevision: 1, resetOverlay: false }, service: 'rpDatabase' },
  ]) await assert.rejects(h.bridge.apply(args, h.exec))
  assert.equal(writes, 0)
  assert.equal(h.permissions.length, 0)
})

test('library state defaults only to the real management Session and uses LastStep positional signature', async () => {
  let actual
  const h = harness({ rpLastStep: { apiVersion: 1, state: async (...args) => { actual = args; return { revision: 2, profiles: [] } } } })
  const result = await h.bridge.inspect({ operation: 'presets.state', input: {} }, h.exec)
  assert.equal(actual[0], 'manager')
  assert.ok(actual[1] instanceof AbortSignal)
  assert.deepEqual(result.target, { sessionId: 'manager' })
})

test('target authorization and native permission rejection both occur before any mutation', async () => {
  let writes = 0
  const owners = { rpContext: { setAuthorNote: async () => { writes++; return {} } } }
  const h = harness(owners, { denied: true, mode: 'workspace-write' })
  const input = { sessionId: 'missing', text: 'note', expectedRevision: 0 }
  await assert.rejects(h.bridge.apply({ operation: 'context.setAuthorNote', input }, h.exec), { code: 'session/not-found' })
  assert.equal(h.permissions.length, 0)
  input.sessionId = 'story'
  await assert.rejects(h.bridge.apply({ operation: 'context.setAuthorNote', input }, h.exec), { code: 'PERMISSION_DENIED' })
  assert.equal(h.permissions.length, 1)
  assert.equal(writes, 0)
})

test('authorized owner DTO never contains exec.agent and preserves the explicit target and signal', async () => {
  let actual
  const h = harness({ rpContext: { setAuthorNote: async input => { actual = input; return { revision: 9, note: { text: input.text } } } } })
  const value = await h.bridge.apply({ operation: 'context.setAuthorNote', input: { sessionId: 'story', text: 'next turn', expectedRevision: 8 } }, h.exec)
  assert.equal(actual.sessionId, 'story')
  assert.equal(Object.hasOwn(actual, 'agent'), false)
  assert.ok(actual.signal instanceof AbortSignal)
  assert.equal(value.result.revision, 9)
  assert.deepEqual(value.target, { sessionId: 'story' })
  assert.match(h.permissions[0].request.justification, /story/u)
  assert.equal(h.permissions[0].request.requestedMode, 'danger-full-access')
})

const entry = { id: 'locked', name: 'locked', content: 'keep', role: 'system', phase: 'shared', order: 0, enabled: true, locked: true, required: false, source: { entryId: 'locked' } }
const profile = { id: 'profile', name: 'style', version: 2, sourceId: 'source', status: 'draft', entries: [entry] }
test('profile save checks latest revision, source and locks before owner save', async () => {
  let writes = 0
  const h = harness({ rpLastStep: { apiVersion: 1, profile: async () => ({ revision: 5, profile }), saveProfile: async () => { writes++; return {} } } })
  for (const changed of [
    { ...profile, sourceId: 'other' },
    { ...profile, entries: [] },
    { ...profile, entries: [{ ...entry, content: 'bypass' }] },
    { ...profile, version: 1 },
  ]) await assert.rejects(h.bridge.apply({ operation: 'presets.save', input: { profile: changed, expectedRevision: 5 } }, h.exec))
  await assert.rejects(h.bridge.apply({ operation: 'presets.save', input: { profile, expectedRevision: 4 } }, h.exec), { code: 'REVISION_CONFLICT' })
  assert.equal(writes, 0)
})

test('normal switch to an independent ready profile succeeds, while same-source lock bypass fails', async () => {
  let writes = 0, sameSource = false
  const target = { ...profile, id: 'independent', sourceId: 'independent-source', status: 'ready', entries: [] }
  const owner = { apiVersion: 1, profile: async input => ({ revision: 5, profile: input.profileId === 'profile' ? profile : { ...target, sourceId: sameSource ? 'source' : target.sourceId } }), state: async () => ({ revision: 5, binding: { profileId: 'profile', version: 2 } }), preview: async () => ({ blocked: false, diagnostics: [] }), bindSession: async () => { writes++; return {} } }
  const h = harness({ rpLastStep: owner })
  const args = { operation: 'presets.bind', input: { sessionId: 'story', profileId: target.id, version: 2, expectedRevision: 5 } }
  const result = await h.bridge.apply(args, h.exec)
  assert.equal(writes, 1)
  assert.equal(result.transition.previous.profileId, 'profile')
  sameSource = true
  await assert.rejects(h.bridge.apply(args, h.exec), { code: 'ENTRY_LOCKED' })
  assert.equal(writes, 1)
})

test('removing a read-only source from an authorized composition keeps overlay and is allowed', async () => {
  let actual
  const h = harness({ rpDatabase: { apiVersion: 2, state: async () => ({ revision: 2, binding: { binding: { sources: [{ key: 'old', databaseId: 'readonly', version: 1 }] } } }), bindSources: async input => { actual = input; return { revision: 3 } } } })
  await h.bridge.apply({ operation: 'database.bindSources', input: { sessionId: 'story', sources: [], expectedRevision: 2, resetOverlay: false } }, h.exec)
  assert.deepEqual(actual.sources, [])
  assert.equal(actual.resetOverlay, false)
  assert.equal(Object.hasOwn(actual, 'agent'), false)
})

test('raw file import uses Session cwd and exact bytes without exposing base64', async () => {
  const bytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 120]), reads = []
  let received
  const target = { displayPath: 'C:/RP/card.png' }
  const h = harness({ rpStoryKit: { apiVersion: 1, importAsset: async input => { received = input; return { assetId: 'card', version: 1, sourceId: 'source', dataBase64: input.dataBase64 } } } }, { fs: { resolve: async (path, options) => { reads.push({ path, options }); return target }, stat: async () => ({ type: 'file', size: bytes.length, version: 'v1' }), readBytes: async (actual, signal, cap) => { assert.equal(actual, target); assert.ok(signal instanceof AbortSignal); assert.equal(cap, 24_000_000); return bytes } } })
  const result = await h.bridge.importFile({ kind: 'character', path: 'card.png', expectedRevision: 0 }, h.exec)
  assert.equal(reads[0].options.cwd, 'C:/RP')
  assert.deepEqual(Buffer.from(received.dataBase64, 'base64'), Buffer.from(bytes))
  assert.equal(result.result.assetId, 'card')
  assert.equal(Object.hasOwn(result.result, 'dataBase64'), false)
  assert.deepEqual(result.binaryFieldsOmitted, ['result.dataBase64'])
  assert.equal(result.file.bytes, bytes.length)
  assert.equal(h.observed[0][0], 'fs/observed')
})

test('file import rejects oversized, unsupported and ambiguous document requests without owner writes', async () => {
  let writes = 0, bytesReads = 0
  const h = harness({ rpDatabase: { apiVersion: 2, import: async () => { writes++; return {} }, importDocument: async () => { writes++; return {} } } }, { fs: { resolve: async () => ({ displayPath: 'big.json' }), stat: async () => ({ type: 'file', size: 8_000_001 }), readBytes: async () => { bytesReads++; return new Uint8Array() } } })
  await assert.rejects(h.bridge.importFile({ kind: 'worldbook', path: 'big.json', expectedRevision: 0 }, h.exec), { code: 'FILE_TOO_LARGE' })
  await assert.rejects(h.bridge.importFile({ kind: 'worldbook', path: 'archive.zip', expectedRevision: 0 }, h.exec), { code: 'UNSUPPORTED_ZIP' })
  await assert.rejects(h.bridge.importFile({ kind: 'document', path: 'note.txt', expectedRevision: 0 }, h.exec), { code: 'INVALID_ARGUMENTS' })
  assert.equal(writes, 0)
  assert.equal(bytesReads, 0)
})

test('UTF-8 BOM and newline bytes survive JSON import unchanged', async () => {
  const rawText = '\uFEFF{"name":"港口"}\r\n', bytes = Buffer.from(rawText)
  let received
  const h = harness({ rpDatabase: { apiVersion: 2, import: async input => { received = input.rawText; return { databaseId: 'db', version: 1 } } } }, { fs: { resolve: async () => ({ displayPath: 'world.json' }), stat: async () => ({ type: 'file', size: bytes.length, version: 'v' }), readBytes: async () => bytes } })
  await h.bridge.importFile({ kind: 'worldbook', path: 'world.json', expectedRevision: 0 }, h.exec)
  assert.equal(received, rawText)
  assert.deepEqual(Buffer.from(received), bytes)
})

test('overview reports missing owners separately and does not include raw sources', async () => {
  const h = harness({ rpStoryKit: { apiVersion: 1, state: async () => ({ revision: 0, characters: [], personas: [] }) }, rpDatabase: { apiVersion: 2, state: async () => ({ revision: 2, databases: [{ id: 'db', version: 1, name: 'db', entries: [{ content: 'PRIVATE_RAW_SOURCE' }] }], sources: [{ rawText: 'PRIVATE_RAW_SOURCE' }], binding: null }) } })
  const { result } = await h.bridge.inspect({ operation: 'overview', input: {} }, h.exec)
  assert.equal(result.assets.available, true)
  assert.equal(result.presets.available, false)
  assert.equal(result.operations.apply['database.import'].available, false)
  assert.equal(JSON.stringify(result).includes('PRIVATE_RAW_SOURCE'), false)
})
