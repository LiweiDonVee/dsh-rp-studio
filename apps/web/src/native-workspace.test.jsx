import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
})
