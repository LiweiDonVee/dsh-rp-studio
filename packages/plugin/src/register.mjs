export const TAB_ID = 'dsh-rp-studio/workspace'
export const TAB_KIND = 'rp-studio'

export function registerWorkspace(ctx, { Body, Button, openSession }) {
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: TAB_ID, kind: TAB_KIND, title: () => 'RP Studio',
    guide: [{ id: 'rp-studio', order: 35, title: () => 'RP Studio', description: () => '角色、剧情与沉浸阅读' }],
  }), 'RP Studio tab type')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: TAB_ID, inject: () => ({ openSession }),
    children: { 'rp.studio.workspace.actions': { kind: 'list', scope: 'session' } },
  }, Body)), 'RP Studio tab body')
  ctx.effect(() => ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions', id: TAB_ID, order: 35,
    inject: () => ({ openRp: () => ctx.sidebarRight.openTab(TAB_KIND) }),
  }, Button)), 'RP Studio header entry')
  // DSH hides title actions for blank conversations; keep the same entry in its native hero options.
  ctx.effect(() => ctx.slots.inject('conversation.hero.options', () => ctx.slots.register({
    name: 'conversation.hero.options', id: TAB_ID, order: 35,
    inject: () => ({ openRp: () => ctx.sidebarRight.openTab(TAB_KIND) }),
  }, Button)), 'RP Studio blank conversation entry')

}
