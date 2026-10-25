import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Workspace } from '../../../packages/plugin/src/Workspace.jsx'
import { apply as applyNativeClient } from '../../../packages/plugin/src/client.jsx'

vi.mock('../../../packages/plugin/src/workspace.css', () => ({ default: '' }))

const state = { started: true, protagonist: { name: '旅人' }, scene: { location: '山间驿站' }, relationships: [], quests: [], inventory: [], memories: [], eventLog: [], statusLines: ['体力充沛'], extensions: {}, checkpoints: { canRollback: true, count: 1, activeTurn: 1 } }
const detail = id => ({ session: { id, cardId: 'world', title: `故事 ${id}`, running: false, blank: false, updatedAt: 1 }, card: { id: 'world', title: `故事 ${id}`, protagonist: '旅人', world: '远山', description: '穿过山间驿站', art: 'world', accent: 'jade' }, state, messages: [{ id: 'first', role: 'gm', text: '风穿过门廊。', createdAt: 1, seq: 1, status: 'complete' }] })
function client() {
  const listeners = new Map()
  const close = vi.fn()
  return { listeners, close, cards: vi.fn(async () => [detail('a').card]), sessions: vi.fn(async () => ['a', 'b'].map(id => detail(id).session)), session: vi.fn(async id => detail(id)),
    subscribe: vi.fn((id, callback) => { listeners.set(id, callback); return close }), send: vi.fn(async () => ({})), cancel: vi.fn(async () => ({})), create: vi.fn(async () => detail('new')), fork: vi.fn(async () => detail('branch')), rollback: vi.fn(async () => ({})), autoplay: vi.fn(async () => ({})),
  }
}
afterEach(cleanup)

