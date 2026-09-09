import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import {
  Archive, ArrowDownToLine, BookOpenText, Check, ChevronLeft, Coins, Database, FileImage, FolderOpen, HeartHandshake, History, ImagePlus, KeyRound, LoaderCircle, MapPin, PackageOpen, PanelLeft, Plus, RefreshCw, RotateCcw, Save, ServerOff, ShieldCheck, Trash2, Upload, Users, Wifi, X,
} from 'lucide-react'
import { api as studioApi } from './api.js'
import { ProductApiError, productApi, type ProductCategory, type ProductPage } from './ProductApi.js'
import { getDesktopBridge } from './DesktopBridge.js'
import type { PairingClient, ProductAsset, ProductBackup, ProductLocation, ProductMemory, ProductNotification, ProductRelationship } from '@dsh-rp/protocol'

type Section = 'assets' | 'ledger' | 'knowledge' | 'rp' | 'notifications' | 'backups' | 'pairing'
type PageState = { loading: boolean; error: string | null }
type ProjectionData = { memories: ProductPage<ProductMemory>; relationships: ProductPage<ProductRelationship>; locations: ProductPage<ProductLocation> }

const categories: Array<{ id: ProductCategory; label: string }> = [
  { id: 'portrait', label: '头像' }, { id: 'background', label: '背景' }, { id: 'sticker', label: '表情包' }, { id: 'audio', label: '音频' }, { id: 'attachment', label: '附件' },
]
const sectionItems: Array<{ id: Section; label: string; hint: string; icon: typeof Archive }> = [
  { id: 'assets', label: '资产与表情包', hint: '上传 / 预览 / 下载', icon: ImagePlus },
  { id: 'ledger', label: '账本', hint: '整数最小货币单位', icon: Coins },
  { id: 'knowledge', label: '用户知识笔记', hint: '你可编辑', icon: BookOpenText },
  { id: 'rp', label: '只读剧情资料', hint: '记忆 / 关系 / 位置', icon: HeartHandshake },
  { id: 'notifications', label: '通知', hint: '查看与标记已读', icon: Wifi },
  { id: 'backups', label: '备份与恢复', hint: '先验证再恢复', icon: Database },
  { id: 'pairing', label: '手机配对', hint: '短码 / 已配对设备', icon: KeyRound },
]

