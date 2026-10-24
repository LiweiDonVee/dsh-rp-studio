import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createRpLastStepApi } from './api.js'

const defaultApi = createRpLastStepApi()
const phaseNames = { unclassified: '待分类', agent: 'Agent · 剧情处理', render: '呈现 · 最终正文', shared: '共用 · 两个阶段' }
const own = (object, key) => Object.prototype.hasOwnProperty.call(object ?? {}, key)
const active = scope => scope?.active
const clone = value => JSON.parse(JSON.stringify(value))

export function Book({ size = 18, ...props }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}><path d="M12 5c-3-2-6-2-9-1v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-3-1-6-1-9 1Z" /><path d="M12 5v15" /></svg>
}

export function Quill({ size = 18, ...props }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}><path d="m4 20 5-5m-2 2c-2-6 6-14 14-14 0 8-8 16-14 14Z" /><path d="m11 13 5-5" /></svg>
}

async function request(scope, work) {
  if (!active(scope)) return null
  const controller = new AbortController()
  scope.controllers.add(controller)
  try { return await work(controller.signal) }
  finally { scope.controllers.delete(controller) }
}

function Diagnostics({ items }) {
  if (!items?.length) return null
  return <ul className="rpls-diagnostics">{items.map((item, index) => <li key={`${item.code ?? 'diagnostic'}-${index}`}><span className="rpls-badge">{item.severity === 'warning' ? '待核对' : '诊断'}</span> {item.message ?? String(item)}{item.entryId && <small>模块 {item.entryId}</small>}</li>)}</ul>
}

function OverlayView({ binding }) {
  if (!binding) return null
  const changes = Object.entries(binding.overlay?.entries ?? {})
  const additions = binding.overlay?.additions ?? []
  return <details className="rpls-overlay">
    <summary>Agent 会话覆盖 · v{binding.version}<span>{changes.length + additions.length} 项</span></summary>
    <div className="rpls-overlay-body">
      <p className="rpls-help">以下变更仅属于当前故事固定的 {binding.profile?.name ?? binding.profileId} · v{binding.version}，原件和预设版本保持完整。</p>
      {!changes.length && !additions.length && <p className="rpls-help">当前没有 Agent 覆盖。</p>}
      {changes.map(([id, patch]) => {
        const original = binding.profile?.entries.find(entry => entry.id === id)
        return <article className="rpls-overlay-entry" key={id}>
          <div className="rpls-section-title"><strong>{original?.name ?? id}</strong><div className="rpls-badges">{own(patch, 'content') && <span className="rpls-badge">Agent 已修改</span>}{patch.enabled === false && <span className="rpls-badge">Agent 已停用</span>}{patch.enabled === true && <span className="rpls-badge">Agent 已启用</span>}{Object.keys(patch.fills ?? {}).length > 0 && <span className="rpls-badge">Agent 已填充</span>}</div></div>
          {own(patch, 'content') && <div className="rpls-diff"><div><small>固定版本原文 · v{binding.version}</small><pre aria-label={`固定版本原文 ${id}`}>{original?.content ?? '原文不可用'}</pre></div><div><small>当前故事 Agent 覆盖</small><pre aria-label={`Agent 覆盖正文 ${id}`}>{patch.content}</pre></div></div>}
          {Object.keys(patch.fills ?? {}).length > 0 && <ul className="rpls-fills">{Object.entries(patch.fills).map(([key, value]) => <li key={key}>{key} = {value}</li>)}</ul>}
        </article>
      })}
      {additions.map(item => <article className="rpls-overlay-entry" key={item.id}><div className="rpls-section-title"><strong>{item.name}</strong><span className="rpls-badge">Agent 临时模块</span></div><pre>{item.content}</pre></article>)}
    </div>
  </details>
}

// A new story has its own request lifecycle and draft identity.
export function PresetWorkspace({ sessionId, visible = true, client = defaultApi }) {
  return <section className="dsh-rp-last-step" data-rp-last-step-session={sessionId ?? ''} hidden={!visible} aria-label="RP 预设工作区"><SessionWorkspace key={sessionId ?? ''} sessionId={sessionId} visible={visible} client={client} /></section>
}

