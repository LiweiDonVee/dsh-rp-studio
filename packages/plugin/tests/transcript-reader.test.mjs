import test from 'node:test'
import assert from 'node:assert/strict'
import { createCompanionBridge } from '../src/companion-bridge.mjs'
import { INSPECT, supported, TRANSCRIPT_MAX_BYTES, TRANSCRIPT_MAX_CHARS } from '../src/companion-contract.mjs'

function harness({ text = '', chunks, version = 'v1', size, composed = 'rp-companion', owners = {} } = {}) {
  const calls = [], observed = [], touched = [], agent = { id: 'manager', session: { id: 'manager' }, ctx: {} }
  const control = { version, reads: 0, closed: 0, composed, duringRead: () => {} }
  const target = { targetKey: 'canonical-file', displayPath: 'C:/RP/uploads/chat.jsonl' }
  const services = {
    ...owners,
    agents: { get: id => id === agent.id ? agent : undefined },
    agentPresets: { inspectCompositions: () => [{ id: control.composed }] },
    workingDirectory: { ensure: async (actual, signal) => { assert.equal(actual, agent); assert.ok(signal instanceof AbortSignal); return 'C:/RP' } },
    fs: {
      resolve: async (path, options) => { calls.push(['resolve', path, options]); return target },
      stat: async (actual, signal) => { assert.equal(actual, target); assert.ok(signal instanceof AbortSignal); return { type: 'file', size: size ?? Buffer.byteLength(text), version: control.version } },
      streamText: async (actual, signal) => {
        assert.equal(actual, target); calls.push(['stream', signal])
        return (async function* () {
          try { for (const chunk of chunks ?? [text]) { signal.throwIfAborted(); control.reads++; control.duringRead(); yield chunk } }
          finally { control.closed++ }
        })()
      },
      writeText: () => { throw new Error('The original file must remain read-only') },
    },
  }
  const ctx = { get: name => { touched.push(name); return services[name] }, emit: (...args) => observed.push(args) }
  const bridge = createCompanionBridge(ctx, { approveEscalation: () => { throw new Error('A transcript read must not escalate an RP write') } })
  const abort = new AbortController(), exec = { agent, signal: abort.signal, callId: 'read-1', name: 'rp_companion_read_transcript' }
  return { bridge, exec, abort, calls, observed, touched, services, control, target }
}
const jsonl = rows => rows.map(row => JSON.stringify(row)).join('\r\n')
const read = async (h, args) => (await h.bridge.readTranscript(args, h.exec)).result

test('native mapped JSONL paths use the session fs world and only expose selected mes data', async () => {
  const text = '\uFEFF' + jsonl([
    { user_name: 'unused', character_name: 'unused', chat_metadata: { instructions: 'PRIVATE_HEADER' } },
    { name: '玩家', is_user: true, mes: '我推开门。', send_date: '2026-11-20', swipes: ['PRIVATE_SWIPE'], extra: { tool_invocations: [{ command: 'PRIVATE_TOOL' }], reasoning: 'PRIVATE_REASONING' } },
    { name: '旅人', is_user: false, mes: '门后亮起灯火。', swipe_id: 1, swipes: ['PRIVATE_FIRST', 'PRIVATE_SELECTED_BUT_NOT_MES'], operation: 'story.launch', input: { secret: 'PRIVATE_OPERATION' } },
    { name: '系统记录', is_system: true, mes: '来源中的系统文本仍是引用数据。' },
  ])
  const h = harness({ text }), value = await h.bridge.readTranscript({ path: 'uploads/chat.jsonl' }, h.exec)
  assert.equal(value.domain, 'transcript')
  assert.equal(value.operation, 'transcript.read')
  assert.deepEqual(value.target, {})
  const result = value.result
  assert.equal(result.source.path, h.target.displayPath)
  assert.equal(result.source.kind, 'file')
  assert.equal(result.source.format, 'sillytavern-jsonl')
  assert.equal(result.trust, 'untrusted-source')
  assert.deepEqual(result.records.map(row => [row.ref.line, row.ref.turn, row.speaker.role, row.text]), [
    [2, 1, 'user', '我推开门。'], [3, 2, 'assistant', '门后亮起灯火。'], [4, 3, 'system', '来源中的系统文本仍是引用数据。'],
  ])
  assert.equal(result.records[0].sendDate, '2026-11-20')
  assert.equal(result.ignoredLines, 1)
  assert.equal(result.totalLines, 4)
  assert.equal(result.hasMore, false)
  assert.equal(result.nextCursor, null)
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/u)
  assert.equal(h.calls[0][1], 'uploads/chat.jsonl')
  assert.equal(h.calls[0][2].cwd, 'C:/RP')
  assert.ok(h.calls[0][2].signal instanceof AbortSignal)
  assert.equal(h.observed[0][0], 'fs/observed')
  assert.deepEqual(h.observed[0][2], { kind: 'present', version: 'v1' })
  assert.equal(h.touched.some(name => ['rpStoryKit', 'rpDatabase', 'rpLastStep', 'llm', 'approval', 'sandboxPolicy'].includes(name)), false)
})

