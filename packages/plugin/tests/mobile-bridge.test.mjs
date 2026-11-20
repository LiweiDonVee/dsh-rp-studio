import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installMobileBridge } from '../src/mobile-bridge.mjs'

const node = (attributes = {}, { hidden = false, children = {} } = {}) => ({
  isConnected: true, getClientRects: () => hidden ? [] : [{}], closest: () => null,
  hasAttribute: key => Object.hasOwn(attributes, key), getAttribute: key => attributes[key],
  querySelector: selector => children[selector] ?? null,
})

function fixture(t, { timeoutMs = 1000 } = {}) {
  const events = [], calls = [], roots = new Map(), mountedListeners = new Set()
  let sessionId = 'before', active, observer, drawerOpen = false, expanded = true
  const target = {
    DshRpMobile: { postMessage: value => events.push(JSON.parse(value)) },
    MutationObserver: class {
      constructor(fn) { observer = fn }
      observe() {}
      disconnect() { observer = undefined }
    },
    document: {
      documentElement: {},
      querySelectorAll: selector => roots.get(selector) ?? [],
      querySelector: selector => selector === '[data-sidebar-drawer]' ? node(drawerOpen ? {} : { 'data-sidebar-collapsed': '' }) : null,
      defaultView: { getComputedStyle: () => ({ visibility: 'visible' }) },
    },
  }
  const mount = id => {
    sessionId = id
    for (const listener of mountedListeners) listener()
  }
  const ctx = {
    sidebarRightTabs: { get: kind => ['rp-studio', 'rp-story-kit', 'rp-database', 'loop-studio'].includes(kind) ? {} : undefined },
    sidebarRight: {
      mounted: { getSnapshot: () => sessionId, subscribe(fn) { mountedListeners.add(fn); return () => mountedListeners.delete(fn) } },
      active: () => active && { kind: active },
      openTab(kind, options) { active = kind; calls.push([kind, options]) },
      isExpanded: () => expanded, toggleExpanded() { expanded = !expanded },
    },
    sessions: { list: { getSnapshot: () => ({ phase: 'ready', byId: { before: { blank: true }, blank: { blank: true } } }) },
      async create(options) { calls.push(['create', options]); return 'blank' } },
    workspaces: { list: { getSnapshot: () => ({ phase: 'ready', items: [{ workspaceId: 'fiction', sessionIds: ['before'] }], archivedSessionIds: [] }) } },
    uiWorkspace: { openSession: mount },
    layout: { toggleSidebar() { drawerOpen = !drawerOpen } },
  }
  const validateSession = async id => calls.push(['validate', id])
  const close = installMobileBridge({ ctx, tabKind: 'rp-studio', validateSession, target, timeoutMs })
  t.after(close)
  return { bridge: target.__dshRpMobile, calls, events, roots, ctx, mount, notify: () => observer?.(), target }
}

test('ACK follows a rendered selected presentation for the exact mounted session and request', async t => {
  const { bridge, calls, events, roots } = fixture(t)
  const target = { requestId: 'reading-1', sessionId: 'story-1', page: 'reading', presentationId: 'result-2' }
  const presentation = node({ 'data-rp-presentation': 'result-2' })
  const surface = (sessionId, requestId) => node({
    'data-rp-session': sessionId, 'data-rp-mobile-page': 'reading', 'data-rp-mobile-request': requestId,
  }, { children: { '[data-rp-presentation]': presentation } })
  roots.set('[data-rp-mobile-page]', [surface('other-story', 'reading-1'), surface('story-1', 'earlier-request')])
  const result = bridge.open(target)
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.deepEqual(calls, [
    ['validate', 'story-1'],
    ['rp-studio', { params: { view: 'story', mobilePage: 'reading', mobileRequest: 'reading-1', presentationId: 'result-2' } }],
  ])
  assert.equal(events.some(event => event.type === 'opened'), false)
  roots.set('[data-rp-mobile-page]', [surface('story-1', 'reading-1')])
  assert.deepEqual(await result, { ok: true, page: 'reading', sessionId: 'story-1', presentationId: 'result-2' })
  assert.deepEqual(events.at(-1), { schemaVersion: 1, type: 'opened', ...target, ok: true })
})

test('global assets mount a real blank seat and ACK only a visible registered owner', async t => {
  const { bridge, calls, events, roots } = fixture(t)
  roots.set('[data-rp-database-session]', [node({ 'data-rp-database-session': 'other' }), node({ 'data-rp-database-session': 'blank' }, { hidden: true })])
  const result = bridge.open({ requestId: 'database', sessionId: null, page: 'assets', ownerKind: 'rp-database' })
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.deepEqual(calls, [['create', { workspaceId: 'fiction' }], ['rp-database', { params: { cacheScope: 'global-assets' } }]])
  assert.equal(events.some(event => event.type === 'opened'), false)
  roots.set('[data-rp-database-session]', [node({ 'data-rp-database-session': 'blank' })])
  assert.deepEqual(await result, { ok: true, sessionId: null, seatSessionId: 'blank', page: 'assets', ownerKind: 'rp-database' })
})

test('rejects forged fields and unavailable owner tabs before any navigation', async t => {
  const { bridge, calls } = fixture(t)
  assert.deepEqual(await bridge.open({ requestId: 'x', sessionId: 'story', page: 'facts', method: 'decideFacts' }), { ok: false, code: 'INVALID_REQUEST' })
  assert.deepEqual(await bridge.open({ requestId: 'x', sessionId: 'story', page: 'constructor', ownerKind: 'rp-context' }), { ok: false, code: 'INVALID_REQUEST' })
  assert.deepEqual(await bridge.open({ requestId: 'x', sessionId: 'story', page: 'tasks' }), { ok: false, code: 'PAGE_UNAVAILABLE' })
  assert.deepEqual(await bridge.open({ requestId: 'x', sessionId: 'story', page: 'context' }), { ok: false, code: 'OWNER_PAGE_UNAVAILABLE' })
  assert.deepEqual(calls, [])
})

test('superseded requests cannot ACK and same-view missing presentations are explicit', async t => {
  const { bridge, events, roots } = fixture(t)
  const obsolete = bridge.open({ requestId: 'old', sessionId: 'story', page: 'reading', presentationId: 'old' })
  const current = bridge.open({ requestId: 'new', sessionId: 'story', page: 'reading', presentationId: 'new' })
  roots.set('[data-rp-mobile-page]', [node({ 'data-rp-session': 'story', 'data-rp-mobile-page': 'reading', 'data-rp-mobile-request': 'new' }, {
    children: { '[data-rp-presentation-missing]': node() },
  })])
  assert.deepEqual(await obsolete, { ok: false, code: 'NAVIGATION_SUPERSEDED' })
  assert.deepEqual(await current, { ok: false, code: 'PRESENTATION_NOT_FOUND' })
  assert.equal(events.some(event => event.type === 'opened'), false)
})

test('sidebar state and actions use the DSH drawer marker and layout service', async t => {
  const { bridge, ctx, events } = fixture(t)
  assert.deepEqual(bridge.sidebarOpen(), { schemaVersion: 1, open: false })
  assert.deepEqual(await bridge.toggleSidebar(), { schemaVersion: 1, open: true })
  assert.equal(ctx.sidebarRight.isExpanded(), false)
  assert.deepEqual(events.at(-1), { schemaVersion: 1, type: 'sidebar', available: true, open: true })
  assert.deepEqual(await bridge.closeSidebar(), { schemaVersion: 1, open: false })
})
