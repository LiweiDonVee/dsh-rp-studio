import { mkdir } from 'node:fs/promises'
import { chromium } from '@playwright/test'

const baseUrl = process.env.DSH_RP_URL ?? 'http://127.0.0.1:4317'
const apiBase = new URL('/api/v1/', baseUrl)
const forbiddenPatterns = ['"secrets"', '"offscreen"', 'hidden-canonical', 'collapse_timeline', 'meta.rp', 'tool/result', 'reasoning']

async function getApi(path) {
  const response = await fetch(new URL(path, apiBase), { headers: { accept: 'application/json' } })
  const text = await response.text()
  if (!response.ok) throw new Error(`GET ${path} returned ${response.status}: ${text.slice(0, 200)}`)
  const forbidden = forbiddenPatterns.filter(pattern => text.includes(pattern))
  if (forbidden.length > 0) throw new Error(`GET ${path} exposed forbidden fields: ${forbidden.join(', ')}`)
  const envelope = JSON.parse(text)
  if (envelope.ok !== true || envelope.protocolVersion !== 1 || !Object.hasOwn(envelope, 'data')) {
    throw new Error(`GET ${path} returned an invalid protocol envelope.`)
  }
  return envelope.data
}

const health = await getApi('health')
if (health.upstream !== 'ready' || typeof health.version !== 'string' || !health.version) {
  throw new Error('Gateway health did not report a ready DSH upstream with a version.')
}
const cards = await getApi('cards')
const cardIds = new Set(cards.map(card => card.id))
if (!cardIds.has('zombie-world')) throw new Error('Required playable RP card is unavailable: zombie-world')
if (!cardIds.has('hp-potion-master')) throw new Error('Required playable RP card is unavailable: hp-potion-master')
if (cardIds.has('rp-runtime')) throw new Error('Runtime template leaked into the playable card list.')
const sessions = await getApi('sessions')
if (sessions.length === 0) throw new Error('No RP session is available for the read-only detail smoke check.')
const details = await Promise.all(sessions.map(session => getApi(`sessions/${encodeURIComponent(session.id)}`)))
for (const [index, detail] of details.entries()) {
  const summary = sessions[index]
  if (detail.session?.id !== summary.id || detail.card?.id !== summary.cardId) {
    throw new Error('Session detail does not match the public session list.')
  }
  if (!cardIds.has(detail.card.id) && detail.card.kind !== 'template') {
    throw new Error(`Historical session ${summary.id} is neither playable nor backed by a runtime template.`)
  }
}

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
const consoleErrors = []
const failedRequests = []
const browserRequests = []

page.on('console', message => {
  if (message.type() === 'error') consoleErrors.push(message.text())
})
page.on('requestfailed', request => {
  failedRequests.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? ''}`)
})
page.on('request', request => browserRequests.push({ method: request.method(), url: request.url() }))

try {
  await page.goto(baseUrl, { waitUntil: 'networkidle' })
  await page.locator('.story-header h1').waitFor()
  const body = await page.locator('body').innerText()
  const forbidden = forbiddenPatterns
    .filter(pattern => body.includes(pattern))
  const images = await page.locator('img').evaluateAll(items => items.map(item => ({
    alt: item.getAttribute('alt'),
    complete: item.complete,
    naturalWidth: item.naturalWidth,
  })))
  const expectedOrigin = new URL(baseUrl).origin
  const foreignRequests = browserRequests.filter(request => new URL(request.url).origin !== expectedOrigin)
  const writeRequests = browserRequests.filter(request => request.method !== 'GET' || /\/(?:messages|prompt)(?:\/|$)/u.test(new URL(request.url).pathname))
  const layout = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
  }))
  await mkdir('test-results/visual', { recursive: true })
  await page.screenshot({ path: 'test-results/visual/real-dsh-1440x960.png' })

  const api = {
    protocolVersion: 1,
    upstreamVersion: health.version,
    cards: cards.map(card => card.id),
    sessionCount: sessions.length,
    checkedSessions: details.map(detail => ({ id: detail.session.id, cardId: detail.card.id, kind: detail.card.kind ?? 'card' })),
  }
  const result = { title: await page.title(), url: page.url(), api, layout, images, forbidden, foreignRequests, writeRequests, consoleErrors, failedRequests }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  if (
    forbidden.length > 0
    || consoleErrors.length > 0
    || failedRequests.length > 0
    || foreignRequests.length > 0
    || writeRequests.length > 0
    || layout.documentWidth > layout.viewportWidth
    || layout.bodyWidth > layout.viewportWidth
    || images.some(image => !image.complete || image.naturalWidth <= 0)
  ) process.exitCode = 1
} finally {
  await browser.close()
}