describe('native RP workspace', () => {
  it('renders contributed workspace actions beside the refresh button', async () => {
    const api = client()
    const configure = vi.fn()
    render(<Workspace sessionId="a" openSession={vi.fn()} client={api} extraActions={<button type="button" onClick={configure}>配置故事预设</button>} />)
    await screen.findByText('山间驿站')
    fireEvent.click(screen.getByRole('button', { name: '配置故事预设' }))
    expect(configure).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: '刷新 RP 工作区' }).parentElement).toBe(screen.getByRole('button', { name: '配置故事预设' }).parentElement)
  })

  it('passes the session child slot from the registered native body into the workspace', async () => {
    const entries = []
    const disposers = []
    applyNativeClient({
      effect(fn) { disposers.push(fn()) },
      sidebarRightTabs: { register() { return () => {} } },
      sidebarRight: {}, uiWorkspace: {},
      slots: { inject(_name, register) { return register() }, register(options, component) { entries.push({ options, component }); return () => {} } },
    })
    const Body = entries.find(entry => entry.options.name === 'sidebar.right.pane.tab').component
    const renderSlot = vi.fn(() => <button type="button">配置故事预设</button>)
    const body = Body({ sessionId: 'a', useTabInfo: () => ({ tab: { visible: true } }), openSession: vi.fn(), renderSlot })
    render(React.cloneElement(body, { client: client() }))
    await screen.findByText('山间驿站')
    expect(screen.getByRole('button', { name: '配置故事预设' })).toBeTruthy()
    expect(renderSlot).toHaveBeenCalledWith('rp.studio.workspace.actions', {})
    for (const dispose of disposers.reverse()) dispose?.()
  })

  it('opens only registered owner tabs even when server services are connected', async () => {
    const entries = [], disposers = [], opened = []
    applyNativeClient({
      effect(fn) { disposers.push(fn()) }, sidebarRightTabs: { register() { return () => {} }, get: kind => kind === 'rp-story-kit' ? { id: 'dsh-rp-story-kit/workspace' } : undefined },
      sidebarRight: { openTab: kind => opened.push(kind) }, uiWorkspace: {},
      slots: { inject(_name, register) { return register() }, register(options, component) { entries.push({ options, component }); return () => {} } },
    })
    const api = client()
    api.action = async () => ({ schemaVersion: 1, services: Object.fromEntries(['gm', 'storyKit', 'database', 'context', 'lastStep', 'loop'].map(key => [key, { available: true, apiVersion: null }])), actions: {} })
    const Body = entries.find(entry => entry.options.name === 'sidebar.right.pane.tab').component
    const body = Body({ sessionId: 'a', useTabInfo: () => ({ tab: { visible: true } }), openSession: vi.fn(), renderSlot: () => null })
    render(React.cloneElement(body, { client: api }))
    await screen.findByText('山间驿站')
    fireEvent.click(screen.getByRole('button', { name: '沉浸阅读' }))
    fireEvent.click(await screen.findByText('正文与材料'))
    fireEvent.click(await screen.findByRole('button', { name: '角色、玩家身份、开场与内容包' }))
    expect(opened).toEqual(['rp-story-kit'])
    expect(screen.queryByRole('button', { name: '打开 RP 最后一步' })).toBeNull()
    for (const dispose of disposers.reverse()) dispose?.()
  })

  it.each(['rp-last-step-failed', 'rp-last-step-cancelled'])('clears an unfinished writer draft on a typed presentation error (%s)', async upstreamCode => {
    const api = client()
    render(<Workspace sessionId="a" openSession={vi.fn()} client={api} />)
    await screen.findByText('山间驿站')
    fireEvent.click(screen.getByRole('button', { name: '沉浸阅读' }))
    act(() => api.listeners.get('a')({ type: 'message.delta', sessionId: 'a', messageId: 'writer', text: '未完成的故事草稿。' }))
    expect(screen.getByText('未完成的故事草稿。')).toBeTruthy()
    act(() => api.listeners.get('a')({ type: 'error', sessionId: 'a', error: { code: 'upstream-unavailable', upstreamCode, message: '故事生成已停止。' } }))
    expect(screen.queryByText('未完成的故事草稿。')).toBeNull()
    expect(screen.getByText('风穿过门廊。')).toBeTruthy()
    expect(screen.getByRole('alert')).toHaveTextContent('故事生成已停止。')
  })

  it('preserves a streaming story after an unrelated error', async () => {
    const api = client()
    render(<Workspace sessionId="a" openSession={vi.fn()} client={api} />)
    await screen.findByText('山间驿站')
    fireEvent.click(screen.getByRole('button', { name: '沉浸阅读' }))
    act(() => api.listeners.get('a')({ type: 'message.delta', sessionId: 'a', messageId: 'writer', text: '正在写下的故事。' }))
    act(() => api.listeners.get('a')({ type: 'error', sessionId: 'a', error: { code: 'agent-busy', message: '正在处理另一条请求。' } }))
    expect(screen.getByText('正在写下的故事。')).toBeTruthy()
  })

  it('sends the current session action, renders streamed text and releases the stream when hidden', async () => {
    const api = client()
    const props = { sessionId: 'a', openSession: vi.fn(), client: api }
    const view = render(<Workspace {...props} />)
    await screen.findByText('山间驿站')
    fireEvent.change(screen.getByRole('textbox', { name: '写下你的行动' }), { target: { value: '  推开门  ' } })
    fireEvent.click(screen.getByRole('button', { name: '发送行动 ↑' }))
    await waitFor(() => expect(api.send).toHaveBeenCalledWith('a', '推开门'))
    fireEvent.click(screen.getByRole('button', { name: '沉浸阅读' }))
    act(() => api.listeners.get('a')({ type: 'message.delta', sessionId: 'a', messageId: 'delta', text: '门后亮起烛光。' }))
    expect(screen.getByText('门后亮起烛光。')).toBeTruthy()
    view.rerender(<Workspace {...props} visible={false} />)
    expect(api.close).toHaveBeenCalledOnce()
  })

  it('does not commit a late response from a previous session', async () => {
    const api = client()
    let resolveOld
    api.session.mockImplementation(id => id === 'a' ? new Promise(resolve => { resolveOld = resolve }) : Promise.resolve(detail(id)))
    const view = render(<Workspace sessionId="a" openSession={vi.fn()} client={api} />)
    await waitFor(() => expect(api.session).toHaveBeenCalledWith('a', expect.any(AbortSignal)))
    view.rerender(<Workspace sessionId="b" openSession={vi.fn()} client={api} />)
    await screen.findByRole('heading', { name: '故事 b' })
    await act(async () => resolveOld(detail('a')))
    expect(screen.queryByRole('heading', { name: '故事 a' })).toBeNull()
    expect(api.subscribe).toHaveBeenCalledTimes(1)
    expect(api.subscribe.mock.calls[0][0]).toBe('b')
  })

  it('offers card creation for a normal DSH conversation and navigates through the host', async () => {
    const api = client()
    const open = vi.fn()
    render(<Workspace sessionId="normal" openSession={open} client={api} />)
    await screen.findByText('为这次冒险留个位置')
    expect(api.session).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /开启故事/ }))
    await waitFor(() => expect(open).toHaveBeenCalledWith('new'))
    expect(api.create).toHaveBeenCalledWith('world')
    expect(api.subscribe).not.toHaveBeenCalled()
  })

  it('preserves the draft after a rejected send and respects IME composition', async () => {
    const api = client()
    api.send.mockRejectedValue(new Error('稍后重试'))
    render(<Workspace sessionId="a" openSession={vi.fn()} client={api} />)
    await screen.findByText('山间驿站')
    const input = screen.getByRole('textbox', { name: '写下你的行动' })
    fireEvent.change(input, { target: { value: '你好' } })
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true, keyCode: 229 })
    expect(api.send).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '发送行动 ↑' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('稍后重试')
    expect(input.value).toBe('你好')
  })
})

