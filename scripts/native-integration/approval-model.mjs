import { randomUUID } from 'node:crypto'
import { createLocalModels } from './model-fixture.mjs'
import { MODEL_STAGES, textOf, sha } from './approval-proof.mjs'
export const APPROVAL_MODELS = MODEL_STAGES
async function* text(text) { yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text }; yield { type: 'block-end', index: 0, block: { type: 'text', text } }; yield { type: 'finish', reason: { kind: 'stop' } } }
async function* tool(name, args, record) { const id = randomUUID(), value = JSON.stringify(args); if (record) record.emitted = { name, arguments: args, callId: id }; yield { type: 'block-start', index: 0, blockType: 'tool-call' }; yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: value }; yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: value } }; yield { type: 'finish', reason: { kind: 'tool-calls' } } }
function results(messages) {
  const calls = new Map(), rows = []
  for (const message of messages) {
    if (message.role === 'assistant') for (const block of message.content ?? []) if (block.type === 'tool-call') calls.set(block.id, block.name)
    if (message.role === 'tool') { let value; try { value = JSON.parse(textOf(message)) } catch { value = null } rows.push({ name: calls.get(message.toolCallId), value, isError: message.isError === true }) }
  }
  return rows
}
export function createApprovalModels({ maxRequests = 192, maxRecords = 128 } = {}) {
  const base = createLocalModels({ maxRequests, maxRecords: Math.min(maxRecords, 128) }), counts = Object.fromEntries(MODEL_STAGES.map(name => [name, 0])), requests = [], observedStates = []
  let total = 0, forbiddenPatch = null
  return {
    stats: () => structuredClone({ counts, total, requests, observedStates }),
    armOwnerPatch(input) { forbiddenPatch = structuredClone(input) },
    async *stream(model, options) {
      if (!Object.hasOwn(counts, model) || total >= maxRequests) throw new Error('APPROVAL_FIXTURE_BUDGET_OR_MODEL')
      total++; counts[model]++
      const messages = options.messages ?? [], human = messages.findLastIndex(message => message.role === 'user' && ['user', 'user-rpc'].includes(message.source?.kind)), raw = textOf(messages.findLast(message => message.role === 'user') ?? { content: [] })
      if (raw.length > 180000) throw new Error('APPROVAL_FIXTURE_INPUT_LIMIT')
      const record = { index: total, startedAt: Date.now(), model, messageCount: messages.length, tools: (options.tools ?? []).map(item => item.name) }
      if (requests.length >= maxRecords) throw new Error('APPROVAL_FIXTURE_RECORD_LIMIT')
      requests.push(record)
      try {
      if (model !== 'gm') {
        const input = JSON.parse(raw); record.input = structuredClone(input)
        if (model === 'revise') {
          if (record.tools.length) throw new Error('FACT_REVISE_MUST_HAVE_NO_TOOLS')
          if (!input.base?.scene || !input.capture?.playerInput) throw new Error('FACT_REVISE_MISSING_CAPTURE')
          const marker = input.instruction || 'FACT_PENDING_RETRY', facts = structuredClone(input.base.facts)
          facts.items = [...facts.items.filter(item => item.id !== 'native-marker'), { id: 'native-marker', text: marker }]
          yield* text(JSON.stringify({ scene: input.base.scene, facts, summary: marker, packet: { playerAction: input.capture.playerInput.text, resolvedChanges: [marker], visibleConsequences: [marker], publicFactRefs: ['native-marker'], variables: { native: marker } } })); return
        }
        record.inputHash = sha(input)
        yield* base.stream(model, options); return
      }
      if (human < 0) throw new Error('APPROVAL_FIXTURE_NO_USER_ACTION')
      const action = textOf(messages[human]); record.humanText = action.slice(0, 1200)
      if (action === 'NATIVE_C17_ORDINARY_LEGACY') {
        if (record.tools.includes('rp_gm_state')) throw new Error('ORDINARY_LEGACY_HAS_GM_TOOLS')
        yield* text('旧故事阅读验证正文。'); return
      }
      if (action.includes('rp_begin_story')) { yield* base.stream(model, options); return }
      const owner = /rp_present\((\{[^\n]+?\})\)/u.exec(action)
      if (owner) {
        const args = JSON.parse(owner[1]); record.ownerDispatch = true
        if (forbiddenPatch) { const patch = forbiddenPatch; forbiddenPatch = null; yield* tool('rp_db_patch', patch, record); return }
        yield* tool('rp_present', args, record); return
      }
      const tail = results(messages.slice(human + 1)), last = name => tail.findLast(result => result.name === name)
      const committed = last('rp_commit_turn')
      if (committed?.value?.id) { yield* tool('rp_present', { factReceiptId: committed.value.id }, record); return }
      if (last('rp_propose_turn')) throw new Error('MAIN_RAN_AFTER_TERMINAL_PROPOSAL')
      if (tail.some(result => result.isError)) throw new Error('UNEXPECTED_APPROVAL_TOOL_ERROR')
      const state = last('rp_gm_state')?.value
      if (!state) { yield* tool('rp_gm_state', {}, record); return }
      if (!Number.isSafeInteger(state.revision) || !state.facts?.items) throw new Error('ACTUAL_GM_STATE_REQUIRED')
      observedStates.push({ action, receiptId: state.lastFactReceipt?.id, revision: state.revision, facts: state.facts, scene: state.scene })
      if (action.includes('PENDING') && !last('rp_db_read')) { yield* tool('rp_db_read', { entryIds: ['["world","0"]'] }, record); return }
      const facts = structuredClone(state.facts), marker = action.includes('NEXT') ? null : action.includes('PENDING') ? 'FACT_PENDING_ORIGINAL' : 'FACT_BASELINE'
      if (marker) facts.items = [...facts.items.filter(item => item.id !== 'native-marker'), { id: 'native-marker', text: marker }]
      const currentMarker = facts.items.find(item => item.id === 'native-marker')?.text ?? 'NO_MARKER'
      const input = { expectedRevision: state.revision, scene: state.scene, facts, summary: currentMarker, packet: { playerAction: action, visibleConsequences: [currentMarker], publicFactRefs: ['native-marker'], variables: { native: currentMarker } }, ...(action.includes('PENDING') ? { operations: [{ op: 'note', ref: { sourceKey: 'world', entryId: '0' }, text: 'NATIVE_FIXED_ONCE' }] } : {}) }
      record.emitted = { name: state.review?.enabled === true ? 'rp_propose_turn' : 'rp_commit_turn', arguments: input }
      yield* tool(record.emitted.name, input, record)
      } catch (error) { record.error = String(error.message).slice(0, 1000); throw error }
    },
  }
}
