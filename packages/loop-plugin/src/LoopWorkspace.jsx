import React, { useEffect, useId, useRef, useState } from 'react'
import { createLoopApi } from './api.js'

const api = createLoopApi()
const emptyPolicy = () => ({ enabled: false, routes: {} })
const copyPolicy = policy => ({ enabled: policy?.enabled === true, routes: Object.fromEntries(Object.entries(policy?.routes || {}).map(([id, route]) => [id, { ...route }])) })
const layerPolicy = (detail, scope) => copyPolicy(detail.policies?.[scope] ?? (scope === 'session' ? { enabled: detail.effectivePolicy?.enabled === true, routes: {} } : emptyPolicy()))
const routeName = route => route?.provider && route?.model ? `${route.provider} / ${route.model}` : '继承宿主选择'
const kindName = { model: '模型', tool: '工具', program: '程序' }
const statusName = { running: '执行中', started: '已开始', complete: '完成', completed: '完成', success: '成功', failed: '失败', error: '失败', cancelled: '已取消', pending: '等待中' }
const effortOptions = model => Array.isArray(model?.reasoning?.efforts) ? model.reasoning.efforts : []

export function LoopIcon({ size = 18 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="8" y="2" width="8" height="5" rx="1.7" /><rect x="8" y="17" width="8" height="5" rx="1.7" /><path d="M12 7v10m4-13h2a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3h-2M8 20H6a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3h2m-2-2 2 2-2 2m12 12-2 2 2 2" /></svg>
}

export function HeaderEntry({ openLoop }) {
  return <button className="dsh-loop-entry" type="button" aria-label="打开 Loop Studio" title="打开 Loop Studio" onClick={openLoop}><LoopIcon /><span>Loop</span></button>
}

function NodeIcon({ kind }) {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{kind === 'model' ? <><rect x="5" y="5" width="14" height="14" rx="4" /><path d="M9 1v4m6-4v4M9 19v4m6-4v4M1 9h4m-4 6h4m14-6h4m-4 6h4M9 10h6m-6 4h4" /></> : kind === 'tool' ? <path d="m14 6 4 4m-10 3-5 5a2.1 2.1 0 0 0 3 3l5-5m-2-5a6 6 0 0 1 8-8l-4 4 4 4 4-4a6 6 0 0 1-8 8Z" /> : <><rect x="3" y="5" width="18" height="14" rx="3" /><path d="m7 9 3 3-3 3m6 0h4" /></>}</svg>
}

function LoopGraph({ graph, selectedId, onSelect, trace, routingCapability, graphRef }) {
  const markerId = `loop-arrow-${useId().replace(/:/g, '')}`
  const nodes = graph.nodes || []
  const positions = new Map(nodes.map((node, index) => [node.id, { index, y: 70 + index * 106 }]))
  const height = Math.max(160, nodes.length * 106 + 36)
  const latestNode = trace[trace.length - 1]?.nodeId
  return <section ref={graphRef} className="loop-graph" aria-label="执行流程">
    <div className="loop-section-heading"><h2>执行流程</h2><span>{nodes.length} 个节点</span></div>
    <div className="loop-graph-legend"><span><i className="loop-dot loop-dot-model" />模型节点</span><span><i className="loop-dot" />程序 / 工具</span><span><i className="loop-dot loop-dot-observed" />最近观测</span></div>
    <div className="loop-graph-map" style={{ height }}>
      <svg className="loop-edges" viewBox={`0 0 360 ${height}`} preserveAspectRatio="none" role="img" aria-label="当前预设的执行连线">
        <defs><marker id={markerId} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="m1 1 5 3-5 3" fill="none" stroke="currentColor" strokeWidth="1.4" /></marker></defs>
        {(graph.edges || []).map((edge, index) => {
          const from = positions.get(edge.from)
          const to = positions.get(edge.to)
          if (!from || !to) return null
          const straight = to.index === from.index + 1
          const backward = to.index <= from.index
          const lane = backward ? 22 + index % 2 * 8 : 338 - index % 2 * 8
          const x = backward ? 72 : 288
          const path = straight ? `M180 ${from.y + 36} V${to.y - 40}` : `M${x} ${from.y} H${lane} V${to.y} H${x + (backward ? -3 : 3)}`
          const textX = backward ? lane - 8 : lane + 12
          const textY = (from.y + to.y) / 2
          return <g key={edge.id}><path d={path} markerEnd={`url(#${markerId})`} /><title>{nodes.find(node => node.id === edge.from)?.label} → {nodes.find(node => node.id === edge.to)?.label}{edge.label ? ` · ${edge.label}` : ''}</title>{edge.label && (straight ? <text x="192" y={textY + 3}>{edge.label}</text> : <text x={textX} y={textY} textAnchor="middle" transform={`rotate(-90 ${textX} ${textY})`}>{edge.label}</text>)}</g>
        })}
      </svg>
      {nodes.map((node, index) => <button type="button" key={node.id} data-loop-node={node.id} aria-label={node.label} aria-pressed={selectedId === node.id} className={`loop-node loop-node-${node.kind}${latestNode === node.id ? ' is-observed' : ''}`} style={{ top: index * 106 + 34 }} onClick={() => onSelect(node.id)}><span className="loop-node-icon"><NodeIcon kind={node.kind} /></span><span className="loop-node-text"><strong>{node.label}</strong><small>{kindName[node.kind] || node.kind} · {node.control === 'route' && routingCapability === 'supported' ? '可配置' : '仅观察'}</small></span>{latestNode === node.id && <i className="loop-observed-mark" title="最近观测" />}</button>)}
    </div>
    {!nodes.length && <p className="loop-note">此预设尚未声明可展示的节点。</p>}
    <p className="loop-graph-caption">连线来自已识别的执行流程。选择节点查看配置与实际请求。</p>
  </section>
}

function formatTime(timestamp) {
  if (timestamp === undefined || timestamp === null) return ''
  const date = new Date(timestamp)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function tokensLabel(tokens) {
  if (typeof tokens === 'number') return `${tokens} tokens`
  if (!tokens || typeof tokens !== 'object') return '用量未报告'
  const input = tokens.input ?? tokens.inputTokens ?? tokens.promptTokens
  const output = tokens.output ?? tokens.outputTokens ?? tokens.completionTokens
  const total = tokens.total ?? tokens.totalTokens
  const parts = [typeof input === 'number' && `输入 ${input}`, typeof output === 'number' && `输出 ${output}`].filter(Boolean)
  return parts.join(' · ') || (typeof total === 'number' ? `合计 ${total} tokens` : '用量未报告')
}

function Activity({ trace, graph }) {
  return <section className="loop-activity" aria-label="实际执行记录"><div className="loop-section-heading"><h2>实际执行记录</h2><span>仅含观测元数据</span></div>{trace.length ? <ol className="loop-trace">{trace.slice(-40).reverse().map((item, index) => {
    const node = graph.nodes?.find(candidate => candidate.id === item.nodeId)
    const duration = item.durationMs ?? item.elapsedMs
    return <li key={item.id ?? index}><span className={`loop-trace-dot ${item.status === 'error' || item.status === 'failed' ? 'is-error' : ''}`} /><div className="loop-trace-body"><div className="loop-trace-title"><strong>{item.toolName || node?.label || item.type}</strong><span>{statusName[item.status] || item.status || item.type}</span></div><p>{[item.step !== undefined ? `步骤 ${item.step}` : null, item.provider && item.model ? `${item.provider} / ${item.model}` : item.model, formatTime(item.timestamp)].filter(Boolean).join(' · ')}</p><small>{tokensLabel(item.tokens)}{typeof duration === 'number' ? ` · ${duration} ms` : ''}</small></div></li>
  })}</ol> : <div className="loop-empty-activity"><LoopIcon size={24} /><p>尚无实际执行记录</p><small>在当前会话发起请求后，这里会显示模型、工具和已报告用量。</small></div>}</section>
}

function Composition({ detail, presetName }) {
  return <details className="loop-composition"><summary><span>预设组成</span><span>{presetName} · {detail.composition?.length || 0} 项</span></summary><div className="loop-composition-body">{detail.composition?.length ? detail.composition.map((item, index) => <div className="loop-composition-row" key={item.entryId ?? index}><div><strong>{item.moduleName || item.entryId}</strong>{item.condition && <small>{typeof item.condition === 'string' ? item.condition : '包含启用条件'}</small>}</div><span>{item.enabled === 'conditional' ? '条件启用' : item.enabled ? '已启用' : '已停用'}{item.fiberState ? ` · ${item.fiberState}` : ''}</span></div>) : <p className="loop-note">宿主未提供组成信息。</p>}<p className="loop-note">预设声明与实际执行分别展示；条件项以本轮运行结果为准。</p></div></details>
}

function NodeInspector({ detail, node, draft, scope, onScope, onDraft, busy, dirty, blocked, draftWarning, onReloadDraft, onSave, onReset, inspectorRef, onReturn }) {
  if (!node) return <aside ref={inspectorRef} className="loop-inspector"><p className="loop-note">选择一个节点查看详情。</p></aside>
  const canRoute = detail.routingCapability === 'supported' && node.kind === 'model' && node.control === 'route'
  const observed = [...(detail.trace || [])].reverse().find(item => item.nodeId === node.id && item.model)
  const actualPolicy = detail.effectivePolicy
  const configured = actualPolicy?.enabled ? actualPolicy.routes?.[node.id] : null
  const route = draft?.routes?.[node.id]
  const providers = [...new Set((detail.models || []).map(model => model.provider))]
  const models = (detail.models || []).filter(model => model.provider === route?.provider)
  const selectedModel = models.find(model => model.id === route?.model)
  const efforts = effortOptions(selectedModel)
  const source = detail.policies?.session?.routes?.[node.id] ? '会话配置' : detail.policies?.preset?.routes?.[node.id] ? '预设默认' : '宿主选择'
  const inherited = scope === 'session' && detail.policies?.preset?.enabled ? detail.policies.preset.routes?.[node.id] : null
  const inheritLabel = inherited ? `继承预设默认 · ${routeName(inherited)}` : '继承宿主选择'
  const editingDisabled = busy || blocked
  const changeRoute = next => {
    const routes = { ...draft.routes }
    if (next) routes[node.id] = next
    else delete routes[node.id]
    onDraft({ ...draft, routes })
  }
  return <aside ref={inspectorRef} className="loop-inspector" aria-label="节点详情">
    <button type="button" className="loop-return" onClick={onReturn}>← 返回执行流程</button>
    <div className="loop-inspector-heading"><span className={`loop-kind loop-kind-${node.kind}`}>{kindName[node.kind] || node.kind}</span><span className="loop-source">来源 · {node.source}</span></div>
    <h2>{node.label}</h2>{node.description && <p className="loop-node-description">{node.description}</p>}
    {node.kind === 'model' && <div className="loop-route-comparison"><div aria-label="当前配置"><span>当前配置 <small>{actualPolicy?.enabled ? source : '接管已关闭'}</small></span><strong>{routeName(configured)}</strong></div><div aria-label="最近实际请求"><span>最近实际请求</span><strong>{observed ? routeName(observed) : '尚未观测到请求'}</strong></div></div>}
    {draftWarning && <div className="loop-diagnostics"><p>{draftWarning}</p><div className="loop-form-actions"><button type="button" className="loop-secondary" disabled={busy} onClick={onReloadDraft}>重新载入配置</button></div></div>}
    {canRoute && draft ? <form onSubmit={onSave} className="loop-route-form">
      <div className="loop-form-heading"><h3>模型配置</h3>{dirty && <span>未保存</span>}</div>
      <label className="loop-enable"><span><strong>启用模型接管</strong><small>关闭后使用宿主原选择</small></span><input type="checkbox" aria-label="启用模型接管" checked={draft.enabled} disabled={editingDisabled} onChange={event => onDraft({ ...draft, enabled: event.target.checked })} /></label>
      <label className="loop-field"><span>提供方</span><select aria-label="提供方" value={route?.provider || ''} disabled={editingDisabled} onChange={event => {
        const provider = event.target.value
        if (!provider) { changeRoute(null); return }
        const first = detail.models.find(model => model.provider === provider)
        changeRoute({ provider, model: first?.id || '', ...(route?.maxTokens ? { maxTokens: route.maxTokens } : {}) })
      }}><option value="">{inheritLabel}</option>{route?.provider && !providers.includes(route.provider) && <option value={route.provider}>{route.provider}（当前配置）</option>}{providers.map(provider => <option value={provider} key={provider}>{provider}</option>)}</select></label>
      <label className="loop-field"><span>模型</span><select aria-label="模型" value={route?.model || ''} disabled={editingDisabled || !route?.provider} onChange={event => { const next = { ...route, model: event.target.value }; delete next.reasoningEffort; changeRoute(next) }}><option value="" disabled>{inheritLabel}</option>{route?.model && !models.some(model => model.id === route.model) && <option value={route.model}>{route.model}（当前配置）</option>}{models.map(model => <option value={model.id} key={model.id}>{model.name || model.id}</option>)}</select></label>
      {efforts.length > 0 && <label className="loop-field"><span>推理强度</span><select aria-label="推理强度" value={route?.reasoningEffort || ''} disabled={editingDisabled} onChange={event => { const next = { ...route }; if (event.target.value) next.reasoningEffort = event.target.value; else delete next.reasoningEffort; changeRoute(next) }}><option value="">模型默认</option>{efforts.map(effort => <option key={effort.id} value={effort.id}>{effort.name || effort.id}</option>)}</select></label>}
      <label className="loop-field"><span>输出 token 上限 <small>可选</small></span><input type="number" aria-label="输出 token 上限" min="1" step="1" placeholder="使用宿主默认" disabled={editingDisabled || !route?.provider} value={route?.maxTokens ?? ''} onChange={event => changeRoute({ ...route, maxTokens: event.target.value })} /></label>
      <div className="loop-save-options"><label className="loop-field"><span>配置范围</span><select aria-label="保存范围" value={scope} disabled={busy} onChange={event => onScope(event.target.value)}><option value="session">当前会话</option><option value="preset" disabled={!detail.selectedPresetId}>此预设的默认配置</option></select></label><p>{scope === 'session' ? '会话配置优先于预设默认。恢复继承后使用预设默认或宿主选择。' : '应用于使用此预设且未覆盖配置的会话。当前会话的覆盖仍然优先。'}切换范围会显示该层配置。</p></div>
      <div className="loop-form-actions"><button className="loop-secondary" type="button" disabled={editingDisabled || !dirty && !detail.policies?.[scope]} onClick={onReset}>恢复继承</button><button className="loop-primary" type="submit" disabled={editingDisabled}>{busy ? '正在保存…' : '保存配置'}</button></div>
      <p className="loop-boundary">配置在下次请求装配时生效。</p>
    </form> : <div className="loop-observe-note"><span className="loop-observe-icon"><NodeIcon kind={node.kind} /></span><h3>此节点仅供观察</h3><p>{detail.routingCapability === 'unknown-driver' ? '当前驱动尚未提供可接管的模型选择能力。组成与实际记录仍可查看。' : node.kind === 'model' ? '此模型调用由其来源管理，未开放路由配置。' : '程序与工具节点按预设执行。实际活动会显示在执行记录中。'}</p></div>}
  </aside>
}

function serializablePolicy(draft) {
  const routes = {}
  for (const [id, route] of Object.entries(draft.routes || {})) {
    if (!route.provider || !route.model) continue
    const result = { provider: route.provider, model: route.model }
    if (route.reasoningEffort) result.reasoningEffort = route.reasoningEffort
    if (route.maxTokens !== '' && route.maxTokens !== undefined && route.maxTokens !== null) {
      const maxTokens = Number(route.maxTokens)
      if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) throw new Error('输出 token 上限须为正整数。')
      result.maxTokens = maxTokens
    }
    routes[id] = result
  }
  return { enabled: draft.enabled === true, routes }
}

export function LoopWorkspace({ sessionId, visible = true, client = api }) {
  const [detail, setDetail] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [connected, setConnected] = useState(false)
  const [busy, setBusy] = useState(false)
  const [scope, setScope] = useState('session')
  const [selectedId, setSelectedId] = useState('host.first')
  const [draft, setDraft] = useState(null)
  const [dirty, setDirty] = useState(false)
  const dirtyRef = useRef(false)
  const draftBase = useRef(null)
  const writeError = useRef(false)
  const scopeRef = useRef('session')
  const lifecycle = useRef(null)
  const refresh = useRef(() => {})
  const busyRef = useRef(false)
  const workspaceRef = useRef(null)
  const graphRef = useRef(null)
  const inspectorRef = useRef(null)

  useEffect(() => {
    if (!visible || !sessionId) { setLoading(false); return }
    const controller = new AbortController()
    const context = { controller, minRevision: 0 }
    lifecycle.current = context
    let close = () => {}
    let readPromise = null
    let pending = false
    let subscribed = false
    dirtyRef.current = false
    draftBase.current = null
    writeError.current = false
    scopeRef.current = 'session'
    busyRef.current = false
    setDetail(null); setDraft(null); setLoading(true); setConnected(false); setError(''); setNotice(''); setBusy(false); setDirty(false); setScope('session'); setSelectedId('host.first')

    const load = () => {
      if (controller.signal.aborted) return Promise.resolve()
      pending = true
      if (readPromise) return readPromise
      readPromise = (async () => {
        do {
          pending = false
          try {
            const next = await client.inspect(sessionId, controller.signal)
            if (controller.signal.aborted) return
            if (next.revision >= context.minRevision) {
              context.minRevision = next.revision
              setDetail(next)
              setSelectedId(previous => next.graph.nodes.some(node => node.id === previous) ? previous : next.graph.nodes[0]?.id)
              if (!dirtyRef.current) {
                draftBase.current = { revision: next.revision, presetId: next.selectedPresetId }
                setDraft(layerPolicy(next, scopeRef.current))
              }
              if (!writeError.current) setError('')
            }
            setLoading(false)
            if (!subscribed) {
              subscribed = true
              close = client.subscribe(sessionId, event => {
                if (controller.signal.aborted || event.sessionId && event.sessionId !== sessionId) return
                if (event.type === 'connected') setConnected(true)
                if (event.type === 'connected' || event.type === 'changed') void load()
              }, () => { if (!controller.signal.aborted) setConnected(false) })
            }
          } catch (cause) {
            if (!controller.signal.aborted) { setError(cause.message || '无法读取 Loop Studio。'); setLoading(false) }
          }
        } while (pending && !controller.signal.aborted)
      })().finally(() => { readPromise = null })
      return readPromise
    }
    refresh.current = load
    void load()
    return () => {
      controller.abort()
      close()
      if (lifecycle.current === context) { lifecycle.current = null; refresh.current = () => {} }
    }
  }, [sessionId, visible, client])

  const editDraft = next => { dirtyRef.current = true; setDirty(true); setDraft(next); setNotice('') }
  const selectNode = id => {
    setSelectedId(id)
    if (workspaceRef.current?.clientWidth > 0 && workspaceRef.current.clientWidth < 680) inspectorRef.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' })
  }
  const changeScope = next => {
    scopeRef.current = next; setScope(next)
    draftBase.current = { revision: detail.revision, presetId: detail.selectedPresetId }
    dirtyRef.current = false; setDirty(false)
    writeError.current = false; setError('')
    setDraft(layerPolicy(detail, next)); setNotice('')
  }
  const reloadDraft = async () => {
    const context = lifecycle.current
    if (!detail || !context || busyRef.current) return
    changeScope(scopeRef.current)
    busyRef.current = true; setBusy(true)
    try { await refresh.current() }
    finally {
      if (!context.controller.signal.aborted && lifecycle.current === context) { busyRef.current = false; setBusy(false) }
    }
  }
  const persist = async reset => {
    const context = lifecycle.current
    const base = draftBase.current
    if (!detail || !context || !base || busyRef.current || base.presetId !== detail.selectedPresetId) return
    busyRef.current = true
    writeError.current = false
    setBusy(true); setError(''); setNotice('')
    try {
      const input = { scope, ...(scope === 'preset' ? { presetId: base.presetId } : {}), expectedRevision: base.revision }
      const result = reset ? await client.resetPolicy(sessionId, input, context.controller.signal) : await client.savePolicy(sessionId, { ...input, policy: serializablePolicy(draft) }, context.controller.signal)
      if (context.controller.signal.aborted || lifecycle.current !== context) return
      context.minRevision = Math.max(context.minRevision, result.revision)
      draftBase.current = { revision: result.revision, presetId: base.presetId }
      dirtyRef.current = false; setDirty(false)
      setNotice(reset ? '已恢复继承' : '配置已保存')
      await refresh.current()
    } catch (cause) {
      if (!context.controller.signal.aborted && lifecycle.current === context) { writeError.current = true; setError(cause.message || '保存配置失败。') }
    } finally {
      if (!context.controller.signal.aborted && lifecycle.current === context) { busyRef.current = false; setBusy(false) }
    }
  }

  const preset = detail?.presets?.find(item => item.id === detail.selectedPresetId)
  const presetName = preset?.name || preset?.title || detail?.selectedPresetId || '未选择预设'
  const node = detail?.graph?.nodes.find(item => item.id === selectedId)
  const changedPreset = Boolean(dirty && detail && draftBase.current?.presetId !== detail.selectedPresetId)
  const draftWarning = changedPreset ? '当前预设已切换。草稿仍属于先前预设，重新载入后才能保存。' : dirty && (writeError.current || detail?.revision !== draftBase.current?.revision) ? '草稿保留。重新载入配置会丢弃未保存修改，并读取当前配置。' : ''
  return <div ref={workspaceRef} className="dsh-loop-workspace" data-loop-session={sessionId}>
    <header className="loop-heading"><div className="loop-heading-title"><span className="loop-brand"><LoopIcon size={16} />LOOP STUDIO</span><h1>Agent Loop</h1></div><button type="button" className="loop-refresh" aria-label="刷新执行流程" title="刷新执行流程" disabled={loading || busy || !sessionId} onClick={() => { void refresh.current() }}><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5m10.4-3A8 8 0 0 0 5.7 5.7L4 8m16 8-1.7 2.3A8 8 0 0 1 4.6 15" /></svg></button></header>
    {error && <div role="alert" className="loop-error"><span>{error}</span><button type="button" aria-label="关闭错误提示" onClick={() => { writeError.current = false; setError('') }}>×</button></div>}
    {notice && <div role="status" className="loop-notice">{notice}</div>}
    {!sessionId ? <div className="loop-loading">选择会话以查看执行流程。</div> : loading ? <div className="loop-loading" role="status">正在读取预设与执行流程…</div> : detail ? <div className="loop-scroll">
      <div className="loop-overview"><div><span className="loop-eyebrow">当前会话的预设</span><strong>{presetName}</strong></div><span className={`loop-live ${detail.running ? 'is-running' : connected ? 'is-connected' : ''}`}><i />{detail.running ? '正在执行' : connected ? '已同步' : '等待连接'}</span></div>
      {detail.diagnostics?.length > 0 && <div className="loop-diagnostics">{detail.diagnostics.map((item, index) => <p key={index}>{typeof item === 'string' ? item : item.message || item.code}</p>)}</div>}
      <Composition detail={detail} presetName={presetName} />
      <div className="loop-main"><LoopGraph graph={detail.graph} selectedId={selectedId} onSelect={selectNode} trace={detail.trace || []} routingCapability={detail.routingCapability} graphRef={graphRef} /><NodeInspector detail={detail} node={node} draft={draft} scope={scope} onScope={changeScope} onDraft={editDraft} busy={busy} dirty={dirty} blocked={changedPreset} draftWarning={draftWarning} onReloadDraft={() => void reloadDraft()} onSave={event => { event.preventDefault(); void persist(false) }} onReset={() => void persist(true)} inspectorRef={inspectorRef} onReturn={() => graphRef.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' })} /></div>
      <Activity trace={detail.trace || []} graph={detail.graph} />
    </div> : <div className="loop-loading">暂时无法读取此会话。点击刷新重试。</div>}
  </div>
}
