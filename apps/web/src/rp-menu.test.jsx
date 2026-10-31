import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RpMenu, ownerPages } from '../../../packages/plugin/src/RpMenu.jsx'
import { apply } from '../../../packages/plugin/src/client.jsx'
import { apply as applyLoop } from '../../../packages/loop-plugin/src/client.jsx'

vi.mock('../../../packages/plugin/src/workspace.css', () => ({ default: '' }))
vi.mock('../../../packages/loop-plugin/src/styles.css', () => ({ default: '' }))
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function registry(kinds = []) {
  const entries = new Map(kinds.map(kind => [kind, { kind }]))
  const listeners = new Set()
  return { get: kind => entries.get(kind), subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) }, register(value) { entries.set(value.kind, value); listeners.forEach(listener => listener()); return () => { entries.delete(value.kind); listeners.forEach(listener => listener()) } } }
}
const studioDetail = { session: { id: 'story', running: false }, card: { title: '远山', protagonist: '旅人', world: '山间' }, state: { started: true, scene: { location: '驿站' }, protagonist: { name: '旅人' }, statusLines: [], relationships: [], quests: [], inventory: [], memories: [], eventLog: [], extensions: {}, checkpoints: { canRollback: false } }, messages: [] }
const client = () => ({ cards: async () => [], sessions: async () => [studioDetail.session], session: async () => studioDetail, subscribe: () => () => {} })