function commandId(prefix: string): string { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}` }
function formatDate(value: string | number): string {
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? '时间未知' : new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date)
}
function errorText(error: unknown): string {
  if (error instanceof ProductApiError) return `[${error.code}] ${error.message}`
  return error instanceof Error ? error.message : String(error)
}
export function useProductPage<T>(loader: (signal: AbortSignal) => Promise<T>, deps: unknown[]): { data: T | null; state: PageState; reload: () => Promise<void> } {
  const [data, setData] = useState<T | null>(null)
  const [state, setState] = useState<PageState>({ loading: true, error: null })
  const generation = useRef(0)
  const controller = useRef<AbortController | null>(null)
  const reload = async () => {
    const current = ++generation.current
    controller.current?.abort()
    const nextController = new AbortController(); controller.current = nextController
    setData(null)
    setState({ loading: true, error: null })
    try { const value = await loader(nextController.signal); if (current === generation.current) { setData(value); setState({ loading: false, error: null }) } } catch (error) { if (current === generation.current && !nextController.signal.aborted) setState({ loading: false, error: errorText(error) }) }
  }
  useEffect(() => { void reload(); return () => { generation.current++; controller.current?.abort() } }, deps) // eslint-disable-line react-hooks/exhaustive-deps
  return { data, state, reload }
}
export function usePagedProduct<T>(loader: (cursor: string | undefined, signal: AbortSignal) => Promise<ProductPage<T>>, deps: unknown[]) {
  const [data, setData] = useState<ProductPage<T> | null>(null)
  const [state, setState] = useState<PageState>({ loading: true, error: null })
  const [moreBusy, setMoreBusy] = useState(false)
  const [moreError, setMoreError] = useState<string | null>(null)
  const generation = useRef(0); const controllers = useRef(new Set<AbortController>())
  const abortAll = () => { controllers.current.forEach(item => item.abort()); controllers.current.clear() }
  const reload = async () => {
    const current = ++generation.current; abortAll(); const controller = new AbortController(); controllers.current.add(controller)
    setData(null)
    setState({ loading: true, error: null }); setMoreError(null)
    try { const value = await loader(undefined, controller.signal); if (current === generation.current) { setData(value); setState({ loading: false, error: null }) } } catch (error) { if (current === generation.current && !controller.signal.aborted) setState({ loading: false, error: errorText(error) }) } finally { controllers.current.delete(controller) }
  }
  const loadMore = async () => {
    const current = data
    const cursor = current?.nextCursor
    if (!cursor || moreBusy || !current) return
    const currentGeneration = generation.current; const controller = new AbortController(); controllers.current.add(controller); setMoreBusy(true); setMoreError(null)
    try { const next = await loader(cursor, controller.signal); if (currentGeneration === generation.current) setData(value => value && value.nextCursor === cursor ? { items: [...value.items, ...next.items], nextCursor: next.nextCursor } : value) } catch (error) { if (currentGeneration === generation.current && !controller.signal.aborted) setMoreError(errorText(error)) } finally { controllers.current.delete(controller); if (currentGeneration === generation.current) setMoreBusy(false) }
  }
  useEffect(() => { void reload(); return () => { generation.current++; abortAll() } }, deps) // eslint-disable-line react-hooks/exhaustive-deps
  return { data, state, reload, moreBusy, moreError, loadMore }
}

function Button(props: { children: ReactNode; onClick?: () => void; type?: 'button' | 'submit'; disabled?: boolean; tone?: 'normal' | 'accent' | 'danger' }) {
  return <button className={`product-button ${props.tone ?? 'normal'}`} disabled={props.disabled} onClick={props.onClick} type={props.type ?? 'button'}>{props.children}</button>
}
function Empty({ children }: { children: ReactNode }) { return <div className="product-empty"><PackageOpen aria-hidden="true" size={22} /><span>{children}</span></div> }
function ProductError({ message, onRetry }: { message: string; onRetry?: () => void }) { return <div className="product-error" role="alert"><ServerOff aria-hidden="true" size={18} /><span>{message}</span>{onRetry ? <Button onClick={onRetry}><RefreshCw aria-hidden="true" size={14} />重试</Button> : null}</div> }
function Loading() { return <div className="product-loading" role="status"><LoaderCircle aria-hidden="true" size={18} />正在读取产品数据…</div> }
function More({ cursor, busy, error, onLoad }: { cursor: string | null | undefined; busy: boolean; error: string | null; onLoad: () => void }) { return <>{error ? <ProductError message={error} onRetry={onLoad} /> : null}{cursor ? <div className="product-more"><Button disabled={busy} onClick={onLoad}>{busy ? '加载中…' : '加载更多'}</Button></div> : null}</> }
function PanelHeader({ title, eyebrow, children }: { title: string; eyebrow: string; children?: ReactNode }) { return <header className="product-panel-header"><div><span className="product-eyebrow">{eyebrow}</span><h2>{title}</h2></div><div className="product-header-actions">{children}</div></header> }

function AssetPreview({ sessionId, asset }: { sessionId: string; asset: ProductAsset }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!asset.mimeType.startsWith('image/')) return
    const controller = new AbortController(); let objectUrl: string | null = null
    void fetch(`/api/v1/product/assets/${encodeURIComponent(asset.id)}?sessionId=${encodeURIComponent(sessionId)}`, { signal: controller.signal }).then(async response => {
      if (!response.ok) return
      objectUrl = URL.createObjectURL(await response.blob())
      if (controller.signal.aborted) { URL.revokeObjectURL(objectUrl); objectUrl = null; return }
      setUrl(objectUrl)
    }).catch(() => { /* preview is optional; metadata remains usable */ })
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [asset.id, asset.mimeType, sessionId])
  return url ? <img alt={`${asset.fileName}预览`} src={url} /> : <div className="asset-placeholder"><FileImage aria-hidden="true" size={25} /><span>{asset.category}</span></div>
}

function AssetsSection({ sessionId }: { sessionId: string }) {
  const [category, setCategory] = useState<ProductCategory | 'all'>('all')
  const [uploadCategory, setUploadCategory] = useState<ProductCategory>('portrait')
  const assets = usePagedProduct((cursor, signal) => productApi.assets(sessionId, category === 'all' ? undefined : category, cursor, signal), [sessionId, category])
  const [file, setFile] = useState<File | null>(null)
  const [label, setLabel] = useState('')
  const [uploading, setUploading] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [assetBusy, setAssetBusy] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [editLabel, setEditLabel] = useState('')
  const desktop = getDesktopBridge()
  const upload = async (event: FormEvent) => {
    event.preventDefault()
    if (!file || uploading) return
    setUploading(true); setMessage(null)
    try { await productApi.uploadAsset(sessionId, file, uploadCategory, label); setFile(null); setLabel(''); setMessage('资产已保存。'); await assets.reload() } catch (error) { setMessage(errorText(error)) } finally { setUploading(false) }
  }
  const download = async (asset: ProductAsset) => {
    try { await productApi.downloadAsset(sessionId, asset) } catch (error) { setMessage(errorText(error)) }
  }
  const importFromDesktop = async () => {
    if (!desktop || uploading) return
    setUploading(true); setMessage(null)
    try {
      const result = await desktop.importAsset(sessionId)
      if (!result.selected) return
      if (!result.ok) throw new ProductApiError(result.diagnostic.message, result.diagnostic.code, 502)
      setMessage('桌面资产已导入。'); await assets.reload()
    } catch (error) { setMessage(errorText(error)) } finally { setUploading(false) }
  }
  return <div className="product-section-content">
    <PanelHeader eyebrow="素材库" title="资产与表情包"><span className="product-safety-note"><ShieldCheck aria-hidden="true" size={15} />安全上传与下载</span></PanelHeader>
    <form className="product-upload-card" onSubmit={upload}>
      <div className="upload-title"><Upload aria-hidden="true" size={17} /><strong>添加安全资产</strong><span>PNG / JPEG / WebP / GIF / MP3 / OGG / WAV / PDF · 最大 10 MiB</span></div>
      <div className="product-form-grid">
        <label className="file-drop"><FileImage aria-hidden="true" size={22} /><span>{file ? file.name : '选择文件'}</span><small>{file ? `${(file.size / 1024).toFixed(1)} KiB` : '不会读取任意磁盘路径'}</small><input aria-label="选择资产文件" accept="image/png,image/jpeg,image/webp,image/gif,audio/mpeg,audio/ogg,audio/wav,application/pdf" onChange={event => setFile(event.target.files?.[0] ?? null)} type="file" /></label>
        <label><span>上传分类</span><select aria-label="上传资产分类" onChange={event => setUploadCategory(event.target.value as ProductCategory)} value={uploadCategory}>{categories.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
        <label><span>标签（可选）</span><input aria-label="资产标签" maxLength={500} onChange={event => setLabel(event.target.value)} placeholder="例如：主角头像" value={label} /></label>
      </div>
      <div className="product-form-actions"><small>仅接受常见图片、音频和 PDF，最大 10 MiB。</small><div>{desktop ? <Button disabled={uploading} onClick={() => void importFromDesktop()}><FolderOpen aria-hidden="true" size={15} />从桌面导入</Button> : null}<Button disabled={!file || uploading} tone="accent" type="submit">{uploading ? <><LoaderCircle aria-hidden="true" size={15} />上传中</> : <><Plus aria-hidden="true" size={15} />上传</>}</Button></div></div>
      {message ? <p className="product-inline-message" role="status">{message}</p> : null}
    </form>
    <div className="product-filter-row"><span>资产目录</span>{categories.map(item => <button aria-pressed={category === item.id} className="product-filter" key={item.id} onClick={() => setCategory(item.id)} type="button">{item.label}</button>)}<button aria-pressed={category === 'all'} className="product-filter" onClick={() => setCategory('all')} type="button">全部</button></div>
    {assets.state.loading ? <Loading /> : assets.state.error ? <ProductError message={assets.state.error} onRetry={() => void assets.reload()} /> : assets.data?.items.length === 0 ? <Empty>还没有资产；从一个头像或表情包开始。</Empty> : <><div className="asset-grid">{assets.data?.items.map(asset => <article className="asset-card" key={asset.id}><AssetPreview asset={asset} sessionId={sessionId} /><div className="asset-copy"><strong title={asset.fileName}>{asset.fileName}</strong><span>{categories.find(item => item.id === asset.category)?.label} · {(asset.bytes / 1024).toFixed(1)} KiB</span>{editing === asset.id ? <form onSubmit={event => { event.preventDefault(); if (assetBusy) return; setAssetBusy(asset.id); void productApi.updateAsset(sessionId, asset.id, editLabel.trim() || null).then(() => assets.reload()).then(() => setEditing(null)).catch(error => setMessage(errorText(error))).finally(() => setAssetBusy(null)) }}><input aria-label={`${asset.fileName}标签`} maxLength={500} onChange={event => setEditLabel(event.target.value)} value={editLabel} /><Button disabled={assetBusy === asset.id} type="submit">保存标签</Button></form> : asset.label ? <small>{asset.label}</small> : <small>无标签</small>}</div><div className="asset-actions"><Button onClick={() => void download(asset)}><ArrowDownToLine aria-hidden="true" size={14} />下载</Button><Button onClick={() => { setEditing(asset.id); setEditLabel(asset.label ?? '') }}>编辑标签</Button><Button disabled={assetBusy === asset.id} onClick={() => { if (!window.confirm(`删除 ${asset.fileName}？`)) return; setAssetBusy(asset.id); void productApi.deleteAsset(sessionId, asset.id).then(() => assets.reload()).catch(error => setMessage(errorText(error))).finally(() => setAssetBusy(null)) }} tone="danger"><Trash2 aria-hidden="true" size={14} />删除</Button></div></article>)}</div><More busy={assets.moreBusy} cursor={assets.data?.nextCursor} error={assets.moreError} onLoad={() => void assets.loadMore()} /></>}
  </div>
}

function LedgerSection({ sessionId }: { sessionId: string }) {
  const ledger = usePagedProduct((cursor, signal) => productApi.ledger(sessionId, cursor, signal), [sessionId])
  const [amount, setAmount] = useState('')
  const [currency, setCurrency] = useState('USD')
  const [description, setDescription] = useState('')
  const [reverses, setReverses] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const ledgerItems = ledger.data?.items ?? []
  const reversedEntryIds = new Set(ledgerItems.flatMap(item => item.reversesEntryId ? [item.reversesEntryId] : []))
  const correctionCandidates = ledgerItems.filter(item => !item.reversesEntryId && !reversedEntryIds.has(item.id))
  const selected = correctionCandidates.find(item => item.id === reverses)
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (busy) return
    const parsed = Number(amount)
    if (!Number.isSafeInteger(parsed) || !description.trim() || !/^[A-Z]{3}$/u.test(currency)) { setMessage('请输入安全范围内的整数 amountMinor、三位大写货币和说明。'); return }
    setBusy(true); setMessage(null)
    try { await productApi.createLedger(sessionId, { commandId: commandId('ledger'), amountMinor: selected ? -selected.amountMinor : parsed, currency: selected?.currency ?? currency, description: description.trim(), occurredAt: new Date().toISOString(), ...(selected ? { reversesEntryId: selected.id } : {}) }); setAmount(''); setDescription(''); setReverses(''); setMessage(selected ? '补偿修正已追加；原账目保持不变。' : '账目已追加。'); await ledger.reload() } catch (error) { setMessage(errorText(error)) } finally { setBusy(false) }
  }
  return <div className="product-section-content"><PanelHeader eyebrow="用户账本" title="账本"><span className="product-safety-note"><Coins aria-hidden="true" size={15} />按最小货币单位记录</span></PanelHeader><div className="product-callout"><strong>金额请填整数</strong><span>例如 12.50 元记作 1250；账本不代表真实银行余额。</span></div><form className="product-form-card" onSubmit={submit}><div className="product-form-grid ledger-form"><label><span>金额（最小货币单位）</span><input aria-label="账目金额（最小货币单位）" disabled={Boolean(selected)} inputMode="numeric" onChange={event => setAmount(event.target.value)} placeholder="-1250" step="1" type="number" value={selected ? String(-selected.amountMinor) : amount} /></label><label><span>货币代码</span><input aria-label="货币代码" disabled={Boolean(selected)} maxLength={3} onChange={event => setCurrency(event.target.value.toUpperCase())} value={selected?.currency ?? currency} /></label><label className="wide"><span>说明</span><input aria-label="账目说明" maxLength={2000} onChange={event => setDescription(event.target.value)} placeholder="旅店住宿" value={description} /></label><label className="wide"><span>补偿修正（可选）</span><select aria-label="选择要修正的账目" onChange={event => setReverses(event.target.value)} value={reverses}><option value="">新建账目</option>{correctionCandidates.map(item => <option key={item.id} value={item.id}>修正：{item.description}（{item.amountMinor} {item.currency}）</option>)}</select></label></div><div className="product-form-actions"><small>{selected ? `将新增一条 ${-selected.amountMinor} ${selected.currency} 的反向记录；原记录不会被改写。` : '已修正的账目和补偿记录不会再次出现在这里。'}</small><Button disabled={busy} tone="accent" type="submit">{busy ? '保存中…' : <><Save aria-hidden="true" size={15} />追加账目</>}</Button></div>{message ? <p className="product-inline-message" role="status">{message}</p> : null}</form>{ledger.state.loading ? <Loading /> : ledger.state.error ? <ProductError message={ledger.state.error} onRetry={() => void ledger.reload()} /> : ledger.data?.items.length === 0 ? <Empty>账本为空。</Empty> : <><div className="ledger-list">{ledger.data?.items.map(item => <article className="ledger-row" key={item.id}><span className={item.amountMinor < 0 ? 'negative' : 'positive'}>{item.amountMinor < 0 ? '−' : '+'}{Math.abs(item.amountMinor).toLocaleString()} {item.currency}</span><div><strong>{item.description}</strong><small>{formatDate(item.occurredAt)} · {item.reversesEntryId ? '补偿修正' : '原始账目'}</small></div></article>)}</div><More busy={ledger.moreBusy} cursor={ledger.data?.nextCursor} error={ledger.moreError} onLoad={() => void ledger.loadMore()} /></>}</div>
}

function KnowledgeSection({ sessionId }: { sessionId: string }) {
  const notes = usePagedProduct((cursor, signal) => productApi.knowledge(sessionId, cursor, signal), [sessionId])
  const [text, setText] = useState(''); const [editing, setEditing] = useState<string | null>(null); const [busy, setBusy] = useState(false); const [message, setMessage] = useState<string | null>(null)
  const save = async (event: FormEvent) => { event.preventDefault(); if (busy || !text.trim()) return; setBusy(true); setMessage(null); try { if (editing) await productApi.updateKnowledge(sessionId, editing, text.trim()); else await productApi.createKnowledge(sessionId, text.trim()); setText(''); setEditing(null); setMessage(editing ? '用户笔记已更新。' : '用户笔记已保存。'); await notes.reload() } catch (error) { setMessage(errorText(error)) } finally { setBusy(false) } }
  const remove = async (id: string) => { if (busy) return; setBusy(true); try { await productApi.deleteKnowledge(sessionId, id); await notes.reload() } catch (error) { setMessage(errorText(error)) } finally { setBusy(false) } }
  return <div className="product-section-content"><PanelHeader eyebrow="你的资料" title="用户知识笔记"><span className="product-source-badge user"><Check aria-hidden="true" size={13} />用户笔记 · 可编辑</span></PanelHeader><div className="product-boundary"><strong>由你维护</strong><span>这些笔记会长期保留；只读剧情资料会清楚标记，不能在这里改写。</span></div><form className="product-form-card" onSubmit={save}><label><span>{editing ? '编辑用户笔记' : '新增用户笔记'}</span><textarea aria-label="用户知识笔记" maxLength={20000} onChange={event => setText(event.target.value)} placeholder="记录你希望长期保留的事实或偏好…" rows={4} value={text} /></label><div className="product-form-actions"><small>{text.length}/20,000</small><Button disabled={busy || !text.trim()} tone="accent" type="submit">{busy ? '保存中…' : <><Save aria-hidden="true" size={15} />{editing ? '保存修改' : '保存笔记'}</>}</Button>{editing ? <Button onClick={() => { setEditing(null); setText('') }}><X aria-hidden="true" size={14} />取消</Button> : null}</div>{message ? <p className="product-inline-message" role="status">{message}</p> : null}</form>{notes.state.loading ? <Loading /> : notes.state.error ? <ProductError message={notes.state.error} onRetry={() => void notes.reload()} /> : notes.data?.items.length === 0 ? <Empty>还没有知识笔记。</Empty> : <><div className="knowledge-list">{notes.data?.items.map(note => <article className={`knowledge-card ${note.source === 'user' ? 'is-user' : 'is-rp'}`} key={note.id}><div className="knowledge-card-meta"><span className={`product-source-badge ${note.source === 'user' ? 'user' : 'rp'}`}>{note.source === 'user' ? '用户笔记 · 可编辑' : '只读剧情资料'}</span><small>{formatDate(note.updatedAt)}</small></div><p>{note.text}</p>{note.source === 'user' ? <div className="knowledge-actions"><Button onClick={() => { setEditing(note.id); setText(note.text) }}><History aria-hidden="true" size={14} />编辑</Button><Button onClick={() => void remove(note.id)} tone="danger"><Trash2 aria-hidden="true" size={14} />删除</Button></div> : <details><summary>来源诊断</summary><small className="provenance">branch {note.provenance?.branchId ?? '—'} · seq {note.provenance?.sourceSeq ?? '—'}</small></details>}</article>)}</div><More busy={notes.moreBusy} cursor={notes.data?.nextCursor} error={notes.moreError} onLoad={() => void notes.loadMore()} /></>}</div>
}

function RpSection({ sessionId }: { sessionId: string }) {
  const rp = useProductPage(async (signal): Promise<ProjectionData> => { const [memories, relationships, locations] = await Promise.all([productApi.memories(sessionId, undefined, signal), productApi.relationships(sessionId, undefined, signal), productApi.locations(sessionId, undefined, signal)]); return { memories, relationships, locations } }, [sessionId])
  return <div className="product-section-content"><PanelHeader eyebrow="剧情资料" title="只读剧情资料"><span className="product-source-badge rp"><ShieldCheck aria-hidden="true" size={13} />只读</span></PanelHeader><div className="product-boundary rp-boundary"><strong>与用户笔记分开</strong><span>记忆、情绪、关系与虚构位置来自当前故事，只能查看，不能在这里改写。</span></div>{rp.state.loading ? <Loading /> : rp.state.error ? <ProductError message={rp.state.error} onRetry={() => void rp.reload()} /> : <div className="rp-grid"><ProjectionCard title="公开记忆与情绪" icon={BookOpenText} items={rp.data?.memories.items.map(item => <div key={item.id}><strong>{item.text}</strong>{item.emotion ? <span>情绪观察：{item.emotion}</span> : null}<details><summary>来源诊断</summary><small>branch {item.branchId} · seq {item.sourceSeq}</small></details></div>)} /><ProjectionCard title="关系" icon={Users} items={rp.data?.relationships.items.map(item => <div key={item.id}><strong>{item.subject} → {item.object}</strong><span>{item.relation}{item.status ? ` · ${item.status}` : ''}</span><details><summary>来源诊断</summary><small>branch {item.branchId} · seq {item.sourceSeq}</small></details></div>)} /><ProjectionCard title="虚构位置" icon={MapPin} items={rp.data?.locations.items.map(item => <div key={item.id}><strong>{item.world}</strong><span>{[item.region, item.scene, item.landmark].filter(Boolean).join(' / ') || '位置未细化'}</span><details><summary>来源诊断</summary><small>branch {item.branchId} · seq {item.sourceSeq}</small></details></div>)} /></div>}</div>
}
function ProjectionCard({ title, icon: Icon, items }: { title: string; icon: typeof BookOpenText; items: ReactNode[] | undefined }) { return <section className="projection-card"><h3><Icon aria-hidden="true" size={16} />{title}</h3>{items?.length ? <div className="projection-list">{items}</div> : <Empty>暂无公开投影</Empty>}</section> }

function NotificationsSection({ sessionId }: { sessionId: string }) {
  const notifications = useProductPage(signal => productApi.notifications(sessionId, undefined, signal), [sessionId]); const [busy, setBusy] = useState<string | null>(null); const [message, setMessage] = useState<string | null>(null)
  const ack = async (item: ProductNotification) => { if (busy || item.acknowledged) return; setBusy(item.id); setMessage(null); try { await productApi.acknowledge(sessionId, item.id); await notifications.reload() } catch (error) { setMessage(errorText(error)) } finally { setBusy(null) } }
  const items = notifications.data?.items ?? []
  return <div className="product-section-content"><PanelHeader eyebrow="消息中心" title="通知"><span className="product-safety-note"><Wifi aria-hidden="true" size={15} />确认只会标记已读</span></PanelHeader><div className="product-boundary"><strong>不会代替你做决定</strong><span>标记已读不会批准权限、工具调用、问题或模型动作。</span></div>{message ? <ProductError message={message} onRetry={() => { setMessage(null); void notifications.reload() }} /> : null}{notifications.state.loading ? <Loading /> : notifications.state.error ? <ProductError message={notifications.state.error} onRetry={() => void notifications.reload()} /> : items.length === 0 ? <Empty>暂无通知。</Empty> : <div className="notification-list">{items.map(item => <article className={`notification-card ${item.acknowledged ? 'is-read' : ''}`} key={item.id}><div><span>{item.type}</span><small>{formatDate(item.createdAt)}</small></div><h3>{item.title}</h3><p>{item.body}</p><Button disabled={item.acknowledged || busy === item.id} onClick={() => void ack(item)}>{item.acknowledged ? <><Check aria-hidden="true" size={14} />已读</> : '标记已读'}</Button></article>)}</div>}</div>
}

function BackupsSection({ sessionId }: { sessionId: string }) {
  const backups = usePagedProduct((cursor, signal) => productApi.backups(sessionId, cursor, signal), [sessionId]); const [busy, setBusy] = useState(false); const [message, setMessage] = useState<string | null>(null); const [staged, setStaged] = useState<Record<string, { token: string; expiresAt: string }>>({}); const [confirmed, setConfirmed] = useState<Record<string, boolean>>({}); const desktop = getDesktopBridge()
  const create = async () => { if (busy) return; setBusy(true); setMessage(null); try { await productApi.createBackup(sessionId); setMessage('备份已创建。'); await backups.reload() } catch (error) { setMessage(errorText(error)) } finally { setBusy(false) } }
  const nativeBackup = async (operation: 'exportBackup' | 'importBackup') => { if (!desktop || busy) return; setBusy(true); setMessage(null); try { const result = await desktop[operation](sessionId); if (!result.selected) return; if (!result.ok) throw new ProductApiError(result.diagnostic.message, result.diagnostic.code, 502); setMessage(operation === 'exportBackup' ? '备份已导出。' : '备份已导入。'); await backups.reload() } catch (error) { setMessage(errorText(error)) } finally { setBusy(false) } }
  const stage = async (backup: ProductBackup) => { if (busy) return; setBusy(true); setMessage(null); try { const result = await productApi.stageRestore(sessionId, backup.id); setStaged(current => ({ ...current, [backup.id]: { token: result.restoreToken, expiresAt: result.expiresAt } })); setConfirmed(current => ({ ...current, [backup.id]: false })); setMessage('备份已验证，请核对替换范围后确认。') } catch (error) { setMessage(errorText(error)) } finally { setBusy(false) } }
  const clearStage = (id: string) => setStaged(current => { const next = { ...current }; delete next[id]; return next })
  const commit = async (backup: ProductBackup) => { const item = staged[backup.id]; if (!item || !confirmed[backup.id] || busy) return; if (Date.parse(item.expiresAt) <= Date.now()) { clearStage(backup.id); setMessage('恢复确认已过期，请重新验证。'); return } setBusy(true); setMessage(null); try { const result = await productApi.commitRestore(sessionId, backup.id, item.token); clearStage(backup.id); setMessage(`恢复完成；系统已创建回滚备份 ${result.rollbackBackupId}。`); await backups.reload() } catch (error) { setMessage(`${errorText(error)} 可重新验证后再试。`) } finally { setBusy(false) } }
  useEffect(() => { const expiries = Object.entries(staged).map(([id, item]) => ({ id, delay: Date.parse(item.expiresAt) - Date.now() })).filter(item => item.delay > 0 && item.delay <= 2_147_483_647); if (!expiries.length) return; const nearest = expiries.reduce((a, b) => a.delay < b.delay ? a : b); const timer = window.setTimeout(() => { clearStage(nearest.id); setMessage('恢复确认已过期，请重新验证。') }, nearest.delay); return () => window.clearTimeout(timer) }, [staged])
  return <div className="product-section-content"><PanelHeader eyebrow="数据保护" title="备份与恢复"><div>{desktop ? <><Button disabled={busy} onClick={() => void nativeBackup('importBackup')}><Upload aria-hidden="true" size={15} />从桌面导入</Button><Button disabled={busy} onClick={() => void nativeBackup('exportBackup')}><ArrowDownToLine aria-hidden="true" size={15} />导出到桌面</Button></> : null}<Button disabled={busy} onClick={() => void create()} tone="accent"><Database aria-hidden="true" size={15} />创建备份</Button></div></PanelHeader><div className="product-boundary"><strong>恢复前会再次确认</strong><span>备份包含用户资料和可重建的剧情资料；完整故事会话需使用官方导出。</span></div>{message ? <p className="product-inline-message" role="status">{message}</p> : null}{backups.state.loading ? <Loading /> : backups.state.error ? <ProductError message={backups.state.error} onRetry={() => void backups.reload()} /> : backups.data?.items.length === 0 ? <Empty>还没有可用备份。</Empty> : <><div className="backup-list">{backups.data?.items.map(backup => { const item = staged[backup.id]; return <article className={`backup-card ${item ? 'is-staged' : ''}`} key={backup.id}><div className="backup-icon"><Archive aria-hidden="true" size={20} /></div><div><strong>{formatDate(backup.createdAt)} 的备份</strong><span>用户资料 + 剧情资料</span>{item ? <div className="restore-confirm"><strong>将替换的数据范围</strong><span>工作区 {backup.scope.workspaceId} · 档案 {backup.scope.sessionId} · 卡片 {backup.scope.cardId}</span><label><input aria-label={`确认恢复 ${backup.id}`} checked={confirmed[backup.id] ?? false} onChange={event => setConfirmed(current => ({ ...current, [backup.id]: event.target.checked }))} type="checkbox" />我已确认恢复会替换上述范围</label><small>确认有效至 {formatDate(item.expiresAt)}</small></div> : <details><summary>查看诊断信息</summary><small>{backup.id} · schema v{backup.schemaVersion} · {backup.scope.branchId}</small></details>}</div><div className="backup-actions"><span className={`backup-state ${backup.state}`}>{backup.state === 'ready' ? '可用' : backup.state === 'staging' ? '处理中' : '失败'}</span>{item ? <><Button disabled={busy || !confirmed[backup.id]} onClick={() => void commit(backup)} tone="danger"><Check aria-hidden="true" size={14} />确认并恢复</Button><Button disabled={busy} onClick={() => void stage(backup)}><RefreshCw aria-hidden="true" size={14} />重新验证</Button></> : <Button disabled={busy || backup.state !== 'ready'} onClick={() => void stage(backup)}><RotateCcw aria-hidden="true" size={14} />验证恢复</Button>}</div></article> })}</div><More busy={backups.moreBusy} cursor={backups.data?.nextCursor} error={backups.moreError} onLoad={() => void backups.loadMore()} /></>}</div>
}

function PairingSection({ sessionId }: { sessionId: string }) {
  const status = useProductPage(signal => productApi.status(signal), []); const pairing = useProductPage(signal => productApi.pairing(signal), []); const clients = useProductPage(signal => productApi.clients(signal), []); const [clientName, setClientName] = useState('我的手机'); const [code, setCode] = useState<string | null>(null); const [busy, setBusy] = useState(false); const [message, setMessage] = useState<string | null>(null)
  const create = async (event: FormEvent) => { event.preventDefault(); if (busy || !clientName.trim() || !sessionId) return; setBusy(true); setMessage(null); try { const result = await productApi.createPairingCode(clientName.trim(), [sessionId], ['product:read']); setCode(result.code); setMessage(`短码有效至 ${formatDate(result.expiresAt)}。`); } catch (error) { setMessage(errorText(error)) } finally { setBusy(false) } }
  const revoke = async (client: PairingClient) => { if (busy) return; setBusy(true); try { await productApi.revokeClient(client.clientId); await clients.reload() } catch (error) { setMessage(errorText(error)) } finally { setBusy(false) } }
  const productStatus = status.data; const pairingStatus = pairing.data
  return <div className="product-section-content"><PanelHeader eyebrow="手机连接" title="手机配对"><span className="product-safety-note"><ShieldCheck aria-hidden="true" size={15} />默认只读</span></PanelHeader><div className="status-strip"><span><ServerOff aria-hidden="true" size={14} />数据：{productStatus?.storage === 'ready' ? '就绪' : productStatus?.storage === 'unavailable' ? '不可用' : '读取中'}</span><span><Wifi aria-hidden="true" size={14} />手机连接：{pairingStatus?.enabled ? '已启用' : '默认关闭'}</span></div>{productStatus?.doctor ? <details className="product-diagnostics"><summary>查看诊断</summary><p>{productStatus.doctor.code} · {productStatus.doctor.message}</p></details> : null}{status.state.error ? <ProductError message={status.state.error} onRetry={() => void status.reload()} /> : null}{pairing.state.error ? <ProductError message={pairing.state.error} onRetry={() => void pairing.reload()} /> : null}<div className="pairing-layout"><form className="product-form-card" onSubmit={create}><div className="upload-title"><KeyRound aria-hidden="true" size={17} /><strong>生成一次性短码</strong></div><p className="muted-product-copy">短码只允许手机查看当前选择的故事档案，不会授予写入权限。</p><label><span>客户端名称</span><input aria-label="客户端名称" maxLength={100} onChange={event => setClientName(event.target.value)} value={clientName} /></label><label className="scope-check"><input checked readOnly type="checkbox" /><span><strong>只读访问</strong><small>{sessionId ? `授权档案：${sessionId}` : '请先创建或选择一个故事档案'}</small></span></label><Button disabled={busy || !pairingStatus?.enabled || !sessionId} tone="accent" type="submit">{busy ? '生成中…' : '生成 5 分钟短码'}</Button>{!pairingStatus?.enabled && !pairing.state.loading ? <p className="product-help">手机连接目前未开启。</p> : null}{message ? <p className="product-inline-message" role="status">{message}</p> : null}</form><div className="pair-code-card"><span>一次性短码</span><strong aria-label="一次性配对短码">{code ?? '········'}</strong><small>{code ? '只展示一次；请在手机 companion 页面输入。' : '生成后不会保存在浏览器中。'}</small></div></div><h3 className="product-subheading">已配对客户端</h3>{clients.state.loading ? <Loading /> : clients.state.error ? <ProductError message={clients.state.error} onRetry={() => void clients.reload()} /> : clients.data?.length === 0 ? <Empty>暂无配对客户端。</Empty> : <div className="client-list">{clients.data?.map(client => <article key={client.clientId}><div><strong>{client.clientName}</strong><span>{client.sessionIds.length} 个已授权档案 · {client.scopes.includes('product:read') ? '只读' : '有限权限'}</span><small>创建于 {formatDate(client.createdAt)} · {client.revoked ? '已撤销' : `到期 ${formatDate(client.expiresAt)}`}</small></div><Button disabled={client.revoked || busy} onClick={() => void revoke(client)} tone="danger"><Trash2 aria-hidden="true" size={14} />撤销</Button></article>)}</div>}</div>
}

function ProductNavigation({ active, onSelect, sessionId }: { active: Section; onSelect: (section: Section) => void; sessionId: string }) { return <aside className="product-navigation"><div className="product-brand"><div className="brand-mark" aria-hidden="true"><Archive size={18} /></div><div><strong>DSH RP</strong><span>产品控制台</span></div></div><div className="product-scope"><span>当前故事档案</span><strong title={sessionId}>{sessionId}</strong><small>列表和新增内容都属于此档案</small></div><nav aria-label="产品管理"><span className="product-nav-label">管理模块</span>{sectionItems.map(item => { const Icon = item.icon; return <button aria-current={active === item.id ? 'page' : undefined} className={active === item.id ? 'active' : ''} data-section={item.id} key={item.id} onClick={() => onSelect(item.id)} type="button"><Icon aria-hidden="true" size={17} /><span><strong>{item.label}</strong><small>{item.hint}</small></span></button> })}</nav><footer><ShieldCheck aria-hidden="true" size={14} />本地资料 · 公开剧情边界</footer></aside> }
function ScopeRequired() { return <div className="product-section-content"><PanelHeader eyebrow="故事档案" title="请先选择一个故事档案" /><Empty>此模块按故事档案保存数据。你仍可使用“手机配对”查看全局状态。</Empty></div> }

export function ProductPanel() {
  const initialSession = new URLSearchParams(window.location.search).get('sessionId')
  const [sessionId, setSessionId] = useState(initialSession ?? '')
  const [active, setActive] = useState<Section>('assets')
  const [sessionLoading, setSessionLoading] = useState(!initialSession)
  const [sessionError, setSessionError] = useState<string | null>(null)
  const [mobileNav, setMobileNav] = useState(false)
  const mobileNavRef = useRef<HTMLDivElement>(null)
  useEffect(() => { if (!mobileNav) return; const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null; const focusable = () => [...(mobileNavRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [href]') ?? [])]; focusable()[0]?.focus(); const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setMobileNav(false); if (event.key !== 'Tab') return; const items = focusable(); const first = items[0]; const last = items.at(-1); if (!first || !last) return; if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() } }; window.addEventListener('keydown', onKey); return () => { window.removeEventListener('keydown', onKey); previous?.focus() } }, [mobileNav])
  useEffect(() => { if (initialSession) return; void studioApi.sessions().then(sessions => { const selected = sessions[0]?.id ?? ''; setSessionId(selected); if (!selected) setActive('pairing'); setSessionLoading(false) }).catch(error => { setSessionError(errorText(error)); setActive('pairing'); setSessionLoading(false) }) }, [initialSession])
  const section = useMemo(() => { if (active === 'pairing') return <PairingSection sessionId={sessionId} />; if (!sessionId) return <ScopeRequired />; if (active === 'assets') return <AssetsSection sessionId={sessionId} />; if (active === 'ledger') return <LedgerSection sessionId={sessionId} />; if (active === 'knowledge') return <KnowledgeSection sessionId={sessionId} />; if (active === 'rp') return <RpSection sessionId={sessionId} />; if (active === 'notifications') return <NotificationsSection sessionId={sessionId} />; return <BackupsSection sessionId={sessionId} /> }, [active, sessionId])
  if (sessionLoading) return <main className="product-root"><Loading /></main>
  return <main className="product-root"><ProductNavigation active={active} onSelect={sectionId => { setActive(sectionId); setMobileNav(false) }} sessionId={sessionId || '未选择'} /><div className="product-main"><header className="product-topbar"><Button onClick={() => { window.location.href = '/' }}><ChevronLeft aria-hidden="true" size={16} />回到叙事</Button><div className="product-mobile-title"><span>产品管理</span><strong>{sectionItems.find(item => item.id === active)?.label}</strong></div><Button onClick={() => setMobileNav(true)}><PanelLeft aria-hidden="true" size={16} />模块</Button></header>{sessionError ? <ProductError message={sessionError} onRetry={() => window.location.reload()} /> : null}{mobileNav ? <div className="product-mobile-nav-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setMobileNav(false) }}><div aria-label="产品管理模块" aria-modal="true" className="product-mobile-nav" ref={mobileNavRef} role="dialog"><Button onClick={() => setMobileNav(false)}><X aria-hidden="true" size={16} />关闭</Button><ProductNavigation active={active} onSelect={sectionId => { setActive(sectionId); setMobileNav(false) }} sessionId={sessionId || '未选择'} /></div></div> : null}<section className="product-content">{section}</section></div></main>
}
