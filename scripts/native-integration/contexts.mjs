import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { chromium } from '@playwright/test'
import { installInputs, startHost, copyFixtureFiles, closeOwnedResources } from './host.mjs'
import { ownedRunPath } from './paths.mjs'
import { verifyInstalled } from './inputs.mjs'

const endpoints = { database: '/api/rp-database/request', context: '/api/rp-context/request', lastStep: '/api/rp-last-step/request', storyKit: '/api/rp-story-kit/request', gm: '/api/rp-gm/request', studio: '/api/rp-studio/actions' }
export async function openNativeContext({ workspace, run, staged, cli, browserPath, providerURL, name, existing }) {
  const home = join(run, name), fixture = join(run, 'fixture')
  const installed = existing ?? await installInputs({ staged, home, cli, workspace, log: message => console.log(`[full:${name}] ${message}`) })
  if (existing) for (const input of staged.packages) await verifyInstalled(home, input)
  await copyFixtureFiles(workspace, fixture)
  const patch = await ownedRunPath(workspace, run, join(run, `${name}.patch.yml`))
  await writeFile(patch, `- id: session-title-llm\n  disabled: true\n- id: llm-deepseek\n  disabled: true\n- id: llm-deepseek-account\n  disabled: true\n- id: llm-pi-ai\n  disabled: true\n- id: agent-default-model\n  config:\n    provider: studio-native-local\n    model: gm\n- id: tools\n  config:\n    mode: native\n- id: rp-database\n  config:\n    embedding:\n      baseURL: ${providerURL}\n      model: studio-native-embedding\n    reranking:\n      baseURL: ${providerURL}\n      model: studio-native-rerank\n- insert:\n    - id: studio-native-probe\n      name: ${JSON.stringify(join(fixture, 'fixture.mjs').replaceAll('\\', '/'))}\n    - id: studio-native-legacy\n      name: '@deepseek-ai/dsh-agent-preset'\n      config:\n        id: studio-legacy-fixture\n        name: Studio full legacy regression\n        description: Public no-model legacy fixture\n        plugins:\n          - id: rp-runtime\n            name: '@deepseek-ai/dsh-persona'\n            config:\n              prefix: Public synthetic old preset.\n`)
  let host, browser
  const errors = []
  try {
    host = await startHost({ cli, home, patch, workspace, env: installed.env, logPath: join(run, `${name}-${Date.now()}.host.log`) })
    browser = await chromium.launch({ headless: true, ...(browserPath ? { executablePath: browserPath } : {}) })
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    page.setDefaultTimeout(15000)
    page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (['error', 'warn'].includes(message.type())) errors.push(message.text()) })
    await page.addInitScript(() => { Object.defineProperty(window, '__ModuleLoader__', { configurable: true, set(target) {
      Object.defineProperty(window, '__ModuleLoader__', { configurable: true, writable: true, value: target })
      let load = target.load.bind(target)
      const wrapped = row => load(row.id !== 'dsh-rp-studio' ? row : { ...row, factory(require) { const plugin = row.factory(require); return { ...plugin, apply(ctx) { window.__nativeStudioCtx = ctx; return plugin.apply(ctx) } } } })
      Object.defineProperty(target, 'load', { configurable: true, get: () => wrapped, set(next) { load = next.bind(target) } })
    } }) })
    await page.goto(host.url, { waitUntil: 'networkidle' })
    const preview = page.getByRole('button', { name: '继续', exact: true })
    await preview.waitFor({ state: 'visible', timeout: 1000 }).catch(() => {}); if (await preview.isVisible()) await preview.click()
    await page.waitForFunction(() => !!window.__nativeStudioCtx)
    async function request(path, body) {
      const value = await page.evaluate(async ({ path, body }) => {
        const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(45000) })
        return { status: response.status, body: await response.json() }
      }, { path, body })
      if (value.status >= 400 || value.body?.error || value.body?.ok === false) throw Object.assign(new Error(`${value.status}:${JSON.stringify(value.body)}`), { status: value.status, code: value.body?.error?.code, detail: value.body })
      return value.body
    }
    const api = (owner, action, input = {}) => { if (!endpoints[owner]) throw new Error('UNKNOWN_OWNER_ENDPOINT'); return request(endpoints[owner], { action, ...input }) }
    const studio = async (method, path, body) => (await request('/api/rp-studio/request', { method, path, ...(body === undefined ? {} : { body }) })).data
    const probe = async (action, input = {}) => (await request('/api/studio-native-probe', { action, ...input })).result
    const openStudio = async sessionId => {
      await page.evaluate(id => window.__nativeStudioCtx.uiWorkspace.openSession(id), sessionId)
      await page.getByRole('button', { name: '打开 RP Studio', exact: true }).first().click()
      await page.locator(`.dsh-rp-workspace[data-rp-session="${sessionId}"]`).waitFor()
      await page.locator('.rp-empty').waitFor({ state: 'hidden' })
    }
    return { name, home, installed, page, hostPid: host.child.pid, errors, api, studio, probe, request, openStudio, snapshot: sessionId => probe('snapshot', { sessionId }), idle: sessionId => probe('idle', { sessionId }), close: async () => { const failures = await closeOwnedResources(browser, host); if (failures.length) throw new Error(JSON.stringify(failures)) } }
  } catch (error) { await closeOwnedResources(browser, host); throw error }
}

export async function waitForNative(read, accept, label, timeout = 45000) {
  const deadline = Date.now() + timeout
  let last
  while (Date.now() < deadline) { last = await read(); if (accept(last)) return last; await new Promise(done => setTimeout(done, 100)) }
  throw new Error(`NATIVE_WAIT_TIMEOUT:${label}:${JSON.stringify(last).slice(0, 2000)}`)
}
