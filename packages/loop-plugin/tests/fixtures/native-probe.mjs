// Keyless host fixture: no external model service and no filesystem tools.
export const name='loop-studio-native-probe'
export const inject=['llm','agents','systemPrompt','connection','typertGateway']
export async function apply(ctx) {
  const calls=[]
  const closeBeforeRequest=new Set()
  ctx.on('agent/pre-step',async ({agent},next)=>{
    if(closeBeforeRequest.delete(agent.id)) await ctx.get('loopStudio').close()
    return next()
  })
  const adapter={
    providerInfo:id=>({id,name:id==='loop-cloud'?'模拟云端':'模拟本地'}),providerRetryPolicy:()=>undefined,imageRequestPricing:()=>undefined,
    imageRequestTarget:(_p,_m,image)=>image,
    listModels:async provider=>['configured','fast','quality'].map(id=>({provider,id,name:id})),
    resolveModel:async (provider,id)=>({provider,id,name:id}),
    async prepareCall(provider,id,signal){return {model:await this.resolveModel(provider,id,signal),stream:options=>this.stream(options)}},
    async *stream(options) {
      const system=options.system??options.messages.filter(m=>m.role==='system').flatMap(m=>m.content.map(b=>b.text??'')).join('\n')
      const main=system.includes('LOOP_SMOKE_ROUTE'),route=/LOOP_SMOKE_ROUTE\s+(\S+)/.exec(system)?.[1]
      calls.push({sessionId:ctx.agents.currentInitiator()?.id,provider:options.provider,model:options.model,kind:main?'main':'auxiliary',promptRoute:route})
      if(main&&!options.messages.some(message=>message.role==='tool')) {
        const id='loop-smoke-'+crypto.randomUUID()
        // Exercise a native failed-tool edge without executing side effects.
        yield {type:'block-start',index:0,blockType:'tool-call'}
        yield {type:'tool-call-delta',index:0,id,name:'loop_smoke_absent_tool',argumentsDelta:'{}'}
        yield {type:'block-end',index:0,block:{type:'tool-call',id,name:'loop_smoke_absent_tool',arguments:'{}'}}
        yield {type:'finish',reason:{kind:'tool-calls'}}
        return
      }
      const text=main?'LOOP_SMOKE_COMPLETED':'Loop smoke session'
      yield {type:'block-start',index:0,blockType:'text'}
      yield {type:'text-delta',index:0,text}
      yield {type:'block-end',index:0,block:{type:'text',text}}
      yield {type:'usage',usage:{inputTokens:12,outputTokens:4}}
      yield {type:'finish',reason:{kind:'stop'}}
    },
  }
  ctx.llm.registerAdapter(['loop-cloud','loop-local'],adapter)
  ctx.systemPrompt.section({name:'loop-smoke-route',order:100,text:'LOOP_SMOKE_ROUTE {{provider}}/{{model}}'})
  const invoke=(method,request,signal)=>ctx.typertGateway.invoke({namespace:'session',method,args:{request},peer:ctx.connection.browserPeer,signal})
  ctx.connection.fetch.register({path:'/api/loop-studio-test',methods:['POST'],requestBody:'buffered',fetch:async request=>{
    try{
      const input=await request.json()
      if(input.action==='create'){
        const result=await invoke('create',{agentPreset:input.preset??'standard'},request.signal)
        if(!input.implicit) await invoke('selectModel',{sessionId:result.sessionId,provider:'loop-cloud',model:'configured'},request.signal)
        return Response.json(result)
      }
      if(input.action==='run'){
        if(input.closeBeforeRequest)closeBeforeRequest.add(input.sessionId)
        await invoke('prompt',{requestId:crypto.randomUUID(),sessionId:input.sessionId,mode:'queue',content:[{type:'text',text:'Synthetic loop probe; no real tools.'}]},request.signal)
        await ctx.agents.get(input.sessionId).whenIdle()
        return Response.json({calls:calls.filter(c=>c.sessionId===input.sessionId),header:ctx.agents.get(input.sessionId).session.requestHeader()?.config})
      }
      return Response.json({error:'Unknown fixture action'},{status:400})
    }catch(error){return Response.json({error:error.message,code:error.code},{status:500})}
  }})
}