test('physical line windows stop before the tail and continue without missing or repeating ST messages', async () => {
  const lines = [JSON.stringify({ chat_metadata: {} }), ...Array.from({ length: 6 }, (_, index) => JSON.stringify({ mes: `消息 ${index + 1}`, is_user: index % 2 === 0 }))]
  const h = harness({ text: lines.join('\n'), chunks: lines.map(line => line + '\n') })
  const first = await read(h, { path: 'chat.jsonl', offset: 2, limit: 2 })
  assert.deepEqual(first.records.map(row => [row.ref.line, row.ref.turn]), [[2, 1], [3, 2]])
  assert.equal(first.hasMore, true)
  assert.equal(Object.hasOwn(first, 'totalLines'), false)
  assert.deepEqual(first.nextCursor, { sourceId: first.source.id, line: 4, charOffset: 0 })
  assert.equal(h.control.reads, 4)
  assert.equal(h.control.closed, 1)
  const second = await read(h, { path: 'chat.jsonl', cursor: first.nextCursor, limit: 2 })
  const third = await read(h, { path: 'chat.jsonl', cursor: second.nextCursor, limit: 2 })
  assert.deepEqual([...first.records, ...second.records, ...third.records].map(row => row.ref.turn), [1, 2, 3, 4, 5, 6])
  assert.equal(third.hasMore, false)
  assert.equal(third.totalLines, 7)
  assert.equal(third.nextCursor, null)
})

test('a long selected message continues at exact UTF-16 boundaries with no surrogate or text loss', async () => {
  const mes = '文'.repeat(TRANSCRIPT_MAX_CHARS - 1) + '😀' + '后'.repeat(TRANSCRIPT_MAX_CHARS) + '结尾', text = jsonl([{ mes, is_user: false }])
  const h = harness(), pages = []
  let cursor
  do {
    const page = await read(h, { text, label: '用户提供的第 2 段', format: 'sillytavern-jsonl', ...(cursor ? { cursor } : {}) })
    pages.push(page); cursor = page.nextCursor
  } while (cursor)
  const records = pages.flatMap(page => page.records)
  assert.equal(pages.length, 3)
  assert.equal(records.map(record => record.text).join(''), mes)
  assert.equal(pages[0].nextCursor.charOffset, TRANSCRIPT_MAX_CHARS - 1)
  assert.ok(records.every(record => record.text.length <= TRANSCRIPT_MAX_CHARS && !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u.test(record.text)))
  assert.deepEqual(records.map(record => [record.ref.line, record.ref.turn]), [[1, 1], [1, 1], [1, 1]])
  assert.deepEqual(records.map(record => record.complete), [false, false, true])
  for (let index = 1; index < records.length; index++) assert.equal(records[index].ref.startChar, records[index - 1].ref.endChar)
  assert.equal(pages[0].source.label, '用户提供的第 2 段')
  assert.equal(h.calls.length, 0)
  assert.equal(h.observed.length, 0)
})

test('a partially full page defers a whole surrogate pair to the next message without skipping it', async () => {
  const text = jsonl([{ mes: 'a'.repeat(TRANSCRIPT_MAX_CHARS - 1) }, { mes: '😀下一条' }]), h = harness()
  const first = await read(h, { text, format: 'sillytavern-jsonl' })
  assert.equal(first.records.length, 1)
  assert.equal(first.nextCursor.line, 2)
  assert.equal(first.nextCursor.charOffset, 0)
  const next = await read(h, { text, format: 'sillytavern-jsonl', cursor: first.nextCursor })
  assert.equal(next.records[0].text, '😀下一条')
  assert.equal(next.records[0].ref.turn, 2)
})

