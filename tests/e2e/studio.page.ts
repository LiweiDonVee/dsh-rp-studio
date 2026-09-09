import { expect, type Page } from '@playwright/test'

export class StudioPage {
  constructor(readonly page: Page) {}

  async open(): Promise<void> {
    await this.page.goto('/')
    await expect(this.page.getByRole('heading', { name: 'D 区封锁线' })).toBeVisible()
  }

  async send(text: string): Promise<void> {
    await this.page.getByLabel('玩家行动').fill(text)
    await this.page.getByRole('button', { name: '发送行动' }).click()
  }

  async openCampaigns(): Promise<void> {
    await this.page.getByRole('button', { name: '打开世界与会话' }).click()
    await expect(this.page.getByRole('dialog', { name: '世界与会话' })).toBeVisible()
  }

  async openInspector(): Promise<void> {
    await this.page.getByRole('button', { name: '打开公开状态' }).click()
    await expect(this.page.getByRole('dialog', { name: '公开状态' })).toBeVisible()
  }

  async expectNoHorizontalOverflow(): Promise<void> {
    const dimensions = await this.page.evaluate(() => ({
      viewport: window.innerWidth,
      document: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
    }))
    expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport)
    expect(dimensions.body).toBeLessThanOrEqual(dimensions.viewport)
  }
}
