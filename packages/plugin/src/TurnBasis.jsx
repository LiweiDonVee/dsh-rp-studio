import React, { useEffect, useState } from 'react'
import { fullNarrativeRef, refKey, sameRef, validNarrativeRef } from './reading-state.mjs'

const message = cause => `${cause.code ? `${cause.code}：` : ''}${cause.message}`
const modes = { full: '全文', summary: '摘要', index: '索引' }
const modelName = model => model ? `${model.provider} / ${model.model}` : '未记录'

export function TurnBasis({ sessionId, record, client, records, onLocate, openOwner, hasOwnerTab }) {
  const [value, setValue] = useState(null), [error, setError] = useState('')
  const [locating, setLocating] = useState(null), [locationError, setLocationError] = useState('')
  const selected = refKey(record.ref)
  useEffect(() => {
    const controller = new AbortController()
    setValue(null); setError('')
    void client.action('turnDetails', { sessionId, basedOn: fullNarrativeRef(record.ref) }, controller.signal).then(next => {
      if (controller.signal.aborted) return
      if (next?.schemaVersion !== 1 || !sameRef(next.ref, record.ref)) throw new Error('本轮依据与所选正文不一致，请重新打开。')
      setValue(next)
    }).catch(cause => { if (!controller.signal.aborted) setError(message(cause)) })
    return () => controller.abort()
  }, [client, sessionId, selected])
  if (error) return <p role="alert" className="rp-tool-error">{error} 当前所选正文仍保留。</p>
  if (!value) return <p role="status">正在读取本轮依据…</p>
  const changes = value.publicChanges, context = value.context, provenance = value.provenance
  return <section className="rp-turn-basis" aria-label="本轮依据" data-rp-turn-details={selected}>
    <p className="rp-note">此处是本轮已冻结的公开依据。</p>
    <section><h3>公开事实与后果</h3>
      {changes?.available ? <>
        <p>事实回执：{changes.factReceiptRef || '未记录'}</p>
        {[['resolvedChanges', '已经解决的变化'], ['visibleConsequences', '可见后果'], ['openHooks', '未决线索'], ['publicFactRefs', '公开事实引用']].map(([key, label]) => <div key={key}><h4>{label}</h4>{changes[key]?.length ? <ul>{changes[key].map((text, index) => <li key={index}>{text}</li>)}</ul> : <p className="rp-note">未记录</p>}</div>)}
        {changes.truncated && <p>公开依据过长，此处显示部分记录。</p>}
      </> : <p className="rp-note">本轮未保存可读取的公开事实快照。</p>}
    </section>
    <section><h3>已选资料</h3>{context?.available ? context.entries?.length ? <ul>{context.entries.map((entry, index) => <li key={`${entry.id || entry.key || index}-${index}`}><strong>{entry.title || entry.id || entry.key || '未命名条目'}</strong><p>{[entry.key && `槽位 ${entry.key}`, entry.ref?.sourceKey && `来源 ${entry.ref.sourceKey}`, (entry.ref?.entryId || entry.id) && `条目 ${entry.ref?.entryId || entry.id}`, (entry.ref?.version ?? entry.version) !== undefined && `版本 ${entry.ref?.version ?? entry.version}`, entry.ref?.databaseVersion !== undefined && `资料库版本 ${entry.ref.databaseVersion}`, entry.mode && (modes[entry.mode] || entry.mode)].filter(Boolean).join(' · ')}</p></li>)}</ul> : <p className="rp-note">本轮未记录已选资料条目。</p> : <p className="rp-note">本轮选材记录不可用。</p>}</section>
    <section><h3>历史依据</h3>{context?.available ? context.history?.length ? <ul>{context.history.map((history, index) => {
      const source = history.source || {}
      const target = records.find(item => item.ref.sessionId === (source.sessionId || sessionId) && item.ref.presentationId === source.presentationId && ['assistantMessageId', 'callSeq', 'baseResultSeq', 'resultSeq'].every(key => source[key] === undefined || source[key] === item.ref[key]))
      const exact = validNarrativeRef(source) && source.sessionId === sessionId ? source : null
      return <li key={`${history.id}-${index}`}><span>{modes[history.mode] || history.mode} · {history.id}</span>{source.resultSeq !== undefined && <span> · seq {source.resultSeq}</span>}{target || exact ? <button type="button" disabled={locating !== null} onClick={async () => { setLocating(index); setLocationError(''); try { await onLocate(target?.ref || fullNarrativeRef(exact)) } catch (cause) { setLocationError(message(cause)) } finally { setLocating(null) } }}>{locating === index ? '正在定位…' : target ? '回到该轮正文' : '载入并定位该轮正文'}</button> : <p className="rp-note">{source.presentationId ? `正文 ${source.presentationId} 未记录完整可定位引用。` : '未记录可定位的正文引用。'}</p>}</li>
    })}</ul> : <p className="rp-note">本轮未记录历史依据。</p> : <p className="rp-note">本轮历史选材记录不可用。</p>}{locationError && <p role="status">{locationError}</p>}{context?.truncated && <p>此处显示部分条目；资料 {context.entriesCount} 条，历史 {context.historyCount} 条。</p>}</section>
    <section><h3>本轮处理记录</h3><p>{provenance?.status ? `呈现状态：${provenance.status}` : '未记录呈现状态'}</p><dl className="rp-stage-list">{[['素材准备', provenance?.contextModels?.prepare], ['历史汇总', provenance?.contextModels?.summarize], ['组稿', provenance?.models?.assemble], ['写作', provenance?.models?.render]].map(([label, model]) => <div key={label}><dt>{label}</dt><dd>{modelName(model)}</dd></div>)}</dl>{openOwner && hasOwnerTab?.('loop-studio') && <button type="button" onClick={() => openOwner('loop-studio')}>查看流程与模型</button>}</section>
  </section>
}
