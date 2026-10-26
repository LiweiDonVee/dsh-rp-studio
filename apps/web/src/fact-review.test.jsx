import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Workspace } from '../../../packages/plugin/src/Workspace.jsx'

// Complete contracted DTO fixtures. No fixture is native product acceptance.
const scene = { schemaVersion: 1, title: '抵港', location: '码头', presentActorIds: ['traveler'] }
const facts = { schemaVersion: 1, items: [{ id: 'letter', text: '信仍未拆开。' }] }
const payload = { scene: { ...scene, title: '等候', location: '船边' }, facts: { schemaVersion: 1, items: [{ id: 'letter', text: '信已交给向导。' }] }, summary: '交出信件', packet: { playerAction: '交出信件', sceneInstruction: '保留雨声', resolvedChanges: ['交出信件'], visibleConsequences: ['向导接信'], openHooks: ['目的地'], proseConstraints: ['不替玩家说话'], publicFactRefs: ['letter'], variables: { user: '旅人' } } }
const candidate = { id: 'candidate-1', roundId: 'round', createdAt: '2026-10-26T00:00:00Z', origin: 'main-gm', payload, payloadHash: 'a'.repeat(64) }
const round = { roundId: 'round', version: 4, sessionId: 'story', turnKey: '["story",1]', source: { assistantMessageId: 'main', callId: 'proposal', callSeq: 4, turnStartSeq: 1 }, base: { scene, facts }, capture: { playerInput: { seq: 1, messageId: 'input', text: '交出信件' }, story: { title: '港口', character: { name: '向导' }, persona: { name: '旅人' }, examples: '' }, observations: [] }, candidates: [candidate], pendingCandidateId: 'candidate-1', activeReceiptId: null, approvalRequired: true, latest: true, canRegenerate: true }
const ref = { sessionId: 'story', presentationId: 'prose', assistantMessageId: 'writer', callSeq: 2, baseResultSeq: 3, resultSeq: 3 }
const narrative = { id: '["prose",3]', ref, turn: 1, action: '等候', text: '有效正文。', factReceiptId: 'fact', narrativeVersion: { schemaVersion: 1, groupId: 'round', kind: 'original', factRoundId: 'round', factRevision: 1 } }
const services = Object.fromEntries(['gm', 'storyKit', 'database', 'context', 'lastStep', 'loop'].map(key => [key, { available: true, apiVersion: 1 }]))
function fixture({ pending = true, enabled = false } = {}) {
  let review = { revision: 7, enabled, databaseRevision: 13, latestRound: structuredClone({ ...round, ...(pending ? {} : { pendingCandidateId: null, activeReceiptId: 'fact' }) }), pendingDecision: null, generation: null }
  let history = { schemaVersion: 1, records: pending ? [] : [narrative], folded: [], projectionKey: 'effective-1' }
  const calls = [], handlers = {}, listeners = new Map()
  const flags = Object.fromEntries(['reviewState', 'configureReview', 'decideFacts', 'resumeFactDecision', 'regenerateFacts', 'resumeFactGeneration', 'cancelFactGeneration', 'resumeFactPresentation', 'regenerateProse', 'storyHistory', 'narratives', 'presentationSummaries', 'authorNote', 'material'].map(key => [key, true]))
  const card = { id: 'generic-gm', title: '港口', protagonist: '旅人', world: '远山', description: '向导', art: 'generic-gm', accent: 'jade' }
  const summary = { id: 'story', cardId: 'generic-gm', title: '港口', running: false, blank: false, updatedAt: 1 }
  const state = { started: true, protagonist: { name: '旅人' }, scene: { location: scene.location }, relationships: [], quests: [], inventory: [], memories: [], eventLog: [], statusLines: [], checkpoints: { canRollback: true, count: 1, activeTurn: 1 }, extensions: { gm: { scene, facts, capabilities: { rollback: true, fork: true, autoplay: false } } } }
  const api = { cards: async () => [], sessions: async () => [summary], session: vi.fn(async () => ({ session: summary, card, state, messages: history.records.map(item => ({ id: item.id, seq: item.ref.resultSeq, role: 'gm', text: item.text, status: 'complete' })) })), subscribe: (_id, listener) => { listeners.set('story', listener); return () => {} }, send: vi.fn(async () => ({})), rollback: vi.fn(), fork: vi.fn(), autoplay: vi.fn(),
    action: async (action, input) => {
      calls.push({ action, input: structuredClone(input) })
      if (handlers[action]) return handlers[action](input)
      if (action === 'capabilities') return { schemaVersion: 1, services, actions: { ...flags } }
      if (action === 'reviewState') return structuredClone(review)
      if (action === 'storyHistory') return structuredClone(history)
      if (action === 'narratives') return { records: [narrative] }
      if (action === 'presentationSummaries') return { presentations: [], canRegenerate: true, capabilities: { regenerateDispatch: true, retryDispatch: false } }
      if (action === 'authorNote') return { text: '保留雨声', status: 'consumed', version: 1 }
      if (action === 'configureReview') { review = { ...review, revision: 8, enabled: input.enabled }; return { revision: 8, enabled: input.enabled } }
      throw new Error(`Unexpected fixture action ${action}`)
    },
  }
  return { api, calls, flags, handlers, get review() { return review }, setReview(value) { review = value }, setHistory(value) { history = value }, refresh() { act(() => listeners.get('story')?.({ type: 'session.rebased', sessionId: 'story' })) }, state }
}
afterEach(cleanup)
const mount = h => render(<Workspace sessionId="story" client={h.api} openSession={vi.fn()} />)

