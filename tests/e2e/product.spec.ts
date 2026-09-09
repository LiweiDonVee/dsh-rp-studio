import { expect, test, type Page, type Route } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

const now = '2026-09-08T12:00:00.000Z'
const hash = `sha256:${'a'.repeat(64)}`
const token = 'paired-token-' + 'a'.repeat(40)

function ok(data: unknown) { return { ok: true, protocolVersion: 1, data } }
function fail(code: string, message: string) { return { ok: false, protocolVersion: 1, error: { code, message } } }
function json(route: Route, status: number, body: unknown) { return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) }) }

async function installProductMocks(page: Page) {
  const staged = new Set<string>()
  let revoked = false
  const requests: Array<{ url: string; authorization?: string }> = []
  await page.route('**/api/v1/product/**', async route => {
    const request = route.request(); const url = new URL(request.url()); const path = url.pathname
    requests.push({ url: request.url(), authorization: request.headers().authorization })
    const remote = request.headers().authorization
    if (remote === 'Bearer expired-token-' + 'b'.repeat(40)) return json(route, 401, fail('unauthorized', '配对已过期。'))
    if (remote === `Bearer ${token}` && revoked) return json(route, 401, fail('unauthorized', '移动端认证已撤销。'))
    if (path === '/api/v1/product/status') return json(route, 200, ok({ apiVersion: 1, dshCompatibility: '0.1.2-rc.1', storage: 'ready', schemaVersion: 1, projection: 'current', pairing: { enabled: true, listener: 'https-lan' } }))
    if (path === '/api/v1/product/pairing') return json(route, 200, ok({ enabled: true, listener: 'https-lan' }))
    if (path === '/api/v1/product/pairing/clients') return json(route, 200, ok([{ clientId: 'client-1', clientName: '测试手机', scopes: ['product:read'], sessionIds: ['session-1'], createdAt: now, expiresAt: '2099-09-08T12:00:00.000Z', revoked: false }]))
    if (path === '/api/v1/product/pairing/codes') {
      const body = request.postDataJSON() as Record<string, unknown>; const keys = Object.keys(body).sort().join(',')
      if (keys !== 'clientName,requestedScopes,sessionIds') return json(route, 400, fail('bad-request', '配对码请求包含未知字段。'))
      return json(route, 200, ok({ code: 'one-time-code-123456789', expiresAt: '2099-09-08T12:05:00.000Z', requestedScopes: body.requestedScopes, sessionIds: body.sessionIds }))
    }
    if (path === '/api/v1/product/pairing/confirm') {
      const body = request.postDataJSON() as Record<string, unknown>; if (Object.keys(body).sort().join(',') !== 'clientName,code') return json(route, 400, fail('bad-request', '配对确认请求包含未知字段。'))
      return json(route, 200, ok({ clientId: 'client-1', token, scopes: ['product:read'], sessionIds: ['session-1'], expiresAt: '2099-09-08T12:00:00.000Z' }))
    }
    if (path === '/api/v1/product/bootstrap') {
      if (remote !== `Bearer ${token}`) return json(route, 401, fail('unauthorized', '需要移动端认证。'))
      return json(route, 200, ok({ clientId: 'client-1', clientName: '测试手机', scopes: ['product:read'], expiresAt: '2099-09-08T12:00:00.000Z', sessions: [{ sessionId: 'session-1', cardId: 'zombie-world', title: 'D 区封锁线' }] }))
    }
    if (path.endsWith('/notifications/stream')) {
      if (remote !== `Bearer ${token}`) return json(route, 401, fail('unauthorized', '需要移动端认证。'))
      const item = { id: 'n-stream', cursor: 'c-stream', type: 'story', title: '剧情有新进展', body: '走廊尽头传来响动。', createdAt: now, acknowledged: false }
      return route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: `id: c-stream\nevent: notification\ndata: ${JSON.stringify(item)}\n\n` })
    }
    if (url.searchParams.get('sessionId') && url.searchParams.get('sessionId') !== 'session-1') return json(route, 403, fail('forbidden', '该故事档案未授权。'))
    if (path === '/api/v1/product/assets' && request.method() === 'POST') {
      const body = request.postDataJSON() as Record<string, unknown>; const allowed = ['category', 'contentBase64', 'fileName', 'label', 'mimeType']
      if (Object.keys(body).some(key => !allowed.includes(key))) return json(route, 400, fail('bad-request', '资产请求包含未知字段。'))
      const encoded = String(body.contentBase64 ?? ''); const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0; const bytes = Math.floor(encoded.length * 3 / 4) - padding
      if (bytes > 10 * 1024 * 1024) return json(route, 413, fail('payload-too-large', '资产大小超过 10 MiB 限制。'))
      return json(route, 201, ok({ id: hash, fileName: body.fileName, mimeType: body.mimeType, category: body.category, label: body.label, bytes, createdAt: now }))
    }
    if (path === '/api/v1/product/assets') {
      const second = url.searchParams.get('cursor') === 'assets-2'
      return json(route, 200, ok({ items: [{ id: hash, fileName: second ? '第二页.webp' : '主角头像.webp', mimeType: 'image/webp', category: 'portrait', bytes: 1200, createdAt: now }], nextCursor: second ? null : 'assets-2' }))
    }
    if (path === `/api/v1/product/assets/${encodeURIComponent(hash)}` && request.method() === 'GET') return route.fulfill({ status: 200, headers: { 'content-type': 'image/webp', 'content-disposition': 'attachment; filename="asset.webp"', 'x-content-type-options': 'nosniff' }, body: 'asset' })
    if (path === '/api/v1/product/ledger') return json(route, 200, ok({ items: [{ id: 'ledger-1', commandId: 'command-1', amountMinor: -1250, currency: 'USD', description: '旅店住宿', occurredAt: now, createdAt: now }], nextCursor: null }))
    if (path === '/api/v1/product/knowledge') return json(route, 200, ok({ items: [{ id: 'user-1', text: '玩家确认的安全屋', source: 'user', createdAt: now, updatedAt: now }, { id: 'rp-1', text: '走廊里有脚印', source: 'rp-projection', provenance: { branchId: 'branch-1', sourceSeq: 4 }, createdAt: now, updatedAt: now }], nextCursor: null }))
    if (path === '/api/v1/product/memory') return json(route, 200, ok({ items: [{ id: 'memory-1', sessionId: 'session-1', branchId: 'branch-1', sourceSeq: 4, text: '在 D 区发现陌生脚印', emotion: '警觉' }], nextCursor: null }))
    if (path === '/api/v1/product/relationships') return json(route, 200, ok({ items: [{ id: 'relation-1', sessionId: 'session-1', branchId: 'branch-1', sourceSeq: 4, subject: '伊莱亚斯', object: '守卫', relation: '互相戒备' }], nextCursor: null }))
    if (path === '/api/v1/product/locations') return json(route, 200, ok({ items: [{ id: 'location-1', sessionId: 'session-1', branchId: 'branch-1', sourceSeq: 4, world: '末日洛杉矶', region: 'MDC D 区', scene: '封锁走廊' }], nextCursor: null }))
    if (path === '/api/v1/product/notifications') return json(route, 200, ok({ items: [], cursor: 'n0', resetRequired: false }))
    if (path === '/api/v1/product/backups' && request.method() === 'GET') return json(route, 200, ok({ items: [{ id: 'backup-1', schemaVersion: 1, scope: { workspaceId: 'workspace-1', sessionId: 'session-1', cardId: 'zombie-world', branchId: 'branch-1' }, createdAt: now, state: 'ready', manifestHash: hash, includes: { authoritativeAppData: true, rpProjections: true, dshSessions: false } }], nextCursor: null }))
    if (path.endsWith('/stage-restore')) { staged.add('backup-1'); return json(route, 200, ok({ backupId: 'backup-1', restoreToken: 'restore-token-long-enough', expiresAt: '2099-09-08T12:05:00.000Z', manifestHash: hash })) }
    if (path.endsWith('/commit-restore')) { if (!staged.has('backup-1')) return json(route, 409, fail('conflict', '必须先验证备份。')); return json(route, 200, ok({ restored: true, rollbackBackupId: 'rollback-1' })) }
    return json(route, 404, fail('not-found', 'mock route missing'))
  })
  return { requests, revoke: () => { revoked = true } }
}