describe('RP umbrella menu', () => {
  it('starts closed, routes every view and every registered native owner, and closes after selection', () => {
    const onSelectView = vi.fn(), onOpenOwner = vi.fn()
    render(<RpMenu registry={registry(ownerPages.map(([kind]) => kind))} onSelectView={onSelectView} onOpenOwner={onOpenOwner} />)
    const trigger = screen.getByRole('button', { name: 'RP', exact: true })
    expect(screen.queryByRole('menu')).toBeNull()
    for (const [view, label] of [['state', '角色与剧情'], ['story', '沉浸阅读'], ['archive', '故事档案与开局']]) {
      fireEvent.click(trigger)
      fireEvent.click(screen.getByRole('menuitemradio', { name: label }))
      expect(onSelectView).toHaveBeenLastCalledWith(view)
      expect(screen.queryByRole('menu')).toBeNull()
    }
    for (const [kind, label] of ownerPages) {
      fireEvent.click(trigger)
      fireEvent.click(screen.getByRole('menuitem', { name: label }))
      expect(onOpenOwner).toHaveBeenLastCalledWith(kind)
      expect(screen.queryByRole('menu')).toBeNull()
    }
  })

  it('tracks owner installation and removal while open, with an explicit unavailable reason', () => {
    const tabs = registry()
    render(<RpMenu registry={tabs} onSelectView={vi.fn()} onOpenOwner={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'RP', exact: true }))
    const database = screen.getByRole('menuitem', { name: '数据库' })
    expect(database).toBeDisabled()
    expect(within(database.parentElement).getByText('未启用对应插件')).toBeTruthy()
    let remove
    act(() => { remove = tabs.register({ kind: 'rp-database' }) })
    expect(database).not.toBeDisabled()
    act(() => remove())
    expect(database).toBeDisabled()
    expect(screen.getByRole('menuitem', { name: 'RP 助手' })).toBeDisabled()
    expect(screen.getByText('RP 助手入口正在准备')).toBeTruthy()
  })

  it('uses keyboard navigation, closes on Escape and outside clicks, and returns focus', () => {
    render(<RpMenu onSelectView={vi.fn()} />)
    const trigger = screen.getByRole('button', { name: 'RP', exact: true })
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    const state = screen.getByRole('menuitemradio', { name: '角色与剧情' })
    expect(document.activeElement).toBe(state)
    fireEvent.keyDown(state, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: '沉浸阅读' }))
    fireEvent.keyDown(document.activeElement, { key: 'End' })
    expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: '故事档案与开局' }))
    fireEvent.keyDown(document.activeElement, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(trigger)
    fireEvent.click(trigger)
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('keeps route failures readable in the open menu and calls a real companion callback', async () => {
    const companion = vi.fn().mockResolvedValue(undefined)
    render(<RpMenu registry={registry(['rp-context'])} onSelectView={vi.fn()} onOpenOwner={() => { throw new Error('上下文页面打开失败') }} onOpenCompanion={companion} />)
    fireEvent.click(screen.getByRole('button', { name: 'RP', exact: true }))
    fireEvent.click(screen.getByRole('menuitem', { name: '上下文' }))
    expect(screen.getByRole('alert')).toHaveTextContent('上下文页面打开失败')
    expect(screen.getByRole('menu')).toBeTruthy()
    await act(async () => fireEvent.click(screen.getByRole('menuitem', { name: 'RP 助手' })))
    expect(companion).toHaveBeenCalledOnce()
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('consumes repeated native view navigation without losing the action draft', async () => {
    const registrations = [], effects = [], source = [], tabs = registry(), openTab = vi.fn()
    apply({ effect(fn) { effects.push(fn()) }, sidebarRightTabs: tabs, sidebarRight: { openTab }, uiWorkspace: {}, slots: { subscribe: () => () => {}, entries: () => source, inject: (_key, fn) => fn(), register(options, component) { registrations.push({ options, component }); return () => {} } } })
    const Body = registrations.find(entry => entry.options.name === 'sidebar.right.pane.tab').component, api = client()
    let navigation = { params: { view: 'story' }, revision: 1 }
    function NativeBody() { return React.cloneElement(Body({ sessionId: 'story', useTabInfo: () => ({ tab: { visible: true, navigation } }), openSession: vi.fn(), renderSlot: vi.fn() }), { client: api }) }
    const mounted = render(<NativeBody />)
    await screen.findByRole('button', { name: '工作区 · 沉浸阅读' })
    fireEvent.change(screen.getByRole('textbox', { name: '写下你的行动' }), { target: { value: '保留行动草稿' } })
    fireEvent.click(screen.getByRole('button', { name: '工作区 · 沉浸阅读' }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: '故事档案与开局' }))
    expect(openTab).toHaveBeenCalledWith('rp-studio', { params: { view: 'archive' } })
    navigation = { params: { view: 'archive' }, revision: 2 }
    mounted.rerender(<NativeBody />)
    expect(screen.getByRole('button', { name: '工作区 · 故事档案与开局' })).toBeTruthy()
    navigation = { params: { view: 'story' }, revision: 3 }
    mounted.rerender(<NativeBody />)
    expect(screen.getByRole('textbox', { name: '写下你的行动' })).toHaveValue('保留行动草稿')
    navigation = { params: { view: 'unsupported' }, revision: 4 }
    mounted.rerender(<NativeBody />)
    expect(screen.getByRole('button', { name: '工作区 · 角色与剧情' })).toBeTruthy()
    for (const release of effects.reverse()) release?.()
  })

  it('enables the real helper only after Host readiness and carries the selected story into its unsent draft', async () => {
    let available = false
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ schemaVersion: 1, presetId: 'rp-companion', available, reason: '助手预设未启用', tools: available ? ['rp_companion_inspect', 'rp_companion_apply', 'rp_companion_import_file'] : [], owners: { storyKit: false, database: false, lastStep: false, context: false, gm: false, loop: false } }) })))
    const registrations = [], effects = [], startSession = vi.fn()
    apply({ effect(fn) { effects.push(fn()) }, sidebarRightTabs: registry(), sidebarRight: {}, uiWorkspace: { startSession }, slots: { inject: (_key, fn) => fn(), register(options, component) { registrations.push({ options, component }); return () => {} } } })
    const entry = registrations.find(row => row.options.name === 'conversation.session.header.actions'), Header = entry.component
    render(<Header sessionId="explicit-story" {...entry.options.inject()} />)
    fireEvent.click(screen.getByRole('button', { name: 'RP', exact: true }))
    await screen.findByText('助手预设未启用')
    expect(screen.getByRole('menuitem', { name: 'RP 助手' })).toBeDisabled()
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    available = true
    fireEvent.click(screen.getByRole('button', { name: 'RP', exact: true }))
    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'RP 助手' })).not.toBeDisabled())
    fireEvent.click(screen.getByRole('menuitem', { name: 'RP 助手' }))
    expect(startSession).toHaveBeenCalledWith(undefined, expect.objectContaining({ agentPreset: 'rp-companion', whenDraftExists: 'append', prompt: expect.stringContaining('explicit-story') }))
    expect(screen.queryByRole('menu')).toBeNull()
    for (const release of effects.reverse()) release?.()
  })

  it('rechecks the mounted story inside the navigation frame before opening Studio', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ schemaVersion: 1, presetId: 'rp-companion', available: false, reason: '助手预设未启用', tools: [], owners: { storyKit: false, database: false, lastStep: false, context: false, gm: false, loop: false } }) })))
    const frames = [], mountedListeners = new Set(), registrations = [], effects = [], openTab = vi.fn()
    let mounted = 'source'
    vi.stubGlobal('requestAnimationFrame', callback => { frames.push(callback); return frames.length })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    apply({ effect(fn) { effects.push(fn()) }, sidebarRightTabs: registry(), sidebarRight: { openTab, mounted: { getSnapshot: () => mounted, subscribe: listener => { mountedListeners.add(listener); return () => mountedListeners.delete(listener) } } }, uiWorkspace: { openSession: id => { mounted = id; mountedListeners.forEach(listener => listener()) } }, slots: { inject: (_key, fn) => fn(), register(options, component) { registrations.push({ options, component }); return () => {} } } })
    const body = registrations.find(row => row.options.name === 'sidebar.right.pane.tab'), opening = body.options.inject().openSession('target')
    mounted = 'unrelated'
    frames.at(-1)()
    expect(openTab).not.toHaveBeenCalled()
    mounted = 'target'
    mountedListeners.forEach(listener => listener())
    frames.at(-1)()
    await opening
    expect(openTab).toHaveBeenCalledExactlyOnceWith('rp-studio', { params: { view: 'state' } })
    for (const release of effects.reverse()) release?.()
  })

  it('filters covered owners, keeps third-party slot behavior, and tracks extension unload and restore', async () => {
    const registrations = [], effects = [], listeners = new Set(), api = client(), extension = vi.fn()
    let source = [{ options: { id: 'dsh-rp-database/workspace' } }, { options: { id: 'third-party' } }]
    apply({ effect(fn) { effects.push(fn()) }, sidebarRightTabs: registry(), sidebarRight: {}, uiWorkspace: {}, slots: { entries: () => source, subscribe: (_key, listener) => { listeners.add(listener); return () => listeners.delete(listener) }, inject: (_key, fn) => fn(), register(options, component) { registrations.push({ options, component }); return () => {} } } })
    const Body = registrations.find(entry => entry.options.name === 'sidebar.right.pane.tab').component
    const renderSlot = vi.fn((_key, _props, { only }) => <button type="button" onClick={extension}>{only}</button>)
    function NativeBody() { return React.cloneElement(Body({ sessionId: 'story', useTabInfo: () => ({ tab: { visible: true } }), openSession: vi.fn(), renderSlot }), { client: api }) }
    render(<NativeBody />)
    await screen.findByText('驿站')
    const open = () => fireEvent.click(screen.getByRole('button', { name: /^工作区 ·/u }))
    open()
    expect(screen.queryByRole('button', { name: 'dsh-rp-database/workspace' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'third-party' }))
    expect(extension).toHaveBeenCalledOnce()
    act(() => { source = []; listeners.forEach(listener => listener()) })
    open()
    expect(screen.queryByRole('group', { name: '扩展操作' })).toBeNull()
    act(() => { source = [{ options: { id: 'third-party' } }]; listeners.forEach(listener => listener()) })
    expect(screen.getByRole('button', { name: 'third-party' })).toBeTruthy()
    expect(renderSlot).toHaveBeenCalledWith('rp.studio.workspace.actions', {}, { only: 'third-party' })
    for (const release of effects.reverse()) release?.()
  })

  it('restores the standalone Loop entry when Studio unloads', () => {
    const tabs = registry(), registrations = [], effects = [], opened = vi.fn()
    applyLoop({ effect(fn) { effects.push(fn()) }, sidebarRightTabs: tabs, sidebarRight: { openTab: opened }, slots: { inject: (_key, fn) => fn(), register(options, component) { registrations.push({ options, component }); return () => {} } } })
    const entry = registrations.find(row => row.options.name === 'conversation.session.header.actions'), Entry = entry.component
    render(<Entry {...entry.options.inject()} />)
    fireEvent.click(screen.getByRole('button', { name: '打开 Loop Studio' }))
    expect(opened).toHaveBeenCalledWith('loop-studio')
    let uninstall
    act(() => { uninstall = tabs.register({ kind: 'rp-studio' }) })
    expect(screen.queryByRole('button', { name: '打开 Loop Studio' })).toBeNull()
    act(() => uninstall())
    expect(screen.getByRole('button', { name: '打开 Loop Studio' })).toBeTruthy()
    for (const release of effects.reverse()) release?.()
  })
})
