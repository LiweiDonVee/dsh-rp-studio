import React, { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'

export const studioViews = [['state', '角色与剧情'], ['story', '沉浸阅读'], ['archive', '故事档案与开局']]
export const ownerPages = [['rp-story-kit', '角色与素材'], ['rp-database', '数据库'], ['rp-context', '上下文'], ['rp-gm', '故事 GM'], ['rp-last-step', '写作预设与正文'], ['loop-studio', '流程与模型']]
export const readStudioView = value => studioViews.some(([view]) => view === value) ? value : 'state'

export function RpMenu({ view, registry, hasOwnerTab, onSelectView, onOpenOwner, onOpenCompanion, onMenuOpen, companionReason = 'RP 助手入口正在准备', extensions = null, workspace = false }) {
  const [opened, setOpened] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const root = useRef(null), trigger = useRef(null), surface = useRef(null)
  const id = useId()
  const availability = useMemo(() => ({
    subscribe: listener => registry?.subscribe ? registry.subscribe(listener) : () => {},
    snapshot: () => ownerPages.map(([kind]) => registry?.get ? registry.get(kind) !== undefined : hasOwnerTab?.(kind) === true).map(Boolean).join(','),
  }), [registry, hasOwnerTab])
  const available = useSyncExternalStore(availability.subscribe, availability.snapshot, availability.snapshot).split(',')
  const close = (restoreFocus = true) => { setOpened(false); if (restoreFocus) trigger.current?.focus() }
  const items = () => [...(surface.current?.querySelectorAll('button:not(:disabled),a[href]') ?? [])]
  useEffect(() => {
    if (!opened) return
    onMenuOpen?.()
    const menu = surface.current
    menu.showPopover?.()
    const position = () => {
      const anchor = trigger.current.getBoundingClientRect()
      const width = Math.min(320, window.innerWidth - 16)
      const below = window.innerHeight - anchor.bottom - 12
      const above = anchor.top - 12
      const height = Math.max(120, Math.max(below, above))
      menu.style.width = `${width}px`
      menu.style.maxHeight = `${height}px`
      menu.style.left = `${Math.max(8, Math.min(anchor.right - width, window.innerWidth - width - 8))}px`
      menu.style.top = below >= Math.min(menu.scrollHeight, 320) || below >= above ? `${anchor.bottom + 6}px` : 'auto'
      menu.style.bottom = menu.style.top === 'auto' ? `${window.innerHeight - anchor.top + 6}px` : 'auto'
    }
    position()
    items()[0]?.focus()
    const outside = event => { if (!root.current?.contains(event.target)) close() }
    document.addEventListener('pointerdown', outside)
    window.addEventListener('resize', position)
    window.addEventListener('scroll', position, true)
    return () => {
      menu.hidePopover?.()
      document.removeEventListener('pointerdown', outside)
      window.removeEventListener('resize', position)
      window.removeEventListener('scroll', position, true)
    }
  }, [opened, onMenuOpen])
  const select = async operation => {
    if (busy) return
    setError(''); setBusy(true)
    try { const result = operation(); if (result?.then) await result; close() }
    catch (cause) { setError(cause.message || String(cause)) }
    finally { setBusy(false) }
  }
  const onMenuKey = event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return }
    if (event.key === 'Tab') { close(false); return }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const buttons = items(), index = buttons.indexOf(document.activeElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
    buttons[next]?.focus()
  }
  const current = studioViews.find(([key]) => key === view)?.[1]
  return <div className="dsh-rp-menu" ref={root}>
    <button ref={trigger} type="button" className="dsh-rp-menu-trigger" aria-haspopup="menu" aria-expanded={opened} aria-controls={opened ? id : undefined} aria-label={workspace ? `工作区 · ${current || '角色与剧情'}` : 'RP'} onClick={() => { setError(''); setOpened(value => !value) }} onKeyDown={event => { if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); setOpened(true) } }}>{workspace ? `工作区 · ${current || '角色与剧情'}` : 'RP'}<span aria-hidden="true">▾</span></button>
    {opened && <div ref={surface} id={id} popover="manual" role="menu" aria-label="RP 工作区菜单" className="dsh-rp-menu-surface" onKeyDown={onMenuKey}>
      <section role="group" aria-label="故事"><p className="dsh-rp-menu-label">故事</p>{studioViews.map(([key, label]) => <button type="button" role="menuitemradio" key={key} aria-checked={view === key} disabled={busy} onClick={() => void select(() => onSelectView(key))}>{label}{view === key && <span aria-hidden="true">✓</span>}</button>)}</section>
      <section role="group" aria-label="管理"><p className="dsh-rp-menu-label">管理</p>{ownerPages.map(([kind, label], index) => <div key={kind} className="dsh-rp-menu-row"><button type="button" role="menuitem" disabled={busy || available[index] !== 'true'} onClick={() => void select(() => onOpenOwner(kind))}>{label}</button>{available[index] !== 'true' && <small>未启用对应插件</small>}</div>)}</section>
      <section role="group" aria-label="助手"><p className="dsh-rp-menu-label">助手</p><button type="button" role="menuitem" disabled={busy || !onOpenCompanion} onClick={() => void select(onOpenCompanion)}>RP 助手</button>{!onOpenCompanion && <small>{companionReason}</small>}</section>
      {extensions && <section role="group" aria-label="扩展操作" className="dsh-rp-menu-extensions" onClick={event => { if (event.target.closest('button:not(:disabled),a[href]')) close() }}><p className="dsh-rp-menu-label">扩展操作</p>{extensions}</section>}
      {error && <p role="alert" className="dsh-rp-menu-error">{error}</p>}
    </div>}
  </div>
}
