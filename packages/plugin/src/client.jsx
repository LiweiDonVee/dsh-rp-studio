import React from 'react'
import { Workspace, HeaderEntry } from './Workspace.jsx'
import { registerWorkspace, TAB_KIND } from './register.mjs'
import css from './workspace.css'

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
  const openOwner = kind => { if (hasOwnerTab(kind)) ctx.sidebarRight.openTab(kind) }
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
        try { ctx.sidebarRight.openTab(TAB_KIND); cancel(); resolve() }
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
    return <Workspace key={sessionId} sessionId={sessionId} visible={tab.visible} openSession={navigate} openOwner={openOwner} hasOwnerTab={hasOwnerTab} extraActions={renderSlot('rp.studio.workspace.actions', {})} />
  }
  registerWorkspace(ctx, { Body, Button: HeaderEntry, openSession })
}
