import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PresetWorkspace } from '../../../packages/rp-last-step/src/PresetWorkspace.jsx'
import { createRpLastStepApi } from '../../../packages/rp-last-step/src/api.js'

const copy = value => structuredClone(value)
const entry = (changes = {}) => ({ id: 'style', name: '叙事风格', content: '保留动作与停顿。', role: 'system', order: 0, enabled: true, phase: 'render', required: false, locked: false, ...changes })
const profile = (changes = {}) => ({ id: 'p1', name: '漫游叙事', version: 1, status: 'ready', sourceId: null, entries: [entry()], ...changes })

function createClient(initialProfiles = [profile()], binding = null) {
  let revision = 7
  const versions = new Map(initialProfiles.map(item => [`${item.id}:${item.version}`, copy(item)]))
  let latest = initialProfiles.map(copy)
  let currentBinding = binding
  const sources = new Map()
  const listeners = new Map()
  const summary = item => ({ id: item.id, name: item.name, version: item.version, status: item.status, sourceId: item.sourceId, entryCount: item.entries.length })
  const remember = item => {
    versions.set(`${item.id}:${item.version}`, copy(item))
    latest = [...latest.filter(value => value.id !== item.id), copy(item)]
  }
  const client = {
    listeners, sources,
    setRemote(item, nextRevision = revision + 1) { remember(item); revision = nextRevision },
    emit(id = 'a') { listeners.get(id)?.({ type: 'changed', sessionId: id }) },
    state: vi.fn(async () => ({ revision, profiles: latest.map(summary), binding: copy(currentBinding), capabilities: { migrate: false } })),
    profile: vi.fn(async (id, version) => ({ revision, profile: copy(version === undefined ? latest.find(value => value.id === id) : versions.get(`${id}:${version}`)) })),
    source: vi.fn(async id => ({ source: copy(sources.get(id)) })),
    create: vi.fn(async (name, expectedRevision) => {
      if (expectedRevision !== revision) throw conflict()
      const next = profile({ id: 'new', name, status: 'draft', entries: [] })
      remember(next); revision++
      return { revision, profileId: next.id, version: 1 }
    }),
    import: vi.fn(async (rawText, options) => {
      if (options.expectedRevision !== revision) throw conflict()
      JSON.parse(rawText.replace(/^\uFEFF/u, ''))
      sources.set('source1', { id: 'source1', format: 'sillytavern', rawText, sha256: 'fixture-source-hash' })
      const next = profile({ id: 'imported', name: options.name || '导入预设', status: 'draft', sourceId: 'source1', entries: [entry({ phase: 'unclassified', locked: false })] })
      remember(next); revision++
      return { revision, profileId: next.id, version: 1, diagnostics: [{ code: 'EXTENSIONS_INERT', message: '扩展仅保留在原件中', severity: 'warning' }] }
    }),
    save: vi.fn(async (input, expectedRevision) => {
      if (expectedRevision !== revision) throw conflict()
      if (input.version !== latest.find(item => item.id === input.id)?.version) throw Object.assign(new Error('预设版本已更新，请重新载入最新版本'), { code: 'PROFILE_VERSION_CONFLICT', status: 409 })
      const next = { ...copy(input), version: Math.max(...latest.filter(value => value.id === input.id).map(value => value.version)) + 1 }
      remember(next); revision++
      return { revision, profileId: next.id, version: next.version }
    }),
    bind: vi.fn(async (_sessionId, input) => {
      if (input.expectedRevision !== revision) throw conflict()
      const saved = versions.get(`${input.profileId}:${input.version}`)
      currentBinding = { profileId: saved.id, version: saved.version, profile: copy(saved), overlay: { entries: {}, additions: [] } }
      return { revision: ++revision }
    }),
    preview: vi.fn(async () => ({ blocked: false, diagnostics: [], entries: [entry()], messages: [{ role: 'system', content: '预览正文' }], text: '预览正文', hash: 'fixture-preview-hash' })),
    migrate: vi.fn(),
    subscribe: vi.fn((id, callback) => {
      listeners.set(id, callback)
      return vi.fn(() => listeners.delete(id))
    }),
  }
  return client
}

