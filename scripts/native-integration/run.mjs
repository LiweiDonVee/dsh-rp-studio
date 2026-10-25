import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import { stageInputs } from './inputs.mjs'
import { assessServices } from './requirements.mjs'
import { assertRunDirectory, defaultCli, installInputs, startHost, copyFixtureFiles, redact, closeOwnedResources } from './host.mjs'
import { ownedRunPath } from './paths.mjs'
import { executeFullNative } from './full-run.mjs'

const { values } = parseArgs({ options: { manifest: { type: 'string' }, mode: { type: 'string', default: 'prepare' }, run: { type: 'string' }, cli: { type: 'string' }, browser: { type: 'string' }, ui: { type: 'boolean', default: false }, help: { type: 'boolean' } } })
if (values.help) { console.log('node scripts/native-integration/run.mjs --manifest <reviewed-inputs.json> --mode prepare|inspect|diagnose|full [--ui] [--run <workspace/.runtime/run>] [--cli <dsh>] [--browser <chromium>]\nFull requires coordinator-approved final inputs. Diagnose can never produce finalAcceptance:true.'); process.exit(0) }
if (!values.manifest || !['prepare', 'inspect', 'diagnose', 'full'].includes(values.mode)) throw new Error('Use an explicit reviewed manifest and supported mode.')
const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const run = await assertRunDirectory(workspace, resolve(values.run ?? join(workspace, '.runtime', `studio-native-${Date.now()}`)))
const manifestPath = resolve(values.manifest), input = JSON.parse(await readFile(manifestPath, 'utf8'))
input.packages = input.packages?.map(item => ({ ...item, path: resolve(dirname(manifestPath), item.path) }))
if (['diagnose', 'full'].includes(values.mode) && input.stage !== 'final') throw new Error('FULL_REQUIRES_APPROVED_FINAL_INPUTS')
await mkdir(run, { recursive: true })
const marker = await ownedRunPath(workspace, run, join(run, 'owner.json'))
try { const previous = JSON.parse(await readFile(marker, 'utf8')); if (previous.workspace !== workspace) throw new Error('RUN_DIRECTORY_NOT_OWNED') }
catch (error) { if (error.code !== 'ENOENT') throw error; await writeFile(marker, JSON.stringify({ workspace, purpose: 'studio-native-isolated-test' }) + '\n', { flag: 'wx' }) }
const staged = await stageInputs(input, run, workspace)
if (['diagnose', 'full'].includes(values.mode)) {
  const result = await executeFullNative({ workspace, run, staged, cli: values.cli ?? defaultCli(), browserPath: values.browser ?? process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, diagnostic: values.mode === 'diagnose' })
  console.log(JSON.stringify({ run, mode: values.mode, fullChain: result.fullChain, scenarios: result.scenarios.map(row => ({ id: row.id, status: row.status })), error: result.error }))
  process.exit(result.fullChain.status === 'passed' || result.fullChain.status === 'diagnostic-complete' ? 0 : result.fullChain.status === 'deferred' ? 2 : 1)
}
const log = message => console.log(`[native-preparation] ${message}`)
const report = { schemaVersion: 1, scope: 'ST-B preparation; actual installed product interfaces, not full-chain acceptance', run, mode: values.mode, inputStage: staged.stage, fullChain: { status: 'not-run', reason: 'Final accepted inputs and separately dispatched full scenario execution are required.' }, packages: staged.packages.map(({ name, version, sha256, archive }) => ({ name, version, sha256, archive })) }
let host, browser
try {
  if (values.mode === 'prepare') { report.prepared = true; log('immutable inputs prepared; no host or product workflow was started') }
  else {
    const home = join(run, 'home-a')
    const installed = await installInputs({ staged, home, workspace, cli: values.cli ?? defaultCli(), log })
    report.hostVersion = installed.version; report.installed = installed.installed
    const fixture = join(run, 'fixture')
    await copyFixtureFiles(workspace, fixture)
    const patch = join(run, 'fixture.patch.yml')
    await writeFile(await ownedRunPath(workspace, run, patch), `- id: session-title-llm\n  disabled: true\n- id: llm-deepseek\n  disabled: true\n- id: llm-deepseek-account\n  disabled: true\n- id: llm-pi-ai\n  disabled: true\n- id: agent-default-model\n  config:\n    provider: studio-native-local\n    model: gm\n- id: tools\n  config:\n    mode: native\n- insert:\n    - id: studio-native-probe\n      name: ${JSON.stringify(join(fixture, 'fixture.mjs').replaceAll('\\', '/'))}\n    - id: studio-native-legacy\n      name: '@deepseek-ai/dsh-agent-preset'\n      config:\n        id: studio-legacy-fixture\n        name: Studio legacy inspection fixture\n        description: Public synthetic no-model fixture\n        plugins:\n          - id: rp-runtime\n            name: '@deepseek-ai/dsh-persona'\n            config:\n              prefix: Public synthetic legacy inspection. No model prompt is sent.\n`)
    log('starting a new official host process from verified installed bytes')
    host = await startHost({ cli: values.cli ?? defaultCli(), home, patch, workspace, env: installed.env, logPath: join(run, 'host.log') })
    report.hostPid = host.child.pid
    browser = await chromium.launch({ headless: true, ...(values.browser ?? process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: values.browser ?? process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) })
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors = []
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
    await preview.waitFor({ state: 'visible', timeout: 1500 }).catch(() => {})
    if (await preview.isVisible()) await preview.click()
    async function request(path, body) {
      return page.evaluate(async ({ path, body }) => {
        const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) })
        const result = await response.json()
        if (!response.ok) throw new Error(JSON.stringify(result))
        return result
      }, { path, body })
    }
    report.observed = (await request('/api/studio-native-probe', { action: 'ready' })).result
    report.assessment = assessServices(report.observed)
    report.studioCapabilities = await request('/api/rp-studio/actions', { action: 'capabilities' })
    report.health = await request('/api/rp-studio/request', { method: 'GET', path: '/api/v1/health' })
    if (!report.health.ok || report.health.data.upstream !== 'ready') throw new Error('NATIVE_STUDIO_HEALTH_FAILED')
    if (values.ui) {
      const created = await request('/api/rp-studio/request', { method: 'POST', path: '/api/v1/sessions', body: { cardId: 'studio-legacy-fixture' } })
      if (!created.ok) throw new Error('NATIVE_STUDIO_LEGACY_CREATE_FAILED')
      await page.waitForFunction(() => !!window.__nativeStudioCtx)
      await page.evaluate(id => window.__nativeStudioCtx.uiWorkspace.openSession(id), created.data.session.id)
      await page.getByRole('button', { name: '打开 RP Studio', exact: true }).click()
      const panel = page.locator('.dsh-rp-workspace')
      await panel.locator('.rp-scene').waitFor()
      report.legacyUi = []
      for (const [name, width] of [['sidebar', 1440], ['full', 1440], ['narrow', 520]]) {
        if (name === 'full') { await page.getByRole('button', { name: '全屏', exact: true }).click(); await page.waitForFunction(() => document.querySelector('.dsh-rp-workspace')?.clientWidth > 1000) }
        await page.setViewportSize({ width, height: 1000 })
        const metrics = await panel.evaluate(element => ({ width: element.clientWidth, height: element.clientHeight, overflow: element.scrollWidth > element.clientWidth }))
        if (metrics.overflow || metrics.width < 250 || metrics.height < 200) throw new Error(`NATIVE_LAYOUT_FAILED:${name}`)
        report.legacyUi.push({ name, ...metrics }); await page.screenshot({ path: await ownedRunPath(workspace, run, join(run, `legacy-${name}.png`)) })
      }
    }
    report.models = (await request('/api/studio-native-probe', { action: 'models' })).result
    if (report.models.total !== 0) throw new Error('INSPECTION_MUST_NOT_GENERATE')
    report.browserErrors = errors
    if (errors.length) throw new Error(`BROWSER_ERRORS:${JSON.stringify(errors)}`)
    report.inspectionCompleted = true
    log(`inspection complete; interfacesReady=${report.assessment.interfacesReady}; deferred=${report.assessment.deferred.length}; fullChain=not-run`)
  }
} catch (error) { report.error = redact(error.message); process.exitCode = 1; console.error(report.error) }
finally {
  const cleanupErrors = await closeOwnedResources(browser, host)
  if (cleanupErrors.length) { report.cleanupErrors = cleanupErrors; report.error ??= 'OWNED_RESOURCE_CLEANUP_FAILED'; process.exitCode = 1 }
  await writeFile(await ownedRunPath(workspace, run, join(run, 'inspection.json')), JSON.stringify(report, null, 2) + '\n')
}
console.log(JSON.stringify({ run, mode: values.mode, prepared: report.prepared, inspectionCompleted: report.inspectionCompleted, deferred: report.assessment?.deferred.length, fullChain: report.fullChain.status, error: report.error }))
