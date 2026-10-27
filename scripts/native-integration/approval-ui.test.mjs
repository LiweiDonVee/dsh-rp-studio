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

test('custom editor fills all typed scene, facts and public packet fields before the exact nested owner submission', async () => {
  assert.equal(typeof approval.fillCustomFacts, 'function')
  const page = await browser.newPage(), posted = []
  const labels = ['场景标题', '场景地点', '场景时间', '在场角色 ID', '事实 1 标识', '事实 1 内容', '事实摘要', '玩家行动', '场景方向', '已经解决的变化', '可见后果', '未决线索', '写作约束', '公开事实引用', '变量 1 名称', '变量 1 内容']
  await page.route('http://custom-ui.test/**', async route => {
    if (route.request().method() === 'POST') { posted.push(route.request().postDataJSON()); await route.fulfill({ json: { status: 'approved' } }); return }
    await route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<form>${labels.map(label => `<textarea aria-label="${label}"></textarea>`).join('')}<button type="submit">采用自定义并继续</button></form><script>
      document.querySelector('form').onsubmit = async event => { event.preventDefault(); const get = label => document.querySelector('[aria-label="' + label + '"]').value, lines = label => get(label).split('\\n');
        const custom = { scene: { schemaVersion: 1, title: get('场景标题'), location: get('场景地点'), time: get('场景时间'), presentActorIds: lines('在场角色 ID') }, facts: { schemaVersion: 1, items: [{ id: get('事实 1 标识'), text: get('事实 1 内容') }] }, summary: get('事实摘要'), packet: { playerAction: get('玩家行动'), sceneInstruction: get('场景方向'), resolvedChanges: lines('已经解决的变化'), visibleConsequences: lines('可见后果'), openHooks: lines('未决线索'), proseConstraints: lines('写作约束'), publicFactRefs: lines('公开事实引用'), variables: { [get('变量 1 名称')]: get('变量 1 内容') } } };
        await fetch('/api/rp-studio/actions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'decideFacts', decision: { sessionId: 'story', action: 'custom', custom } }) });
      };
    </script>` })
  })
  try {
    await page.goto('http://custom-ui.test/')
    const custom = { scene: { schemaVersion: 1, title: 'Human scene', location: 'Human place', time: 'Human time', presentActorIds: ['guide', 'traveler'] }, facts: { schemaVersion: 1, items: [{ id: 'chosen-fact', text: 'Exact human facts' }] }, summary: 'Exact human summary', packet: { playerAction: 'Exact human action', sceneInstruction: 'Exact human direction', resolvedChanges: ['Change one', 'Change two'], visibleConsequences: ['Visible'], openHooks: ['Hook'], proseConstraints: ['Constraint'], publicFactRefs: ['chosen-fact'], variables: { human: 'Human variable' } } }
    await approval.fillCustomFacts({ page }, custom)
    await approval.clickOwner({ page }, 'decideFacts', () => page.getByRole('button', { name: '采用自定义并继续', exact: true }).click(), row => row.decision?.sessionId === 'story')
    assert.deepEqual(posted, [{ action: 'decideFacts', decision: { sessionId: 'story', action: 'custom', custom } }])
  } finally { await page.close() }
})
