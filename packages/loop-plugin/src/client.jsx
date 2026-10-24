import React from 'react'
import { HeaderEntry, LoopWorkspace } from './LoopWorkspace.jsx'
import css from './styles.css'

export const inject = ['slots', 'sidebarRight', 'sidebarRightTabs']
export const TAB_ID = 'dsh-loop-studio/workspace'
export const TAB_KIND = 'loop-studio'

export function apply(ctx) {
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.dshLoopStudio = ''
    style.textContent = css
    document.head.append(style)
    return () => style.remove()
  }, 'Loop Studio styles')
  function Body({ sessionId, useTabInfo }) {
    const { tab } = useTabInfo()
    return <LoopWorkspace key={sessionId} sessionId={sessionId} visible={tab.visible} />
  }
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: TAB_ID, kind: TAB_KIND, title: () => 'Loop Studio',
    guide: [{ id: TAB_KIND, order: 36, title: () => 'Loop Studio', description: () => '查看 Agent 执行流程与节点模型' }],
  }), 'Loop Studio tab type')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: TAB_ID,
  }, Body)), 'Loop Studio tab body')
  for (const name of ['conversation.session.header.actions', 'conversation.hero.options']) {
    ctx.effect(() => ctx.slots.inject(name, () => ctx.slots.register({
      name, id: TAB_ID, order: 36,
      inject: () => ({ openLoop: () => ctx.sidebarRight.openTab(TAB_KIND) }),
    }, HeaderEntry)), `Loop Studio ${name}`)
  }
}
