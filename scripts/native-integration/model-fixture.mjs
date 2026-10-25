import { randomUUID } from 'node:crypto'

export const MODELS = ['gm', 'prepare', 'summarize', 'assembly', 'writer']
const textOf = message => typeof message?.content === 'string' ? message.content : (message?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n')
async function* prose(text) {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}
async function* tool(name, args) {
  const id = randomUUID(), argumentsText = JSON.stringify(args)
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: argumentsText }
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: argumentsText } }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}
function results(messages) {
  const names = new Map(), output = []
  for (const message of messages) {
    if (message.role === 'assistant') for (const block of Array.isArray(message.content) ? message.content : []) if (block.type === 'tool-call') names.set(block.id, block.name)
    if (message.role === 'tool') {
      const text = textOf(message)
      if (text.length > 500000) throw new Error('FIXTURE_INPUT_LIMIT')
      let value
      try { value = JSON.parse(text) } catch { value = null }
      output.push({ name: names.get(message.toolCallId), value, isError: message.isError === true })
    }
  }
  return output
}

/** Only a local LLM test double. It never registers or returns product receipts. */
export function createLocalModels({ maxRequests = 64, maxRecords = 64 } = {}) {
  if (!Number.isSafeInteger(maxRequests) || maxRequests < 1 || maxRequests > 256 || !Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > 128) throw new Error('FIXTURE_BUDGET_INVALID')
  const counts = Object.fromEntries(MODELS.map(name => [name, 0])), requests = []
  let total = 0, writerFailure = false
  return {
    stats: () => structuredClone({ counts, requests, total }),
    failWriterOnce() { writerFailure = true },
    async *stream(model, options) {
      if (!MODELS.includes(model)) throw new Error('FIXTURE_UNKNOWN_MODEL')
      if (total >= maxRequests) throw new Error('FIXTURE_REQUEST_LIMIT')
      const messages = options.messages ?? []
      if (messages.length > 2500) throw new Error('FIXTURE_INPUT_LIMIT')
      total++; counts[model]++
      const human = messages.findLastIndex(message => message.role === 'user' && ['user', 'user-rpc'].includes(message.source?.kind))
      // Never clone request histories: runtime-context can grow on every step.
      if (requests.length < maxRecords) requests.push({ model, messageCount: messages.length, humanText: human < 0 ? null : textOf(messages[human]).slice(0, 300), runtimeContextCount: messages.filter(message => message.source?.kind === 'runtime-context').length })
      if (model === 'gm') {
        if (human < 0) throw new Error('FIXTURE_NO_USER_ACTION')
        const action = textOf(messages[human]), tail = results(messages.slice(human + 1)), last = name => tail.findLast(result => result.name === name)
        const rewrite = /"rewriteOf"\s*:\s*("(?:[^"\\]|\\.)*")/u.exec(action)
        if (action.startsWith('仅重试已冻结正文') && rewrite) { yield* tool('rp_present', { rewriteOf: JSON.parse(rewrite[1]) }); return }
        if (tail.some(result => result.isError)) { yield* prose('呈现失败；保留已结算事实，等待所有者明确重试。'); return }
        if (action.includes('rp_begin_story')) {
          const receipt = last('rp_begin_story')
          if (!receipt) { yield* tool('rp_begin_story', {}); return }
          if (typeof receipt.value?.id !== 'string') throw new Error('FIXTURE_OPENING_RECEIPT_MISSING')
          yield* tool('rp_present', { factReceiptId: receipt.value.id }); return
        }
        const state = last('rp_gm_state'), committed = last('rp_commit_turn')
        if (committed?.value?.id) { yield* tool('rp_present', { factReceiptId: committed.value.id }); return }
        if (!state) { yield* tool('rp_gm_state', {}); return }
        if (!Number.isSafeInteger(state.value?.revision) || !Array.isArray(state.value?.facts?.items)) throw new Error('FIXTURE_GM_STATE_MISSING')
        const transfer = action.includes('STUDIO_TRANSFER_LETTER') || action.includes('把信交给林遥')
        if (transfer && !state.value.facts.items.some(item => item.id === 'letter-holder')) throw new Error('FIXTURE_FACT_MISSING')
        const facts = transfer ? { schemaVersion: 1, items: state.value.facts.items.map(item => item.id === 'letter-holder' ? { ...item, text: '密封信件当前由林遥持有。' } : item) } : undefined
        yield* tool('rp_commit_turn', { expectedRevision: state.value.revision, ...(facts ? { facts } : {}), summary: transfer ? '旅人将密封信交给林遥。' : '旅人等待。', packet: { playerAction: action, resolvedChanges: transfer ? ['密封信件当前由林遥持有。'] : [], visibleConsequences: transfer ? ['林遥保管着密封信件。'] : ['雨仍在下。'] } }); return
      }
      const raw = textOf(messages.findLast(message => message.role === 'user'))
      if (raw.length > 500000) throw new Error('FIXTURE_INPUT_LIMIT')
      const input = JSON.parse(raw)
      if (model === 'assembly') { yield* prose('{"commit":true}'); return }
      if (model === 'summarize') { yield* prose(JSON.stringify({ summaries: input.history.map(item => ({ id: item.id, summary: `已发生：${item.text}` })) })); return }
      if (model === 'prepare') {
        if (!input.searchResults?.length) { yield* prose('{"search":["buried-observatory"],"commit":false}'); return }
        const keys = [...new Set([...(input.candidates ?? []), ...input.searchResults.flatMap(result => result.candidates ?? [])].map(item => item.key).filter(Boolean))]
        if (keys.some(key => !(input.readEntries ?? []).some(item => item.key === key))) { yield* prose(JSON.stringify({ readEntries: keys, commit: false })); return }
        yield* prose(JSON.stringify({ selectedEntries: keys, historyOperations: (input.history ?? []).map((item, index, history) => ({ id: item.id, mode: index === history.length - 1 ? 'full' : 'summary' })), notes: '仅整理已接受事实与实际材料。', commit: true })); return
      }
      if (writerFailure) { writerFailure = false; throw new Error('FIXTURE_WRITER_FAILURE') }
      const publicText = (input.packet?.visibleConsequences ?? []).join(' ') || input.packet?.playerAction || '合成故事继续。'
      yield* prose(`${input.instruction ? '候选表达' : '本地合成正文'}：${publicText}`)
    },
  }
}