describe('native snapshot handoff', () => {
  it('reconciles the first SSE connection and retains completions received during the snapshot request', async () => {
    const api = client()
    let resolveSnapshot
    api.session.mockResolvedValueOnce({ ...detail('a'), session: { ...detail('a').session, running: true } })
    api.session.mockImplementationOnce(() => new Promise(resolve => { resolveSnapshot = resolve }))
    render(<Workspace sessionId="a" openSession={vi.fn()} client={api} />)
    await screen.findByText('山间驿站')
    act(() => api.listeners.get('a')({ type: 'connected', sessionId: 'a' }))
    expect(api.session).toHaveBeenCalledTimes(2)
    const completed = { id: 'final', role: 'gm', text: '旅程已经抵达下一站。', status: 'complete', seq: 2 }
    act(() => {
      api.listeners.get('a')({ type: 'message.completed', sessionId: 'a', message: completed })
      api.listeners.get('a')({ type: 'session.status', sessionId: 'a', running: false })
      resolveSnapshot({ ...detail('a'), session: { ...detail('a').session, running: true } })
    })
    await screen.findByRole('button', {name:'发送行动 ↑'})
    fireEvent.click(screen.getByRole('button', {name:'沉浸阅读'}))
    expect(screen.getByText('旅程已经抵达下一站。')).toBeTruthy()
  })

  it('shows generic facts and opens the rollback child while leaving autoplay unavailable', async () => {
    const api = client(), open = vi.fn()
    api.session.mockImplementation(async id => ({ ...detail(id), state: { ...state, extensions: { gm: { scene: { title: '靠岸', location: '码头', presentActorIds: [] }, facts: { schemaVersion: 1, items: [{ id: 'f1', text: '船已经靠岸。' }] }, status: 'active', character: { name: '林' }, persona: { name: '旅人' }, capabilities: { rollback: true, fork: true, autoplay: false } } } } }))
    api.rollback.mockResolvedValue({ accepted: true, sessionId: 'rollback-child' })
    render(<Workspace sessionId="a" openSession={open} client={api} />)
    await screen.findByText('船已经靠岸。')
    expect(screen.getByRole('button', { name: '自动续写' })).toBeDisabled()
    expect(screen.getByText(/保留原故事/u)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '回退' }))
    await waitFor(() => expect(open).toHaveBeenCalledWith('rollback-child'))
    expect(api.autoplay).not.toHaveBeenCalled()
  })

  it('does not navigate or overwrite a new story after a previous branch action resolves', async () => {
    const api = client(), open = vi.fn()
    let finish
    api.fork.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const view = render(<Workspace sessionId="a" openSession={open} client={api} />)
    await screen.findByText('山间驿站')
    fireEvent.click(screen.getByRole('button', { name: '分支' }))
    view.rerender(<Workspace sessionId="b" openSession={open} client={api} />)
    await screen.findByRole('heading', { name: '故事 b' })
    await act(async () => finish(detail('old-child')))
    expect(open).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '分支' })).not.toBeDisabled()
  })
})

