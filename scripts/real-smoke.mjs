import { mkdir } from 'node:fs/promises'
import { chromium } from '@playwright/test'

const baseUrl = process.env.DSH_RP_URL ?? 'http://127.0.0.1:4317'
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
const consoleErrors = []
const failedRequests = []
const requestUrls = []

page.on('console', message => {
  if (message.type() === 'error') consoleErrors.push(message.text())
})
page.on('requestfailed', request => {
  failedRequests.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? ''}`)
})
page.on('request', request => requestUrls.push(request.url()))

try {
  await page.goto(baseUrl, { waitUntil: 'networkidle' })
  await page.locator('.story-header h1').waitFor()
  const body = await page.locator('body').innerText()
  const forbidden = ['"secrets"', 'hidden-canonical', 'collapse_timeline', 'meta.rp', 'tool/result', 'reasoning']
    .filter(pattern => body.includes(pattern))
  const images = await page.locator('img').evaluateAll(items => items.map(item => ({
    alt: item.getAttribute('alt'),
    complete: item.complete,
    naturalWidth: item.naturalWidth,
  })))
  const expectedOrigin = new URL(baseUrl).origin
  const foreignRequests = requestUrls.filter(url => new URL(url).origin !== expectedOrigin)
  const layout = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
  }))
  await mkdir('test-results/visual', { recursive: true })
  await page.screenshot({ path: 'test-results/visual/real-dsh-1440x960.png' })

  const result = { title: await page.title(), url: page.url(), layout, images, forbidden, foreignRequests, consoleErrors, failedRequests }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  if (
    forbidden.length > 0
    || consoleErrors.length > 0
    || failedRequests.length > 0
    || foreignRequests.length > 0
    || layout.documentWidth > layout.viewportWidth
    || layout.bodyWidth > layout.viewportWidth
    || images.some(image => !image.complete || image.naturalWidth <= 0)
  ) process.exitCode = 1
} finally {
  await browser.close()
}
