import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerWorkspace, TAB_ID, TAB_KIND } from '../src/register.mjs'

test('native header entry and sidebar type/body register and dispose together', () => {
  const entries = []
  const types = []
  const effects = []
  const opened = []
  const ctx = {
    effect(fn) { effects.push(fn()); },
    sidebarRightTabs: { register(value) { types.push(value); return () => types.splice(types.indexOf(value), 1) } },
    slots: { inject(_name, fn) { return fn() }, register(options, component) { const row = { options, component }; entries.push(row); return () => entries.splice(entries.indexOf(row), 1) } },
    sidebarRight: { openTab(kind) { opened.push(kind) } },
  }
  function Body() {}
  function Button() {}
  registerWorkspace(ctx, { Body, Button, openSession() {} })
  assert.equal(types[0].id, TAB_ID)
  assert.equal(types[0].kind, TAB_KIND)
  assert.equal(entries.find(row => row.options.name === 'sidebar.right.pane.tab').options.key, TAB_ID)
  assert.deepEqual(entries.find(row => row.options.name === 'sidebar.right.pane.tab').options.children, {
    'rp.studio.workspace.actions': { kind: 'list', scope: 'session' },
  })
  const entry = entries.find(row => row.options.name === 'conversation.session.header.actions')
  assert.equal(entry.options.id, TAB_ID)
  assert.equal(entries.find(row => row.options.name === 'conversation.hero.options').options.id, TAB_ID)
  entry.options.inject().openRp()
  assert.deepEqual(opened, [TAB_KIND])
  for (const dispose of effects.reverse()) dispose?.()
  assert.equal(entries.length, 0)
  assert.equal(types.length, 0)
})