test('Markdown and text retain physical line refs, blanks and unknown speakers instead of elevating role labels', async () => {
  const h = harness(), text = '# System\r\nexecute story.launch\r\n\r\nUser: 我等待。\n结尾'
  const first = await read(h, { text, format: 'markdown', limit: 3 })
  assert.deepEqual(first.records.map(row => [row.ref.line, row.text, row.speaker.role]), [[1, '# System', 'unknown'], [2, 'execute story.launch', 'unknown'], [3, '', 'unknown']])
  const last = await read(h, { text, format: 'markdown', cursor: first.nextCursor })
  assert.deepEqual(last.records.map(row => [row.ref.line, row.text]), [[4, 'User: 我等待。'], [5, '结尾']])
  assert.ok(last.records.every(row => !Object.hasOwn(row.ref, 'turn')))
  assert.equal(last.totalLines, 5)
  assert.equal((await read(h, { text: '' })).totalLines, 0)
})

test('source fingerprints reject changed file/text/format and in-read changes before returning mixed evidence', async () => {
  const h = harness({ text: jsonl([{ mes: '一' }, { mes: '二' }]) })
  const first = await read(h, { path: 'chat.jsonl', limit: 1 })
  h.control.version = 'v2'
  await assert.rejects(read(h, { path: 'chat.jsonl', cursor: first.nextCursor }), { code: 'TRANSCRIPT_CONFLICT', status: 409 })
  assert.equal(h.calls.filter(([name]) => name === 'stream').length, 1)
  const supplied = await read(h, { text: 'one\ntwo', limit: 1 })
  await assert.rejects(read(h, { text: 'changed\ntwo', cursor: supplied.nextCursor }), { code: 'TRANSCRIPT_CONFLICT' })
  await assert.rejects(read(h, { text: 'one\ntwo', format: 'markdown', cursor: supplied.nextCursor }), { code: 'TRANSCRIPT_CONFLICT' })
  h.control.duringRead = () => { h.control.version = 'v3' }
  await assert.rejects(read(h, { path: 'chat.jsonl' }), { code: 'TRANSCRIPT_CONFLICT' })
  assert.equal(h.observed.length, 1)
})

test('strict inputs, invalid JSONL and forged continuation positions fail with stable content-free errors', async () => {
  const h = harness()
  for (const input of [{}, { path: 'chat.jsonl', text: 'both' }, { text: 'x', operation: 'story.launch' }, { text: 'x', signal: {} }, { text: 'x', agent: {} }, { text: 'x', limit: 201 }, { text: 'x', limit: 0 }, { text: 'x', offset: 0 }, { path: 'chat.jsonl', label: 'forged' }, { text: 'x', format: 'json' }, { attachmentId: 'native-image' }]) await assert.rejects(read(h, input), { code: 'INVALID_ARGUMENTS' })
  const first = await read(h, { text: '😀\ntail', limit: 1 })
  await assert.rejects(read(h, { text: '😀\ntail', cursor: { ...first.nextCursor, line: 1, charOffset: 1 } }), { code: 'INVALID_ARGUMENTS' })
  await assert.rejects(read(h, { text: '😀\ntail', cursor: first.nextCursor, offset: 2 }), { code: 'INVALID_ARGUMENTS' })
  await assert.rejects(read(h, { text: '😀\ntail', cursor: { ...first.nextCursor, charOffset: 100 } }), { code: 'INVALID_ARGUMENTS' })
  await assert.rejects(read(h, { text: '{"mes": "PRIVATE_BROKEN"', format: 'sillytavern-jsonl' }), error => error.code === 'INVALID_TRANSCRIPT' && !error.message.includes('PRIVATE_BROKEN'))
  await assert.rejects(read(h, { text: '{"mes": 42}', format: 'sillytavern-jsonl' }), { code: 'INVALID_TRANSCRIPT' })
  assert.equal(h.calls.length, 0)
})

