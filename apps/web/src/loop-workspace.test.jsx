import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LoopWorkspace } from '../../../packages/loop-plugin/src/LoopWorkspace.jsx'
import { createLoopApi } from '../../../packages/loop-plugin/src/api.js'
import { apply, TAB_ID, TAB_KIND } from '../../../packages/loop-plugin/src/client.jsx'

vi.mock('../../../packages/loop-plugin/src/styles.css', () => ({ default: '.dsh-loop-workspace{}' }))

function snapshot(sessionId = 'a', changes = {}) {
  return {
    revision: 7,
    selectedPresetId: 'standard',
    presets: [{ id: 'standard', name: 'Standard' }],
    composition: [{ entryId: 'agent', moduleName: 'Native agent', enabled: true }],
    graph: {
      schemaVersion: 1, id: 'host-loop-v1',
      nodes: [
        { id: 'host.prepare', label: '准备上下文', kind: 'program', control: 'observe', source: 'host' },
        { id: 'host.first', label: '首个模型请求', kind: 'model', control: 'route', source: 'host' },
        { id: 'host.tools', label: '工具执行', kind: 'tool', control: 'observe', source: 'host' },
        { id: 'host.continuation', label: '后续模型请求', kind: 'model', control: 'route', source: 'host' },
        { id: 'host.finish', label: '回合结束', kind: 'program', control: 'observe', source: 'host' },
      ],
      edges: [
        { id: 'prepare-first', from: 'host.prepare', to: 'host.first' },
        { id: 'first-tools', from: 'host.first', to: 'host.tools', label: '调用工具' },
        { id: 'tools-next', from: 'host.tools', to: 'host.continuation' },
        { id: 'next-tools', from: 'host.continuation', to: 'host.tools', label: '继续调用' },
        { id: 'first-finish', from: 'host.first', to: 'host.finish', label: '直接完成' },
        { id: 'next-finish', from: 'host.continuation', to: 'host.finish', label: '完成' },
      ],
    },
    policies: { session: null, preset: null },
    effectivePolicy: { enabled: false, routes: {} },
    models: [
      { provider: 'cloud', id: 'fast', name: 'Fast' },
      { provider: 'local', id: 'quality', name: 'Quality', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } },
    ],
    trace: [{ id: `${sessionId}-request`, type: 'assistant/message', nodeId: 'host.first', timestamp: 1720000000000, step: 1, provider: 'cloud', model: 'fast', status: 'completed', tokens: { inputTokens: 120, outputTokens: 30 } }],
    running: false,
    routingCapability: 'supported',
    diagnostics: [],
    ...changes,
  }
}