test('product console paginates within session and separates user notes from read-only story data', async ({ page }) => {
  const mock = await installProductMocks(page)
  await page.goto('/product?sessionId=session-1')
  await expect(page.getByRole('heading', { name: '资产与表情包' })).toBeVisible()
  await expect(page.getByText('主角头像.webp')).toBeVisible()
  await page.getByRole('button', { name: '加载更多' }).click()
  await expect(page.getByText('第二页.webp')).toBeVisible()
  expect(mock.requests.filter(item => item.url.includes('/assets?')).every(item => item.url.includes('sessionId=session-1'))).toBe(true)
  await page.locator('nav[aria-label="产品管理"] button[data-section="knowledge"]').click()
  const userNote = page.getByRole('article').filter({ has: page.getByText('玩家确认的安全屋', { exact: true }) })
  const storyNote = page.getByRole('article').filter({ has: page.getByText('走廊里有脚印', { exact: true }) })
  await expect(userNote.getByText('用户笔记 · 可编辑', { exact: true })).toBeVisible()
  await expect(userNote.getByRole('button', { name: '编辑', exact: true })).toBeVisible()
  await expect(userNote.getByRole('button', { name: '删除', exact: true })).toBeVisible()
  await expect(storyNote.getByText('只读剧情资料', { exact: true })).toBeVisible()
  await expect(storyNote.getByRole('button')).toHaveCount(0)
})

