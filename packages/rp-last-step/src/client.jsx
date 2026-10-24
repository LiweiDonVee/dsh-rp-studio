import React, {useEffect,useState} from 'react'
import {PresetWorkspace,Quill} from './PresetWorkspace.jsx'
import {createRpLastStepApi} from './api.js'
import css from './styles.css'

export const inject=['slots','sidebarRight','sidebarRightTabs']
export const TAB_ID='dsh-rp-last-step/workspace'
export const TAB_KIND='rp-last-step'
const api=createRpLastStepApi()
const phaseName={'rp-last-step.migrate':'预设迁移','rp-last-step.assemble':'模块热组装','rp-last-step.render':'正文呈现'}

function OpenButton({open,story=false}) {
  return <button className="rpls-open-entry" type="button" aria-label={story?'配置故事预设':'打开 RP 最后一步'} title={story?'配置故事预设':'RP 预设与呈现'} onClick={open}><Quill/><span>{story?'故事预设':'预设'}</span></button>
}

export function PresentationRecords({sessionId,visible,client=api}) {
  const [records,setRecords]=useState([]),[error,setError]=useState(''),[progress,setProgress]=useState('')
  useEffect(()=>{
    if(!visible||!sessionId)return
    const controller=new AbortController();let loading=false,again=false
    const refresh=async()=>{
      if(loading){again=true;return} loading=true
      do {
        again=false
        try{const state=await client.state(sessionId,controller.signal);if(!controller.signal.aborted){setRecords(state.presentations??[]);setError('')}}
        catch(cause){if(!controller.signal.aborted)setError(cause.message)}
      }while(again&&!controller.signal.aborted)
      loading=false
    }
    setRecords([]);setError('');setProgress('');void refresh()
    const close=client.subscribe(sessionId,event=>{
      if(controller.signal.aborted)return
      if(event.type==='stage'){
        setProgress(['complete','failed','cancelled'].includes(event.status)?'':phaseName[event.stageId]??'正在处理')
        if(['complete','failed','cancelled','rendered'].includes(event.status))void refresh()
      }else void refresh()
    },()=>{if(!controller.signal.aborted)setProgress('正在重新同步')})
    return()=>{controller.abort();close()}
  },[sessionId,visible,client])
  const completed=records.filter(record=>record.status==='complete')
  return <section className="rpls-records" aria-label="本会话生成记录">
    <header><h2>生成记录</h2><p>本会话已提交的正文稿件，按生成时间排列。</p></header>
    {progress&&<p role="status">{progress}…</p>}{error&&<p role="alert">{error}</p>}
    {!completed.length&&<p className="rpls-record-empty">尚未提交正文。在当前故事应用就绪预设后，Agent 完成处理并调用最后一步，稿件会显示在这里。</p>}
    {completed.map(record=><article key={record.id}><div className="rpls-record-meta"><span>{new Date(record.createdAt).toLocaleString()}</span><span>预设版本 {record.profileVersion}</span>{record.truncated&&<span>达到输出上限</span>}</div><div className="rpls-record-text">{record.text}</div></article>)}
  </section>
}

function LastStepWorkspace({sessionId,visible}) {
  const [view,setView]=useState('presets')
  return <div className="rpls-shell" data-rp-last-step-root={sessionId}>
    <nav className="rpls-shell-tabs" aria-label="最后一步视图"><button type="button" aria-pressed={view==='presets'} onClick={()=>setView('presets')}>预设管理</button><button type="button" aria-pressed={view==='records'} onClick={()=>setView('records')}>生成记录</button></nav>
    <div className="rpls-shell-view" style={{display:view==='presets'?'flex':'none'}}><PresetWorkspace sessionId={sessionId} visible={visible&&view==='presets'}/></div>
    <div className="rpls-shell-view" style={{display:view==='records'?'flex':'none'}}><PresentationRecords sessionId={sessionId} visible={visible&&view==='records'}/></div>
  </div>
}

export function apply(ctx) {
  ctx.effect(()=>{const style=document.createElement('style');style.dataset.rpLastStep='';style.textContent=css;document.head.append(style);return()=>style.remove()},'RP last-step styles')
  function Body({sessionId,useTabInfo}){const {tab}=useTabInfo();return <LastStepWorkspace key={sessionId} sessionId={sessionId} visible={tab.visible}/>}
  ctx.effect(()=>ctx.sidebarRightTabs.register({id:TAB_ID,kind:TAB_KIND,title:()=> 'RP 预设与呈现',guide:[{id:TAB_KIND,order:37,title:()=> 'RP 最后一步',description:()=> '预设迁移、模块权限与最终正文'}]}),'RP last-step tab')
  ctx.effect(()=>ctx.slots.inject('sidebar.right.pane.tab',()=>ctx.slots.register({name:'sidebar.right.pane.tab',key:TAB_ID},Body)),'RP last-step pane')
  for(const name of ['conversation.session.header.actions','conversation.hero.options'])ctx.effect(()=>ctx.slots.inject(name,()=>ctx.slots.register({name,id:TAB_ID,order:37,inject:()=>({open:()=>ctx.sidebarRight.openTab(TAB_KIND)})},OpenButton)),`RP last-step entry ${name}`)
  ctx.effect(()=>ctx.slots.inject('rp.studio.workspace.actions',()=>ctx.slots.register({name:'rp.studio.workspace.actions',id:TAB_ID,order:37,inject:()=>({open:()=>ctx.sidebarRight.openTab(TAB_KIND),story:true})},OpenButton)),'RP Studio preset contribution')
}