function conflict() { return Object.assign(new Error('预设版本已更新，请重新载入'), { code: 'REVISION_CONFLICT', status: 409 }) }
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('RP preset library editor', () => {
  it('imports exact pasted JSON as an unclassified draft and displays its immutable original', async () => {
    const client = createClient([])
    render(<PresetWorkspace sessionId="a" client={client} />)
    await screen.findByText('预设库还是空的')
    const raw = '{\r\n  "prompts": [], "extensions": {"unknown": "保留"}\r\n}\n'
    fireEvent.paste(screen.getByLabelText('SillyTavern JSON'), { clipboardData: { getData: () => raw } })
    fireEvent.click(screen.getByRole('button', { name: '导入为草稿' }))
    await screen.findByLabelText('模块正文')
    expect(client.import).toHaveBeenCalledWith(raw, { expectedRevision: 7 }, expect.any(AbortSignal))
    expect(screen.getByLabelText('模块阶段')).toHaveValue('unclassified')
    expect(screen.getByLabelText('预设状态')).toHaveValue('draft')
    expect(screen.getByRole('button', { name: '应用到当前故事' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '查看只读原件' }))
    const original = await screen.findByLabelText('原始预设 JSON（只读）')
    expect(original).toHaveAttribute('readonly')
    // Textarea normalizes CRLF; the transport and stored original remain byte-for-byte unchanged.
    expect(original).toHaveValue(raw.replaceAll('\r\n', '\n'))
    fireEvent.change(screen.getByLabelText('模块正文'), { target: { value: '用户派生正文' } })
    expect(client.sources.get('source1').rawText).toBe(raw)
    expect(screen.getByText('扩展仅保留在原件中')).toBeVisible()
  })

  it('lets the owner edit Agent-readonly modules and saves a separate version before pinning it', async () => {
    const original = profile({ entries: [entry({ enabled: false, locked: true })] })
    const client = createClient([original], { profileId: 'p1', version: 1, profile: original, overlay: { entries: {}, additions: [] } })
    render(<PresetWorkspace sessionId="a" client={client} />)
    const content = await screen.findByLabelText('模块正文')
    expect(content).not.toBeDisabled()
    fireEvent.change(content, { target: { value: '用户可以修改锁定模块。' } })
    fireEvent.click(screen.getByRole('checkbox', { name: '必用' }))
    expect(screen.getByRole('checkbox', { name: '启用模块' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: '启用模块' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('模块角色'), { target: { value: 'user' } })
    fireEvent.change(screen.getByLabelText('模块排序'), { target: { value: '12' } })
    fireEvent.change(screen.getByLabelText('模块阶段'), { target: { value: 'shared' } })
    fireEvent.click(screen.getByRole('button', { name: '保存新版本' }))
    await screen.findByText(/^已保存 v2/)
    expect(client.save.mock.calls[0][0].entries[0]).toMatchObject({ content: '用户可以修改锁定模块。', required: true, enabled: true, locked: true, role: 'user', order: 12, phase: 'shared' })
    expect(client.save.mock.calls[0][1]).toBe(7)
    expect(client.bind).not.toHaveBeenCalled()
    expect(screen.getByLabelText('当前故事固定版本')).toHaveTextContent('v1')
    fireEvent.click(screen.getByRole('button', { name: '应用到当前故事' }))
    await waitFor(() => expect(screen.getByLabelText('当前故事固定版本')).toHaveTextContent('v2'))
    expect(client.bind).toHaveBeenCalledWith('a', { profileId: 'p1', version: 2, expectedRevision: 8 }, expect.any(AbortSignal))
  })

  it('creates a blank draft, adds and removes owner modules, and never invents starter stories', async () => {
    const client = createClient([])
    render(<PresetWorkspace sessionId="a" client={client} />)
    await screen.findByText('预设库还是空的')
    fireEvent.change(screen.getByLabelText('新预设名称'), { target: { value: '我的空白预设' } })
    fireEvent.click(screen.getByRole('button', { name: '新建空白预设' }))
    await screen.findByDisplayValue('我的空白预设')
    expect(screen.getByText('还没有模块')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: '添加模块' }))
    expect(screen.getByLabelText('模块阶段')).toHaveValue('unclassified')
    fireEvent.change(screen.getByLabelText('模块名称'), { target: { value: '我的规则' } })
    fireEvent.click(screen.getByRole('button', { name: '删除模块' }))
    expect(screen.queryByLabelText('模块正文')).toBeNull()
    expect(screen.getByLabelText('预设状态')).toHaveValue('draft')
  })

  it('preserves file import text and parse errors for correction', async () => {
    const client = createClient([])
    render(<PresetWorkspace sessionId="a" client={client} />)
    await screen.findByText('预设库还是空的')
    const raw = '\uFEFF{ "prompts": [], "name": "文件预设" }\n'
    fireEvent.change(screen.getByLabelText('选择 JSON 文件'), { target: { files: [new File([raw], 'preset.json', { type: 'application/json' })] } })
    await waitFor(() => expect(screen.getByLabelText('SillyTavern JSON')).toHaveValue(raw))
    client.import.mockRejectedValueOnce(Object.assign(new Error('JSON 格式无效'), { code: 'INVALID_PRESET' }))
    fireEvent.click(screen.getByRole('button', { name: '导入为草稿' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('JSON 格式无效')
    expect(screen.getByLabelText('SillyTavern JSON')).toHaveValue(raw)
    expect(screen.getByText('预设库还是空的')).toBeVisible()
  })

  it('keeps newer pasted JSON when an older selected file finishes reading', async () => {
    const readers = []
    class Reader {
      constructor() { readers.push(this) }
      readAsArrayBuffer() {}
    }
    vi.stubGlobal('FileReader', Reader)
    const client = createClient([])
    render(<PresetWorkspace sessionId="a" client={client} />)
    await screen.findByText('预设库还是空的')
    fireEvent.change(screen.getByLabelText('选择 JSON 文件'), { target: { files: [new File(['{}'], 'old.json')] } })
    const correction = '{"prompts":[],"name":"新的手动输入"}'
    fireEvent.paste(screen.getByLabelText('SillyTavern JSON'), { clipboardData: { getData: () => correction } })
    readers[0].result = new TextEncoder().encode('{"prompts":[],"name":"旧文件"}').buffer
    await act(async () => readers[0].onload())
    expect(screen.getByLabelText('SillyTavern JSON')).toHaveValue(correction)
  })

  it('keeps the draft base revision through SSE and conflicts until an explicit reload', async () => {
    const client = createClient()
    render(<PresetWorkspace sessionId="a" client={client} />)
    fireEvent.change(await screen.findByLabelText('模块正文'), { target: { value: '本地未保存正文' } })
    client.setRemote(profile({ version: 2, entries: [entry({ content: '远端新正文' })] }), 8)
    await act(async () => client.emit())
    fireEvent.click(screen.getByRole('button', { name: '保存新版本' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('预设版本已更新')
    expect(client.save.mock.calls[0][1]).toBe(7)
    expect(screen.getByLabelText('模块正文')).toHaveValue('本地未保存正文')
    await act(async () => client.emit())
    expect(screen.getByRole('alert')).toHaveTextContent('预设版本已更新')
    fireEvent.click(screen.getByRole('button', { name: '重新载入预设' }))
    await waitFor(() => expect(screen.getByLabelText('模块正文')).toHaveValue('远端新正文'))
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.change(screen.getByLabelText('模块正文'), { target: { value: '基于远端修改' } })
    fireEvent.click(screen.getByRole('button', { name: '保存新版本' }))
    await screen.findByText(/^已保存 v3/)
    expect(client.save.mock.calls[1][1]).toBe(8)
  })

  it('keeps its completed save version and explicitly reloads latest after a profile-version conflict', async () => {
    const client = createClient()
    const commitSave = client.save.getMockImplementation()
    client.save.mockImplementation(async (...args) => {
      const result = await commitSave(...args)
      client.setRemote(profile({ version: 3, entries: [entry({ content: '并发更新的 v3 正文' })] }), 9)
      return result
    })
    render(<PresetWorkspace sessionId="a" client={client} />)
    fireEvent.change(await screen.findByLabelText('模块正文'), { target: { value: '我完成保存的 v2 正文' } })
    fireEvent.click(screen.getByRole('button', { name: '保存新版本' }))
    await screen.findByText(/^已保存 v2/)
    await screen.findByRole('button', { name: /漫游叙事 · v3/ })
    expect(client.profile).toHaveBeenLastCalledWith('p1', 2, expect.any(AbortSignal))
    expect(screen.getByLabelText('模块正文')).toHaveValue('我完成保存的 v2 正文')
    fireEvent.change(screen.getByLabelText('模块正文'), { target: { value: '仍基于 v2 的本地草稿' } })
    fireEvent.click(screen.getByRole('button', { name: '保存新版本' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('预设版本已更新')
    expect(client.save.mock.calls[1][0].version).toBe(2)
    expect(client.save.mock.calls[1][1]).toBe(9)
    expect(screen.getByLabelText('模块正文')).toHaveValue('仍基于 v2 的本地草稿')
    fireEvent.click(screen.getByRole('button', { name: '重新载入预设' }))
    await waitFor(() => expect(screen.getByLabelText('模块正文')).toHaveValue('并发更新的 v3 正文'))
    expect(client.profile).toHaveBeenLastCalledWith('p1', undefined, expect.any(AbortSignal))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('requires explicit discard before switching a dirty draft to a different preset', async () => {
    const client = createClient([profile(), profile({ id: 'p2', name: '另一套预设', entries: [entry({ content: '第二套正文' })] })])
    render(<PresetWorkspace sessionId="a" client={client} />)
    fireEvent.change(await screen.findByLabelText('模块正文'), { target: { value: '第一套未保存正文' } })
    fireEvent.click(screen.getByRole('button', { name: /另一套预设 · v1/ }))
    expect(screen.getByLabelText('模块正文')).toHaveValue('第一套未保存正文')
    expect(screen.getByText(/当前草稿有未保存修改/)).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: '继续编辑' }))
    fireEvent.click(screen.getByRole('button', { name: '保存新版本' }))
    await screen.findByText(/^已保存 v2/)
    expect(client.save.mock.calls[0][0].id).toBe('p1')
    fireEvent.click(screen.getByRole('button', { name: /另一套预设 · v1/ }))
    await waitFor(() => expect(screen.getByLabelText('模块正文')).toHaveValue('第二套正文'))
  })

  it('blocks a pending discard-and-switch while a save is in flight', async () => {
    const client = createClient([profile(), profile({ id: 'p2', name: '另一套预设' })])
    const commitSave = client.save.getMockImplementation()
    let finishSave
    client.save.mockImplementation(async (...args) => { await new Promise(resolve => { finishSave = resolve }); return commitSave(...args) })
    render(<PresetWorkspace sessionId="a" client={client} />)
    fireEvent.change(await screen.findByLabelText('模块正文'), { target: { value: '待保存正文' } })
    fireEvent.click(screen.getByRole('button', { name: /另一套预设 · v1/ }))
    fireEvent.click(screen.getByRole('button', { name: '保存新版本' }))
    const discard = screen.getByRole('button', { name: '放弃草稿并切换' })
    expect(discard).toBeDisabled()
    fireEvent.click(discard)
    expect(client.profile.mock.calls.some(([id]) => id === 'p2')).toBe(false)
    await act(async () => finishSave())
    await screen.findByText(/^已保存 v2/)
    expect(screen.getByLabelText('预设名称')).toHaveValue('漫游叙事')
    expect(screen.getByLabelText('模块正文')).toHaveValue('待保存正文')
  })

  it('scopes overlay badges and original-to-Agent diffs to the story’s pinned version', async () => {
    const bound = profile({ entries: [entry({ content: '固定版本正文' })] })
    const client = createClient([profile({ version: 2 })], {
      profileId: 'p1', version: 1, profile: bound,
      overlay: { entries: { style: { content: 'Agent 临时正文', enabled: false, fills: { tone: '克制' } } }, additions: [entry({ id: 'temporary', name: '临时模块' })] },
    })
    client.profile.mockImplementation(async (_id, version) => ({ revision: 7, profile: copy(version === 1 ? bound : profile({ version: 2 })) }))
    render(<PresetWorkspace sessionId="a" client={client} />)
    await screen.findByLabelText('模块正文')
    expect(within(screen.getByLabelText('模块列表')).queryByText('Agent 已修改')).toBeNull()
    expect(screen.getByLabelText('当前故事固定版本')).toHaveTextContent('v1')
    fireEvent.click(screen.getByText(/Agent 会话覆盖/))
    expect(screen.getByLabelText('固定版本原文 style')).toHaveTextContent('固定版本正文')
    expect(screen.getByLabelText('Agent 覆盖正文 style')).toHaveTextContent('Agent 临时正文')
    expect(screen.getByText('Agent 已停用')).toBeVisible()
    expect(screen.getByText('tone = 克制')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: '查看故事固定版本' }))
    await waitFor(() => expect(screen.getByLabelText('模块正文')).toHaveValue('固定版本正文'))
    expect(within(screen.getByLabelText('模块列表')).getByText('Agent 已修改')).toBeVisible()
  })

  it('previews unsaved phases with diagnostics without marking an import ready', async () => {
    const client = createClient([profile({ status: 'draft', entries: [entry({ phase: 'unclassified' })] })])
    client.preview.mockResolvedValueOnce({ blocked: true, diagnostics: [{ code: 'UNCLASSIFIED_ENTRY', message: '请先分类启用模块', entryId: 'style', severity: 'error' }], entries: [], messages: [], text: '', hash: null })
    render(<PresetWorkspace sessionId="a" client={client} />)
    fireEvent.change(await screen.findByLabelText('模块正文'), { target: { value: '未保存预览' } })
    fireEvent.change(screen.getByLabelText('预览阶段'), { target: { value: 'agent' } })
    fireEvent.click(screen.getByRole('button', { name: '编译预览' }))
    expect(await screen.findByText('请先分类启用模块')).toBeVisible()
    expect(screen.getByText('编译被阻塞')).toBeVisible()
    expect(client.preview).toHaveBeenCalledWith(expect.objectContaining({ entries: [expect.objectContaining({ content: '未保存预览' })] }), { sessionId: 'a', phase: 'agent', variables: {} }, expect.any(AbortSignal))
    expect(screen.getByLabelText('预设状态')).toHaveValue('draft')
    expect(client.save).not.toHaveBeenCalled()
  })

  it('does not apply late save responses after a session switch and releases hidden subscriptions', async () => {
    const client = createClient()
    let finishSave
    client.save.mockImplementation(() => new Promise(resolve => { finishSave = resolve }))
    const view = render(<PresetWorkspace sessionId="a" client={client} />)
    fireEvent.change(await screen.findByLabelText('模块正文'), { target: { value: '旧故事修改' } })
    fireEvent.click(screen.getByRole('button', { name: '保存新版本' }))
    const oldSignal = client.save.mock.calls[0][2]
    view.rerender(<PresetWorkspace sessionId="b" client={client} />)
    await waitFor(() => expect(screen.getByLabelText('模块正文')).toHaveValue('保留动作与停顿。'))
    await act(async () => finishSave({ revision: 8, profileId: 'p1', version: 2 }))
    expect(oldSignal.aborted).toBe(true)
    expect(screen.queryByText(/^已保存 v2/)).toBeNull()
    expect(document.querySelector('[data-rp-last-step-session="b"]')).toBeTruthy()
    const dispose = client.subscribe.mock.results.at(-1).value
    view.rerender(<PresetWorkspace sessionId="b" visible={false} client={client} />)
    expect(dispose).toHaveBeenCalledOnce()
    expect(client.listeners.has('b')).toBe(false)
  })

  it('offers model adaptation only when capability is declared and the profile is saved', async () => {
    const client = createClient()
    client.state.mockResolvedValue({ revision: 7, profiles: [{ id: 'p1', name: '漫游叙事', version: 1, status: 'ready', sourceId: null, entryCount: 1 }], binding: null, capabilities: { migrate: true } })
    client.migrate.mockResolvedValue({ revision: 8, profileId: 'adapted', version: 1, report: { notes: ['请检查阶段分配'] } })
    client.profile.mockImplementation(async id => ({ revision: id === 'adapted' ? 8 : 7, profile: profile(id === 'adapted' ? { id, name: '适配草稿', status: 'draft' } : {}) }))
    render(<PresetWorkspace sessionId="a" client={client} />)
    await screen.findByLabelText('模块正文')
    fireEvent.click(screen.getByRole('button', { name: '生成 Agent 适配草稿' }))
    await screen.findByDisplayValue('适配草稿')
    expect(client.migrate).toHaveBeenCalledWith('a', { profileId: 'p1', version: 1, expectedRevision: 7 }, expect.any(AbortSignal))
    expect(screen.getByLabelText('预设状态')).toHaveValue('draft')
    fireEvent.change(screen.getByLabelText('模块正文'), { target: { value: '继续编辑适配' } })
    expect(screen.getByRole('button', { name: '生成 Agent 适配草稿' })).toBeDisabled()
  })

  it('restores a saved migration report on initial load and reload, and clears it for ordinary profiles', async () => {
    const migrated = profile({
      status: 'draft',
      migrationReport: {
        summary: '已拆分剧情处理与呈现职责',
        blocked: ['只读模块需要用户核对'],
        diagnostics: [{ code: 'UNMAPPED_MARKER', message: '历史标记尚未映射' }],
      },
    })
    const client = createClient([migrated, profile({ id: 'ordinary', name: '普通预设' })])
    render(<PresetWorkspace sessionId="a" client={client} />)
    await screen.findByLabelText('模块正文')
    expect(screen.getByText(/已拆分剧情处理与呈现职责/)).toBeVisible()
    expect(screen.getByText(/只读模块需要用户核对/)).toBeVisible()
    expect(screen.getByText(/历史标记尚未映射/)).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: '重新载入预设' }))
    await waitFor(() => expect(client.profile).toHaveBeenLastCalledWith('p1', undefined, expect.any(AbortSignal)))
    expect(screen.getByText(/历史标记尚未映射/)).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: /普通预设 · v1/ }))
    await screen.findByDisplayValue('普通预设')
    expect(screen.queryByText(/已拆分剧情处理与呈现职责/)).toBeNull()
    expect(screen.queryByText(/只读模块需要用户核对/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /漫游叙事 · v1/ }))
    await screen.findByDisplayValue('漫游叙事')
    expect(screen.getByText(/历史标记尚未映射/)).toBeVisible()
  })

  it('uses the persisted report of the received migrated version and retains it after saving edits', async () => {
    const report = { summary: '派生版本已保存', blocked: ['保留未解决的宏'], diagnostics: [{ code: 'UNRESOLVED_MACRO', message: '需要提供角色变量' }] }
    const adapted = profile({ id: 'adapted', name: '适配草稿', status: 'draft', migrationReport: report })
    const client = createClient()
    const originalState = client.state.getMockImplementation()
    client.state.mockImplementation(async (...args) => ({ ...await originalState(...args), capabilities: { migrate: true } }))
    client.migrate.mockImplementation(async () => {
      client.setRemote(adapted, 8)
      return { revision: 8, profileId: 'adapted', version: 1, report: { summary: '旧的返回摘要' } }
    })
    render(<PresetWorkspace sessionId="a" client={client} />)
    await screen.findByLabelText('模块正文')
    fireEvent.click(screen.getByRole('button', { name: '生成 Agent 适配草稿' }))
    await screen.findByDisplayValue('适配草稿')
    expect(screen.getByText(/需要提供角色变量/)).toBeVisible()
    expect(screen.queryByText(/旧的返回摘要/)).toBeNull()
    fireEvent.change(screen.getByLabelText('模块正文'), { target: { value: '用户核对后的派生正文' } })
    fireEvent.click(screen.getByRole('button', { name: '保存新版本' }))
    await screen.findByText(/^已保存 v2/)
    expect(screen.getByText(/保留未解决的宏/)).toBeVisible()
    expect(screen.getByText(/需要提供角色变量/)).toBeVisible()
  })

  it('keeps a failed initial read actionable until the user explicitly refreshes', async () => {
    const client = createClient()
    client.profile.mockRejectedValueOnce(new Error('预设读取失败'))
    render(<PresetWorkspace sessionId="a" client={client} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('预设读取失败')
    expect(client.profile).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: '刷新预设库' }))
    await screen.findByLabelText('模块正文')
    expect(client.profile).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('keeps the import form revision through a remote library change until an explicit reset', async () => {
    const client = createClient([])
    render(<PresetWorkspace sessionId="a" client={client} />)
    await screen.findByText('预设库还是空的')
    const raw = '{"prompts":[]}'
    fireEvent.change(screen.getByLabelText('SillyTavern JSON'), { target: { value: raw } })
    client.setRemote(profile({ id: 'remote', name: '远端预设' }), 8)
    await act(async () => client.emit())
    await screen.findByLabelText('模块正文')
    fireEvent.click(screen.getByText('新建与导入'))
    fireEvent.click(screen.getByRole('button', { name: '导入为草稿' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('预设版本已更新')
    expect(client.import.mock.calls[0][1].expectedRevision).toBe(7)
    expect(screen.getByLabelText('SillyTavern JSON')).toHaveValue(raw)
    fireEvent.click(screen.getByRole('button', { name: '重新载入导入表单' }))
    await waitFor(() => expect(screen.getByLabelText('SillyTavern JSON')).toHaveValue(''))
    fireEvent.change(screen.getByLabelText('SillyTavern JSON'), { target: { value: raw } })
    fireEvent.click(screen.getByRole('button', { name: '导入为草稿' }))
    await screen.findByDisplayValue('导入预设')
    expect(client.import.mock.calls[1][1].expectedRevision).toBe(8)
  })

  it('coalesces SSE bursts and waits for fresh metadata after saving past an in-flight refresh', async () => {
    const client = createClient()
    render(<PresetWorkspace sessionId="a" client={client} />)
    fireEvent.change(await screen.findByLabelText('模块正文'), { target: { value: '第一版修改' } })
    let finishOldRefresh
    client.state.mockImplementationOnce(() => new Promise(resolve => { finishOldRefresh = resolve }))
    act(() => { client.emit(); client.emit(); client.emit() })
    expect(client.state).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByRole('button', { name: '保存新版本' }))
    await screen.findByText(/^已保存 v2/)
    expect(screen.getByRole('button', { name: '正在保存…' })).toBeDisabled()
    await act(async () => finishOldRefresh({ revision: 7, profiles: [{ id: 'p1', name: '漫游叙事', version: 1, status: 'ready', sourceId: null, entryCount: 1 }], binding: null, capabilities: { migrate: false } }))
    await waitFor(() => expect(screen.getByRole('button', { name: '重新载入预设' })).toBeEnabled())
    expect(client.state).toHaveBeenCalledTimes(3)
    fireEvent.change(screen.getByLabelText('模块正文'), { target: { value: '基于已保存版本修改' } })
    fireEvent.click(screen.getByRole('button', { name: '保存新版本' }))
    await screen.findByText(/^已保存 v3/)
    expect(client.save.mock.calls[1][1]).toBe(8)
  })

  it('ignores a compile response for a draft that has since changed', async () => {
    const client = createClient()
    let finishPreview
    client.preview.mockImplementationOnce(() => new Promise(resolve => { finishPreview = resolve }))
    render(<PresetWorkspace sessionId="a" client={client} />)
    await screen.findByLabelText('模块正文')
    fireEvent.click(screen.getByRole('button', { name: '编译预览' }))
    fireEvent.change(screen.getByLabelText('模块正文'), { target: { value: '预览期间的新正文' } })
    await act(async () => finishPreview({ blocked: false, diagnostics: [], entries: [entry()], messages: [], text: '过期预览正文', hash: 'old' }))
    expect(screen.queryByLabelText('编译结果正文')).toBeNull()
    expect(screen.getByLabelText('模块正文')).toHaveValue('预览期间的新正文')
    expect(screen.getByRole('button', { name: '编译预览' })).toBeEnabled()
  })
})

describe('RP last-step browser API', () => {
  it('sends plain action DTOs relative to the host and preserves structured revision failures', async () => {
    const send = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ revision: 8, profileId: 'p1', version: 2 }) }).mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ error: { code: 'REVISION_CONFLICT', message: '已更新', diagnostics: [{ code: 'STALE' }] } }) })
    const api = createRpLastStepApi(send)
    const controller = new AbortController()
    await api.save(profile(), 7, controller.signal)
    const [url, input] = send.mock.calls[0]
    expect(url.pathname).toBe('/api/rp-last-step/request')
    expect(input.signal).toBe(controller.signal)
    expect(JSON.parse(input.body)).toEqual({ action: 'saveProfile', profile: profile(), expectedRevision: 7 })
    await expect(api.bind('a/b', { profileId: 'p1', version: 2, expectedRevision: 7 }, controller.signal)).rejects.toMatchObject({ status: 409, code: 'REVISION_CONFLICT', message: '已更新', diagnostics: [{ code: 'STALE' }] })
  })

  it('filters session events, ignores malformed frames, and closes its event source', () => {
    const streams = []
    class Source extends EventTarget {
      constructor(url) { super(); this.url = url; this.close = vi.fn(); streams.push(this) }
    }
    vi.stubGlobal('EventSource', Source)
    const received = []
    const dispose = createRpLastStepApi().subscribe('a/b', event => received.push(event), vi.fn())
    const stream = streams[0]
    expect(stream.url.pathname).toBe('/api/rp-last-step/events')
    expect(stream.url.searchParams.get('sessionId')).toBe('a/b')
    stream.dispatchEvent(new MessageEvent('changed', { data: JSON.stringify({ sessionId: 'other' }) }))
    stream.dispatchEvent(new MessageEvent('changed', { data: '{' }))
    stream.dispatchEvent(new MessageEvent('connected', { data: JSON.stringify({ sessionId: 'a/b' }) }))
    stream.dispatchEvent(new MessageEvent('changed', { data: JSON.stringify({ sessionId: 'a/b', revision: 8 }) }))
    expect(received).toEqual([{ type: 'connected', sessionId: 'a/b' }, { type: 'changed', sessionId: 'a/b', revision: 8 }])
    dispose()
    expect(stream.close).toHaveBeenCalledOnce()
  })
})
