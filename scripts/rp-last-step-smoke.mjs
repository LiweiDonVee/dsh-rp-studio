import {spawn,execFile} from 'node:child_process'
import {createHash} from 'node:crypto'
import {mkdir,writeFile,readFile} from 'node:fs/promises'
import {resolve,join} from 'node:path'
import {chromium} from '@playwright/test'
const standalone=process.argv.includes('--standalone')
const root=process.cwd(),home=resolve(`.runtime/rp-step-smoke-${Date.now()}`),evidence=resolve(standalone?'.runtime/rp-step-alone-evidence':'.runtime/rp-step-evidence')
await mkdir(home,{recursive:true});await mkdir(evidence,{recursive:true})
const artifact='packages/rp-last-step/artifacts/dsh-rp-last-step-0.1.0.tgz',hash=createHash('sha256').update(await readFile(artifact)).digest('hex')
await writeFile(join(evidence,'acceptance.json'),JSON.stringify({passed:false,status:'running',hash}))
const cli=process.env.DSH_BIN??join(process.env.LOCALAPPDATA,'Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd'),quote=value=>process.platform==='win32'?`"${value}"`:value
const env={...process.env,DSH_HOME:home,DEEPSEEK_API_KEY:'rp-step-smoke-placeholder-unused'}
const invokeCli=args=>new Promise((done,reject)=>{const child=spawn(quote(cli),args,{shell:process.platform==='win32',windowsHide:true,env,cwd:root,stdio:'pipe'});let out='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>out+=b);child.on('error',reject);child.on('exit',code=>code===0?done():reject(Error('DSH fixture install failed '+out)))})
for(const path of (standalone?[artifact]:['packages/loop-plugin/artifacts/dsh-loop-studio-0.1.0.tgz','packages/plugin/artifacts/dsh-rp-studio-1.2.0.tgz',artifact]))await invokeCli(['plugin','--profile','web','add',quote(resolve(path))])
const probeFile=join(home,'native-probe.mjs');await writeFile(probeFile,await readFile('packages/rp-last-step/tests/fixtures/native-probe.mjs','utf8'))
const patch=join(home,'probe.patch.yml')
await writeFile(patch,`- id: agent-default-model\n  config:\n    provider: rpls-main\n    model: main\n- insert:\n    - id: rp-step-probe\n      name: ${JSON.stringify(probeFile.replaceAll('\\','/'))}\n    - id: rp-step-story\n      name: '@deepseek-ai/dsh-agent-preset'\n      config:\n        id: rpls-test-story\n        name: 最后一步测试\n        description: 合成事实与预设，无私有角色或真实模型\n        plugins:\n          - id: rp-runtime-facts\n            name: '@deepseek-ai/dsh-persona'\n            config:\n              prefix: 先读取工具结果，再单独调用 rp_present 完成呈现。\n`)
const host=spawn(quote(cli),['--profile','web','--patch',quote(patch),'--host','127.0.0.1','--port','0','--no-open'],{shell:process.platform==='win32',windowsHide:true,cwd:root,env,stdio:['ignore','pipe','pipe']})
let logs='',browser;for(const out of[host.stdout,host.stderr])out.on('data',b=>logs+=b)
const redact=value=>value.replace(/([?&]token=)[^\s"'<>]+/gu,'$1[REDACTED]')
const raw=JSON.stringify({name:'合成风格',prompts:[{identifier:'law',name:'固定事实约束',role:'system',content:'RENDER_LOCKED_CANARY 按已决事实呈现，不重做判定。'},{identifier:'tone',name:'文风',role:'system',content:'以 {{tone}} 语气写作。'},{identifier:'agent',name:'Agent 专用',role:'system',content:'MAIN_AGENT_ONLY_CANARY 先读取工具事实，再提交公开方向包。'},{identifier:'sleeping',name:'默认关闭',role:'system',content:'此模块默认关闭。'}],prompt_order:[{character_id:100001,order:[{identifier:'law',enabled:true},{identifier:'tone',enabled:true},{identifier:'agent',enabled:true},{identifier:'sleeping',enabled:false}]}],extensions:{regex_scripts:[{id:'inert',findRegex:'never',replaceString:'do not execute'}]}},null,2)
try{
 let url;const deadline=Date.now()+30_000
 while(Date.now()<deadline){url=/https?:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/u.exec(logs)?.[0];if(url)break;if(host.exitCode!==null)throw Error('Host exited');await new Promise(r=>setTimeout(r,100))}
 if(!url)throw Error('Host startup timed out')
 browser=await chromium.launch({headless:true,...process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{}})
 const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(15_000);const errors=[];page.on('pageerror',e=>errors.push(e.message))
 await page.addInitScript(()=>{Object.defineProperty(window,'__ModuleLoader__',{configurable:true,set(target){Object.defineProperty(window,'__ModuleLoader__',{configurable:true,writable:true,value:target});let load=target.load.bind(target);const observed=row=>load(!['@deepseek-ai/dsh-client-ui-workspace','dsh-rp-studio','dsh-rp-last-step'].includes(row.id)?row:{...row,factory(require){const plugin=row.factory(require);return{...plugin,apply(ctx){window[row.id==='dsh-rp-studio'?'__studioCtx':row.id==='dsh-rp-last-step'?'__lastCtx':'__workspaceCtx']=ctx;return plugin.apply(ctx)}}}});Object.defineProperty(target,'load',{configurable:true,get:()=>observed,set(next){load=next.bind(target)}})}})})
 await page.goto(url,{waitUntil:'networkidle'})
 const preview=page.getByRole('button',{name:'继续',exact:true});await preview.waitFor({state:'visible',timeout:2000}).catch(()=>{});if(await preview.isVisible())await preview.click()
 const request=async(path,body)=>page.evaluate(async({path,body})=>{const response=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},signal:AbortSignal.timeout(25000),body:JSON.stringify(body)});const data=await response.json();if(!response.ok)throw Error(JSON.stringify(data));return data.data??data},{path,body})
 const api=(action,input={})=>request('api/rp-last-step/request',{action,...input}),probe=input=>request('api/rpls-test',input),loop=input=>request('api/loop-studio/request',input)
 const {sessionId}=await probe({action:'create'});console.log('Created synthetic RP story')
 if(!standalone){
 const inspected=await loop({action:'inspect',sessionId})
 await loop({action:'savePolicy',sessionId,scope:'session',expectedRevision:inspected.revision,policy:{enabled:true,routes:{'rp-last-step.migrate':{provider:'rpls-local',model:'migrate'},'rp-last-step.assemble':{provider:'rpls-local',model:'cheap'},'rp-last-step.render':{provider:'rpls-main',model:'quality'}}}})
 }
 let state=await api('state',{sessionId});if(state.profiles.length)throw Error('Fresh library not empty')
 const imported=await api('importSillyTavern',{rawText:raw,name:'合成风格',expectedRevision:state.revision});console.log('Imported immutable source')
 const migration=await api('migrate',{sessionId,profileId:imported.profileId,version:imported.version,expectedRevision:imported.revision});console.log('Migrated profile draft')
 let {profile}=await api('profile',{profileId:migration.profileId,version:migration.version})
 if(profile.status!=='draft'||profile.entries.find(e=>e.id==='sleeping').enabled!==false)throw Error('Migration status/defaultoff changed')
 profile.status='ready';for(const entry of profile.entries)if(['law','agent'].includes(entry.id)){entry.required=true;entry.locked=true}
 const saved=await api('saveProfile',{profile,expectedRevision:migration.revision});await api('bindSession',{sessionId,profileId:saved.profileId,version:saved.version,expectedRevision:saved.revision});console.log('Bound ready protected profile')
 await page.evaluate(id=>window.__workspaceCtx.get('uiWorkspace').openSession(id),sessionId)
 await page.getByRole('button',{name:'打开 RP 最后一步',exact:true}).click();await page.locator('[data-rp-last-step-root]').waitFor()
 await page.getByRole('textbox',{name:'模块正文',exact:true}).waitFor()
 if(!await page.getByRole('checkbox',{name:'Agent 只读',exact:true}).isChecked())throw Error('Readonly module not visible')
 await page.screenshot({path:join(evidence,'preset-sidebar.png')})
 if(standalone){
  const one=await probe({action:'run',sessionId,text:'我试着推门。'})
  const two=await probe({action:'run',sessionId,text:'我继续等门外的反应。'})
  await page.getByRole('button',{name:'生成记录',exact:true}).click()
  await page.getByText('门板依旧紧闭。门外的脚步声渐渐远去。',{exact:true}).waitFor()
  const status=await api('state',{sessionId}),source=await api('source',{sourceId:profile.sourceId})
  if(status.presentations.filter(r=>r.status==='complete').length!==2||source.source.rawText!==raw||one.worldCalls!==1||two.worldCalls!==2)throw Error('Independent presentation/source check failed')
  if(two.calls.some(c=>['assemble','render'].includes(c.kind)&&c.model!=='main'))throw Error('Independent stage did not inherit current model')
  await page.screenshot({path:join(evidence,'standalone-records.png')})
  if(errors.length)throw Error('Browser errors '+JSON.stringify(errors))
  const result={passed:true,standalone:true,hash,worldCalls:two.worldCalls,committed:2,sourceUnchanged:true,errors}
  await writeFile(join(evidence,'acceptance.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result))
 }else{
 await page.evaluate(()=>window.__studioCtx.sidebarRight.openTab('rp-studio'))
 await page.getByRole('button',{name:'沉浸阅读',exact:true}).click();await page.locator('.rp-empty').waitFor({state:'hidden'})
 await page.evaluate(id=>{window.__narration=[];const url=new URL('api/rp-studio/events',document.baseURI);url.searchParams.set('sessionId',id);const source=new EventSource(url);window.__storySource=source;for(const type of['message.delta','message.completed','error'])source.addEventListener(type,event=>window.__narration.push({type,data:JSON.parse(event.data)}))},sessionId)
 const one=await probe({action:'run',sessionId,text:'我试着推门。'});console.log('First frozen presentation completed')
 await page.locator('.dsh-rp-workspace').getByText('门板顶住了推力，仍未打开。守卫留在门外，片刻安静。',{exact:true}).waitFor()
 const two=await probe({action:'run',sessionId,text:'我继续等门外的反应。'});console.log('Second presentation with reused provider IDs completed')
 await page.locator('.dsh-rp-workspace').getByText('门板依旧紧闭。门外的脚步声渐渐远去。',{exact:true}).waitFor()
 const detail=await request('api/rp-studio/request',{method:'GET',path:'/api/v1/sessions/'+sessionId})
 const gm=detail.messages.filter(m=>m.role==='gm');if(gm.length!==2||gm[0].text===gm[1].text)throw Error('Canonical reused-ID replay failed '+JSON.stringify(gm))
 const frames=await page.evaluate(()=>window.__narration);if(JSON.stringify(frames).includes('PRIVATE')||JSON.stringify(frames).includes('CANARY'))throw Error('Private model material reached story stream')
 if(!frames.some(frame=>frame.type==='message.delta'))throw Error('Native writer stream missing')
 const source=await api('source',{sourceId:profile.sourceId});if(source.source.rawText!==raw)throw Error('Original source changed')
 state=await api('state',{sessionId});if(state.binding.overlay.entries.law)throw Error('Readonly overlay was modified')
 if(state.binding.overlay.entries.tone?.fills?.tone!=='克制')throw Error('Managed fill not applied')
 if(one.worldCalls!==1||two.worldCalls!==2||two.calls.filter(c=>c.kind==='main').length!==4)throw Error('World tools repeated or main echoed '+JSON.stringify(two))
 if(two.calls.filter(c=>c.kind==='render').some(c=>c.model!=='quality'||c.tools))throw Error('Writer routing/tool isolation failed')
 const unbound=await probe({action:'create'})
 const unboundRaw=await probe({action:'tools',sessionId:unbound.sessionId})
 if(unboundRaw.names.some(name=>name.startsWith('rp_')))throw Error('Bound story leaked RP definitions into unrelated scope')
 await probe({action:'run',sessionId:unbound.sessionId,text:'仅检查未绑定会话'})
 await probe({action:'selectModel',sessionId:unbound.sessionId,provider:'rpls-local',model:'migrate'})
 const pendingState=await api('state',{sessionId:unbound.sessionId})
 const pendingImport=await api('importSillyTavern',{rawText:raw,name:'待选模型测试',expectedRevision:pendingState.revision})
 await api('migrate',{sessionId:unbound.sessionId,profileId:pendingImport.profileId,version:pendingImport.version,expectedRevision:pendingImport.revision})
 const pendingStats=await probe({action:'stats'})
 if(pendingStats.calls.filter(c=>c.kind==='migrate').at(-1)?.provider!=='rpls-local')throw Error('Migration ignored newly selected local session model')
 console.log('Unbound registry isolation and pending session model selection passed')
 await page.screenshot({path:join(evidence,'story-sidebar.png')});await page.getByRole('button',{name:'全屏',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.dsh-rp-workspace')?.clientWidth>1000);await page.screenshot({path:join(evidence,'story-fullscreen.png')})
 await page.setViewportSize({width:520,height:900});await page.screenshot({path:join(evidence,'story-narrow.png')})
 await page.setViewportSize({width:1440,height:1000})
 await page.evaluate(()=>window.__studioCtx.sidebarRight.openTab('loop-studio'))
 await page.locator('[data-loop-node="rp-last-step.render"]').click()
 if(await page.getByRole('combobox',{name:'模型',exact:true}).inputValue()!=='quality')throw Error('RP writer route missing from native Loop inspector')
 await page.screenshot({path:join(evidence,'rp-loop-integration.png')})
 if(errors.length)throw Error('Browser errors '+JSON.stringify(errors))
 const stats=await probe({action:'stats'}),result={passed:true,hash,host:'DSH 0.2.1-rc.2',worldCalls:two.worldCalls,mainCalls:two.calls.filter(c=>c.kind==='main').length,stageCalls:stats.calls.filter(c=>c.kind!=='main'),gmCount:gm.length,sourceUnchanged:true,frames:frames.map(frame=>({type:frame.type})),errors}
 await writeFile(join(evidence,'acceptance.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result))
 }
}catch(error){console.error(error.message);console.error(redact(logs.slice(-10000)));await writeFile(join(evidence,'acceptance.json'),JSON.stringify({passed:false,hash,error:redact(error.message)}));process.exitCode=1}
finally{await browser?.close();if(host.pid){if(process.platform==='win32')await new Promise(done=>execFile('taskkill.exe',['/PID',String(host.pid),'/T','/F'],{windowsHide:true},done));else host.kill('SIGTERM')}}