function createClient(initial = snapshot()) {
  let current = initial
  const listeners = new Map()
  const disposers = []
  return {
    listeners, disposers,
    inspect: vi.fn(async () => current),
    savePolicy: vi.fn(async (_id, input) => {
      current = { ...current, revision: current.revision + 1, policies: { ...current.policies, [input.scope]: input.policy }, effectivePolicy: input.policy }
      return { revision: current.revision }
    }),
    resetPolicy: vi.fn(async (_id, input) => {
      const policies = { ...current.policies, [input.scope]: null }
      current = { ...current, revision: current.revision + 1, policies, effectivePolicy: policies.session ?? policies.preset ?? { enabled: false, routes: {} } }
      return { revision: current.revision }
    }),
    subscribe: vi.fn((id, callback) => {
      listeners.set(id, callback)
      const dispose = vi.fn(() => listeners.delete(id))
      disposers.push(dispose)
      return dispose
    }),
  }
}

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('native Loop Studio workspace', () => {
  it('saves the selected model node with the current revision and confirms the saved route', async () => {
    const client = createClient()
    render(<LoopWorkspace sessionId="a" client={client} />)
    fireEvent.click(await screen.findByRole('button', { name: /首个模型请求/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: '启用模型接管' }))
    fireEvent.change(screen.getByLabelText('提供方'), { target: { value: 'local' } })
    fireEvent.change(screen.getByLabelText('模型'), { target: { value: 'quality' } })
    fireEvent.change(screen.getByLabelText('推理强度'), { target: { value: 'high' } })
    fireEvent.change(screen.getByLabelText('输出 token 上限'), { target: { value: '2048' } })
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }))
    await waitFor(() => expect(client.savePolicy).toHaveBeenCalledWith('a', {
      scope: 'session', expectedRevision: 7,
      policy: { enabled: true, routes: { 'host.first': { provider: 'local', model: 'quality', reasoningEffort: 'high', maxTokens: 2048 } } },
    }, expect.any(AbortSignal)))
    expect(await screen.findByText('配置已保存')).toBeVisible()
    expect(screen.getByLabelText('提供方')).toHaveValue('local')
    expect(screen.getByLabelText('模型')).toHaveValue('quality')
  })

  it('restores session inheritance and uses the new revision for a subsequent explicit disable', async () => {
    const client = createClient(snapshot('a', {
      policies: { session: { enabled: true, routes: { 'host.first': { provider: 'cloud', model: 'fast' } } }, preset: { enabled: true, routes: { 'host.first': { provider: 'local', model: 'quality' } } } },
      effectivePolicy: { enabled: true, routes: { 'host.first': { provider: 'cloud', model: 'fast' } } },
    }))
    render(<LoopWorkspace sessionId="a" client={client} />)
    fireEvent.click(await screen.findByRole('button', { name: /首个模型请求/ }))
    fireEvent.click(screen.getByRole('button', { name: '恢复继承' }))
    await waitFor(() => expect(screen.getByLabelText('当前配置')).toHaveTextContent('local / quality'))
    expect(screen.getByLabelText('提供方')).toHaveValue('')
    expect(client.resetPolicy).toHaveBeenCalledWith('a', { scope: 'session', expectedRevision: 7 }, expect.any(AbortSignal))
    fireEvent.click(screen.getByRole('checkbox', { name: '启用模型接管' }))
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }))
    await waitFor(() => expect(client.savePolicy).toHaveBeenCalledWith('a', {
      scope: 'session', expectedRevision: 8, policy: { enabled: false, routes: {} },
    }, expect.any(AbortSignal)))
    expect(await screen.findByText('配置已保存')).toBeVisible()
    expect(screen.getByRole('checkbox', { name: '启用模型接管' })).not.toBeChecked()
  })

  it('saves the selected preset layer without copying a session route into its defaults', async () => {
    const client = createClient(snapshot('a', {
      policies: { session: { enabled: true, routes: { 'host.continuation': { provider: 'local', model: 'quality' } } }, preset: null },
      effectivePolicy: { enabled: true, routes: { 'host.continuation': { provider: 'local', model: 'quality' } } },
    }))
    render(<LoopWorkspace sessionId="a" client={client} />)
    fireEvent.click(await screen.findByRole('button', { name: /首个模型请求/ }))
    fireEvent.change(screen.getByLabelText('保存范围'), { target: { value: 'preset' } })
    fireEvent.click(screen.getByRole('checkbox', { name: '启用模型接管' }))
    fireEvent.change(screen.getByLabelText('提供方'), { target: { value: 'cloud' } })
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }))
    await waitFor(() => expect(client.savePolicy).toHaveBeenCalledWith('a', {
      scope: 'preset', presetId: 'standard', expectedRevision: 7,
      policy: { enabled: true, routes: { 'host.first': { provider: 'cloud', model: 'fast' } } },
    }, expect.any(AbortSignal)))
  })

  it('shows observed routes separately and keeps tools, programs and unknown drivers read only', async () => {
    const client = createClient(snapshot('a', { effectivePolicy: { enabled: true, routes: { 'host.first': { provider: 'local', model: 'quality' } } } }))
    const view = render(<LoopWorkspace sessionId="a" client={client} />)
    fireEvent.click(await screen.findByRole('button', { name: /首个模型请求/ }))
    expect(screen.getByLabelText('当前配置')).toHaveTextContent('local / quality')
    expect(screen.getByLabelText('最近实际请求')).toHaveTextContent('cloud / fast')
    expect(screen.getByText('输入 120 · 输出 30')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: '工具执行' }))
    expect(screen.getByText('此节点仅供观察')).toBeVisible()
    expect(screen.queryByLabelText('提供方')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '准备上下文' }))
    expect(screen.queryByLabelText('模型')).toBeNull()
    view.unmount()
    render(<LoopWorkspace sessionId="a" client={createClient(snapshot('a', { routingCapability: 'unknown-driver', diagnostics: ['自定义驱动未声明模型选择扩展点'] }))} />)
    fireEvent.click(await screen.findByRole('button', { name: /首个模型请求/ }))
    expect(screen.getByText('自定义驱动未声明模型选择扩展点')).toBeVisible()
    expect(screen.queryByLabelText('提供方')).toBeNull()
    expect(screen.queryByRole('button', { name: '保存配置' })).toBeNull()
  })

  it('ignores late inspection responses after switching sessions and releases subscriptions on hide and unmount', async () => {
    const client = createClient()
    let resolveOld
    client.inspect.mockImplementation(id => id === 'a' ? new Promise(resolve => { resolveOld = resolve }) : Promise.resolve(snapshot(id, { selectedPresetId: 'b-preset', presets: [{ id: 'b-preset', name: 'Session B preset' }] })))
    const view = render(<LoopWorkspace sessionId="a" client={client} />)
    await waitFor(() => expect(client.inspect).toHaveBeenCalledWith('a', expect.any(AbortSignal)))
    const oldSignal = client.inspect.mock.calls[0][1]
    view.rerender(<LoopWorkspace sessionId="b" client={client} />)
    await screen.findByText('Session B preset')
    await act(async () => resolveOld(snapshot('a')))
    expect(oldSignal.aborted).toBe(true)
    expect(screen.queryByText('Standard')).toBeNull()
    expect(client.subscribe.mock.calls.map(call => call[0])).toEqual(['b'])
    view.rerender(<LoopWorkspace sessionId="b" visible={false} client={client} />)
    expect(client.disposers[0]).toHaveBeenCalledOnce()
    view.rerender(<LoopWorkspace sessionId="b" client={client} />)
    await waitFor(() => expect(client.subscribe).toHaveBeenCalledTimes(2))
    view.unmount()
    expect(client.disposers[1]).toHaveBeenCalledOnce()
  })

  it('refreshes metadata without overwriting an unsaved route, and clears unsupported reasoning when the model changes', async () => {
    const client = createClient()
    render(<LoopWorkspace sessionId="a" client={client} />)
    fireEvent.click(await screen.findByRole('button', { name: /首个模型请求/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: '启用模型接管' }))
    fireEvent.change(screen.getByLabelText('提供方'), { target: { value: 'local' } })
    fireEvent.change(screen.getByLabelText('推理强度'), { target: { value: 'high' } })
    act(() => client.listeners.get('a')({ type: 'changed', sessionId: 'a' }))
    await waitFor(() => expect(client.inspect).toHaveBeenCalledTimes(2))
    expect(screen.getByLabelText('推理强度')).toHaveValue('high')
    fireEvent.change(screen.getByLabelText('提供方'), { target: { value: 'cloud' } })
    expect(screen.queryByLabelText('推理强度')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }))
    await waitFor(() => expect(client.savePolicy.mock.calls[0][1].policy).toEqual({ enabled: true, routes: { 'host.first': { provider: 'cloud', model: 'fast' } } }))
  })

  it('shows revision conflicts without discarding the draft', async () => {
    const client = createClient()
    client.savePolicy.mockRejectedValue(new Error('配置版本已更新，请刷新后重试'))
    render(<LoopWorkspace sessionId="a" client={client} />)
    fireEvent.click(await screen.findByRole('button', { name: /首个模型请求/ }))
    fireEvent.change(screen.getByLabelText('提供方'), { target: { value: 'local' } })
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('配置版本已更新，请刷新后重试')
    expect(screen.getByLabelText('模型')).toHaveValue('quality')
    expect(screen.queryByText('配置已保存')).toBeNull()
  })

  it('changes one session node without pinning inherited preset routes at other nodes', async () => {
    const preset = { enabled: true, routes: { 'host.continuation': { provider: 'local', model: 'quality', reasoningEffort: 'high' } } }
    const client = createClient(snapshot('a', { policies: { session: null, preset }, effectivePolicy: preset }))
    render(<LoopWorkspace sessionId="a" client={client} />)
    fireEvent.click(await screen.findByRole('button', { name: /首个模型请求/ }))
    fireEvent.change(screen.getByLabelText('提供方'), { target: { value: 'cloud' } })
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }))
    await waitFor(() => expect(client.savePolicy.mock.calls[0][1].policy).toEqual({ enabled: true, routes: { 'host.first': { provider: 'cloud', model: 'fast' } } }))
  })

  it('does not apply a late save completion to a different session', async () => {
    const client = createClient()
    let finishSave
    client.savePolicy.mockImplementation(() => new Promise(resolve => { finishSave = resolve }))
    const view = render(<LoopWorkspace sessionId="a" client={client} />)
    fireEvent.click(await screen.findByRole('button', { name: /首个模型请求/ }))
    fireEvent.change(screen.getByLabelText('提供方'), { target: { value: 'local' } })
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }))
    const oldSignal = client.savePolicy.mock.calls[0][2]
    view.rerender(<LoopWorkspace sessionId="b" client={client} />)
    await screen.findByRole('button', { name: /首个模型请求/ })
    await act(async () => finishSave({ revision: 8 }))
    expect(oldSignal.aborted).toBe(true)
    expect(screen.queryByText('配置已保存')).toBeNull()
    expect(screen.getByLabelText('提供方')).toHaveValue('')
    expect(screen.getByRole('button', { name: '保存配置' })).toBeEnabled()
  })

  it('waits for the saved revision when a metadata refresh was already in flight', async () => {
    const client = createClient()
    let finishOldRefresh
    let finishSavedRefresh
    client.inspect.mockResolvedValueOnce(snapshot())
    client.inspect.mockImplementationOnce(() => new Promise(resolve => { finishOldRefresh = resolve }))
    client.inspect.mockImplementationOnce(() => new Promise(resolve => { finishSavedRefresh = resolve }))
    render(<LoopWorkspace sessionId="a" client={client} />)
    fireEvent.click(await screen.findByRole('button', { name: /首个模型请求/ }))
    act(() => client.listeners.get('a')({ type: 'changed', sessionId: 'a' }))
    fireEvent.change(screen.getByLabelText('提供方'), { target: { value: 'local' } })
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }))
    await screen.findByText('配置已保存')
    expect(screen.getByRole('button', { name: '正在保存…' })).toBeDisabled()
    await act(async () => finishOldRefresh(snapshot()))
    await waitFor(() => expect(client.inspect).toHaveBeenCalledTimes(3))
    expect(screen.getByRole('button', { name: '正在保存…' })).toBeDisabled()
    await act(async () => finishSavedRefresh(snapshot('a', { revision: 8, policies: { session: { enabled: false, routes: { 'host.first': { provider: 'local', model: 'quality' } } }, preset: null } })))
    expect(screen.getByRole('button', { name: '保存配置' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }))
    await waitFor(() => expect(client.savePolicy.mock.calls[1][1].expectedRevision).toBe(8))
  })

  it('keeps the draft base revision across remote changes and preserves a conflict until explicit reload', async () => {
    const original = { enabled: true, routes: { 'host.first': { provider: 'cloud', model: 'fast' } } }
    let current = snapshot('a', { policies: { session: original, preset: null }, effectivePolicy: original })
    const client = createClient()
    client.inspect.mockImplementation(async () => current)
    client.savePolicy.mockImplementation(async (_id, input) => {
      if (input.expectedRevision !== current.revision) throw Object.assign(new Error('配置版本已更新，请重新载入配置'), { code: 'revision-conflict' })
      current = { ...current, revision: current.revision + 1, policies: { session: input.policy, preset: null }, effectivePolicy: input.policy }
      return { revision: current.revision }
    })
    render(<LoopWorkspace sessionId="a" client={client} />)
    fireEvent.click(await screen.findByRole('button', { name: '后续模型请求' }))
    fireEvent.change(screen.getByLabelText('提供方'), { target: { value: 'local' } })
    fireEvent.change(screen.getByLabelText('推理强度'), { target: { value: 'high' } })
    const remotePolicy = { enabled: true, routes: { 'host.first': { provider: 'local', model: 'quality', reasoningEffort: 'low' } } }
    current = snapshot('a', { revision: 8, policies: { session: remotePolicy, preset: null }, effectivePolicy: remotePolicy })
    await act(async () => client.listeners.get('a')({ type: 'changed', sessionId: 'a' }))
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('配置版本已更新')
    expect(client.savePolicy.mock.calls[0][1].expectedRevision).toBe(7)
    expect(current.policies.session).toEqual(remotePolicy)
    expect(screen.getByLabelText('推理强度')).toHaveValue('high')
    await act(async () => client.listeners.get('a')({ type: 'changed', sessionId: 'a' }))
    expect(screen.getByRole('alert')).toHaveTextContent('配置版本已更新')
    expect(screen.getByLabelText('推理强度')).toHaveValue('high')
    fireEvent.click(screen.getByRole('button', { name: '重新载入配置' }))
    await waitFor(() => expect(screen.getByLabelText('提供方')).toHaveValue(''))
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.change(screen.getByLabelText('提供方'), { target: { value: 'cloud' } })
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }))
    await waitFor(() => expect(client.savePolicy.mock.calls[1][1].expectedRevision).toBe(8))
    expect(current.policies.session.routes['host.first']).toEqual({ provider: 'local', model: 'quality', reasoningEffort: 'low' })
  })

  it('requires explicit reload before a dirty preset draft can target a newly selected preset in the same session', async () => {
    let current = snapshot('a', { selectedPresetId: 'preset-a', presets: [{ id: 'preset-a', name: 'Preset A' }, { id: 'preset-b', name: 'Preset B' }] })
    const client = createClient()
    client.inspect.mockImplementation(async () => current)
    client.savePolicy.mockImplementation(async (_id, input) => {
      current = { ...current, revision: current.revision + 1, policies: { session: null, preset: input.policy }, effectivePolicy: input.policy }
      return { revision: current.revision }
    })
    render(<LoopWorkspace sessionId="a" client={client} />)
    fireEvent.click(await screen.findByRole('button', { name: '首个模型请求' }))
    fireEvent.change(screen.getByLabelText('保存范围'), { target: { value: 'preset' } })
    fireEvent.click(screen.getByRole('checkbox', { name: '启用模型接管' }))
    fireEvent.change(screen.getByLabelText('提供方'), { target: { value: 'local' } })
    const policyB = { enabled: true, routes: { 'host.first': { provider: 'cloud', model: 'fast' } } }
    current = { ...current, revision: 8, selectedPresetId: 'preset-b', policies: { session: null, preset: policyB }, effectivePolicy: policyB }
    await act(async () => client.listeners.get('a')({ type: 'changed', sessionId: 'a' }))
    expect(screen.getByText('Preset B', { exact: true })).toBeVisible()
    expect(screen.getByLabelText('提供方')).toHaveValue('local')
    expect(screen.getByRole('button', { name: '保存配置' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }))
    expect(client.savePolicy).not.toHaveBeenCalled()
    expect(screen.getByText(/当前预设已切换/)).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: '重新载入配置' }))
    await waitFor(() => expect(screen.getByLabelText('提供方')).toHaveValue('cloud'))
    fireEvent.change(screen.getByLabelText('提供方'), { target: { value: 'local' } })
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }))
    await waitFor(() => expect(client.savePolicy).toHaveBeenCalledWith('a', {
      scope: 'preset', presetId: 'preset-b', expectedRevision: 8,
      policy: { enabled: true, routes: { 'host.first': { provider: 'local', model: 'quality' } } },
    }, expect.any(AbortSignal)))
  })
})

