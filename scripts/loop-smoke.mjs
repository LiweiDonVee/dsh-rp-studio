import {spawn,execFile} from 'node:child_process'
import {createHash} from 'node:crypto'
import {mkdir,writeFile,readFile} from 'node:fs/promises'
import {resolve,join} from 'node:path'
import {chromium} from '@playwright/test'
const root=process.cwd(),home=resolve(`.runtime/loop-smoke-${Date.now()}`),evidence=resolve('.runtime/loop-evidence')
await mkdir(home,{recursive:true});await mkdir(evidence,{recursive:true})
const artifactSha256=createHash('sha256').update(await readFile('packages/loop-plugin/artifacts/dsh-loop-studio-0.1.0.tgz')).digest('hex')
await writeFile(join(evidence,'acceptance.json'),JSON.stringify({passed:false,status:'running',artifactSha256}))
const cli=process.env.DSH_BIN??join(process.env.LOCALAPPDATA,'Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd')
const quote=value=>process.platform==='win32'?`"${value}"`:value
const env={...process.env,DSH_HOME:home,DEEPSEEK_API_KEY:'loop-smoke-placeholder-unused'}
const run=args=>new Promise((done,reject)=>{
  const child=spawn(quote(cli),args,{shell:process.platform==='win32',windowsHide:true,cwd:root,env,stdio:'pipe'});let log=''
  child.stdout.on('data',b=>log+=b);child.stderr.on('data',b=>log+=b);child.on('error',reject);child.on('exit',code=>code===0?done():reject(Error('DSH install failed: '+log)))
})
await run(['plugin','--profile','web','add',quote(resolve('packages/loop-plugin/artifacts/dsh-loop-studio-0.1.0.tgz'))])
const patch=join(home,'probe.patch.yml')
const probePlugin=join(home,'native-probe.mjs')
await writeFile(probePlugin,await readFile('packages/loop-plugin/tests/fixtures/native-probe.mjs','utf8'))
await writeFile(patch,`- id: agent-default-model\n  config:\n    provider: loop-cloud\n    model: configured\n- insert:\n    - id: loop-smoke\n      name: ${JSON.stringify(probePlugin.replaceAll('\\','/'))}\n    - id: loop-smoke-preset\n      name: '@deepseek-ai/dsh-agent-preset'\n      config:\n        id: loop-smoke-preset\n        name: 独立测试预设\n        plugins:\n          - name: '@deepseek-ai/dsh-persona'\n            config:\n              prefix: Synthetic keyless loop acceptance.\n`)
const host=spawn(quote(cli),['--profile','web','--patch',quote(patch),'--host','127.0.0.1','--port','0','--no-open'],{shell:process.platform==='win32',windowsHide:true,env,cwd:root,stdio:['ignore','pipe','pipe']})
let logs='',browser;for(const out of[host.stdout,host.stderr])out.on('data',b=>logs+=b)
const redact=value=>value.replace(/([?&]token=)[^\s"'<>]+/gu,'$1[REDACTED]')
try{
  let url;const deadline=Date.now()+30_000
  while(Date.now()<deadline){url=/https?:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/u.exec(logs)?.[0];if(url)break;if(host.exitCode!==null)throw Error('Host exited');await new Promise(r=>setTimeout(r,100))}
  if(!url)throw Error('Host startup timed out')
  browser=await chromium.launch({headless:true,...process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{}})
  const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(15_000);const errors=[]
  page.on('pageerror',e=>errors.push(e.message))
  await page.addInitScript(()=>{
    Object.defineProperty(window,'__ModuleLoader__',{configurable:true,set(target){
      Object.defineProperty(window,'__ModuleLoader__',{configurable:true,writable:true,value:target});let load=target.load.bind(target)
      const observe=row=>load(!['dsh-loop-studio','@deepseek-ai/dsh-client-ui-workspace'].includes(row.id)?row:{...row,factory(require){const plugin=row.factory(require);return {...plugin,apply(ctx){window[row.id==='dsh-loop-studio'?'__loopCtx':'__workspaceCtx']=ctx;return plugin.apply(ctx)}}}})
      Object.defineProperty(target,'load',{configurable:true,get:()=>observe,set(next){load=next.bind(target)}})
    }})
  })
  await page.goto(url,{waitUntil:'networkidle'})
  const preview=page.getByRole('button',{name:'继续',exact:true});await preview.waitFor({state:'visible',timeout:2500}).catch(()=>{});if(await preview.isVisible())await preview.click()
  const request=async(path,body)=>page.evaluate(async({path,body})=>{const response=await fetch(path,{signal:AbortSignal.timeout(20000),method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const data=await response.json();if(!response.ok)throw Error(JSON.stringify(data));return data.data??data},{path,body})
  const api=body=>request('api/loop-studio/request',body),probe=body=>request('api/loop-studio-test',body)
  const results=[];let activeId
  for(const {preset,implicit} of [{preset:'standard',implicit:false},{preset:'loop-smoke-preset',implicit:false},{preset:'standard',implicit:true}]){
    console.log('Checking preset',preset,'implicit',implicit); const {sessionId}=await probe({action:'create',preset,implicit}); console.log('Created isolated session');activeId=sessionId
    const initial=await api({action:'inspect',sessionId});console.log('Inspected preset and graph')
    if(initial.selectedPresetId!==preset||initial.routingCapability!=='supported')throw Error('Preset/driver inspection failed '+JSON.stringify(initial))
    await api({action:'savePolicy',sessionId,scope:'session',expectedRevision:initial.revision,policy:{enabled:true,routes:{'host.first':{provider:'loop-cloud',model:'fast'},'host.continuation':{provider:'loop-local',model:'quality'}}}})
    console.log('Policy saved, executing keyless loop');const generated=await probe({action:'run',sessionId}),main=generated.calls.filter(c=>c.kind==='main')
    if(main.length!==2||main[0].provider!=='loop-cloud'||main[0].model!=='fast'||main[1].provider!=='loop-local'||main[1].model!=='quality')throw Error('Actual routing mismatch '+JSON.stringify(generated))
    if(main.some(c=>c.promptRoute!==c.provider+'/'+c.model))throw Error('Prompt and route selection disagree')
    const inspect=await api({action:'inspect',sessionId})
    await api({action:'savePolicy',sessionId,scope:'session',expectedRevision:inspect.revision,policy:{enabled:false,routes:{}}})
    const restored=await probe({action:'run',sessionId})
    if(restored.header.provider!=='loop-cloud'||restored.header.model!=='configured')throw Error('Disable did not restore host selection')
    results.push({preset,implicit,routes:main.map(c=>c.provider+'/'+c.model),restored:restored.header})
  }
  await page.evaluate(id=>window.__workspaceCtx.get('uiWorkspace').openSession(id),activeId)
  await page.getByRole('button',{name:/打开.*Loop/u}).click()
  await page.locator('[data-loop-session]').waitFor()
  await page.locator('[data-loop-node="host.first"]').click()
  await page.getByRole('checkbox',{name:'启用模型接管',exact:true}).check()
  await page.getByRole('combobox',{name:'提供方',exact:true}).selectOption('loop-cloud')
  await page.getByRole('combobox',{name:'模型',exact:true}).selectOption('fast')
  await page.getByRole('button',{name:'保存配置',exact:true}).click()
  await page.getByText('配置已保存',{exact:true}).waitFor()
  const configured=await api({action:'inspect',sessionId:activeId})
  if(configured.policies.session?.routes?.['host.first']?.model!=='fast')throw Error('Native UI did not save selected model')
  const uiRun=await probe({action:'run',sessionId:activeId})
  if(uiRun.header.provider!=='loop-cloud'||uiRun.header.model!=='fast')throw Error('UI-selected model not used by actual adapter')
  await page.getByRole('button',{name:/返回执行流程/u}).click()
  const showTop=async()=>page.locator('[data-loop-session]').evaluate(el=>{document.activeElement?.blur?.();for(const child of [el,...el.querySelectorAll('*')])if(child.scrollTop)child.scrollTop=0;for(let parent=el.parentElement;parent;parent=parent.parentElement)if(parent.scrollTop)parent.scrollTop=0})
  await showTop()
  await page.screenshot({path:join(evidence,'native-loop-sidebar.png')})
  const panel=page.locator('[data-loop-session]')
  const metrics=await panel.evaluate(el=>({width:el.clientWidth,height:el.clientHeight,overflow:el.scrollWidth>el.clientWidth}))
  if(metrics.width<250||metrics.height<200||metrics.overflow)throw Error('Invalid native layout '+JSON.stringify(metrics))
  await page.getByRole('button',{name:'全屏',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[data-loop-session]')?.clientWidth>1000)
  await showTop()
  await page.screenshot({path:join(evidence,'native-loop-fullscreen.png')})
  await page.setViewportSize({width:520,height:900});await page.waitForFunction(()=>document.querySelector('[data-loop-session]')?.clientWidth<530)
  const narrow=await panel.evaluate(el=>({width:el.clientWidth,height:el.clientHeight,overflow:el.scrollWidth>el.clientWidth}));if(narrow.overflow)throw Error('Narrow overflow')
  await showTop()
  await page.screenshot({path:join(evidence,'native-loop-narrow.png')})
  await page.getByRole('button',{name:'关闭',exact:true}).click();await panel.waitFor({state:'hidden'});await page.getByRole('button',{name:/打开.*Loop/u}).click();await panel.waitFor({state:'visible'})
  const boundarySession=await probe({action:'create',preset:'standard',implicit:true})
  const boundaryInitial=await api({action:'inspect',sessionId:boundarySession.sessionId})
  await api({action:'savePolicy',sessionId:boundarySession.sessionId,scope:'session',expectedRevision:boundaryInitial.revision,policy:{enabled:true,routes:{'host.first':{provider:'loop-cloud',model:'fast'},'host.continuation':{provider:'loop-local',model:'quality'}}}})
  const boundary=await probe({action:'run',sessionId:boundarySession.sessionId,closeBeforeRequest:true})
  const boundaryCalls=boundary.calls.filter(c=>c.kind==='main')
  if(boundaryCalls.length!==2||boundaryCalls[0].model!=='fast'||boundaryCalls[1].model!=='configured'||boundaryCalls.some(c=>c.promptRoute!==c.provider+'/'+c.model))throw Error('Captured-step drain did not preserve route/prompt boundary '+JSON.stringify(boundary))
  results.push({preset:'standard',boundary:'close-after-assembly',routes:boundaryCalls.map(c=>c.provider+'/'+c.model)})
  if(errors.length)throw Error('Browser errors: '+JSON.stringify(errors))
  const result={passed:true,artifactSha256,host:'DSH 0.2.1-rc.2',results,metrics,narrow,errors}
  await writeFile(join(evidence,'acceptance.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result))
}catch(error){await writeFile(join(evidence,'acceptance.json'),JSON.stringify({passed:false,status:'failed',artifactSha256,error:redact(error.message)}));console.error(error.message);console.error(redact(logs.slice(-8000)));process.exitCode=1}
finally{await browser?.close();if(host.pid){if(process.platform==='win32')await new Promise(done=>execFile('taskkill.exe',['/PID',String(host.pid),'/T','/F'],{windowsHide:true},done));else host.kill('SIGTERM')}}
