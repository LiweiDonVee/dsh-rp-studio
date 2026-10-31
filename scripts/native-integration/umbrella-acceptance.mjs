import { spawn, execFile } from 'node:child_process'
import { promisify, parseArgs } from 'node:util'
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import { verifyInstalled, PACKAGE_NAMES } from './inputs.mjs'
import { runCli, stopOwned, redact, defaultCli } from './host.mjs'
import { nativeCompanion } from './umbrella-companion.mjs'

const execute = promisify(execFile)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const ownerPages = [
  { name: 'dsh-rp-story-kit', kind: 'rp-story-kit', label: '角色与素材', root: '.rpsk', heading: 'h1', ordinary: '.rpsk-field > span', entry: '.rpsk-native-entry' },
  { name: 'dsh-rp-database', kind: 'rp-database', label: '数据库', root: '.rpdb', heading: '.rpdb-heading h2', ordinary: '.rpdb-field > span', entry: '.rpdb-open-entry' },
  { name: 'dsh-rp-context', kind: 'rp-context', label: '上下文', root: '.rpc-workspace', heading: 'h1', ordinary: 'label', entry: '.rpc-open-entry' },
  { name: 'dsh-rp-gm', kind: 'rp-gm', label: '故事 GM', root: '.rpgm-workspace', heading: '.rpgm-heading h2', ordinary: '.rpgm-card p', entry: '.rpgm-open-entry' },
  { name: 'dsh-rp-last-step', kind: 'rp-last-step', label: '写作预设与正文', root: '.dsh-rp-last-step', heading: '.rpls-heading h1', ordinary: '.rpls-field > span', entry: '.rpls-open-entry' },
  { name: 'dsh-loop-studio', kind: 'loop-studio', label: '流程与模型', root: '.dsh-loop-workspace', heading: '.loop-heading h1', ordinary: 'label', entry: '.dsh-loop-entry' },
]
const allEntries = ownerPages.map(row => row.entry).join(',')
const q = value => {
  if (/["\r\n%]/u.test(value)) throw new Error('Unsupported launcher argument')
  return process.platform === 'win32' ? `"${value}"` : value
}
const assert = (condition, detail) => { if (!condition) throw new Error(detail) }
const timestamp = () => new Date().toISOString()

async function stage(input, out) {
  assert(input.hostVersion === '0.2.1-rc.5', 'Coordinator final rc.5 manifest required')
  assert(input.packages.length === 7 && new Set(input.packages.map(row => row.name)).size === 7 && PACKAGE_NAMES.every(name => input.packages.some(row => row.name === name)), 'All seven unique RP artifacts required')
  const directory = join(out, 'inputs')
  await mkdir(directory, { recursive: true })
  const packages = []
  for (const item of input.packages) {
    const bytes = await readFile(item.path)
    assert(/^[a-f0-9]{64}$/u.test(item.sha256) && hash(bytes) === item.sha256, `Archive SHA mismatch: ${item.name}`)
    const archive = join(directory, `${item.name}-${item.version}-${item.sha256}.tgz`)
    await writeFile(archive, bytes, { flag: 'wx' })
    const tar = async entry => (await execute('tar', ['-xOf', archive, `package/${entry}`], { encoding: 'buffer', windowsHide: true, maxBuffer: 16 * 1024 * 1024 })).stdout
    const manifest = JSON.parse((await tar('package.json')).toString('utf8'))
    assert(manifest.name === item.name && manifest.version === item.version, `Package identity mismatch: ${item.name}`)
    const entries = new Set(['package.json', manifest.main, manifest.exports['./client'], manifest.dsh.bundle.patch].map(value => value.replace(/^\.\//u, '')))
    if (item.name === 'dsh-rp-studio') {
      assert(typeof manifest.exports['./companion'] === 'string', 'Installable companion export missing')
      entries.add(manifest.exports['./companion'].replace(/^\.\//u, ''))
      entries.add('skills/managing-rp-studio/SKILL.md')
      entries.add('THIRD-PARTY-NOTICES.md')
    }
    const files = {}
    for (const entry of entries) files[entry] = hash(await tar(entry))
    packages.push({ ...item, archive, files })
  }
  return { hostVersion: input.hostVersion, stage: 'final', packages }
}

async function install(staged, out, cli) {
  const home = join(out, 'home')
  await mkdir(home)
  await writeFile(join(home, 'package.json'), '{"name":"rp-umbrella-isolated-native-home","private":true,"type":"module"}\n', { flag: 'wx' })
  const env = { ...process.env, DSH_HOME: home, DSH_TOOLS_MODE: 'native', DSH_PERMISSION_MODE: 'danger-full-access' }
  for (const name of Object.keys(env)) if (/API_KEY$|ACCESS_TOKEN$|AUTH_TOKEN$/u.test(name)) delete env[name]
  const version = await runCli(cli, ['--version'], env, workspace)
  assert(version === staged.hostVersion, `Actual host mismatch: ${version}`)
  const installed = []
  for (const input of staged.packages) {
    console.log(`[umbrella] install ${input.name}@${input.version}`)
    const output = await runCli(cli, ['plugin', '--profile', 'web', 'add', input.archive], env, workspace)
    await writeFile(join(out, `install-${input.name}.log`), redact(output))
    installed.push(await verifyInstalled(home, input))
  }
  return { home, env, installed, version }
}

async function start({ home, env }, out, cli, segment = 'initial', extraPatch = '') {
  const fixture = join(out, 'umbrella-fixture.mjs')
  if (segment === 'initial') await writeFile(fixture, await readFile(join(workspace, 'scripts/native-integration/umbrella-fixture.mjs')), { flag: 'wx' })
  const patch = join(out, `${segment}.patch.yml`)
  await writeFile(patch, `- id: session-title-llm\n  disabled: true\n- id: llm-deepseek\n  disabled: true\n- id: llm-deepseek-account\n  disabled: true\n- id: llm-pi-ai\n  disabled: true\n- id: agent-default-model\n  config:\n    provider: rp-umbrella-local\n    model: umbrella\n- id: sandbox-policy\n  config:\n    mode: danger-full-access\n- id: tools\n  config:\n    mode: native\n- insert:\n    - id: rp-umbrella-native-probe\n      name: ${JSON.stringify(fixture.replaceAll('\\', '/'))}\n    - id: preset-umbrella-story\n      name: '@deepseek-ai/dsh-agent-preset'\n      config:\n        id: umbrella-story\n        name: 合成菜单验收故事\n        description: No private data. No model is required to browse this synthetic story.\n        plugins:\n          - id: rp-runtime\n            name: '@deepseek-ai/dsh-persona'\n            config:\n              prefix: Public synthetic RP umbrella acceptance fixture.\n`, { flag: 'wx' })
  if (extraPatch) await writeFile(patch, (await readFile(patch, 'utf8')) + extraPatch)
  const child = spawn(q(cli), ['web', '--patch', patch, '--host', '127.0.0.1', '--port', '0', '--no-open'].map(q), { cwd: workspace, env: { ...env, DSH_HOME: home }, shell: process.platform === 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let logs = '', launchError
  child.on('error', error => { launchError = error })
  for (const stream of [child.stdout, child.stderr]) stream.on('data', value => { logs += value })
  const close = async () => { await stopOwned(child); await writeFile(join(out, `${segment}.host.log`), redact(logs)) }
  try {
    const deadline = Date.now() + 60000
    while (Date.now() < deadline) {
      if (launchError) throw launchError
      const url = /https?:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/u.exec(logs)?.[0]
      if (url) return { child, url, close }
      if (child.exitCode !== null) throw new Error(`Host exited ${child.exitCode}: ${redact(logs.slice(-4000))}`)
      await new Promise(done => setTimeout(done, 100))
    }
    throw new Error(`Host startup timed out: ${redact(logs.slice(-4000))}`)
  } catch (error) { await close(); throw error }
}

async function instrument(page) {
  await page.addInitScript(() => {
    window.__umbrella = { contexts: {}, modules: null, extensionClicks: 0 }
    Object.defineProperty(window, '__ModuleLoader__', { configurable: true, set(target) {
      Object.defineProperty(window, '__ModuleLoader__', { configurable: true, writable: true, value: target })
      let load = target.load.bind(target)
      const observed = row => load({ ...row, factory(require) {
        const plugin = row.factory(require)
        if (typeof plugin.apply !== 'function') return plugin
        if (!/^dsh-(?:rp-|loop-)/u.test(row.id) && !['@deepseek-ai/dsh-client-ui-workspace', '@deepseek-ai/dsh-client-ui-theme', '@deepseek-ai/dsh-client-ui-conversation'].includes(row.id)) return plugin
        return { ...plugin, apply(ctx, ...args) {
          window.__umbrella.contexts[row.id] = ctx
          if (row.id === 'dsh-rp-studio') window.__umbrella.react = require('react')
          return plugin.apply(ctx, ...args)
        } }
      } })
      Object.defineProperty(target, 'load', { configurable: true, get: () => observed, set(next) { load = next.bind(target) } })
      const create = target.create.bind(target)
      target.create = options => { const modules = create(options); window.__umbrella.modules = modules; return modules }
    } })
  })
}

async function syncClients(page, includedRP) {
  return page.evaluate(async included => {
    const boot = window.__DSH_BOOT__, wanted = new Set(included)
    const entries = boot.entries.filter(row => !/^dsh-(?:rp-|loop-)/u.test(row.id) || wanted.has(row.id))
    const ids = new Set(entries.map(row => row.id))
    const graph = { ...boot, entries, batches: boot.batches.map(row => ({ ...row, entries: row.entries.filter(id => ids.has(id)) })).filter(row => row.entries.length) }
    await window.__umbrella.modules.entries.sync(graph)
    const ctx = window.__umbrella.contexts['@deepseek-ai/dsh-client-ui-workspace']
    const registry = ctx.get('sidebarRightTabs')
    return { graphEntries: entries.map(row => row.id), registered: registry.entries().map(row => ({ id: row.id, kind: row.kind })), state: window.__umbrella.modules.entries.state.getSnapshot(), styles: [...document.querySelectorAll('style')].map(row => ({ plugin: row.dataset.plugin, attributes: [...row.attributes].map(item => item.name) })).filter(row => row.plugin?.startsWith('dsh-rp') || row.attributes.some(name => /rp|loop/u.test(name))) }
  }, includedRP)
}

async function nativeUi({ page, report, scenario, shot, request, probe }) {
  const header = () => page.getByRole('button', { name: 'RP', exact: true }).filter({ visible: true }).first()
  const menu = () => page.getByRole('menu', { name: 'RP 工作区菜单' })
  const openMenu = async trigger => { await trigger.click(); await menu().waitFor() }
  const choose = async (label, role = 'menuitem') => { await openMenu(header()); await menu().getByRole(role, { name: label, exact: true }).click(); await menu().waitFor({ state: 'hidden' }) }
  report.initialRegistry = await page.evaluate(() => window.__umbrella.contexts['dsh-rp-studio'].sidebarRightTabs.entries().map(row => ({ id: row.id, kind: row.kind })))

  await scenario('blank-hero-entry-and-menu', async () => {
    assert(await page.getByRole('button', { name: 'RP', exact: true }).count() === 1, 'Expected one RP entry in blank hero')
    assert(await page.locator(allEntries).count() === 0, 'Duplicate owner entry while Studio installed')
    const before = await probe('models'), sessions = await probe('sessions')
    await openMenu(header())
    report.blankMenu = await menu().innerText()
    await shot('blank-menu')
    await page.keyboard.press('Escape')
    assert((await probe('models')).models.length === before.models.length, 'Opening menu executed a model')
    assert(JSON.stringify(await probe('sessions')) === JSON.stringify(sessions), 'Opening menu created/changed sessions')
  })
  await scenario('ordinary-session-owner-routes', async () => {
    report.routes = []
    for (const owner of ownerPages) {
      await choose(owner.label)
      await page.locator(owner.root).filter({ visible: true }).first().waitFor()
      const route = await page.evaluate(() => window.__umbrella.contexts['dsh-rp-studio'].sidebarRight.openTabs.getSnapshot())
      report.routes.push({ kind: owner.kind, root: owner.root, visible: true, route, text: (await page.locator(owner.root).filter({ visible: true }).first().innerText()).slice(0, 1200) })
    }
    await shot('ordinary-loop-route')
  })
  let storyId
  await scenario('synthetic-story-creation', async () => {
    const created = await request('/api/rp-studio/request', { method: 'POST', path: '/api/v1/sessions', body: { cardId: 'umbrella-story' } })
    storyId = created.data.session.id
    report.storySessionId = storyId
    await page.evaluate(id => window.__umbrella.contexts['dsh-rp-studio'].uiWorkspace.openSession(id), storyId)
    await page.waitForFunction(id => window.__umbrella.contexts['dsh-rp-studio'].sidebarRight.mounted.getSnapshot() === id, storyId)
  })
  await scenario('studio-real-view-navigation', async () => {
    assert(storyId, 'Synthetic story unavailable')
    report.views = []
    for (const [view, label, selector] of [['state', '角色与剧情', '.rp-state'], ['story', '沉浸阅读', '.rp-story'], ['archive', '故事档案与开局', '.rp-archive'], ['state', '角色与剧情', '.rp-state'], ['story', '沉浸阅读', '.rp-story']]) {
      await choose(label, 'menuitemradio')
      await page.locator(`.dsh-rp-workspace ${selector}`).waitFor()
      const state = await page.evaluate(() => window.__umbrella.contexts['dsh-rp-studio'].sidebarRight.openTabs.getSnapshot())
      report.views.push({ view, selector, state })
    }
    await page.locator('.dsh-rp-workspace .dsh-rp-menu-trigger').click()
    await menu().getByRole('menuitemradio', { name: '角色与剧情', exact: true }).click()
    await page.locator('.dsh-rp-workspace .rp-state').waitFor()
    await page.evaluate(() => window.__umbrella.contexts['dsh-rp-studio'].sidebarRight.openTab('rp-studio', { params: { view: 'unknown-view' } }))
    await page.locator('.dsh-rp-workspace .rp-state').waitFor()
    await shot('studio-state')
  })
  await scenario('keyboard-outside-and-focus', async () => {
    const trigger = page.locator('.dsh-rp-workspace .dsh-rp-menu-trigger')
    await trigger.focus(); await page.keyboard.press('ArrowDown'); await menu().waitFor()
    await page.keyboard.press('End')
    report.endKey = await page.evaluate(() => ({ text: document.activeElement?.textContent, role: document.activeElement?.getAttribute('role') }))
    await page.keyboard.press('Home')
    assert(await menu().getByRole('menuitemradio', { name: '角色与剧情', exact: true }).evaluate(el => el === document.activeElement), 'Home did not focus first menu item')
    await page.keyboard.press('Escape'); await menu().waitFor({ state: 'hidden' })
    assert(await trigger.evaluate(el => el === document.activeElement), 'Escape did not return focus')
    await openMenu(trigger); await page.mouse.click(2, 2); await menu().waitFor({ state: 'hidden' })
    await page.waitForFunction(() => document.activeElement?.matches('.dsh-rp-workspace .dsh-rp-menu-trigger'))
    assert(await trigger.evaluate(el => el === document.activeElement), 'Outside click did not return focus')
    await openMenu(trigger)
    const outsideInput = page.locator('.dsh-rp-workspace textarea').filter({ visible: true }).last()
    await outsideInput.click(); await menu().waitFor({ state: 'hidden' })
    assert(await outsideInput.evaluate(el => el === document.activeElement), 'Outside input focus was stolen after menu close')
    report.focusChecks = { escapeReturnedToTrigger: true, blankOutsideReturnedToTrigger: true, outsideInputRetainedFocus: true }
    await openMenu(trigger)
    const refreshed = page.waitForResponse(response => response.url().endsWith('/api/rp-studio/request') && response.request().postDataJSON()?.path === '/api/v1/cards')
    await page.getByRole('button', { name: '刷新 RP 工作区', exact: true }).click()
    await menu().waitFor({ state: 'hidden' }); assert((await refreshed).ok(), 'Outside button did not execute its real refresh action')
    await page.getByRole('button', { name: '刷新 RP 工作区', exact: true }).waitFor()
    report.focusChecks.outsideRefreshButtonExecuted = true
    await openMenu(trigger); await trigger.click(); await menu().waitFor({ state: 'hidden' })
  })
  await scenario('third-party-slot-contribution', async () => {
    await page.evaluate(() => {
      const ctx = window.__umbrella.contexts['dsh-rp-studio'], React = window.__umbrella.react
      window.__umbrella.disposeExtension = ctx.slots.inject('rp.studio.workspace.actions', () => ctx.slots.register({ name: 'rp.studio.workspace.actions', id: 'umbrella-native-extension', order: 999 }, () => React.createElement('button', { type: 'button', onClick: () => { window.__umbrella.extensionClicks++ } }, '合成扩展操作')))
    })
    await page.locator('.dsh-rp-workspace .dsh-rp-menu-trigger').click()
    const extension = menu().getByRole('button', { name: '合成扩展操作', exact: true })
    await extension.click(); await menu().waitFor({ state: 'hidden' })
    assert(await page.evaluate(() => window.__umbrella.extensionClicks) === 1, 'Third-party contribution inaccessible')
    await page.evaluate(() => window.__umbrella.disposeExtension())
  })
  await scenario('wide-sidebar-and-390-layout', async () => {
    report.layouts = []
    for (const width of [1440, 390]) {
      await choose('角色与剧情', 'menuitemradio')
      await page.setViewportSize({ width, height: 900 })
      const root = page.locator('.dsh-rp-workspace')
      await root.waitFor()
      await openMenu(root.locator('.dsh-rp-menu-trigger'))
      const layout = await menu().evaluate(el => { const rect = el.getBoundingClientRect(); return { x: rect.x, right: rect.right, width: rect.width, height: rect.height, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, overflowX: el.scrollWidth > el.clientWidth + 1, rowHeights: [...el.querySelectorAll('button')].map(row => { const css = getComputedStyle(row); return { text: row.textContent, height: row.getBoundingClientRect().height, fontFamily: css.fontFamily, fontSize: css.fontSize, fontWeight: css.fontWeight } }) } })
      const panel = await root.evaluate(el => ({ width: el.clientWidth, height: el.clientHeight, scrollWidth: el.scrollWidth, overflowX: el.scrollWidth > el.clientWidth + 1 }))
      report.layouts.push({ width, menu: layout, panel })
      assert(layout.x >= 0 && layout.right <= width && !layout.overflowX && !panel.overflowX, `Horizontal overflow at ${width}`)
      assert(layout.rowHeights.every(row => row.height >= 44), 'Menu touch row shorter than 44px')
      assert(new Set(layout.rowHeights.map(row => `${row.fontFamily}|${row.fontSize}`)).size === 1, 'Menu item font families or sizes differ')
      await shot(`menu-${width}`)
      await page.keyboard.press('Escape')
    }
    await page.setViewportSize({ width: 1440, height: 1000 })
  })
  await fontMatrix({ page, report, scenario, shot, choose })
  await scenario('native-registry-missing-owner-and-reload', async () => {
    const included = PACKAGE_NAMES.filter(name => name !== 'dsh-rp-database')
    report.dynamicMissing = await syncClients(page, included)
    await openMenu(header())
    const row = menu().getByRole('menuitem', { name: '数据库', exact: true })
    assert(await row.isDisabled(), 'Missing owner still enabled')
    assert((await row.locator('..').innerText()).includes('未启用对应插件'), 'Missing owner reason absent')
    await shot('missing-database')
    await page.keyboard.press('Escape')
    report.dynamicReload = await syncClients(page, PACKAGE_NAMES)
    await choose('数据库'); await page.locator('.rpdb').filter({ visible: true }).waitFor()
  })
  await scenario('each-owner-client-standalone-and-studio-late-load', async () => {
    report.standalone = []
    for (const owner of ownerPages) {
      const state = await syncClients(page, [owner.name])
      const entry = page.locator(owner.entry).filter({ visible: true })
      await entry.waitFor()
      assert(await entry.count() === 1, `${owner.kind} standalone entry count`)
      await entry.click(); await page.locator(owner.root).filter({ visible: true }).first().waitFor()
      await shot(`standalone-${owner.kind}`)
      report.standalone.push({ owner: owner.kind, state, entryVisible: true, rootVisible: true })
      await syncClients(page, [owner.name, 'dsh-rp-studio'])
      await entry.waitFor({ state: 'hidden' })
      await header().waitFor()
      assert(await page.locator(owner.entry).count() === 0, 'Independent owner entry remains after Studio load')
    }
    report.finalRegistry = await syncClients(page, PACKAGE_NAMES)
  })
}

async function fontMatrix({ page, report, scenario, shot, choose }) {
  await scenario('computed-font-matrix-and-host-isolation', async () => {
    report.fonts = []
    const studio = { kind: 'rp-studio', label: '沉浸阅读', root: '.dsh-rp-workspace', heading: '.rp-heading h1, .rp-heading h2', ordinary: '.rp-action label, .rp-action button, .rp-heading button' }
    for (const theme of ['light', 'dark']) for (const size of [14, 20]) {
      await page.evaluate(({ theme, size }) => { const ctx = window.__umbrella.contexts['dsh-rp-studio']; ctx.get('theme').setTheme(theme); ctx.get('theme').setFontSize('text', size) }, { theme, size })
      await page.waitForFunction(size => getComputedStyle(document.body).getPropertyValue('--dsh-content-font-size').trim() === `${size}px`, size)
      for (const owner of [studio, ...ownerPages]) {
        await choose(owner.label, owner.kind === 'rp-studio' ? 'menuitemradio' : 'menuitem')
        const root = page.locator(owner.root).filter({ visible: true }).first()
        await root.waitFor()
        if (owner.kind === 'rp-story-kit') {
          await root.getByRole('button', { name: '新建角色资产', exact: true }).click()
          await root.locator('.rpsk-field > span').first().waitFor()
        }
        if (owner.kind === 'rp-database') {
          const summary = root.locator('summary').filter({ hasText: '新建数据库' })
          await summary.waitFor()
          if (!await summary.evaluate(el => el.parentElement.open)) await summary.click()
        }
        await root.locator(owner.ordinary).filter({ visible: true }).first().waitFor()
        await root.locator('input:not([type=hidden]):not([type=checkbox]):not([type=file]),textarea:not([readonly]),select').filter({ visible: true }).first().waitFor()
        const row = await root.evaluate((el, owner) => {
          const visible = value => !!value && value.getBoundingClientRect().width > 0 && value.getBoundingClientRect().height > 0
          const read = value => { if (!value) return null; const css = getComputedStyle(value); return { tag: value.tagName, class: value.className, text: value.textContent?.trim().slice(0, 120), fontFamily: css.fontFamily, fontSize: css.fontSize, fontWeight: css.fontWeight, lineHeight: css.lineHeight } }
          const pick = selector => [...el.querySelectorAll(selector)].find(visible)
          return { root: read(el), heading: read(pick(owner.heading)), ordinary: read(pick(owner.ordinary)), input: read(pick('input:not([type=hidden]):not([type=checkbox]):not([type=file]), textarea:not([readonly]), select')), allHeadings: [...el.querySelectorAll('h1,h2,h3')].filter(visible).map(read), inputs: [...el.querySelectorAll('input:not([type=hidden]),textarea,select')].filter(visible).map(read) }
        }, owner)
        report.fonts.push({ theme, size, kind: owner.kind, ...row })
        assert(row.root.fontSize === `${size}px`, `${owner.kind} root font ${row.root.fontSize} != ${size}px`)
        assert(row.ordinary?.fontSize === `${size}px`, `${owner.kind} ordinary font ${row.ordinary?.fontSize} != ${size}px`)
        assert(row.heading && row.heading.fontSize === `${size + 5}px`, `${owner.kind} heading ${row.heading?.fontSize} != ${size + 5}px`)
        assert(row.input && row.input.fontSize === `${size}px`, `${owner.kind} input ${row.input?.fontSize} != ${size}px`)
        assert([row.root, row.ordinary, row.heading, row.input].filter(Boolean).every(item => item.fontFamily === row.root.fontFamily), `${owner.kind} UI font families differ`)
      }
      await shot(`font-${theme}-${size}`)
      const isolation = await page.evaluate(() => {
        const roots = '.dsh-rp-workspace,.dsh-rp-menu,.rpdb,.rpc-workspace,.rpsk,.rpgm-workspace,.dsh-rp-last-step,.rpls-prose-workspace,.dsh-loop-workspace'
        const elements = [...document.querySelectorAll('button,input,textarea,h1,h2,p')].filter(el => !el.closest(roots) && el.getBoundingClientRect().width > 0).slice(0, 35)
        const read = () => elements.map(el => { const css = getComputedStyle(el); return { tag: el.tagName, class: el.className, text: el.textContent?.trim().slice(0, 80), fontSize: css.fontSize, fontFamily: css.fontFamily, lineHeight: css.lineHeight, color: css.color } })
        const before = read(), sheets = [...document.querySelectorAll('style')].filter(el => el.hasAttribute('data-dsh-rp-studio') || el.hasAttribute('data-dsh-loop-studio') || /^dsh-(?:rp-|loop-)/u.test(el.dataset.plugin ?? '') || /rpdb|rpc-workspace|rpsk|rpgm|rpls/u.test(el.textContent.slice(0, 500)))
        for (const style of sheets) style.disabled = true
        const without = read()
        for (const style of sheets) style.disabled = false
        return { before, without, sheetCount: sheets.length, equal: JSON.stringify(before) === JSON.stringify(without) }
      })
      report.hostIsolation ??= []
      report.hostIsolation.push({ theme, size, ...isolation })
      assert(isolation.before.length > 0 && isolation.equal, 'RP styles changed non-RP host computed styles')
    }
    await page.evaluate(() => { const theme = window.__umbrella.contexts['dsh-rp-studio'].get('theme'); theme.setTheme('light'); theme.setFontSize('text', 14) })
  })
}

async function run(options) {
  const manifestPath = resolve(options.manifest), input = JSON.parse(await readFile(manifestPath, 'utf8'))
  input.packages = input.packages.map(item => ({ ...item, path: resolve(dirname(manifestPath), item.path) }))
  const out = resolve(options.out ?? join(workspace, '.runtime', `umbrella-native-${Date.now()}`))
  await mkdir(out, { recursive: true })
  await writeFile(join(out, 'umbrella-run-owner.json'), JSON.stringify({ workspace: await realpath(workspace), created: timestamp(), purpose: 'isolated RP umbrella acceptance' }), { flag: 'wx' })
  const report = { schemaVersion: 1, started: timestamp(), mode: options.mode, output: out, hostVersion: null, finalAcceptance: false, status: 'running', scenarios: [], console: [], pageErrors: [], requestFailures: [], http: [], externalNetwork: [], screenshots: [] }
  let host, browser, page
  const scenario = async (id, action) => {
    console.log(`[umbrella] ${id}`)
    const row = { id, started: timestamp(), status: 'running', pageErrorStart: report.pageErrors.length }
    report.scenarios.push(row)
    try { await action(); assert(report.pageErrors.length === row.pageErrorStart, 'Native browser pageerror during scenario'); row.status = 'passed' }
    catch (error) { row.status = 'failed'; row.error = redact(error.stack ?? error.message); console.error(`[umbrella] FAIL ${id}: ${redact(error.message)}`); if (page) await page.screenshot({ path: join(out, `failure-${id}.png`) }).catch(() => {}) }
    row.finished = timestamp()
    await writeFile(join(out, 'native-acceptance.progress.json'), JSON.stringify(report, null, 2))
  }
  const shot = async name => { const path = join(out, `${name}.png`); await page.screenshot({ path }); report.screenshots.push({ name, path }) }
  const pendingHTTP = new Set()
  try {
    const staged = await stage(input, out)
    report.packages = staged.packages
    await writeFile(join(out, 'staged-inputs.json'), JSON.stringify(staged, null, 2))
    if (options.mode === 'prepare') { report.status = 'prepared'; return report }
    const installed = await install(staged, out, options.cli ?? defaultCli())
    Object.assign(report, { installed: installed.installed, home: installed.home, hostVersion: installed.version })
    host = await start(installed, out, options.cli ?? defaultCli())
    report.hostPid = host.child.pid
    report.segments = [{ name: 'initial', hostPid: host.child.pid, home: installed.home, started: timestamp() }]
    browser = await chromium.launch({ headless: true, ...(options.browser ? { executablePath: options.browser } : {}) })
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    page.setDefaultTimeout(10000)
    page.on('pageerror', error => report.pageErrors.push({ time: timestamp(), message: error.message, stack: error.stack }))
    page.on('console', message => { if (['error', 'warn'].includes(message.type())) report.console.push({ time: timestamp(), type: message.type(), text: redact(message.text()) }) })
    page.on('requestfailed', request => report.requestFailures.push({ time: timestamp(), url: redact(request.url()), error: request.failure()?.errorText }))
    page.on('response', response => {
      const request = response.request(), pathname = new URL(response.url()).pathname
      if (!pathname.startsWith('/api/rp-') && response.status() < 400) return
      const row = { time: timestamp(), url: redact(response.url()), method: request.method(), status: response.status() }
      if (request.method() === 'POST') try { row.input = request.postDataJSON() } catch {}
      report.http.push(row)
      const pending = response.text().then(text => { row.body = redact(text).slice(0, 196608); row.bodyLength = text.length }, error => { row.bodyReadError = error.message })
      pendingHTTP.add(pending); void pending.finally(() => pendingHTTP.delete(pending))
    })
    await page.route('**/*', async route => {
      const url = new URL(route.request().url())
      if (['127.0.0.1', 'localhost'].includes(url.hostname) || !['http:', 'https:'].includes(url.protocol)) return route.continue()
      report.externalNetwork.push({ url: redact(url.href), time: timestamp() }); return route.abort('blockedbyclient')
    })
    await instrument(page)
    await page.goto(host.url, { waitUntil: 'networkidle' })
    const preview = page.getByRole('button', { name: '继续', exact: true })
    await preview.waitFor({ state: 'visible', timeout: 1200 }).catch(() => {})
    if (await preview.isVisible()) await preview.click()
    await page.waitForFunction(() => !!window.__umbrella.contexts['dsh-rp-studio'] && !!window.__umbrella.modules)
    const request = async (path, input) => {
      const response = await page.request.post(new URL(path, page.url()).href, { data: input, timeout: 45000 })
      const body = await response.json()
      report.http.push({ time: timestamp(), url: path, method: 'POST', status: response.status(), input, body })
      assert(response.ok() && body?.ok !== false && !body?.error, `HTTP ${response.status()} ${path}: ${JSON.stringify(body)}`)
      return body
    }
    const probe = async (action, input = {}) => (await request('/api/rp-umbrella-native-probe', { action, ...input })).result
    const restart = async (segment, extraPatch = '') => {
      const previous = report.segments.at(-1)
      previous.models = await probe('models')
      await page.goto('about:blank')
      await host.close(); previous.cleanup = 'stopped'; previous.finished = timestamp()
      host = await start(installed, out, options.cli ?? defaultCli(), segment, extraPatch)
      report.segments.push({ name: segment, hostPid: host.child.pid, home: installed.home, started: timestamp() })
      await page.goto(host.url, { waitUntil: 'networkidle' })
      const preview = page.getByRole('button', { name: '继续', exact: true })
      await preview.waitFor({ state: 'visible', timeout: 600 }).catch(() => {})
      if (await preview.isVisible()) await preview.click()
      await page.waitForFunction(() => !!window.__umbrella.contexts['dsh-rp-studio'])
      for (const input of staged.packages) await verifyInstalled(installed.home, input)
    }
    report.ready = await probe('ready')
    if (options.mode !== 'companion') await nativeUi({ page, report, scenario, shot, request, probe })
    else await scenario('diagnostic-companion-target-fixture', async () => {
      const created = await request('/api/rp-studio/request', { method: 'POST', path: '/api/v1/sessions', body: { cardId: 'umbrella-story' } })
      report.storySessionId = created.data.session.id
      await page.evaluate(id => window.__umbrella.contexts['dsh-rp-studio'].uiWorkspace.openSession(id), report.storySessionId)
      await page.waitForFunction(id => window.__umbrella.contexts['dsh-rp-studio'].sidebarRight.mounted.getSnapshot() === id, report.storySessionId)
    })
    if (['full', 'companion'].includes(options.mode)) await nativeCompanion({ page, report, out, scenario, shot, request, probe, restart })
    report.models = await probe('models')
    report.totalLocalModelRequests = report.models.models.length + (report.segments ?? []).reduce((total, segment) => total + (segment.models?.models.length ?? 0), 0)
    assert(options.mode !== 'ui' || report.models.models.length === 0, 'UI-only acceptance unexpectedly executed a model')
    report.status = report.scenarios.every(row => row.status === 'passed') && report.pageErrors.length === 0 && report.externalNetwork.length === 0 ? 'passed' : 'failed'
  } catch (error) { report.status = 'failed'; report.error = redact(error.stack ?? error.message); console.error(redact(error.message)) }
  finally {
    const cleanup = []
    for (const [name, close] of [['browser', () => browser?.close()], ['host', () => host?.close()]]) {
      try { await close(); cleanup.push({ name, status: 'stopped' }) }
      catch (error) { cleanup.push({ name, status: 'failed', error: error.message }); report.status = 'failed' }
    }
    await Promise.allSettled(pendingHTTP)
    report.cleanup = cleanup; report.finished = timestamp()
    if (report.segments?.length) { report.segments.at(-1).cleanup = cleanup.find(row => row.name === 'host')?.status; report.segments.at(-1).finished = timestamp() }
    report.finalAcceptance = options.mode === 'full' && report.status === 'passed' && cleanup.every(row => row.status === 'stopped')
    await writeFile(join(out, 'native-acceptance.json'), JSON.stringify(report, null, 2))
    const md = [`# Native RP umbrella acceptance`, ``, `Status: **${report.status}**. Final acceptance: **${report.finalAcceptance}**.`, ``, `Actual host: ${report.hostVersion ?? 'not started'}. Isolated home: \`${report.home ?? 'not created'}\`.`, ``, `| Scenario | Status | Detail |`, `| --- | --- | --- |`, ...report.scenarios.map(row => `| ${row.id} | ${row.status} | ${(row.error ?? '').split('\n')[0].replaceAll('|', '\\|')} |`), ``, `Browser page errors: ${report.pageErrors.length}; console warnings/errors: ${report.console.length}; HTTP records: ${report.http.length}.`, ``, `All detailed observations, input hashes, raw HTTP bodies, errors and cleanup are in native-acceptance.json. Screenshots are synthetic assets only.`, ``, ...(report.error ? [report.error] : [])].join('\n')
    const boundary = report.companion?.evidenceBoundary
    const boundaryText = boundary ? `\n${boundary.positive}\n\n${boundary.negatives}\n\n${boundary.migration}\n` : ''
    await writeFile(join(out, 'native-acceptance.md'), md + '\n' + boundaryText)
  }
  console.log(JSON.stringify({ output: out, status: report.status, finalAcceptance: report.finalAcceptance, failed: report.scenarios.filter(row => row.status === 'failed').map(row => row.id) }))
  return report
}

const { values } = parseArgs({ options: { manifest: { type: 'string' }, out: { type: 'string' }, cli: { type: 'string' }, browser: { type: 'string' }, mode: { type: 'string', default: 'full' }, help: { type: 'boolean' } } })
if (values.help) console.log('node scripts/native-integration/umbrella-acceptance.mjs --manifest <final-rc5-seven-package-manifest.json> [--out <new-exclusive-output-directory>] [--mode prepare|ui|companion|full] [--cli <official-dsh.cmd>] [--browser <chromium>]\ncompanion is a diagnostic continuation and cannot produce finalAcceptance:true.')
else {
  assert(values.manifest && ['prepare', 'ui', 'companion', 'full'].includes(values.mode), 'Use --manifest and --mode prepare|ui|companion|full')
  const result = await run({ ...values, browser: values.browser ?? process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH })
  if (!['passed', 'prepared'].includes(result.status)) process.exitCode = 1
}
