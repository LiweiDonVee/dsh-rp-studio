import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from '@playwright/test'
import * as approval from './approval-run.mjs'

let browser
before(async () => { browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) }) })
after(async () => { await browser?.close() })

async function controlledReview({ status = 200, result = { revision: 1, enabled: true } } = {}) {
  const page = await browser.newPage(), requests = []
  page.setDefaultTimeout(2500)
  await page.route('http://approval-ui.test/**', async route => {
    if (route.request().method() === 'POST') {
      requests.push(route.request().postDataJSON())
      await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(result) }); return
    }
    await route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<input type="checkbox" aria-label="本故事事实审批"><script>
      let enabled = false; window.reviewClicks = 0;
      const toggle = document.querySelector('input');
      toggle.addEventListener('change', async event => {
        const desired = event.target.checked; window.reviewClicks++; toggle.checked = enabled;
        const response = await fetch('/api/rp-studio/actions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'configureReview', sessionId: 'story', enabled: desired, expectedRevision: 0 }) });
        const value = await response.json();
        if (response.ok && !value.error) setTimeout(() => { enabled = value.enabled; toggle.checked = enabled; }, 100);
      });
    </script>` })
  })
  await page.goto('http://approval-ui.test/')
  return { page, requests, close: () => page.close() }
}

test('approval toggle waits for the owner response and delayed controlled UI update after exactly one real click', async () => {
  assert.equal(typeof approval.configureApproval, 'function')
  const ui = await controlledReview()
  try {
    assert.deepEqual(await approval.configureApproval(ui, 'story', true), { revision: 1, enabled: true })
    assert.equal(await ui.page.evaluate(() => window.reviewClicks), 1)
    assert.deepEqual(ui.requests, [{ action: 'configureReview', sessionId: 'story', enabled: true, expectedRevision: 0 }])
  } finally { await ui.close() }
})

test('approval toggle retains a failed owner HTTP response as failure after one real click', async () => {
  assert.equal(typeof approval.configureApproval, 'function')
  const ui = await controlledReview({ status: 503, result: { error: { code: 'OWNER_UNAVAILABLE' } } })
  try {
    await assert.rejects(approval.configureApproval(ui, 'story', true), /503/u)
    assert.equal(await ui.page.evaluate(() => window.reviewClicks), 1)
    assert.equal(await ui.page.getByRole('checkbox', { name: '本故事事实审批', exact: true }).isChecked(), false)
  } finally { await ui.close() }
})
