import { spawn, execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { chromium } from '@playwright/test'
const root = process.cwd()
const home = resolve(`.runtime/native-smoke-${Date.now()}`)
await mkdir(home, { recursive: true })
await writeFile('.runtime/native.patch.yml', `- insert:
    - id: preset-rp-smoke
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: smoke-story
        name: 远山来信
        description: 合成测试故事，不包含私人角色卡
        plugins:
          - id: rp-runtime
            name: '@deepseek-ai/dsh-persona'
            config:
              prefix: 你是远山驿站的讲述者。
`)

let logs = ''
const cli = process.env.DSH_BIN || (process.platform === 'win32' ? join(process.env.LOCALAPPDATA, 'Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd') : 'dsh')
const quotedCli = process.platform === 'win32' ? `"${cli}"` : cli
const env = { ...process.env, DSH_HOME: home, DEEPSEEK_API_KEY: 'native-smoke-placeholder-never-used' }
// The fixture has no model traffic. Only this disposable profile is installed/modified.
const installing = spawn(quotedCli, ['plugin','--profile','web','add',process.platform==='win32' ? `"${resolve('packages/plugin/artifacts/dsh-rp-studio-1.1.0.tgz')}"` : resolve('packages/plugin/artifacts/dsh-rp-studio-1.1.0.tgz')], { shell:process.platform==='win32', windowsHide:true, env, stdio:'pipe' })
let installLog = ''
installing.stdout.on('data', chunk => { installLog += chunk })
installing.stderr.on('data', chunk => { installLog += chunk })
const installed = await new Promise((done, reject) => { installing.on('error',reject); installing.on('exit',done) })
if (installed !== 0) throw new Error('Plugin install failed: '+installLog)

const child = spawn(quotedCli, ['--profile','web','--patch',resolve('.runtime/native.patch.yml'),'--host','127.0.0.1','--port','0','--no-open'], { shell: process.platform === 'win32', windowsHide: true, cwd: root, env, stdio: ['ignore','pipe','pipe'] })
child.stdout.on('data', chunk => { logs = (logs + chunk).slice(-100000) })
child.stderr.on('data', chunk => { logs = (logs + chunk).slice(-100000) })
const redact = value => value.replace(/([?&]token=)[^\s"'<>]+/giu,'$1[REDACTED]')
let browser
try {
  let url
  const deadline = Date.now()+60000
  while (Date.now()<deadline) {
    url = /https?:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/u.exec(logs)?.[0]
    if (url) break
    if (child.exitCode !== null) throw new Error('Host exited '+child.exitCode)
    await new Promise(resolve => setTimeout(resolve,100))
  }
  if (!url) throw new Error('Host startup timed out')
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? {executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH} : {}) })
  const page = await browser.newPage({ viewport:{width:1440,height:1000} })
  page.setDefaultTimeout(15_000)
  const errors=[]
  page.on('pageerror',error=>errors.push(error.stack)); page.on('console',message => { if(message.type() === 'error' || message.type() === 'warn') errors.push(message.text()) })
  await page.addInitScript(() => {
    Object.defineProperty(window, '__ModuleLoader__', { configurable: true, set(target) {
      Object.defineProperty(window, '__ModuleLoader__', { configurable: true, writable: true, value: target })
      let load = target.load.bind(target)
      const observer = row => load(row.id !== 'dsh-rp-studio' ? row : { ...row, factory(require) {
        const plugin = row.factory(require)
        return {...plugin, apply(ctx) { window.__rpctx = ctx; return plugin.apply(ctx) } }
      } })
      Object.defineProperty(target, 'load', { configurable: true, get: () => observer, set(next) { load=next.bind(target) } })
    } })
  })
  await page.goto(url, { waitUntil:'networkidle' })
  const activationError = await page.evaluate(() => window.__rpctx?.fiber?._error?.message)
  if(activationError) throw new Error(activationError)
  const result = await page.evaluate(async () => {
    const response = await fetch('api/rp-studio/request', { method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({method:'GET',path:'/api/v1/health'}) })
    return { status:response.status, body:await response.json() }
  })
  if(result.status!==200 || result.body?.data?.upstream!=='ready') throw new Error('Native host health failed')
  const preview = page.getByRole('button', {name:'继续',exact:true})
  await preview.waitFor({state:'visible',timeout:2500}).catch(()=>{}); if(await preview.isVisible()) await preview.click()
  const created = await page.evaluate(async () => {
    const request = async (method,path,body) => (await (await fetch('api/rp-studio/request', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({method,path,body})})).json())
    const cards = await request('GET','/api/v1/cards')
    if(!cards.data?.some(card=>card.id==='smoke-story')) throw new Error(JSON.stringify(cards))
    return request('POST','/api/v1/sessions', {cardId:'smoke-story'})
  })
  if(!created.ok) throw new Error('Create failed '+JSON.stringify(created))
  await page.evaluate(id => window.__rpctx.uiWorkspace.openSession(id), created.data.session.id)
  await page.getByRole('button',{name:'打开 RP Studio',exact:true}).click()
  await page.locator('.rp-intro, .rp-scene').waitFor()
  await page.locator('.rp-empty').waitFor({state:'hidden'})
  await mkdir('.runtime/evidence',{recursive:true})
  await page.screenshot({path:'.runtime/evidence/native-sidebar.png'})
  const panel = page.locator('.dsh-rp-workspace')
  const metrics = await panel.evaluate(el=>({width:el.clientWidth,height:el.clientHeight,overflow:el.scrollWidth>el.clientWidth}))
  if(metrics.width < 200 || metrics.height < 200 || metrics.overflow) throw new Error('Invalid panel layout '+JSON.stringify(metrics))
  await page.getByRole('button',{name:'沉浸阅读',exact:true}).click()
  await page.getByRole('textbox',{name:'写下你的行动'}).fill('留下未发送的测试草稿')
  console.log(JSON.stringify({health:result,errors,metrics}))
  await page.screenshot({path:'.runtime/evidence/native-story.png'})
  await page.getByRole('button',{name:'全屏',exact:true}).click()
  await page.waitForFunction(()=>document.querySelector('.dsh-rp-workspace')?.clientWidth > 1000)
  await page.screenshot({path:'.runtime/evidence/native-fullscreen.png'})
  await page.getByRole('button',{name:'故事档案',exact:true}).click()
  await page.locator('.rp-card').filter({hasText:'远山来信'}).click()
  await page.waitForFunction(old=>document.querySelector('.dsh-rp-workspace')?.dataset.rpSession !== old, created.data.session.id)
  await page.locator('.rp-scene').waitFor()
  await page.getByRole('button',{name:'沉浸阅读',exact:true}).click()
  await page.getByRole('textbox',{name:'写下你的行动'}).fill('会话切换后的草稿')
  await page.setViewportSize({width:520,height:900})
  await page.waitForFunction(()=>document.querySelector('.dsh-rp-workspace')?.clientWidth < 530)
  const narrow = await panel.evaluate(el=>({width:el.clientWidth,height:el.clientHeight,overflow:el.scrollWidth>el.clientWidth}))
  if(narrow.overflow || narrow.width < 300 || narrow.height < 200) throw new Error('Invalid narrow layout '+JSON.stringify(narrow))
  await page.screenshot({path:'.runtime/evidence/native-narrow.png'})
  await page.getByRole('button',{name:'关闭',exact:true}).click()
  await panel.waitFor({state:'hidden'})
  await page.getByRole('button',{name:'打开 RP Studio',exact:true}).click()
  await panel.waitFor({state:'visible'})
  console.log('Native fullscreen, archive creation/navigation, narrow layout, close/reopen: passed', JSON.stringify(narrow))
  if(errors.length) throw new Error('Browser errors: '+JSON.stringify(errors))

} catch (error) { console.error(error.message); console.error(redact(logs.slice(-10000))); process.exitCode=1 }
finally { await browser?.close(); if(child.pid) { if(process.platform==='win32') await new Promise(done=>execFile('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true},done)); else child.kill('SIGTERM') } }
