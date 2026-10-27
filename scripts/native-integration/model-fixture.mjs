import { randomUUID, createHash } from 'node:crypto'

export const MODELS = ['gm', 'prepare', 'summarize', 'assembly', 'writer', 'writer-alt']
const digest = value => createHash('sha256').update(value).digest('hex')
const materialKey = entry => entry?.key ?? (entry?.ref ? JSON.stringify([entry.ref.sourceKey, entry.ref.entryId]) : undefined)
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
  const counts = Object.fromEntries(MODELS.map(name => [name, 0])), requests = [], conflicts = [], materialGuards = []
  let total = 0, writerFailure = false, assemblyFailure = false, conflicting = false, conflictSent = false, materialGuard = null, retry = 'proper'
  return {
    stats: () => structuredClone({ counts, requests, total, conflicts, materialGuards }),
    failWriterOnce() { writerFailure = true },
    failAssemblyOnce() { assemblyFailure = true },
    armConflict() { conflicting = true; conflictSent = false },
    armMaterialGuard() { materialGuard = 'armed' },
    retryMode(value) { if (!['proper', 'wrong'].includes(value)) throw new Error('FIXTURE_RETRY_MODE_INVALID'); retry = value },
    async *stream(model, options) {
      if (!MODELS.includes(model)) throw new Error('FIXTURE_UNKNOWN_MODEL')
      if (total >= maxRequests) throw new Error('FIXTURE_REQUEST_LIMIT')
      const messages = options.messages ?? []
      if (messages.length > 2500) throw new Error('FIXTURE_INPUT_LIMIT')
      total++; counts[model]++
      const human = messages.findLastIndex(message => message.role === 'user' && ['user', 'user-rpc'].includes(message.source?.kind))
      // Never clone request histories: runtime-context can grow on every step.
      const record = requests.length < maxRecords ? { model, messageCount: messages.length, humanText: human < 0 ? null : textOf(messages[human]).slice(0, 300), runtimeContextCount: messages.filter(message => message.source?.kind === 'runtime-context').length, tools: (options.tools ?? []).map(tool => tool.name).slice(0, 24) } : null
      if (record) requests.push(record)
      if (model === 'gm') {
        if (human < 0) throw new Error('FIXTURE_NO_USER_ACTION')
        const action = textOf(messages[human]), tail = results(messages.slice(human + 1)), last = name => tail.findLast(result => result.name === name)
        const rewrite = /"rewriteOf"\s*:\s*("(?:[^"\\]|\\.)*")/u.exec(action)
        if (rewrite) { yield* tool('rp_present', { rewriteOf: retry === 'wrong' ? 'not-the-selected-failed-presentation' : JSON.parse(rewrite[1]) }); return }
        const firstCommit = tail.find(result => result.name === 'rp_commit_turn' && !result.isError && typeof result.value?.id === 'string')
        if (conflicting && firstCommit) {
          const error = tail.find(result => result.name === 'rp_commit_turn' && result.isError)
          if (error) {
            const detail = error.value?.error
            if (detail?.code !== 'TURN_ALREADY_COMMITTED' || detail.receiptId !== firstCommit.value.id) throw new Error('FIXTURE_CONFLICT_ERROR_FIELDS_MISSING')
            const checked = tail.slice(tail.indexOf(error) + 1).find(result => result.name === 'rp_gm_state' && !result.isError)
            if (!checked) { yield* tool('rp_gm_state', {}); return }
            if (checked.value?.revision !== firstCommit.value.databaseRevision || checked.value.lastFactReceipt?.id !== firstCommit.value.id || JSON.stringify(checked.value.lastFactReceipt.stateRefs) !== JSON.stringify(firstCommit.value.stateRefs)) throw new Error('FIXTURE_CONFLICT_CHANGED_FACT_STATE')
            conflicts.push({ isError: error.isError, code: detail.code, receiptId: detail.receiptId, firstDatabaseRevision: firstCommit.value.databaseRevision, postRejectedRevision: checked.value.revision, stateRefs: checked.value.lastFactReceipt.stateRefs, factsHash: digest(JSON.stringify(checked.value.facts ?? null)) }); conflicting = false
            yield* tool('rp_present', { factReceiptId: firstCommit.value.id }); return
          }
          if (conflictSent) throw new Error('FIXTURE_CONFLICT_NOT_REJECTED')
          conflictSent = true
          yield* tool('rp_commit_turn', { expectedRevision: firstCommit.value.databaseRevision, summary: 'DIFFERENT_SAME_TURN_SUBMISSION', packet: { playerAction: action, visibleConsequences: ['This conflicting submission must be rejected.'] } }); return
        }
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
        if (action.includes('STUDIO_PRESENT_UNRESOLVED')) { if (!state.value.lastFactReceipt?.id) throw new Error('FIXTURE_UNRESOLVED_RECEIPT_MISSING'); yield* tool('rp_present', { factReceiptId: state.value.lastFactReceipt.id }); return }
        const transfer = action.includes('STUDIO_TRANSFER_LETTER') || action.includes('把信交给林遥')
        if (transfer && !state.value.facts.items.some(item => item.id === 'letter-holder')) throw new Error('FIXTURE_FACT_MISSING')
        const facts = transfer ? { schemaVersion: 1, items: state.value.facts.items.map(item => item.id === 'letter-holder' ? { ...item, text: '密封信件当前由林遥持有。' } : item) } : undefined
        yield* tool('rp_commit_turn', { expectedRevision: state.value.revision, ...(facts ? { facts } : {}), summary: transfer ? '旅人将密封信交给林遥。' : '旅人等待。', packet: { playerAction: action, resolvedChanges: transfer ? ['密封信件当前由林遥持有。'] : [], visibleConsequences: transfer ? ['林遥保管着密封信件。'] : ['雨仍在下。'] } }); return
      }
      const raw = textOf(messages.findLast(message => message.role === 'user'))
      if (raw.length > 500000) throw new Error('FIXTURE_INPUT_LIMIT')
      const input = JSON.parse(raw)
      if (raw.includes('DISABLED_NATIVE_PROVIDER_SENTINEL')) throw new Error('FIXTURE_DISABLED_BODY_LEAK')
      if (model === 'assembly') { if (assemblyFailure) { assemblyFailure = false; throw new Error('FIXTURE_ASSEMBLY_FAILURE') } yield* prose('{"commit":true}'); return }
      if (model === 'summarize') { if (record) record.history = input.history.slice(0, 24).map(item => ({ id: item.id, textHash: digest(item.text) })); yield* prose(JSON.stringify({ summaries: input.history.map(item => ({ id: item.id, summary: `已发生：${item.text}` })) })); return }
      if (model === 'prepare') {
        if (record) { record.candidateKeys = (input.candidates ?? []).slice(0, 32).map(item => item.key); record.readKeys = (input.readEntries ?? []).slice(0, 32).map(materialKey); record.searchKeys = (input.searchResults ?? []).flatMap(result => result.candidates ?? []).slice(0, 32).map(item => item.key); record.diagnostics = (input.diagnostics ?? []).map(item => item.code).slice(0, 8) }
        const keys = [...new Set([...(input.candidates ?? []), ...input.searchResults.flatMap(result => result.candidates ?? [])].map(item => item.key).filter(Boolean))]
        if (!keys.includes('["world","outside"]')) { yield* prose('{"search":["buried-observatory"],"commit":false}'); return }
        if (keys.some(key => !(input.readEntries ?? []).some(item => materialKey(item) === key))) { yield* prose(JSON.stringify({ readEntries: keys, commit: false })); return }
        const work = (input.readEntries ?? []).find(item => materialKey(item) === '["world","0"]')
        if (materialGuard === 'armed') {
          const fact = input.database?.binding?.factEntryRefs?.find(ref => ref.entryId === 'gm.facts')
          if (!work || !fact) throw new Error('FIXTURE_MATERIAL_REFS_MISSING')
          materialGuard = 'sent'
          yield* prose(JSON.stringify({ databaseOperations: [{ op: 'update', id: materialKey(work), patch: { content: 'MIXED_SHOULD_NOT_STAGE' } }, { op: 'update', id: JSON.stringify([fact.sourceKey, fact.entryId]), patch: { content: '{"schemaVersion":1,"items":[]}' } }], commit: true })); return
        }
        let operations = []
        if (materialGuard === 'sent') {
          if (!input.diagnostics?.some(item => item.code === 'FACT_OWNER_REQUIRED') || work?.content?.includes('MIXED_SHOULD_NOT_STAGE')) throw new Error('FIXTURE_MIXED_BATCH_NOT_ATOMICALLY_REJECTED')
          materialGuards.push({ code: 'FACT_OWNER_REQUIRED', workUnchanged: true }); materialGuard = null
          operations = [{ op: 'note', id: materialKey(work), text: '合法的合成选材备注。' }]
        }
        const historyOperations = (input.history ?? []).slice(0, -1).map(item => ({ id: item.id, mode: 'summary', summary: item.mode === 'summary' ? item.content : `已发生：${item.content}` }))
        yield* prose(JSON.stringify({ databaseOperations: operations, selectedEntries: keys, historyOperations, notes: '仅整理已接受事实与实际材料。', commit: true })); return
      }
      if (record) record.frozenInputHash = digest(JSON.stringify({ packet: input.packet, modules: input.modules, context: input.context, story: input.story, recentProse: input.recentProse }))
      if (writerFailure) { writerFailure = false; throw new Error('FIXTURE_WRITER_FAILURE') }
      const publicText = (input.packet?.visibleConsequences ?? []).join(' ') || input.packet?.playerAction || '合成故事继续。'
      yield* prose(`${input.instruction ? `候选表达[${model}]` : '本地合成正文'}：${publicText}`)
    },
  }
}