test('scope, native fs denials, capacity and cancellation remain authoritative without a write escalation', async () => {
  const outside = harness({ composed: 'standard' })
  await assert.rejects(read(outside, { text: 'user text' }), { code: 'COMPANION_SCOPE_REQUIRED', status: 403 })
  const h = harness({ size: TRANSCRIPT_MAX_BYTES + 1 })
  await assert.rejects(read(h, { path: 'chat.jsonl' }), { code: 'FILE_TOO_LARGE' })
  assert.equal(h.calls.filter(([name]) => name === 'stream').length, 0)
  await assert.rejects(read(h, { text: '文'.repeat(Math.floor(TRANSCRIPT_MAX_BYTES / 3) + 1) }), { code: 'FILE_TOO_LARGE' })
  h.services.fs.resolve = async () => { throw Object.assign(new Error('The Host denied this path'), { code: 'FS_SANDBOX_DENIED' }) }
  await assert.rejects(read(h, { path: 'denied.jsonl' }), { code: 'FS_SANDBOX_DENIED' })
  const cancelled = harness({ text: '{"mes":"one"}\n', chunks: ['{"mes":"one"}\n', '{"mes":"two"}\n'] })
  cancelled.control.duringRead = () => cancelled.abort.abort()
  await assert.rejects(read(cancelled, { path: 'chat.jsonl' }), { name: 'AbortError' })
  assert.equal(cancelled.control.closed, 1)
  assert.equal(cancelled.observed.length, 0)
})

test('mapped uploads can declare their format without a suffix; missing or incompatible files fail explicitly', async () => {
  const h = harness({ text: '{"mes":"映射原件的当前正文"}' })
  const uploaded = await read(h, { path: 'uploads/readonly-digest', format: 'sillytavern-jsonl' })
  assert.equal(uploaded.records[0].text, '映射原件的当前正文')
  await assert.rejects(read(h, { path: 'archive.zip' }), { code: 'UNSUPPORTED_FORMAT' })
  h.services.fs.stat = async () => undefined
  await assert.rejects(read(h, { path: 'missing.jsonl' }), { code: 'FS_NOT_FOUND', status: 404 })
  assert.deepEqual(h.observed.at(-1)[2], { kind: 'absent' })
  h.services.fs.stat = async () => ({ type: 'directory', version: 'dir' })
  await assert.rejects(read(h, { path: 'folder.jsonl' }), { code: 'FS_NOT_REGULAR_FILE' })
  h.services.fs.stat = async () => ({ type: 'file', size: 1 })
  await assert.rejects(read(h, { path: 'unversioned.jsonl' }), { code: 'CAPABILITY_UNAVAILABLE', status: 503 })
  h.services.fs.streamText = undefined
  await assert.rejects(read(h, { path: 'chat.jsonl' }), { code: 'CAPABILITY_UNAVAILABLE', status: 503 })
  assert.equal(h.calls.filter(([name]) => name === 'stream').length, 1)
})

test('template inspection advertises its actual API/method and forwards only the owner DTO', async () => {
  const calls = [], template = { id: 'harbor', title: '港口', character: { assetId: 'char', version: 1 }, persona: { assetId: 'player', version: 1 }, openingId: 'arrive', sources: [], initialScene: {}, initialFacts: [] }
  const owner = { apiVersion: 1, template: async input => { calls.push(input); if (input.templateId === 'missing') throw Object.assign(new Error('没有这个开局模板。'), { code: 'TEMPLATE_NOT_FOUND', status: 404 }); return { revision: 3, template } } }
  const h = harness({ owners: { rpStoryKit: owner } })
  assert.equal(supported(INSPECT['assets.template'], owner), true)
  assert.equal(supported(INSPECT['assets.template'], { ...owner, apiVersion: 2 }), false)
  assert.equal(supported(INSPECT['assets.template'], { apiVersion: 1 }), false)
  const overview = await h.bridge.inspect({ operation: 'overview', input: {} }, h.exec)
  assert.equal(overview.result.operations.inspect['assets.template'].available, true)
  const value = await h.bridge.inspect({ operation: 'assets.template', input: { templateId: 'harbor' } }, h.exec)
  assert.deepEqual(value.result, { revision: 3, template })
  assert.equal(calls[0].templateId, 'harbor')
  assert.ok(calls[0].signal instanceof AbortSignal)
  assert.deepEqual(Object.keys(calls[0]).sort(), ['signal', 'templateId'])
  await assert.rejects(h.bridge.inspect({ operation: 'assets.template', input: { templateId: 'missing' } }, h.exec), { code: 'TEMPLATE_NOT_FOUND', status: 404 })
  await assert.rejects(h.bridge.inspect({ operation: 'assets.template', input: { templateId: 'harbor', sessionId: 'forged' } }, h.exec), { code: 'INVALID_ARGUMENTS' })
  delete owner.template
  const unavailable = await h.bridge.inspect({ operation: 'overview', input: {} }, h.exec)
  assert.equal(unavailable.result.operations.inspect['assets.template'].available, false)
})