function SessionWorkspace({ sessionId, visible, client }) {
  const [state, setState] = useState(null)
  const stateRef = useRef(null)
  const [draft, setDraft] = useState(null)
  const draftRef = useRef(null)
  const [selectedEntry, setSelectedEntry] = useState(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [errorDiagnostics, setErrorDiagnostics] = useState([])
  const [conflictForm, setConflictForm] = useState(null)
  const [transportError, setTransportError] = useState('')
  const [notice, setNotice] = useState('')
  const [pendingSelection, setPendingSelection] = useState(null)
  const [importText, setImportText] = useState('')
  const [importName, setImportName] = useState('')
  const [orderCharacterId, setOrderCharacterId] = useState('')
  const [newName, setNewName] = useState('')
  const [importDiagnostics, setImportDiagnostics] = useState([])
  const [source, setSource] = useState(null)
  const [sourceBusy, setSourceBusy] = useState(false)
  const [preview, setPreview] = useState(null)
  const [previewPhase, setPreviewPhase] = useState('render')
  const [previewVariables, setPreviewVariables] = useState('{}')
  const [previewBusy, setPreviewBusy] = useState(false)
  const [report, setReport] = useState(null)
  const [stage, setStage] = useState('')
  const lifecycle = useRef(null)
  const initialProfileAttempted = useRef(false)
  const importFormRevision = useRef(null)
  const createFormRevision = useRef(null)
  const newEntryCounter = useRef(0)

  const acceptDraft = useCallback((profile, revision) => {
    const next = { profile: clone(profile), baseRevision: revision, dirty: false }
    draftRef.current = next
    setDraft(next)
    setReport(next.profile.migrationReport ?? null)
    setSelectedEntry(profile.entries[0]?.id ?? null)
    setPendingSelection(null)
    setSource(null)
    setSourceBusy(false)
    setPreview(null)
    setPreviewBusy(false)
    setError('')
    setErrorDiagnostics([])
  }, [])

  const refreshState = useCallback(scope => {
    if (!active(scope)) return Promise.resolve(null)
    if (scope.refreshing) { scope.refreshAgain = true; return scope.refreshing }
    scope.refreshing = (async () => {
      do {
        scope.refreshAgain = false
        try {
          const next = await request(scope, signal => client.state(sessionId, signal))
          if (!active(scope)) break
          if (next.revision >= scope.minimumRevision && next.revision >= (stateRef.current?.revision ?? 0)) {
            stateRef.current = next
            setState(next)
            setTransportError('')
          }
        } catch (failure) {
          if (active(scope) && failure.name !== 'AbortError') setTransportError(failure.message || '预设库暂时无法读取。')
        }
      } while (active(scope) && scope.refreshAgain)
      return stateRef.current
    })().finally(() => { scope.refreshing = null })
    return scope.refreshing
  }, [client, sessionId])

  useEffect(() => {
    if (!visible) return
    const scope = { active: true, controllers: new Set(), minimumRevision: stateRef.current?.revision ?? 0, profileSequence: 0, sourceSequence: 0, previewSequence: 0, fileSequence: 0, refreshing: null, refreshAgain: false }
    lifecycle.current = scope
    if (!draftRef.current) initialProfileAttempted.current = false
    setBusy('')
    setPreviewBusy(false)
    setSourceBusy(false)
    void refreshState(scope)
    let dispose
    try {
      dispose = client.subscribe(sessionId, event => {
        if (!active(scope)) return
        if (event.type === 'stage') { setStage(event.label ?? event.stage ?? '正在生成适配草稿…'); return }
        if (event.type === 'changed' || event.type === 'connected') void refreshState(scope)
      }, () => { if (active(scope)) setTransportError('实时连接已断开，可手动刷新预设库。') })
    } catch (failure) { setTransportError(failure.message || '实时连接不可用，可手动刷新。') }
    return () => {
      scope.active = false
      for (const controller of scope.controllers) controller.abort()
      dispose?.()
    }
  }, [client, sessionId, visible, refreshState])

  const openProfile = useCallback(async (id, version) => {
    const scope = lifecycle.current
    if (!active(scope)) return
    const sequence = ++scope.profileSequence
    ++scope.sourceSequence
    ++scope.previewSequence
    setBusy('load')
    try {
      const result = await request(scope, signal => client.profile(id, version, signal))
      if (!active(scope) || sequence !== scope.profileSequence) return
      if (!result.profile) throw new Error('找不到该预设版本，请刷新预设库。')
      acceptDraft(result.profile, result.revision)
      setNotice('')
      setImportDiagnostics([])
    } catch (failure) {
      if (active(scope) && sequence === scope.profileSequence && failure.name !== 'AbortError') setError(failure.message)
    } finally { if (active(scope) && sequence === scope.profileSequence) setBusy('') }
  }, [acceptDraft, client])

  useEffect(() => {
    if (!visible || !state || draftRef.current || busy || !state.profiles.length || initialProfileAttempted.current) return
    initialProfileAttempted.current = true
    const first = state.profiles.find(item => item.id === state.binding?.profileId) ?? state.profiles[0]
    void openProfile(first.id, first.version)
  }, [state, busy, openProfile, visible])

  function editProfile(change) {
    const previous = draftRef.current
    if (!previous || busy) return
    const profile = change(previous.profile)
    if (profile.status === 'ready' && profile.entries.some(item => item.enabled && item.phase === 'unclassified')) profile.status = 'draft'
    const next = { ...previous, profile, dirty: true }
    draftRef.current = next
    setDraft(next)
    ++lifecycle.current.previewSequence
    setPreview(null)
    setPreviewBusy(false)
    setNotice('')
  }

  function editEntry(change) {
    editProfile(profile => ({ ...profile, entries: profile.entries.map(item => item.id === selectedEntry ? { ...item, ...change } : item) }))
  }

  function selectProfile(id, version) {
    if (busy) return
    if (draftRef.current?.dirty) { setPendingSelection({ id, version }); return }
    void openProfile(id, version)
  }

  async function perform(kind, work) {
    const scope = lifecycle.current
    if (!active(scope) || busy) return
    setBusy(kind)
    setError('')
    setErrorDiagnostics([])
    setConflictForm(null)
    setNotice('')
    try { await work(scope) }
    catch (failure) {
      if (active(scope) && failure.name !== 'AbortError') {
        setError(failure.message || '操作失败，草稿已保留。')
        setErrorDiagnostics(failure.diagnostics ?? [])
        if ((kind === 'create' || kind === 'import') && (failure.status === 409 || String(failure.code).toUpperCase().replaceAll('-', '_') === 'REVISION_CONFLICT')) setConflictForm(kind)
      }
    } finally { if (active(scope)) { setBusy(''); setStage('') } }
  }

  async function receiveVersion(scope, result) {
    if (!active(scope)) return false
    scope.minimumRevision = Math.max(scope.minimumRevision, result.revision)
    const saved = await request(scope, signal => client.profile(result.profileId, result.version, signal))
    if (!active(scope)) return false
    if (!saved.profile) throw new Error('版本已保存，但读取失败；请重新载入预设。')
    acceptDraft(saved.profile, saved.revision)
    if (!own(saved.profile, 'migrationReport') && result.report !== undefined) setReport(result.report)
    return true
  }

  function save() {
    const captured = draftRef.current
    if (!captured) return
    void perform('save', async scope => {
      const result = await request(scope, signal => client.save(captured.profile, captured.baseRevision, signal))
      if (!await receiveVersion(scope, result)) return
      setNotice(`已保存 v${result.version}。应用后才会更新当前故事的固定版本。`)
      await refreshState(scope)
    })
  }

  function create() {
    if (!newName.trim() || !stateRef.current) return
    void perform('create', async scope => {
      const result = await request(scope, signal => client.create(newName.trim(), createFormRevision.current ?? stateRef.current.revision, signal))
      if (!await receiveVersion(scope, result)) return
      setNewName('')
      createFormRevision.current = null
      setImportDiagnostics([])
      setNotice('已新建空白草稿，请添加自己的模块。')
      await refreshState(scope)
    })
  }

  function importPreset() {
    if (!importText.trim() || !stateRef.current) return
    void perform('import', async scope => {
      const options = { expectedRevision: importFormRevision.current ?? stateRef.current.revision, ...(importName.trim() ? { name: importName.trim() } : {}), ...(orderCharacterId.trim() ? { orderCharacterId: orderCharacterId.trim() } : {}) }
      const result = await request(scope, signal => client.import(importText, options, signal))
      if (!await receiveVersion(scope, result)) return
      setImportDiagnostics(result.diagnostics ?? [])
      importFormRevision.current = null
      setNotice('已导入为待分类草稿。请逐项选择阶段，并核对原有的默认启停。')
      await refreshState(scope)
    })
  }

  async function readFile(file) {
    const scope = lifecycle.current
    if (!file || !active(scope)) return
    captureForm('import')
    const sequence = ++scope.fileSequence
    try {
      const buffer = await new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result)
        reader.onerror = () => reject(new Error('无法读取 JSON 文件，请重试。'))
        reader.readAsArrayBuffer(file)
      })
      if (active(scope) && sequence === scope.fileSequence) setImportText(new TextDecoder('utf-8', { ignoreBOM: true }).decode(buffer))
    } catch (failure) { if (active(scope)) setError(failure.message) }
  }

  function captureForm(kind) {
    const revision = kind === 'import' ? importFormRevision : createFormRevision
    if (revision.current === null) revision.current = stateRef.current?.revision ?? null
  }

  function editImportText(value) {
    if (active(lifecycle.current)) ++lifecycle.current.fileSequence
    captureForm('import')
    setImportText(value)
  }

  function resetForm(kind) {
    void perform('reset', async scope => {
      if (kind === 'import') ++scope.fileSequence
      await refreshState(scope)
      if (!active(scope)) return
      if (kind === 'import') {
        setImportText(''); setImportName(''); setOrderCharacterId('')
        importFormRevision.current = null
      } else { setNewName(''); createFormRevision.current = null }
      setNotice(`${kind === 'import' ? '导入' : '新建'}表单已重新载入。`)
    })
  }

  async function viewSource() {
    const sourceId = draftRef.current?.profile.sourceId
    const scope = lifecycle.current
    if (!sourceId || !active(scope)) return
    const sequence = ++scope.sourceSequence
    setSourceBusy(true)
    try {
      const result = await request(scope, signal => client.source(sourceId, signal))
      if (active(scope) && sequence === scope.sourceSequence && draftRef.current?.profile.sourceId === sourceId) {
        if (!result.source) throw new Error('找不到导入原件。')
        setSource(result.source)
      }
    } catch (failure) { if (active(scope) && sequence === scope.sourceSequence && failure.name !== 'AbortError') setError(failure.message) }
    finally { if (active(scope) && sequence === scope.sourceSequence) setSourceBusy(false) }
  }

  function bind() {
    const captured = draftRef.current
    if (!captured || captured.dirty || captured.profile.status !== 'ready' || !sessionId) return
    void perform('bind', async scope => {
      const result = await request(scope, signal => client.bind(sessionId, { profileId: captured.profile.id, version: captured.profile.version, expectedRevision: captured.baseRevision }, signal))
      if (!active(scope)) return
      scope.minimumRevision = Math.max(scope.minimumRevision, result.revision)
      // The binding itself changes the store revision; its successful response is a new owner baseline.
      const next = { ...captured, baseRevision: result.revision }
      draftRef.current = next
      setDraft(next)
      setNotice(`当前故事已固定到 v${captured.profile.version}。`)
      await refreshState(scope)
    })
  }

  function migrate() {
    const captured = draftRef.current
    if (!captured || captured.dirty || !state?.capabilities?.migrate) return
    void perform('migrate', async scope => {
      const result = await request(scope, signal => client.migrate(sessionId, { profileId: captured.profile.id, version: captured.profile.version, expectedRevision: captured.baseRevision }, signal))
      if (!await receiveVersion(scope, result)) return
      setNotice('适配草稿已生成，请核对模块阶段、权限与诊断。')
      await refreshState(scope)
    })
  }

  async function compilePreview() {
    const scope = lifecycle.current
    const captured = draftRef.current
    if (!active(scope) || !captured) return
    const sequence = ++scope.previewSequence
    let variables
    try {
      variables = JSON.parse(previewVariables)
      if (variables === null || typeof variables !== 'object' || Array.isArray(variables)) throw new Error()
    } catch { setError('预览变量必须是 JSON 对象。'); return }
    setPreviewBusy(true)
    try {
      const result = await request(scope, signal => client.preview(captured.profile, { sessionId, phase: previewPhase, variables }, signal))
      if (active(scope) && sequence === scope.previewSequence && draftRef.current === captured) setPreview(result)
    } catch (failure) { if (active(scope) && sequence === scope.previewSequence && failure.name !== 'AbortError') setError(failure.message) }
    finally { if (active(scope) && sequence === scope.previewSequence) setPreviewBusy(false) }
  }

  const profile = draft?.profile
  const selected = profile?.entries.find(item => item.id === selectedEntry)
  const binding = state?.binding
  const matchesBinding = profile && binding && profile.id === binding.profileId && profile.version === binding.version
  const unclassified = profile?.entries.filter(item => item.enabled && item.phase === 'unclassified').length ?? 0
  const disabled = Boolean(busy)

  return <>
    <header className="rpls-heading"><div><div className="rpls-brand"><Quill size={15} /> RP LAST STEP</div><h1>角色扮演预设</h1><p>导入原件，编排模块，固定故事使用的版本。</p></div><button className="rpls-icon-button" type="button" aria-label="刷新预设库" title="刷新预设库" disabled={disabled} onClick={() => { initialProfileAttempted.current = false; void refreshState(lifecycle.current) }}>↻</button></header>
    {(error || transportError) && <div className="rpls-error" role="alert"><p>{error || transportError}</p>{error && draft?.dirty && <p className="rpls-help">本地修改已保留；重新载入预设会放弃当前草稿。</p>}<Diagnostics items={errorDiagnostics} />{conflictForm && <><p className="rpls-help">表单内容已保留。重新载入会清空此表单，并读取最新预设库。</p><button type="button" className="rpls-text-button" disabled={disabled} onClick={() => resetForm(conflictForm)}>{conflictForm === 'import' ? '重新载入导入表单' : '重新载入新建表单'}</button></>}</div>}
    {notice && <div className="rpls-notice" role="status">{notice}</div>}
    {!state ? <div className="rpls-loading" role="status">正在读取预设库…</div> : <div className="rpls-scroll"><div className="rpls-library-layout">
      <aside className="rpls-library" aria-label="预设库">
        <div className="rpls-section-title"><h2><Book size={15} /> 预设库</h2><span>{state.profiles.length}</span></div>
        {state.profiles.length ? <div className="rpls-profiles">{state.profiles.map(item => <button type="button" key={item.id} className="rpls-profile-choice" disabled={disabled} aria-label={`${item.name} · v${item.version}`} aria-pressed={profile?.id === item.id && profile.version === item.version} onClick={() => selectProfile(item.id, item.version)}><strong>{item.name}</strong><span>v{item.version} · {item.status === 'ready' ? '可用' : '草稿'} · {item.entryCount} 个模块</span></button>)}</div> : <div className="rpls-empty"><Book size={28} /><h3>预设库还是空的</h3><p>从 SillyTavern 导入，或新建自己的空白预设。</p></div>}
        <details className="rpls-create-panel" open={state.profiles.length === 0 || undefined}><summary>新建与导入</summary><div className="rpls-create-body">
          <label className="rpls-field"><span>新预设名称</span><input value={newName} disabled={disabled} onChange={event => { captureForm('create'); setNewName(event.target.value) }} placeholder="给这套预设取个名字" /></label>
          <button type="button" className="rpls-secondary" disabled={disabled || !newName.trim() || draft?.dirty} onClick={create}>新建空白预设</button>
          <div className="rpls-divider" />
          <label className="rpls-field"><span>选择 JSON 文件</span><input type="file" accept=".json,application/json" disabled={disabled} onChange={event => void readFile(event.target.files?.[0])} /></label>
          <label className="rpls-field"><span>SillyTavern JSON</span><textarea rows={7} spellCheck={false} value={importText} disabled={disabled} placeholder="在这里粘贴完整预设 JSON" onChange={event => editImportText(event.target.value)} onPaste={event => { const pasted = event.clipboardData?.getData('text/plain'); if (pasted === undefined) return; event.preventDefault(); const target = event.currentTarget; editImportText(target.value.slice(0, target.selectionStart) + pasted + target.value.slice(target.selectionEnd)) }} /></label>
          <label className="rpls-field"><span>导入名称（可选）</span><input value={importName} disabled={disabled} onChange={event => { captureForm('import'); setImportName(event.target.value) }} /></label>
          <label className="rpls-field"><span>排序角色 ID（可选）</span><input value={orderCharacterId} disabled={disabled} onChange={event => { captureForm('import'); setOrderCharacterId(event.target.value) }} placeholder="使用原件的默认 prompt_order" /></label>
          <button type="button" className="rpls-secondary" disabled={disabled || !importText.trim() || draft?.dirty} onClick={importPreset}>{busy === 'import' ? '正在导入…' : '导入为草稿'}</button>
          <p className="rpls-help">原件完整保留。导入条目先进入待分类草稿，未知扩展不会执行。</p>{draft?.dirty && <p className="rpls-help">先保存或重新载入当前草稿，再新建或导入。</p>}
        </div></details>
      </aside>
      <main className="rpls-editor">
        <section className="rpls-binding" aria-label="当前故事预设"><div><small>当前故事固定版本</small><strong aria-label="当前故事固定版本">{binding ? `${binding.profile?.name ?? binding.profileId} · v${binding.version}` : '尚未应用预设'}</strong><p className="rpls-help">保存预设不会自动改变故事；应用时固定到指定版本。</p></div>{binding && <button type="button" className="rpls-text-button" disabled={disabled} onClick={() => selectProfile(binding.profileId, binding.version)}>查看故事固定版本</button>}</section>
        <OverlayView binding={binding} />
        {pendingSelection && <div className="rpls-switch-notice" role="status"><p>当前草稿有未保存修改。放弃后才能切换预设。</p><div className="rpls-actions"><button type="button" className="rpls-secondary" disabled={disabled} onClick={() => { const target = pendingSelection; setPendingSelection(null); void openProfile(target.id, target.version) }}>放弃草稿并切换</button><button type="button" className="rpls-text-button" disabled={disabled} onClick={() => setPendingSelection(null)}>继续编辑</button></div></div>}
        {!profile ? <div className="rpls-editor-empty"><Quill size={30} /><h2>{busy === 'load' ? '正在读取预设…' : '从你的第一套预设开始'}</h2><p>预设库只包含你创建或导入的内容。</p></div> : <>
          <div className="rpls-profile-heading"><div className="rpls-section-title"><h2>预设编辑</h2><div className="rpls-badges"><span className="rpls-badge">v{profile.version}</span><span className={`rpls-badge${draft.dirty ? ' rpls-badge-accent' : ''}`}>{draft.dirty ? '未保存修改' : '已保存版本'}</span></div></div><div className="rpls-profile-fields"><label className="rpls-field"><span>预设名称</span><input value={profile.name} disabled={disabled} onChange={event => editProfile(value => ({ ...value, name: event.target.value }))} /></label><label className="rpls-field"><span>预设状态</span><select value={profile.status} disabled={disabled} onChange={event => { if (event.target.value === 'ready' && unclassified) { setError('请先为所有启用模块选择阶段。'); return } editProfile(value => ({ ...value, status: event.target.value })) }}><option value="draft">草稿 · 待核对</option><option value="ready" disabled={unclassified > 0}>可用 · 已核对阶段</option></select></label></div><p className="rpls-help">{unclassified > 0 ? `${unclassified} 个启用模块待分类；完成阶段分配后，再显式设为可用。` : 'Agent 处理剧情事实，呈现阶段生成最终正文；共用模块同时进入两个阶段。'}</p>{state.revision > draft.baseRevision && <p className="rpls-update-hint">预设库有新变更。当前草稿仍基于修订 {draft.baseRevision}；可重新载入后编辑。</p>}</div>
          <Diagnostics items={importDiagnostics} />
          <div className="rpls-modules-layout">
            <section className="rpls-modules"><div className="rpls-section-title"><h3>模块</h3><button type="button" className="rpls-text-button" disabled={disabled} onClick={() => { const id = `user-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${++newEntryCounter.current}`}`; const nextOrder = Math.max(-1, ...profile.entries.map(item => item.order)) + 1; editProfile(value => ({ ...value, entries: [...value.entries, { id, name: '新模块', content: '', role: 'system', order: nextOrder, enabled: true, phase: 'unclassified', required: false, locked: false }] })); setSelectedEntry(id) }}>添加模块</button></div>
              <div className="rpls-module-list" aria-label="模块列表">{[...profile.entries].sort((a, b) => a.order - b.order).map(item => { const patch = matchesBinding ? binding.overlay?.entries?.[item.id] : null; return <button type="button" key={item.id} className="rpls-module-choice" disabled={disabled} aria-pressed={selectedEntry === item.id} onClick={() => setSelectedEntry(item.id)}><div><strong>{item.name}</strong><span className={`rpls-enabled-dot${item.enabled ? ' is-enabled' : ''}`} title={item.enabled ? '启用' : '关闭'} /></div><small>{phaseNames[item.phase]} · {item.role} · #{item.order}</small><div className="rpls-badges">{item.required && <span className="rpls-badge">必用</span>}{item.locked && <span className="rpls-badge">Agent 只读</span>}{patch && own(patch, 'content') && <span className="rpls-badge rpls-badge-accent">Agent 已修改</span>}{patch?.enabled === false && <span className="rpls-badge">Agent 已停用</span>}{patch && Object.keys(patch.fills ?? {}).length > 0 && <span className="rpls-badge">Agent 已填充</span>}</div></button> })}{!profile.entries.length && <p className="rpls-help">还没有模块</p>}</div>
            </section>
            <section className="rpls-module-editor" aria-label="模块编辑">{selected ? <>
              <div className="rpls-section-title"><h3>模块设置</h3><button type="button" className="rpls-text-button rpls-danger" disabled={disabled} onClick={() => { editProfile(value => ({ ...value, entries: value.entries.filter(item => item.id !== selected.id) })); setSelectedEntry(profile.entries.find(item => item.id !== selected.id)?.id ?? null) }}>删除模块</button></div>
              <label className="rpls-field"><span>模块名称</span><input value={selected.name} disabled={disabled} onChange={event => editEntry({ name: event.target.value })} /></label>
              <div className="rpls-policy"><label><input type="checkbox" checked={selected.enabled} disabled={disabled || selected.required} onChange={event => editEntry({ enabled: event.target.checked })} /><span>启用模块</span></label><label><input type="checkbox" checked={selected.required} disabled={disabled} onChange={event => editEntry({ required: event.target.checked, ...(event.target.checked ? { enabled: true } : {}) })} /><span>必用</span></label><label><input type="checkbox" checked={selected.locked} disabled={disabled} onChange={event => editEntry({ locked: event.target.checked })} /><span>Agent 只读</span></label></div>
              <p className="rpls-help">“必用”阻止 Agent 停用；“Agent 只读”保护正文、开关和填充。你仍可编辑所有模块。</p>
              <div className="rpls-entry-fields"><label className="rpls-field"><span>模块阶段</span><select value={selected.phase} disabled={disabled} onChange={event => editEntry({ phase: event.target.value })}>{Object.entries(phaseNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className="rpls-field"><span>模块角色</span><select value={selected.role} disabled={disabled} onChange={event => editEntry({ role: event.target.value })}><option value="system">system</option><option value="user">user</option><option value="assistant">assistant</option></select></label><label className="rpls-field"><span>模块排序</span><input type="number" step="any" value={selected.order} disabled={disabled} onChange={event => editEntry({ order: Number(event.target.value) })} /></label></div>
              {selected.marker && <p className="rpls-update-hint">这是导入的 ST 标记模块。请通过编译诊断核对映射，未映射的标记会阻塞生产编译。</p>}
              <label className="rpls-field rpls-content-field"><span>模块正文</span><textarea rows={13} spellCheck={false} value={selected.content} disabled={disabled} onChange={event => editEntry({ content: event.target.value })} /></label><p className="rpls-entry-id">模块 ID · {selected.id}{selected.source?.entryId ? ` · 来源 ${selected.source.entryId}` : ''}</p>
            </> : <div className="rpls-empty-module"><p>添加模块后，在这里编辑正文与权限。</p></div>}</section>
          </div>
          <div className="rpls-save-bar"><div className="rpls-actions"><button type="button" className="rpls-primary" disabled={disabled || !draft.dirty || !profile.name.trim()} onClick={save}>{busy === 'save' ? '正在保存…' : '保存新版本'}</button><button type="button" className="rpls-secondary" disabled={disabled} onClick={() => void openProfile(profile.id, undefined)}>重新载入预设</button></div><button type="button" className="rpls-secondary" disabled={disabled || draft.dirty || profile.status !== 'ready' || !sessionId} onClick={bind}>{busy === 'bind' ? '正在应用…' : '应用到当前故事'}</button><p className="rpls-help">{draft.dirty ? '重新载入会放弃未保存修改。应用与适配需要先保存当前草稿。' : `当前编辑 ${profile.id} · v${profile.version}，基于修订 ${draft.baseRevision}。`}</p></div>
          {state.capabilities?.migrate && <div className="rpls-adaptation"><div><h3>Agent 适配草稿</h3><p className="rpls-help">按已配置的迁移能力生成派生版本，完成后核对阶段、宏与用户权限。</p></div><button type="button" className="rpls-secondary" disabled={disabled || draft.dirty} onClick={migrate}>{busy === 'migrate' ? (stage || '正在生成适配草稿…') : '生成 Agent 适配草稿'}</button></div>}
          {report && <details className="rpls-details" open><summary>适配说明</summary><pre>{typeof report === 'string' ? report : JSON.stringify(report, null, 2)}</pre></details>}
          {profile.sourceId && <section className="rpls-source"><div className="rpls-section-title"><h3>导入原件</h3><button type="button" className="rpls-text-button" disabled={sourceBusy || disabled} onClick={() => void viewSource()}>{sourceBusy ? '正在读取原件…' : '查看只读原件'}</button></div><p className="rpls-help">所有编辑进入派生版本，原始 JSON 供回溯。</p>{source && <><label className="rpls-field"><span>原始预设 JSON（只读）</span><textarea rows={12} value={source.rawText} readOnly spellCheck={false} /></label><small className="rpls-hash">SHA-256 · {source.sha256}</small></>}</section>}
          <section className="rpls-preview" aria-label="编译预览"><div className="rpls-section-title"><h3>编译预览</h3><span>{draft.dirty ? '使用本地未保存草稿' : `使用已保存 v${profile.version}`}</span></div><div className="rpls-preview-options"><label className="rpls-field"><span>预览阶段</span><select value={previewPhase} disabled={disabled} onChange={event => { setPreviewPhase(event.target.value); setPreview(null); ++lifecycle.current.previewSequence; setPreviewBusy(false) }}><option value="render">呈现 · 最终正文</option><option value="agent">Agent · 剧情处理</option></select></label><label className="rpls-field"><span>预览变量 JSON</span><textarea rows={2} spellCheck={false} value={previewVariables} disabled={disabled} onChange={event => { setPreviewVariables(event.target.value); setPreview(null); ++lifecycle.current.previewSequence; setPreviewBusy(false) }} /></label><button type="button" className="rpls-secondary" disabled={disabled || previewBusy} onClick={() => void compilePreview()}>{previewBusy ? '正在编译…' : '编译预览'}</button></div><p className="rpls-help">预览检查模块编排与占位符，不执行导入脚本，不改变当前故事。</p>{preview && <div className="rpls-preview-result"><strong className={preview.blocked ? 'rpls-danger' : ''}>{preview.blocked ? '编译被阻塞' : '编译完成'}</strong><Diagnostics items={preview.diagnostics} /><p className="rpls-help">{preview.entries?.length ?? 0} 个模块 · {preview.messages?.length ?? 0} 条消息</p><pre aria-label="编译结果正文">{preview.text || '（无可用正文）'}</pre>{preview.hash && <small className="rpls-hash">Hash · {preview.hash}</small>}</div>}</section>
        </>}
      </main>
    </div></div>}
  </>
}
