import { mkdir } from 'node:fs/promises'
import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import { StudioPage } from './studio.page.js'

const SECRET_PATTERNS = ['MOCK_DSH_CANARY_SECRET', 'meta.rp', '"secrets"']

test.beforeEach(async ({ page, context }, testInfo) => {
  await context.addCookies([{
    name: 'dsh-rp-e2e',
    value: `${testInfo.workerIndex}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    domain: '127.0.0.1',
    path: '/',
  }])
  const jsonBodies: string[] = []
  page.on('response', async response => {
    const contentType = response.headers()['content-type'] ?? ''
    if (contentType.includes('application/json')) {
      try { jsonBodies.push(await response.text()) } catch { /* closed response */ }
    }
  })
  test.info().annotations.push({ type: 'network-audit', description: 'JSON response bodies captured for secret scan' })
  Reflect.set(page, '__jsonBodies', jsonBodies)
})

test.afterEach(async ({ page }) => {
  const bodies = Reflect.get(page, '__jsonBodies') as string[]
  const combined = `${bodies.join('\n')}\n${await page.locator('body').innerText()}`
  for (const pattern of SECRET_PATTERNS) expect(combined).not.toContain(pattern)
})

test('desktop narrative workflow streams, rolls back, forks, and controls autoplay', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 })
  const studio = new StudioPage(page)
  await studio.open()
  await expect(page.locator('img[alt="世界模拟器世界档案"]').first()).toHaveJSProperty('complete', true)
  await studio.send('沿着脚印继续调查')
  await expect(page.getByText('脚印在灰土里突然转向，没入两排牢门之间的暗处。')).toBeVisible()
  await expect(page.getByText('4 个关键快照')).toBeVisible()

  await page.getByRole('button', { name: '回退上一轮' }).click()
  await expect(page.getByText('沿着脚印继续调查')).toHaveCount(0)
  await expect(page.getByText('3 个关键快照')).toBeVisible()
  await page.getByRole('button', { name: '回退上一轮' }).click()
  await expect(page.getByText('2 个关键快照')).toBeVisible()

  await page.getByRole('button', { name: '启动自动续跑' }).click()
  await page.getByLabel('轮数').fill('4')
  await page.getByLabel('目标').fill('推进调查')
  await page.getByRole('button', { name: '启动', exact: true }).click()
  await page.getByRole('tab', { name: '任务' }).click()
  await expect(page.getByText('推进调查')).toBeVisible()
  await page.getByRole('button', { name: '管理自动续跑' }).click()
  await page.getByRole('button', { name: '停止', exact: true }).click()
  await expect(page.getByText('推进调查')).toHaveCount(0)

  await page.getByRole('button', { name: '从当前档案创建分支' }).click()
  await expect(page.getByRole('heading', { name: /D 区封锁线 · 分支/ })).toBeVisible()
  await studio.expectNoHorizontalOverflow()

  await mkdir('test-results/visual', { recursive: true })
  await page.screenshot({ path: 'test-results/visual/studio-1440x960.png' })
})

test('creates, resumes, cancels, and switches campaign sessions', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 })
  const studio = new StudioPage(page)
  await studio.open()

  await page.getByRole('button', { name: '以世界模拟器创建档案' }).click()
  await expect(page.getByRole('heading', { name: '世界模拟器' })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('heading', { name: '世界模拟器' })).toBeVisible()

  await studio.send('检查门后的响动')
  await page.getByRole('button', { name: '停止当前回合' }).click()
  await expect(page.getByRole('button', { name: '发送行动' })).toBeVisible()
  await page.waitForTimeout(120)
  await expect(page.getByText('脚印在灰土里突然转向，没入两排牢门之间的暗处。')).toHaveCount(0)
  await expect(page.getByText('检查门后的响动')).toBeVisible()

  await page.locator('.session-entry').filter({ hasText: 'D 区封锁线' }).click()
  await expect(page.getByRole('heading', { name: 'D 区封锁线' })).toBeVisible()
  await studio.expectNoHorizontalOverflow()
})

test('keeps optional narrative methods empty by default and applies them next turn', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 })
  const studio = new StudioPage(page)
  await studio.open()

  await page.getByRole('tab', { name: '方法' }).click()
  await expect(page.getByText(/当前没有启用任何叙事方法/)).toBeVisible()
  await expect(page.getByText('Agent runtime core')).toBeVisible()
  await expect(page.getByRole('checkbox', { name: '梦鲸·实验文风（Agent）' })).not.toBeChecked()

  await page.getByRole('checkbox', { name: '梦鲸思客 V3 · Agent 特调全部方法' }).check()
  await page.getByRole('button', { name: '应用到下一轮' }).click()
  await expect(page.getByText('叙事方法已保存，将从下一轮生效。')).toBeVisible()
  await expect(page.getByText(/NEXT TURN/)).toBeVisible()

  await page.reload()
  await page.getByRole('tab', { name: '方法' }).click()
  await expect(page.getByRole('checkbox', { name: '梦鲸·实验文风（Agent）' })).toBeChecked()
  await studio.expectNoHorizontalOverflow()
})

test('mobile sheets preserve the narrative as the primary surface', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const studio = new StudioPage(page)
  await studio.open()
  await mkdir('test-results/visual', { recursive: true })
  await studio.openCampaigns()
  await expect(page.getByRole('dialog', { name: '世界与会话' }).getByText('世界模拟器')).toBeVisible()
  await page.screenshot({ path: 'test-results/visual/studio-390x844-campaigns.png' })
  await page.getByRole('button', { name: '关闭世界与会话' }).click()
  await studio.openInspector()
  await expect(page.getByRole('dialog', { name: '公开状态' }).getByText(/个关键快照/)).toBeVisible()
  await page.getByRole('dialog', { name: '公开状态' }).getByRole('tab', { name: '方法' }).click()
  const inspector = page.getByRole('dialog', { name: '公开状态' })
  await expect(inspector.getByText('Agent runtime core')).toBeVisible()
  const applyBox = await inspector.getByRole('button', { name: '应用到下一轮' }).boundingBox()
  const footerBox = await inspector.locator('.checkpoint-footer').boundingBox()
  expect(applyBox).not.toBeNull()
  expect(footerBox).not.toBeNull()
  expect((applyBox?.y ?? 0) + (applyBox?.height ?? 0)).toBeLessThanOrEqual(footerBox?.y ?? 0)
  await page.screenshot({ path: 'test-results/visual/studio-390x844-inspector.png' })
  await page.getByRole('button', { name: '关闭公开状态' }).click()
  await studio.expectNoHorizontalOverflow()
  await page.screenshot({ path: 'test-results/visual/studio-390x844.png' })
})

for (const viewport of [
  { width: 1024, height: 768 },
  { width: 360, height: 800 },
]) {
  test(`layout remains bounded at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport)
    const studio = new StudioPage(page)
    await studio.open()
    await studio.expectNoHorizontalOverflow()
    await expect(page.getByLabel('玩家行动')).toBeVisible()
    await mkdir('test-results/visual', { recursive: true })
    await page.screenshot({ path: `test-results/visual/studio-${viewport.width}x${viewport.height}.png` })
  })
}

test('has no serious or critical accessibility violations', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 })
  const studio = new StudioPage(page)
  await studio.open()
  const results = await new AxeBuilder({ page }).analyze()
  const violations = results.violations.filter(item => item.impact === 'serious' || item.impact === 'critical')
  expect(violations).toEqual([])
})