describe('Loop Studio native transport', () => {
  it('posts the policy DTO through the host endpoint and reports revision failures', async () => {
    const requests = []
    const client = createLoopApi(async (url, input) => {
      requests.push({ url, input })
      return requests.length === 1 ? { ok: true, json: async () => ({ revision: 8 }) } : { ok: false, json: async () => ({ error: { code: 'revision-conflict', message: '配置版本已更新' } }) }
    })
    const controller = new AbortController()
    const policy = { enabled: true, routes: { 'host.first': { provider: 'local', model: 'quality' } } }
    expect(await client.savePolicy('a/b', { scope: 'session', expectedRevision: 7, policy }, controller.signal)).toEqual({ revision: 8 })
    expect(requests[0].url.pathname).toBe('/api/loop-studio/request')
    expect(requests[0].input.signal).toBe(controller.signal)
    expect(JSON.parse(requests[0].input.body)).toEqual({ action: 'savePolicy', sessionId: 'a/b', scope: 'session', expectedRevision: 7, policy })
    await expect(client.resetPolicy('a/b', { scope: 'session', expectedRevision: 7 }, controller.signal)).rejects.toMatchObject({ code: 'revision-conflict', message: '配置版本已更新' })
  })

  it('filters metadata events by session and closes the native event source', () => {
    const streams = []
    class Source extends EventTarget {
      constructor(url) { super(); this.url = url; this.close = vi.fn(); streams.push(this) }
    }
    vi.stubGlobal('EventSource', Source)
    const received = []
    const close = createLoopApi().subscribe('a/b', event => received.push(event), vi.fn())
    const stream = streams[0]
    expect(stream.url.searchParams.get('sessionId')).toBe('a/b')
    stream.dispatchEvent(new MessageEvent('changed', { data: JSON.stringify({ sessionId: 'another' }) }))
    stream.dispatchEvent(new MessageEvent('changed', { data: '{' }))
    stream.dispatchEvent(new MessageEvent('connected', { data: JSON.stringify({ sessionId: 'a/b' }) }))
    stream.dispatchEvent(new MessageEvent('changed', { data: JSON.stringify({ sessionId: 'a/b' }) }))
    expect(received).toEqual([{ sessionId: 'a/b', type: 'connected' }, { sessionId: 'a/b', type: 'changed' }])
    close()
    expect(stream.close).toHaveBeenCalledOnce()
  })
})

