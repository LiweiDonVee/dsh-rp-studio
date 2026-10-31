import React, { useSyncExternalStore } from 'react'
import { Workspace, HeaderEntry } from './Workspace.jsx'
import { registerWorkspace, TAB_KIND } from './register.mjs'
import css from './workspace.css'
import { ACTION_SLOT, extensionEntryIds } from './workspace-navigation.mjs'
import { openCompanionSession, readCompanionStatus } from './companion-client.mjs'

export const inject = ['slots', 'sidebarRight', 'sidebarRightTabs', 'uiWorkspace']

export function apply(ctx) {
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.dshRpStudio = ''
    style.textContent = css
    document.head.append(style)
    return () => style.remove()
  }, 'RP Studio styles')
  const pending = new Set()
  const ownerKinds = new Set(['rp-gm', 'rp-story-kit', 'rp-database', 'rp-context', 'rp-last-step', 'loop-studio'])
  const hasOwnerTab = kind => ownerKinds.has(kind) && typeof ctx.sidebarRightTabs.get === 'function' && ctx.sidebarRightTabs.get(kind) !== undefined
  const openOwner = kind => {
    if (!hasOwnerTab(kind)) throw new Error('未启用对应插件。')
    ctx.sidebarRight.openTab(kind)
  }
  const navigateView = view => ctx.sidebarRight.openTab(TAB_KIND, { params: { view } })
  const subscribeExtensions = listener => ctx.slots.subscribe(ACTION_SLOT, listener)
  const getExtensions = () => ctx.slots.entries(ACTION_SLOT)
  const companionListeners = new Set()
  let companionStatus = { available: false, reason: '正在检查 RP 助手入口' }
  let refreshCompanion = () => {}
  const onMenuOpen = () => { void refreshCompanion() }
  const subscribeCompanion = listener => { companionListeners.add(listener); return () => companionListeners.delete(listener) }
  const getCompanionStatus = () => companionStatus
  ctx.effect(() => {
    let request
    const refresh = async () => {
      request?.abort()
      const current = new AbortController()
      request = current
      try {
        const status = await readCompanionStatus({ signal: current.signal })
        if (current.signal.aborted) return
        companionStatus = status
      } catch (cause) {
        if (current.signal.aborted) return
        companionStatus = { available: false, reason: cause.message }
      }
      for (const listener of companionListeners) listener()
    }
    refreshCompanion = refresh
    void refresh()
    const unsubscribe = ctx.sidebarRightTabs.subscribe(() => void refresh())
    return () => { request?.abort(); unsubscribe(); refreshCompanion = () => {} }
  }, 'RP companion readiness')
  function useCompanion(targetSessionId) {
    const status = useSyncExternalStore(subscribeCompanion, getCompanionStatus, getCompanionStatus)
    const canOpen = status.available && typeof ctx.uiWorkspace.startSession === 'function'
    return { onOpenCompanion: canOpen ? () => openCompanionSession(ctx, { targetSessionId }) : undefined, onMenuOpen, companionReason: status.available ? '宿主未提供 RP 助手会话入口' : status.reason || 'RP 助手尚未启用' }
  }
  ctx.effect(() => () => { for (const cancel of pending) cancel(new Error('RP Studio 已停用。')) }, 'RP Studio navigation')
  const openSession = id => new Promise((resolve, reject) => {
    let frame
    let timer
    let unsubscribe = () => {}
    const cancel = reason => { if (reason) reject(reason); unsubscribe(); clearTimeout(timer); if (frame) cancelAnimationFrame(frame); pending.delete(cancel) }
    const show = () => {
      if (ctx.sidebarRight.mounted.getSnapshot() !== id) return
      if (frame) cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        frame = undefined
        if (ctx.sidebarRight.mounted.getSnapshot() !== id) return
        try { navigateView('state'); cancel(); resolve() }
        catch (error) { cancel(); reject(error) }
      })
    }
    pending.add(cancel)
    unsubscribe = ctx.sidebarRight.mounted.subscribe(show)
    timer = setTimeout(() => { cancel(); reject(new Error('未能打开故事，请从 dsh 会话列表选择后重试。')) }, 10_000)
    ctx.uiWorkspace.openSession(id)
    show()
  })
  function Body({ sessionId, useTabInfo, openSession: navigate, renderSlot }) {
    const { tab } = useTabInfo()
    const entries = useSyncExternalStore(subscribeExtensions, getExtensions, getExtensions)
    const companion = useCompanion(sessionId)
    const extensions = extensionEntryIds(entries)
    return <Workspace key={sessionId} sessionId={sessionId} visible={tab.visible} navigation={tab.navigation} navigateView={navigateView} registry={ctx.sidebarRightTabs} openSession={navigate} openOwner={openOwner} hasOwnerTab={hasOwnerTab} {...companion} extraActions={extensions.length ? extensions.map(id => <React.Fragment key={id}>{renderSlot(ACTION_SLOT, {}, { only: id })}</React.Fragment>) : null} />
  }
  function Header(props) { return <HeaderEntry {...props} {...useCompanion(props.sessionId)} /> }
  registerWorkspace(ctx, { Body, Button: Header, openSession, headerProps: { registry: ctx.sidebarRightTabs, onOpenOwner: openOwner } })
}
