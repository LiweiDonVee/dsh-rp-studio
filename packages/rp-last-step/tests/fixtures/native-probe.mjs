// Synthetic integration fixture. Every model/tool is local and deterministic.
export const name='rp-last-step-native-probe'
export const inject=['llm','agents','tools','connection','typertGateway']
const textOf=message=>message?.content?.filter(b=>b.type==='text').map(b=>b.text).join('\n')??''
const jsonChunks=async function*(text){yield{type:'block-start',index:0,blockType:'text'};yield{type:'text-delta',index:0,text};yield{type:'block-end',index:0,block:{type:'text',text}};yield{type:'usage',usage:{inputTokens:20,outputTokens:8}};yield{type:'finish',reason:{kind:'stop'}}}
const toolChunks=async function*(name,args,id,privateText=''){
 let index=0
 if(privateText){yield{type:'block-start',index,blockType:'text'};yield{type:'text-delta',index,text:privateText};yield{type:'block-end',index,block:{type:'text',text:privateText}};index++}
 yield{type:'block-start',index,blockType:'tool-call'};yield{type:'tool-call-delta',index,id,name,argumentsDelta:JSON.stringify(args)};yield{type:'block-end',index,block:{type:'tool-call',id,name,arguments:JSON.stringify(args)}};yield{type:'finish',reason:{kind:'tool-calls'}}
}
export function apply(ctx){
 const calls=[],worldCalls=new Map()
 ctx.tools.register({name:'rpls_world_probe',description:'Read synthetic committed public and private facts.',parameters:{type:'object',properties:{},additionalProperties:false},isConcurrencySafe:()=>true,
 output:{schema:{type:'object'},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},execute:async(_args,exec)=>{const id=exec.agent.id,count=(worldCalls.get(id)??0)+1;worldCalls.set(id,count);return{publicFacts:count===1?'门仍关闭；守卫在门外':'门仍关闭；守卫退到走廊尽头',secret:'GAME_PRIVATE_CANARY',count}}})
 const adapter={providerInfo:id=>({id,name:id}),providerRetryPolicy:()=>undefined,imageRequestPricing:()=>undefined,imageRequestTarget:(_p,_m,v)=>v,
 listModels:async provider=>['main','migrate','cheap','quality'].map(id=>({provider,id,name:id})),resolveModel:async(provider,id)=>({provider,id,name:id}),
 async prepareCall(provider,id,signal){return{model:await this.resolveModel(provider,id,signal),stream:options=>this.stream(options)}},
 async*stream(options){
  const body=options.messages.map(textOf).join('\n'),system=options.system??options.messages.filter(m=>m.role==='system').map(textOf).join('\n')
  const stage=/RP_LAST_STEP_(MIGRATE|ASSEMBLE|RENDER)/u.exec(system)?.[1]
  const sid=ctx.agents.currentInitiator()?.id
  if(stage==='MIGRATE'){
   calls.push({kind:'migrate',provider:options.provider,model:options.model,tools:options.tools?.length??0})
   yield*jsonChunks(JSON.stringify({updates:[{id:'law',phase:'render'},{id:'tone',phase:'render'},{id:'agent',phase:'agent'},{id:'sleeping',phase:'render'}],report:{summary:'拆分 Agent 与呈现职责；原先关闭的模块保持关闭。',changes:['阶段分类已调整'],blocked:[]}}));return
  }
  if(stage==='ASSEMBLE'){
   const input=JSON.parse(textOf(options.messages[0]));calls.push({kind:'assemble',sessionId:sid,provider:options.provider,model:options.model,step:input.step,tools:options.tools?.length??0})
   const response=input.step===1?{read:['tone'],commit:false}:input.step===2?{operations:[{op:'disable',entryId:'law'}],commit:true}:{operations:[{op:'fill',entryId:'tone',key:'tone',value:'克制'}],commit:true}
   yield*jsonChunks(JSON.stringify(response));return
  }
  if(stage==='RENDER'){
   if(options.tools?.length||options.messages.length!==1||body.includes('MAIN_AGENT_ONLY_CANARY')||body.includes('GAME_PRIVATE_CANARY'))throw Error('Writer received forbidden context')
   if(!body.includes('RENDER_LOCKED_CANARY')||!body.includes('克制'))throw Error('Protected or filled module missing from writer')
   calls.push({kind:'render',sessionId:sid,provider:options.provider,model:options.model,tools:0})
   const input=JSON.parse(textOf(options.messages[0])),second=JSON.stringify(input.packet).includes('走廊尽头')
   const prose=second?'门板依旧紧闭。门外的脚步声渐渐远去。':'门板顶住了推力，仍未打开。守卫留在门外，片刻安静。'
   const parts=['<thi','nk>WRITER_PRIVATE_REASONING</thi','nk>',prose],full=parts.join('')
   yield{type:'block-start',index:0,blockType:'text'};for(const text of parts)yield{type:'text-delta',index:0,text};yield{type:'block-end',index:0,block:{type:'text',text:full}};yield{type:'usage',usage:{inputTokens:30,outputTokens:12}};yield{type:'finish',reason:{kind:'stop'}};return
  }
  const human=options.messages.findLastIndex(m=>m.role==='user'&&m.source?.kind==='user')
  if(human<0){yield*jsonChunks('Synthetic title');return}
  const input=textOf(options.messages[human]),tail=options.messages.slice(human+1),visible=options.tools?.map(t=>t.name)??[]
  calls.push({kind:'main',sessionId:sid,provider:options.provider,model:options.model,toolNames:visible,hasAgentModule:body.includes('MAIN_AGENT_ONLY_CANARY'),hasRenderModule:body.includes('RENDER_LOCKED_CANARY')})
  if(input==='仅检查未绑定会话'){
   if(visible.some(name=>name.startsWith('rp_')))throw Error('Unbound native scope got RP schemas')
   yield*jsonChunks('未绑定会话正常');return
  }
  if(!visible.includes('rp_present'))throw Error('Ready native scope is missing rp_present schema')
  if(body.includes('RENDER_LOCKED_CANARY')||!body.includes('MAIN_AGENT_ONLY_CANARY'))throw Error('Main profile phase separation failed')
  const result=tail.find(m=>m.role==='tool'&&m.toolCallId==='reused-world-call')
  if(!result){yield*toolChunks('rpls_world_probe',{},'reused-world-call','后台处理 GAME_PRIVATE_CANARY，不应进入旁白。');return}
  if(tail.some(m=>m.role==='tool'&&m.toolCallId==='reused-present-call'))throw Error('Main agent echoed after terminal handoff')
  const facts=JSON.parse(textOf(result)).publicFacts
  yield*toolChunks('rp_present',{packet:{playerAction:input,resolvedChanges:['推门判定失败，门没有打开。'],visibleConsequences:[facts],proseConstraints:['保持既定结果，不替玩家作下一步选择。'],variables:{}}},'reused-present-call','内部组装计划 MAIN_AGENT_PRIVATE_PLAN，不应进入旁白。')
 }}
 ctx.llm.registerAdapter(['rpls-main','rpls-local'],adapter)
 const invoke=(method,request,signal)=>ctx.typertGateway.invoke({namespace:'session',method,args:{request},peer:ctx.connection.browserPeer,signal})
 ctx.connection.fetch.register({path:'/api/rpls-test',methods:['POST'],requestBody:'buffered',fetch:async request=>{try{
  const input=await request.json()
  if(input.action==='create')return Response.json(await invoke('create',{agentPreset:input.preset??'rpls-test-story'},request.signal))
  if(input.action==='selectModel'){await invoke('selectModel',{sessionId:input.sessionId,provider:input.provider,model:input.model},request.signal);return Response.json({selected:true})}
  if(input.action==='tools'){const agent=ctx.agents.get(input.sessionId);return Response.json({names:agent.ctx.tools.schemas(agent).map(t=>t.name)})}
  if(input.action==='run'){
   await invoke('prompt',{sessionId:input.sessionId,requestId:crypto.randomUUID(),mode:'queue',content:[{type:'text',text:input.text??'我试着推门。'}]},request.signal)
   await ctx.agents.get(input.sessionId).whenIdle()
   return Response.json({calls:calls.filter(c=>c.sessionId===input.sessionId),worldCalls:worldCalls.get(input.sessionId)??0,header:ctx.agents.get(input.sessionId).session.requestHeader()?.config})
  }
  if(input.action==='stats')return Response.json({calls,worldCalls:[...worldCalls]})
  return Response.json({error:'Unknown fixture action'},{status:400})
 }catch(error){return Response.json({error:error.message,code:error.code},{status:500})}}})
}