test('strict mock rejects unknown DTOs, real file limit, commit-before-stage, expired token, and ungranted session', async ({ page }) => {
  await installProductMocks(page); await page.goto('/companion')
  const results = await page.evaluate(async ({ hugeLength, expired, valid }) => {
    const post = (url: string, body: unknown, authorization?: string) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) }, body: JSON.stringify(body) }).then(async response => ({ status: response.status, body: await response.json() }))
    return {
      unknown: await post('/api/v1/product/assets?sessionId=session-1', { fileName: 'x.png', mimeType: 'image/png', category: 'portrait', contentBase64: 'AA==', path: 'C:/secret' }),
      huge: await post('/api/v1/product/assets?sessionId=session-1', { fileName: 'x.png', mimeType: 'image/png', category: 'portrait', contentBase64: 'A'.repeat(hugeLength) }),
      commit: await post('/api/v1/product/backups/backup-1/commit-restore?sessionId=session-1', { restoreToken: 'restore-token-long-enough' }),
      expired: await fetch('/api/v1/product/bootstrap', { headers: { authorization: `Bearer ${expired}` } }).then(async response => ({ status: response.status, body: await response.json() })),
      ungranted: await fetch('/api/v1/product/memory?sessionId=session-2&limit=20', { headers: { authorization: `Bearer ${valid}` } }).then(async response => ({ status: response.status, body: await response.json() })),
    }
  }, { hugeLength: Math.ceil((10 * 1024 * 1024 + 1) * 4 / 3), expired: 'expired-token-' + 'b'.repeat(40), valid: token })
  expect(results.unknown).toMatchObject({ status: 400, body: { error: { code: 'bad-request' } } })
  expect(results.huge).toMatchObject({ status: 413, body: { error: { code: 'payload-too-large' } } })
  expect(results.commit).toMatchObject({ status: 409, body: { error: { code: 'conflict' } } })
  expect(results.expired).toMatchObject({ status: 401, body: { error: { code: 'unauthorized' } } })
  expect(results.ungranted).toMatchObject({ status: 403, body: { error: { code: 'forbidden' } } })
})

test('mobile companion bootstraps only authorized sessions, streams with bearer fetch, and shows revocation', async ({ page }) => {
  const mock = await installProductMocks(page); await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/companion')
  await page.getByLabel('companion 客户端名称').fill('测试手机')
  await page.getByLabel('一次性配对短码').fill('one-time-code-123456789')
  await page.getByRole('button', { name: '确认配对' }).click()
  await expect(page.getByLabel('已授权故事档案')).toHaveValue('session-1')
  await page.getByRole('button', { name: '读取公开状态' }).click()
  await expect(page.getByText('在 D 区发现陌生脚印')).toBeVisible()
  await expect(page.getByText('剧情有新进展')).toBeVisible()
  expect(mock.requests.find(item => item.url.includes('/bootstrap'))?.authorization).toBe(`Bearer ${token}`)
  expect(mock.requests.find(item => item.url.includes('/notifications/stream'))?.authorization).toBe(`Bearer ${token}`)
  expect(await page.evaluate(() => localStorage.length)).toBe(0)
  mock.revoke()
  await page.getByRole('button', { name: '读取公开状态' }).click()
  await expect(page.getByRole('alert')).toContainText('unauthorized')
  const dimensions = await page.evaluate(() => ({ viewport: innerWidth, scroll: document.documentElement.scrollWidth }))
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.viewport)
})

test('product mobile module sheet is keyboard reachable and has no serious accessibility violations', async ({ page }) => {
  await installProductMocks(page); await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/product?sessionId=session-1')
  await page.getByRole('button', { name: '模块' }).focus(); await page.keyboard.press('Enter')
  const dialog = page.getByRole('dialog', { name: '产品管理模块' })
  await expect(dialog).toBeVisible(); await expect(dialog.getByRole('button', { name: '关闭' })).toBeFocused()
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(page.getByRole('button', { name: '模块' })).toBeFocused()
  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations.filter(item => item.impact === 'serious' || item.impact === 'critical')).toEqual([])
})