describe('Loop Studio native entry points', () => {
  it('registers a keyed pane, native action entries and disposable styles', () => {
    const releases = []
    const registrations = new Map()
    const ctx = {
      effect: callback => { const dispose = callback(); if (dispose) releases.push(dispose) },
      sidebarRightTabs: { register: vi.fn(() => vi.fn()), get: () => undefined, subscribe: () => () => {} },
      sidebarRight: { openTab: vi.fn() },
      slots: {
        inject: (_name, callback) => callback(),
        register: (options, Component) => { registrations.set(options.name, { options, Component }); return vi.fn() },
      },
    }
    apply(ctx)
    expect(ctx.sidebarRightTabs.register.mock.calls[0][0]).toMatchObject({ id: TAB_ID, kind: TAB_KIND })
    expect(registrations.get('sidebar.right.pane.tab').options.key).toBe(TAB_ID)
    const style = document.head.querySelector('[data-dsh-loop-studio]')
    expect(style).toBeTruthy()
    for (const name of ['conversation.session.header.actions', 'conversation.hero.options']) {
      const entry = registrations.get(name)
      expect(entry.options.id).toBe(TAB_ID)
      const view = render(<entry.Component {...entry.options.inject()} />)
      fireEvent.click(screen.getByRole('button', { name: '打开 Loop Studio' }))
      view.unmount()
    }
    expect(ctx.sidebarRight.openTab.mock.calls).toEqual([[TAB_KIND], [TAB_KIND]])
    for (const release of releases.reverse()) release()
    expect(style.isConnected).toBe(false)
  })
})