describe('unified owner operations', () => {
  const ref = { sessionId: 'a', presentationId: 'receipt-a', assistantMessageId: 'assistant-a', callSeq: 2, baseResultSeq: 3, resultSeq: 3 }
  const record = { id: '["receipt-a",3]', ref, turn: 1, action: '推开门', text: '已确认的正式正文。' }
  const savedStory = { format: 'dsh-rp-saved-story', schemaVersion: 1, identityMode: 'preserve', exportedAt: '2026-10-25T00:00:00Z', selectedSessionId: 'restored', sessions: [{ header: { id: 'restored' }, events: [], inheritedEventCount: 0 }], pluginState: { database: { schemaVersion: 1, revision: 0, payload: {} }, context: null, lastStep: { schemaVersion: 1, revision: 0, payload: {} }, gm: { schemaVersion: 1, revision: 0, payload: {} }, storyKit: { schemaVersion: 1, revision: 0, payload: {} } }, resources: [], requirements: [] }
  function ecosystem() {
    const api = client(), drafts = [], calls = []
    let adopted = record, retryDispatch = false
    const actions = Object.fromEntries(['narratives', 'presentationSummaries', 'drafts', 'createDraft', 'editDraft', 'adoptDraft', 'material', 'authorNote', 'exportReading', 'exportSavedStory', 'previewSavedStory', 'restoreSavedStory'].map(key => [key, true]))
    api.action = async (action, input) => {
      calls.push({ action, input })
      if (action === 'capabilities') return { schemaVersion: 1, services: { gm: { available: true, apiVersion: 1 }, storyKit: { available: true, apiVersion: 1 }, database: { available: true, apiVersion: 2 }, context: { available: true, apiVersion: null }, lastStep: { available: true, apiVersion: null }, loop: { available: false, apiVersion: null } }, actions: { ...actions, retryPresentation: retryDispatch } }
      if (action === 'narratives') return { records: [adopted] }
      if (action === 'drafts') return { drafts: [...drafts] }
      if (action === 'presentationSummaries') return { presentations: [{ presentationId: 'failed-a', status: 'failed', createdAt: '2026-10-25T00:00:00Z', canRetry: true, errorCode: 'MODEL_UNAVAILABLE' }], capabilities: { retryDispatch } }
      if (action === 'authorNote') return { id: 'note-a', text: '多一些停顿。', version: 1, status: 'claimed', claimedBy: 'receipt-a' }
      if (action === 'createDraft') { const draft = { id: 'draft-a', sessionId: 'a', version: 1, basedOn: ref, kind: input.kind, text: adopted.text, status: 'ready', createdAt: '2026-10-25T00:00:00Z' }; drafts.push(draft); return structuredClone(draft) }
      if (action === 'editDraft') { if (input.expectedDraftVersion !== drafts[0].version) throw Object.assign(new Error('草稿版本已改变，请重新载入。'), { code: 'DRAFT_CONFLICT' }); drafts[0] = { ...drafts[0], version: drafts[0].version + 1, kind: 'manual', text: input.text }; return drafts[0] }
      if (action === 'adoptDraft') { if (input.expectedDraftVersion !== drafts[0].version) throw Object.assign(new Error('候选已被其他窗口修改。'), { code: 'DRAFT_VERSION_CONFLICT' }); adopted = { ...record, id: '["receipt-a",9]', ref: { ...ref, resultSeq: 9 }, text: drafts[0].text }; return { narrative: adopted } }
      if (action === 'material') return { presentationId: input.presentationId, packet: { playerAction: '推开门' }, storySnapshot: { title: '冻结故事', character: { assetId: 'actor', version: 1, name: '林', description: '冻结角色描述。' }, persona: { assetId: 'player', version: 1, name: '旅人', description: '冻结身份。' }, examples: '冻结风格示例。' }, contextPreparation: { candidates: [{ ref: { sourceKey: 'world', entryId: '0' }, title: '港口' }], authorNote: { id: 'note-a', version: 1, claimId: 'receipt-a' } }, compiled: { text: '原始冻结模块。' }, models: { render: { provider: 'local', model: 'writer-v1' } }, status: 'complete' }
      if (action === 'exportReading') return { fileName: 'reading.md', mimeType: 'text/markdown', text: '# 阅读稿\n采用的正文。' }
      if (action === 'previewSavedStory') return { supported: true, conflicts: [], requirements: [], identityMode: 'preserve' }
      if (action === 'restoreSavedStory') return { status: 'pending', sessionId: 'restored', diagnostics: [{ code: 'RESTORE_REQUIREMENT_MISSING', message: '目标环境尚需模型配置。' }] }
      if (action === 'retryPresentation') return { accepted: true }
      throw new Error(`Unexpected action ${action}`)
    }
    return { api, drafts, calls, enableRetry() { retryDispatch = true }, setNarrative(value) { adopted = value } }
  }

  it('creates and edits a manual candidate, adopts against the current reference, and refreshes reading', async () => {
    const h = ecosystem()
    render(<Workspace sessionId="a" openSession={vi.fn()} client={h.api} />)
    await screen.findByText('山间驿站')
    fireEvent.click(screen.getByRole('button', { name: '沉浸阅读' }))
    fireEvent.click(await screen.findByText('正文与材料'))
    fireEvent.click(await screen.findByRole('button', { name: '手改当前正文' }))
    const editor = await screen.findByRole('textbox', { name: '候选正文' })
    expect(editor.value).toBe('已确认的正式正文。')
    fireEvent.change(editor, { target: { value: '手工改写后的正文。' } })
    fireEvent.click(screen.getByRole('button', { name: '保存候选修改' }))
    await screen.findByText('候选修改已保存。')
    fireEvent.click(screen.getByRole('button', { name: '采用这个候选' }))
    await screen.findByText(/采用已确认/u)
    expect(h.calls.find(call => call.action === 'createDraft').input).toEqual({ sessionId: 'a', basedOn: ref, kind: 'manual' })
    expect(h.calls.find(call => call.action === 'adoptDraft').input.expectedNarrative).toEqual(ref)
    expect(h.calls.find(call => call.action === 'adoptDraft').input.expectedDraftVersion).toBe(2)
    expect(h.api.session.mock.calls.length).toBeGreaterThan(1)
  })

  it('retains an unsaved edit after a version conflict and keeps retry disabled without scoped dispatch', async () => {
    const h = ecosystem()
    render(<Workspace sessionId="a" openSession={vi.fn()} client={h.api} />)
    await screen.findByText('山间驿站')
    fireEvent.click(screen.getByRole('button', { name: '沉浸阅读' }))
    fireEvent.click(await screen.findByText('正文与材料'))
    expect(await screen.findByRole('button', { name: '重试该次正文' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '手改当前正文' }))
    const editor = await screen.findByRole('textbox', { name: '候选正文' })
    h.drafts[0].version = 2
    fireEvent.change(editor, { target: { value: '不要丢失的手改文字。' } })
    fireEvent.click(screen.getByRole('button', { name: '保存候选修改' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('DRAFT_CONFLICT')
    expect(editor.value).toBe('不要丢失的手改文字。')
  })

  it('preserves text typed while saving and saves that remaining dirty edit against the confirmed version', async () => {
    const h = ecosystem(), action = h.api.action, submitted = []
    let finishSave
    h.api.action = (name, input, signal) => {
      if (name === 'editDraft') {
        submitted.push(structuredClone(input))
        if (submitted.length === 1) return new Promise(resolve => { finishSave = async () => resolve(await action(name, input, signal)) })
      }
      return action(name, input, signal)
    }
    render(<Workspace sessionId="a" openSession={vi.fn()} client={h.api} />)
    await screen.findByText('山间驿站')
    fireEvent.click(screen.getByRole('button', { name: '沉浸阅读' }))
    fireEvent.click(await screen.findByText('正文与材料'))
    fireEvent.click(await screen.findByRole('button', { name: '手改当前正文' }))
    const editor = await screen.findByRole('textbox', { name: '候选正文' })
    fireEvent.change(editor, { target: { value: '本次提交文字。' } })
    fireEvent.click(screen.getByRole('button', { name: '保存候选修改' }))
    await waitFor(() => expect(typeof finishSave).toBe('function'))
    expect(editor).not.toBeDisabled()
    fireEvent.change(editor, { target: { value: '本次提交文字。继续输入且尚未保存。' } })
    await act(async () => finishSave())
    await screen.findByText('候选修改已保存。')
    expect(editor.value).toBe('本次提交文字。继续输入且尚未保存。')
    const save = screen.getByRole('button', { name: '保存候选修改' })
    await waitFor(() => expect(save).not.toBeDisabled())
    expect(screen.getByRole('button', { name: '采用这个候选' })).toBeDisabled()
    fireEvent.click(save)
    await waitFor(() => expect(submitted).toHaveLength(2))
    expect(submitted[1]).toMatchObject({ draftId: 'draft-a', expectedDraftVersion: 2, text: '本次提交文字。继续输入且尚未保存。' })
    await waitFor(() => expect(save).toBeDisabled())
  })

  it('does not switch a newly selected candidate when an earlier save resolves', async () => {
    const h = ecosystem(), action = h.api.action
    let finishSave
    h.api.action = (name, input, signal) => name === 'editDraft' ? new Promise(resolve => { finishSave = async () => resolve(await action(name, input, signal)) }) : action(name, input, signal)
    render(<Workspace sessionId="a" openSession={vi.fn()} client={h.api} />)
    await screen.findByText('山间驿站')
    fireEvent.click(screen.getByRole('button', { name: '沉浸阅读' }))
    fireEvent.click(await screen.findByText('正文与材料'))
    fireEvent.click(await screen.findByRole('button', { name: '手改当前正文' }))
    const editor = await screen.findByRole('textbox', { name: '候选正文' })
    h.drafts.push({ ...structuredClone(h.drafts[0]), id: 'draft-b', kind: 'writer', text: '另一个候选的正文。' })
    fireEvent.click(screen.getByRole('button', { name: '刷新正文操作' }))
    const other = await screen.findByRole('button', { name: '写作 · ready · v1' })
    fireEvent.change(editor, { target: { value: '保存第一个候选。' } })
    await waitFor(() => expect(screen.getByRole('button', { name: '保存候选修改' })).not.toBeDisabled())
    fireEvent.click(screen.getByRole('button', { name: '保存候选修改' }))
    await waitFor(() => expect(typeof finishSave).toBe('function'))
    fireEvent.click(other)
    expect(editor.value).toBe('另一个候选的正文。')
    await act(async () => finishSave())
    expect(editor.value).toBe('另一个候选的正文。')
    expect(other).toHaveAttribute('aria-pressed', 'true')
  })

  it('reads the stored material snapshot and marks a claimed author note without consuming it', async () => {
    const h = ecosystem()
    render(<Workspace sessionId="a" openSession={vi.fn()} client={h.api} />)
    await screen.findByText('山间驿站')
    fireEvent.click(screen.getByRole('button', { name: '沉浸阅读' }))
    fireEvent.click(await screen.findByText('正文与材料'))
    fireEvent.click(await screen.findByRole('button', { name: '查看当前正文材料' }))
    expect(await screen.findByText(/原始冻结模块/u)).toBeTruthy()
    expect(screen.getByText(/冻结角色描述/u)).toBeTruthy()
    expect(screen.getByText(/模块文本长度：7/u)).toBeTruthy()
    expect(screen.getByText(/已认领/u)).toBeTruthy()
    expect(screen.getByText(/记录的候选池/u)).toBeTruthy()
    expect(h.calls.some(call => call.action === 'setAuthorNote')).toBe(false)
  })

  it('separates reading export from exact-ID restoration and resumes a pending job with the same ID', async () => {
    const h = ecosystem(), open = vi.fn()
    render(<Workspace sessionId="a" openSession={open} client={h.api} />)
    await screen.findByText('山间驿站')
    fireEvent.click(screen.getByRole('button', { name: '故事档案' }))
    fireEvent.click(await screen.findByRole('button', { name: '导出阅读稿' }))
    expect(await screen.findByText(/# 阅读稿/u)).toBeTruthy()
    expect(h.calls.filter(call => call.action === 'restoreSavedStory')).toHaveLength(0)
    const snapshot = structuredClone(savedStory)
    const file = new File([JSON.stringify(snapshot)], 'save.json', { type: 'application/json' })
    fireEvent.change(screen.getByLabelText('完整存档文件'), { target: { files: [file] } })
    fireEvent.click(await screen.findByRole('button', { name: '恢复完整存档' }))
    expect(await screen.findByText(/恢复尚未完成/u)).toBeTruthy()
    expect(open).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '继续恢复' }))
    await waitFor(() => expect(h.calls.filter(call => call.action === 'restoreSavedStory')).toHaveLength(2))
    const calls = h.calls.filter(call => call.action === 'restoreSavedStory')
    expect(calls[1].input.restoreId).toBe(calls[0].input.restoreId)
    expect(screen.getByLabelText('恢复任务 ID')).toBeDisabled()
  })

  it('does not offer restoration after the owner reports an exact-ID conflict', async () => {
    const h = ecosystem(), action = h.api.action
    h.api.action = (name, input, signal) => name === 'previewSavedStory' ? Promise.resolve({ supported: false, identityMode: 'preserve', conflicts: [{ code: 'RESTORE_ID_CONFLICT', id: 'existing' }], requirements: [] }) : action(name, input, signal)
    render(<Workspace sessionId="a" openSession={vi.fn()} client={h.api} />)
    await screen.findByText('山间驿站')
    fireEvent.click(screen.getByRole('button', { name: '故事档案' }))
    const file = new File([JSON.stringify(savedStory)], 'conflict.json', { type: 'application/json' })
    const upload = await screen.findByLabelText('完整存档文件')
    await waitFor(() => expect(upload).not.toBeDisabled())
    fireEvent.change(upload, { target: { files: [file] } })
    expect(await screen.findByText(/RESTORE_ID_CONFLICT/u)).toBeTruthy()
    expect(screen.getByRole('button', { name: '恢复完整存档' })).toBeDisabled()
    expect(h.calls.some(call => call.action === 'restoreSavedStory')).toBe(false)
  })

  it('shows missing optional capabilities while preserving legacy reading and runtime controls', async () => {
    const api = client()
    api.action = async () => ({ schemaVersion: 1, services: Object.fromEntries(['gm', 'storyKit', 'database', 'context', 'lastStep', 'loop'].map(key => [key, { available: false, apiVersion: null }])), actions: {} })
    render(<Workspace sessionId="a" openSession={vi.fn()} client={api} />)
    await screen.findByText('山间驿站')
    fireEvent.click(screen.getByRole('button', { name: '沉浸阅读' }))
    fireEvent.click(await screen.findByText('正文与材料'))
    expect(await screen.findByText('RP 最后一步：未连接')).toBeTruthy()
    expect(screen.getByRole('button', { name: '手改当前正文' })).toBeDisabled()
    expect(screen.getByText('风穿过门廊。')).toBeTruthy()
    expect(screen.getByRole('button', { name: '自动续写' })).not.toBeDisabled()
  })

  it('refreshes the adopted version after an idle owner change without overwriting an unsaved candidate', async () => {
    const h = ecosystem()
    render(<Workspace sessionId="a" openSession={vi.fn()} client={h.api} />)
    await screen.findByText('山间驿站')
    fireEvent.click(screen.getByRole('button', { name: '沉浸阅读' }))
    fireEvent.click(await screen.findByText('正文与材料'))
    fireEvent.click(await screen.findByRole('button', { name: '手改当前正文' }))
    const editor = await screen.findByRole('textbox', { name: '候选正文' })
    fireEvent.change(editor, { target: { value: '保留尚未保存的候选。' } })
    const next = { ...record, id: '["receipt-a",9]', ref: { ...ref, resultSeq: 9 }, text: '另一窗口已采用的正文。' }
    h.setNarrative(next)
    h.api.session.mockResolvedValue({ ...detail('a'), messages: [{ id: next.id, seq: 9, role: 'gm', text: next.text, status: 'complete' }] })
    act(() => h.api.listeners.get('a')({ type: 'session.rebased', sessionId: 'a' }))
    expect(await screen.findByText(/版本 9.*已采用修订/u)).toBeTruthy()
    expect(editor.value).toBe('保留尚未保存的候选。')
  })

  it('dispatches an eligible failed presentation by its public ID when scoped retry is available', async () => {
    const h = ecosystem()
    h.enableRetry()
    render(<Workspace sessionId="a" openSession={vi.fn()} client={h.api} />)
    await screen.findByText('山间驿站')
    fireEvent.click(screen.getByRole('button', { name: '沉浸阅读' }))
    fireEvent.click(await screen.findByText('正文与材料'))
    const retry = await screen.findByRole('button', { name: '重试该次正文' })
    await waitFor(() => expect(retry).not.toBeDisabled())
    fireEvent.click(retry)
    expect(await screen.findByText(/已提交受限正文重试/u)).toBeTruthy()
    expect(h.calls.find(call => call.action === 'retryPresentation').input).toEqual({ sessionId: 'a', presentationId: 'failed-a' })
    expect(h.calls.some(call => call.action === 'gmState' || call.action === 'createDraft')).toBe(false)
  })

  it('does not adopt unseen newer text after another window edits the previewed draft', async () => {
    const h = ecosystem()
    render(<Workspace sessionId="a" openSession={vi.fn()} client={h.api} />)
    await screen.findByText('山间驿站')
    fireEvent.click(screen.getByRole('button', { name: '沉浸阅读' }))
    fireEvent.click(await screen.findByText('正文与材料'))
    fireEvent.click(await screen.findByRole('button', { name: '手改当前正文' }))
    const editor = await screen.findByRole('textbox', { name: '候选正文' })
    h.drafts[0].version = 2; h.drafts[0].text = '用户没有预览过的新文字。'
    await waitFor(() => expect(screen.getByRole('button', { name: '采用这个候选' })).not.toBeDisabled())
    fireEvent.click(screen.getByRole('button', { name: '采用这个候选' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('DRAFT_VERSION_CONFLICT')
    expect(editor.value).toBe('已确认的正式正文。')
    expect(h.calls.find(call => call.action === 'adoptDraft').input.expectedDraftVersion).toBe(1)
    expect(screen.queryByText(/已采用正式正文版本/u)).toBeNull()
  })

  it('shows absent frozen source for an older receipt rather than reconstructing today’s character', async () => {
    const h = ecosystem(), action = h.api.action
    h.api.action = async (name, input, signal) => { const result = await action(name, input, signal); if (name === 'material') delete result.storySnapshot; return result }
    render(<Workspace sessionId="a" openSession={vi.fn()} client={h.api} />)
    await screen.findByText('山间驿站')
    fireEvent.click(screen.getByRole('button', { name: '沉浸阅读' }))
    fireEvent.click(await screen.findByText('正文与材料'))
    fireEvent.click(await screen.findByRole('button', { name: '查看当前正文材料' }))
    expect(await screen.findByText('未记录固定来源')).toBeTruthy()
    expect(h.calls.some(call => call.action === 'gmState')).toBe(false)
  })

  it('labels deferred Loop checks as conditional staging and never opens a pending restored story', async () => {
    const h = ecosystem(), action = h.api.action, open = vi.fn()
    h.api.action = (name, input, signal) => name === 'previewSavedStory' ? Promise.resolve({ supported: true, identityMode: 'preserve', conflicts: [], requirements: [], deferredChecks: [{ code: 'LOOP_NODE_VALIDATION', sessionId: 'restored', nodeIds: ['render'] }] }) : action(name, input, signal)
    render(<Workspace sessionId="a" openSession={open} client={h.api} />)
    await screen.findByText('山间驿站')
    fireEvent.click(screen.getByRole('button', { name: '故事档案' }))
    const upload = await screen.findByLabelText('完整存档文件')
    await waitFor(() => expect(upload).not.toBeDisabled())
    fireEvent.change(upload, { target: { files: [new File([JSON.stringify(savedStory)], 'conditional.json', { type: 'application/json' })] } })
    expect(await screen.findByText(/支持条件暂存；目标实际路由尚未完成验证/u)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '暂存并验证目标路由' }))
    expect(await screen.findByText(/恢复尚未完成/u)).toBeTruthy()
    expect(open).not.toHaveBeenCalled()
  })

  it('displays recorded public dependency use with fixed labels when exporting a save', async () => {
    const h = ecosystem(), action = h.api.action
    const dependencySummary = { databases: [{ databaseId: 'world-default', version: 2, uses: ['asset-default'] }], profiles: [{ profileId: 'style-current', version: 3, uses: ['current-binding'] }] }
    h.api.action = (name, input, signal) => name === 'exportSavedStory' ? Promise.resolve({ snapshot: { ...savedStory, dependencySummary } }) : action(name, input, signal)
    render(<Workspace sessionId="a" openSession={vi.fn()} client={h.api} />)
    await screen.findByText('山间驿站')
    fireEvent.click(screen.getByRole('button', { name: '故事档案' }))
    const button = await screen.findByRole('button', { name: '导出完整存档' })
    await waitFor(() => expect(button).not.toBeDisabled()); fireEvent.click(button)
    const summary = await screen.findByRole('region', { name: '记录的依赖用途' })
    expect(within(summary).getByText('world-default · v2')).toBeTruthy()
    expect(within(summary).getByText('style-current · v3')).toBeTruthy()
    expect(within(summary).getByText('资产默认来源')).toBeTruthy()
    expect(within(summary).getByText('所选故事当前绑定')).toBeTruthy()
    expect(within(summary).getByText(/不表示历史从未使用/u)).toBeTruthy()
  })

  it('marks legacy dependency use as unrecorded instead of inspecting private plugin payloads', async () => {
    const h = ecosystem(), action = h.api.action
    const snapshot = structuredClone(savedStory)
    snapshot.pluginState.lastStep.payload = { profiles: [{ id: 'PRIVATE_PAYLOAD_SHOULD_NOT_BE_INFERRED', version: 1 }] }
    h.api.action = (name, input, signal) => name === 'exportSavedStory' ? Promise.resolve({ snapshot }) : action(name, input, signal)
    render(<Workspace sessionId="a" openSession={vi.fn()} client={h.api} />)
    await screen.findByText('山间驿站')
    fireEvent.click(screen.getByRole('button', { name: '故事档案' }))
    const button = await screen.findByRole('button', { name: '导出完整存档' })
    await waitFor(() => expect(button).not.toBeDisabled()); fireEvent.click(button)
    expect(await screen.findByText('依赖用途：未记录')).toBeTruthy()
    expect(screen.queryByText(/PRIVATE_PAYLOAD_SHOULD_NOT_BE_INFERRED/u)).toBeNull()
  })

  it('uses only the owner preview summary for display and does not enable a denied restoration', async () => {
    const h = ecosystem(), action = h.api.action, open = vi.fn()
    const dependencySummary = { databases: [], profiles: [{ profileId: 'owner-current', version: 3, uses: ['current-binding'] }] }
    h.api.action = (name, input, signal) => name === 'previewSavedStory' ? Promise.resolve({ supported: false, identityMode: 'preserve', conflicts: [{ code: 'RESTORE_ID_CONFLICT', id: 'restored' }], requirements: [], dependencySummary }) : action(name, input, signal)
    render(<Workspace sessionId="a" openSession={open} client={h.api} />)
    await screen.findByText('山间驿站')
    fireEvent.click(screen.getByRole('button', { name: '故事档案' }))
    const upload = await screen.findByLabelText('完整存档文件')
    await waitFor(() => expect(upload).not.toBeDisabled())
    const snapshot = { ...savedStory, dependencySummary: { databases: [], profiles: [{ profileId: 'file-only', version: 1, uses: ['asset-default'] }] } }
    fireEvent.change(upload, { target: { files: [new File([JSON.stringify(snapshot)], 'with-info.json', { type: 'application/json' })] } })
    const summary = await screen.findByRole('region', { name: '记录的依赖用途' })
    expect(within(summary).getByText('owner-current · v3')).toBeTruthy()
    expect(within(summary).queryByText(/file-only/u)).toBeNull()
    expect(screen.getByRole('button', { name: '恢复完整存档' })).toBeDisabled()
    expect(h.calls.some(call => call.action === 'restoreSavedStory')).toBe(false)
    expect(open).not.toHaveBeenCalled()
  })
})