describe('fact approval and separate regeneration controls (contract fixtures)', () => {
  it('starts approval off and uses the GM settings revision for the per-story switch', async () => {
    const h = fixture({ pending: false }); mount(h)
    const toggle = await screen.findByRole('checkbox', { name: '本故事事实审批' })
    await waitFor(() => expect(toggle).not.toBeDisabled())
    expect(toggle).not.toBeChecked()
    fireEvent.click(toggle)
    await waitFor(() => expect(h.calls.find(call => call.action === 'configureReview')?.input).toEqual({ sessionId: 'story', enabled: true, expectedRevision: 7 }))
    expect(await screen.findByRole('checkbox', { name: '本故事事实审批' })).toBeChecked()
  })
  it('blocks ordinary send without clearing typed input and compares candidate with authoritative current facts', async () => {
    const h = fixture(); mount(h)
    await screen.findByText('候选事实 · 尚未写入')
    const review = within(screen.getByRole('region', { name: '事实审批与重新生成' }))
    expect(review.getByText('信仍未拆开。')).toBeTruthy()
    expect(review.getByText('信已交给向导。', { exact: false })).toBeTruthy()
    const input = screen.getByRole('textbox', { name: '写下你的行动' })
    fireEvent.change(input, { target: { value: '留待审批后发送' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.getByRole('button', { name: '等待事实审批' })).toBeDisabled()
    expect(h.api.send).not.toHaveBeenCalled()
    expect(input).toHaveValue('留待审批后发送')
    expect(screen.getByRole('button', { name: '只重新写作' })).toBeDisabled()
  })
  it('never silently selects or approves a newer pending candidate after a refresh', async () => {
    const h = fixture(); mount(h)
    await screen.findByText('候选事实 · 尚未写入')
    fireEvent.click(screen.getByRole('button', { name: '自定义事实' }))
    fireEvent.change(screen.getByRole('textbox', { name: '场景地点' }), { target: { value: '我保留的编辑' } })
    const next = { ...candidate, id: 'candidate-2', payloadHash: 'b'.repeat(64), payload: { ...payload, summary: '新的候选' } }
    h.setReview({ ...h.review, latestRound: { ...h.review.latestRound, version: 5, pendingCandidateId: next.id, candidates: [candidate, next] } })
    h.refresh()
    await screen.findByText(/候选已变化/u)
    expect(screen.getByRole('textbox', { name: '场景地点' })).toHaveValue('我保留的编辑')
    expect(screen.getByRole('button', { name: '通过并继续' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '采用自定义并继续' })).toBeDisabled()
    expect(h.calls.some(call => call.action === 'decideFacts')).toBe(false)
  })
  it('submits exact human fields once with an operation ID and preserves edits made after the request', async () => {
    const h = fixture(); let resolve
    h.handlers.decideFacts = () => new Promise(done => { resolve = done })
    mount(h); await screen.findByText('候选事实 · 尚未写入')
    fireEvent.click(screen.getByRole('button', { name: '自定义事实' }))
    const location = screen.getByRole('textbox', { name: '场景地点' })
    fireEvent.change(location, { target: { value: '旅人亲自选择的船舱' } })
    const button = screen.getByRole('button', { name: '采用自定义并继续' })
    fireEvent.click(button); fireEvent.click(button)
    const writes = h.calls.filter(call => call.action === 'decideFacts')
    expect(writes).toHaveLength(1)
    expect(writes[0].input).toMatchObject({ sessionId: 'story', roundId: 'round', candidateId: 'candidate-1', action: 'custom', expectedRoundVersion: 4, expectedDatabaseRevision: 13, operationId: expect.any(String), custom: { ...payload, scene: { ...payload.scene, location: '旅人亲自选择的船舱' } } })
    expect(Object.keys(writes[0].input.custom).sort()).toEqual(['facts', 'packet', 'scene', 'summary'])
    fireEvent.change(location, { target: { value: '请求后继续写的草稿' } })
    await act(async () => resolve({ operationId: writes[0].input.operationId, status: 'approved', roundId: 'round', factReceiptId: 'fact-2', presentation: { status: 'failed', errorCode: 'WRITER_FAILED' } }))
    expect(location).toHaveValue('请求后继续写的草稿')
    expect(await screen.findByText(/事实已生效.*写作失败/u)).toBeTruthy()
  })
  it.each([['recorded', '继续审批结算', 'resumeFactDecision'], ['applied', '继续已批准事实的写作', 'resumeFactPresentation']])('resumes a cold %s decision using its persisted identity', async (status, label, action) => {
    const h = fixture()
    h.setReview({ ...h.review, latestRound: { ...round, ...(status === 'applied' ? { pendingCandidateId: null, activeReceiptId: 'fact-2' } : {}) }, pendingDecision: { operationId: 'cold-decision', roundId: 'round', candidateId: 'candidate-1', action: 'approve', requestHash: 'c'.repeat(64), status, source: { sessionId: 'story', commandId: 'command', runSeq: 8, requestHash: 'c'.repeat(64) }, ...(status === 'applied' ? { factReceiptId: 'fact-2' } : {}) } })
    h.handlers[action] = async input => ({ operationId: input.operationId, status: 'approved', roundId: 'round', factReceiptId: 'fact-2', presentation: { status: 'complete' } })
    mount(h)
    fireEvent.click(await screen.findByRole('button', { name: label }))
    await waitFor(() => expect(h.calls.find(call => call.action === action)?.input).toEqual({ sessionId: 'story', operationId: 'cold-decision', ...(status === 'applied' ? { roundId: 'round' } : {}) }))
  })
  it('settles a staged interrupted generation without reconstructing its old version or instruction', async () => {
    const h = fixture(); h.setReview({ ...h.review, generation: { id: 'job', operationId: 'cold-generation', roundId: 'round', status: 'interrupted', candidateId: 'candidate-1' } })
    h.handlers.resumeFactGeneration = async () => { throw Object.assign(new Error('没有已暂存的候选，请明确重新生成。'), { code: 'GENERATION_NOT_STAGED' }) }
    mount(h)
    fireEvent.click(await screen.findByRole('button', { name: '继续候选结算（不重新生成）' }))
    await screen.findByText(/GENERATION_NOT_STAGED/u)
    expect(h.calls.find(call => call.action === 'resumeFactGeneration').input).toEqual({ sessionId: 'story', operationId: 'cold-generation' })
    expect(h.calls.some(call => call.action === 'regenerateFacts')).toBe(false)
  })
  it('uses separate fact and writer owners, retaining the writer operation after response loss', async () => {
    const h = fixture({ pending: false })
    h.handlers.regenerateProse = async () => { throw new Error('response lost') }
    mount(h)
    fireEvent.click(await screen.findByRole('button', { name: '只重新写作' }))
    await screen.findByText(/response lost/u)
    fireEvent.click(screen.getByRole('button', { name: '重试上次写作请求' }))
    await waitFor(() => expect(h.calls.filter(call => call.action === 'regenerateProse')).toHaveLength(2))
    const writes = h.calls.filter(call => call.action === 'regenerateProse')
    expect(writes[0].input).toEqual(writes[1].input)
    expect(writes[0].input).toMatchObject({ sessionId: 'story', basedOn: ref, operationId: expect.any(String) })
    expect(h.api.rollback).not.toHaveBeenCalled()
    expect(h.calls.some(call => call.action === 'adoptDraft')).toBe(false)
  })
  it('keeps old prose in an explicitly opened audit and preserves consumed note status while new facts await writing', async () => {
    const h = fixture({ pending: false })
    const history = { schemaVersion: 1, records: [], folded: [{ groupId: 'round', factRoundId: 'round', activeFactReceiptId: 'fact-2', selectedPresentationId: null, pendingFacts: true, versions: [{ presentationId: 'prose', factReceiptId: 'fact', resultSeq: 3 }] }], projectionKey: 'fact-2-without-prose' }
    h.setHistory(history); h.state.extensions.reader = { status: 'available', pendingFacts: true, folded: history.folded, projectionKey: history.projectionKey }
    mount(h); await screen.findByText('事实审批与重新生成')
    fireEvent.click(screen.getByRole('button', { name: '沉浸阅读' }))
    expect(await screen.findByText('当前事实已生效，等待写作。')).toBeTruthy()
    fireEvent.click(await screen.findByText('正文与材料'))
    expect(await screen.findByText('已由正式正文采用 · v1')).toBeTruthy()
    expect(screen.queryByText('有效正文。')).toBeNull()
    fireEvent.click(screen.getByText('旧版本审计（1）'))
    expect(await screen.findByText('有效正文。')).toBeTruthy()
    expect(screen.getByRole('button', { name: '只重新写作' })).toBeDisabled()
  })
  it('shows an effective-history dependency error with usable story controls instead of a stale reader', async () => {
    const h = fixture({ pending: false })
    h.flags.storyHistory = false
    h.setHistory({ schemaVersion: 1, records: [], folded: [], projectionKey: 'none' })
    h.state.extensions.reader = { status: 'unavailable', code: 'EFFECTIVE_HISTORY_UNAVAILABLE', message: '需要有效历史所属服务。' }
    mount(h); await screen.findByRole('checkbox', { name: '本故事事实审批' })
    fireEvent.click(screen.getByRole('button', { name: '沉浸阅读' }))
    expect(await screen.findByText('需要有效历史所属服务。')).toBeTruthy()
    expect(screen.getByRole('textbox', { name: '写下你的行动' })).toBeTruthy()
    fireEvent.click(await screen.findByText('正文与材料'))
    await screen.findAllByText(/EFFECTIVE_HISTORY_UNAVAILABLE/u)
    expect(screen.queryByText('有效正文。')).toBeNull()
  })
  it('sends explicit fact retry and cancel to the GM without using a writer, rollback, or adoption', async () => {
    const h = fixture()
    h.handlers.regenerateFacts = async input => ({ job: { id: 'job', operationId: input.operationId, roundId: 'round', status: 'complete', candidateId: 'candidate-1' }, round: h.review.latestRound })
    h.handlers.decideFacts = async input => ({ operationId: input.operationId, roundId: 'round', status: 'cancelled', presentation: { status: 'not-requested' } })
    mount(h); await screen.findByText('候选事实 · 尚未写入')
    fireEvent.change(screen.getByRole('textbox', { name: '事实重生要求' }), { target: { value: '保留已经执行的工具结果' } })
    fireEvent.click(screen.getByRole('button', { name: '重试事实' }))
    await screen.findByText('候选操作已返回，请确认待审候选。')
    expect(h.calls.find(call => call.action === 'regenerateFacts').input).toEqual({ sessionId: 'story', roundId: 'round', operationId: expect.any(String), expectedRoundVersion: 4, instruction: '保留已经执行的工具结果' })
    const cancel = screen.getByRole('button', { name: '取消本次候选' })
    await waitFor(() => expect(cancel).not.toBeDisabled()); fireEvent.click(cancel)
    await screen.findByText(/本次候选已取消/u)
    expect(h.calls.find(call => call.action === 'decideFacts').input).toMatchObject({ action: 'cancel', expectedRoundVersion: 4, expectedDatabaseRevision: 13 })
    expect(h.calls.some(call => ['regenerateProse', 'adoptDraft', 'retryPresentation'].includes(call.action))).toBe(false)
    expect(h.api.rollback).not.toHaveBeenCalled()
  })
  it('cancels only the real running generation job while keeping approval and writer controls disabled', async () => {
    const h = fixture(); h.setReview({ ...h.review, generation: { id: 'running-job', operationId: 'generation', roundId: 'round', status: 'running' } })
    h.handlers.cancelFactGeneration = async input => ({ job: { id: input.jobId, operationId: 'generation', roundId: 'round', status: 'cancelled' } })
    mount(h)
    const cancel = await screen.findByRole('button', { name: '取消事实生成' })
    expect(screen.getByRole('button', { name: '通过并继续' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '重试事实' })).toBeDisabled()
    fireEvent.click(cancel)
    await waitFor(() => expect(h.calls.find(call => call.action === 'cancelFactGeneration').input).toEqual({ sessionId: 'story', jobId: 'running-job' }))
  })
  it('never enables approval for provisional generated bodies or absent owner capabilities', async () => {
    const h = fixture(); const provisional = { ...candidate, generationConfirmed: false }
    h.setReview({ ...h.review, latestRound: { ...round, candidates: [provisional], pendingCandidateId: null } }); h.flags.configureReview = false; h.flags.regenerateFacts = false
    mount(h)
    fireEvent.click(await screen.findByRole('button', { name: /candidate-1.*尚未完成生成结算/u }))
    expect(screen.getByRole('button', { name: '通过并继续' })).toBeDisabled()
    expect(screen.getByRole('checkbox', { name: '本故事事实审批' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '重新生成事实' })).toBeDisabled()
  })
  it('shows recorded narrative version, history projection and actual model without inventing token cost', async () => {
    const h = fixture({ pending: false })
    h.handlers.material = async () => ({ presentationId: 'prose', factReceiptRef: 'fact', status: 'complete', packet: payload.packet, narrativeVersion: narrative.narrativeVersion, ownerOperation: { schemaVersion: 1, kind: 'regenerate-prose', operationId: 'writer-op', requestHash: 'e'.repeat(64) }, contextPreparation: { historyProjection: { schemaVersion: 1, projectionKey: 'frozen-projection', selectedPresentationIds: ['prose'], activeFactReceiptIds: ['fact'] } }, compiled: { text: '真正冻结的模块' }, models: { render: { provider: 'local', model: 'measured-writer' } } })
    mount(h); await screen.findByRole('checkbox', { name: '本故事事实审批' })
    fireEvent.click(screen.getByRole('button', { name: '沉浸阅读' })); fireEvent.click(await screen.findByText('正文与材料'))
    fireEvent.click(await screen.findByRole('button', { name: '查看当前正文材料' }))
    const material = await screen.findByRole('region', { name: '实际冻结材料' })
    expect(material.textContent).toContain('frozen-projection')
    expect(material.textContent).toContain('measured-writer')
    expect(material.textContent).toContain('writer-op')
    expect(material.textContent).not.toContain('token 费用')
  })
  it('explains a real legacy current receipt without manufacturing a captured round', async () => {
    const h = fixture({ pending: false }); h.setReview({ ...h.review, latestRound: null })
    h.state.extensions.gm.lastFactReceipt = { id: 'legacy-fact', kind: 'turn' }
    mount(h)
    expect(await screen.findByText(/LEGACY_BASELINE_UNAVAILABLE.*legacy-fact/u)).toBeTruthy()
    expect(screen.getByRole('button', { name: '重新生成事实' })).toBeDisabled()
  })
  it('allows a fresh explicit decision after deterministic failure and does not resume the failed operation', async () => {
    const h = fixture(); h.setReview({ ...h.review, databaseRevision: 15, latestRound: { ...round, version: 6 }, pendingDecision: { operationId: 'failed-decision', roundId: 'round', candidateId: 'candidate-1', action: 'approve', requestHash: 'c'.repeat(64), status: 'failed', errorCode: 'FACT_BASE_CHANGED', source: { sessionId: 'story', commandId: 'failed-command', runSeq: 8, requestHash: 'c'.repeat(64) } } })
    h.handlers.decideFacts = async input => ({ operationId: input.operationId, status: 'cancelled', roundId: 'round', presentation: { status: 'not-requested' } })
    mount(h); await screen.findByText('候选事实 · 尚未写入')
    const cancel = screen.getByRole('button', { name: '取消本次候选' })
    expect(cancel).not.toBeDisabled(); fireEvent.click(cancel)
    await screen.findByText(/本次候选已取消/u)
    const write = h.calls.find(call => call.action === 'decideFacts').input
    expect(write.operationId).not.toBe('failed-decision')
    expect(write).toMatchObject({ action: 'cancel', expectedRoundVersion: 6, expectedDatabaseRevision: 15 })
    expect(h.calls.some(call => call.action === 'resumeFactDecision')).toBe(false)
  })
  it('settles a cold decision without automatically asking for writing', async () => {
    const h = fixture(); const intent = { operationId: 'cold-op', roundId: 'round', candidateId: 'candidate-1', action: 'approve', requestHash: 'c'.repeat(64), status: 'recorded', source: { sessionId: 'story', commandId: 'command', runSeq: 8, requestHash: 'c'.repeat(64) } }
    h.setReview({ ...h.review, pendingDecision: intent })
    h.handlers.resumeFactDecision = async input => { h.setReview({ ...h.review, latestRound: { ...round, activeReceiptId: 'fact-2', pendingCandidateId: null }, pendingDecision: { ...intent, status: 'applied', factReceiptId: 'fact-2' } }); return { operationId: input.operationId, status: 'approved', roundId: 'round', factReceiptId: 'fact-2', presentation: { status: 'not-requested' } } }
    mount(h); fireEvent.click(await screen.findByRole('button', { name: '继续审批结算' }))
    expect(await screen.findByRole('button', { name: '继续已批准事实的写作' })).toBeTruthy()
    expect(h.calls.some(call => ['resumeFactPresentation', 'regenerateProse'].includes(call.action))).toBe(false)
  })
})
