import React, { useEffect, useRef, useState } from 'react'

const json = value => JSON.stringify(value, null, 2)
function download(name, mimeType, body) {
  const url = URL.createObjectURL(new Blob([body], { type: mimeType }))
  const anchor = document.createElement('a')
  anchor.href = url; anchor.download = name; anchor.click()
  URL.revokeObjectURL(url)
}

export function TransferTools({ sessionId, actions, disabled, run, onOpenSession }) {
  const [format, setFormat] = useState('markdown')
  const [reading, setReading] = useState(null)
  const [snapshot, setSnapshot] = useState(null)
  const [incoming, setIncoming] = useState(null)
  const [jobId, setJobId] = useState('')
  const [outcome, setOutcome] = useState(null)
  const [fileBusy, setFileBusy] = useState(false)
  const [fileError, setFileError] = useState('')
  const request = useRef(0), alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false; request.current++ } }, [])
  async function inspect(file) {
    if (!file) return
    const generation = ++request.current
    setIncoming(null); setOutcome(null); setFileError(''); setFileBusy(true)
    try {
      const body = await new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result)
        reader.onerror = () => reject(new Error('存档文件无法读取。'))
        reader.readAsText(file)
      })
      const value = JSON.parse(body)
      if (!alive.current || generation !== request.current) return
      await run('previewSavedStory', { snapshot: value }, preview => {
        if (!alive.current || generation !== request.current) return
        setIncoming({ snapshot: value, preview }); setJobId(crypto.randomUUID())
      })
    } catch (error) { if (alive.current && generation === request.current) setFileError(error.message) }
    finally { if (alive.current && generation === request.current) setFileBusy(false) }
  }
  const blocked = disabled || fileBusy
  const conditional = Boolean(incoming?.preview.deferredChecks?.length)
  return <div className="rp-transfer">
    {sessionId && <div className="rp-action-row"><label>阅读稿格式<select aria-label="阅读稿格式" disabled={blocked} value={format} onChange={event => setFormat(event.target.value)}><option value="markdown">Markdown</option><option value="text">纯文本</option></select></label>
      <button type="button" disabled={blocked || !actions.exportReading} onClick={() => void run('exportReading', { sessionId, format }, setReading)}>导出阅读稿</button>
      <button type="button" disabled={blocked || !actions.exportSavedStory} onClick={() => void run('exportSavedStory', { sessionId }, value => setSnapshot(value.snapshot))}>导出完整存档</button>
    </div>}
    {reading && <details open><summary>阅读稿 · {reading.fileName}</summary><pre>{reading.text}</pre><button type="button" onClick={() => download(reading.fileName, reading.mimeType, reading.text)}>下载阅读稿</button></details>}
    {snapshot && <p><button type="button" onClick={() => download('saved-story.json', 'application/json', json(snapshot))}>下载完整存档</button></p>}
    <label className="rp-file-label">检查完整存档<input type="file" accept="application/json,.json" aria-label="完整存档文件" disabled={blocked || !actions.previewSavedStory} onChange={event => void inspect(event.target.files?.[0])} /></label>
    {fileBusy && <p role="status">正在检查存档…</p>}{fileError && <p role="alert">{fileError}</p>}
    {incoming && <section className="rp-restore"><p>精确保留原 ID；冲突不会覆盖或自动改名。阅读稿不能作为完整存档恢复。</p><pre>{json(incoming.preview)}</pre>
      {conditional && <p role="status">支持条件暂存；目标实际路由尚未完成验证。暂存后由所属插件检查目标真实节点，完成验证前不开放游玩。</p>}
      <label>恢复任务 ID<input aria-label="恢复任务 ID" value={jobId} disabled={blocked || outcome?.status === 'pending' || outcome?.status === 'complete'} onChange={event => setJobId(event.target.value)} /></label>
      <button type="button" disabled={blocked || !actions.restoreSavedStory || incoming.preview.supported !== true || incoming.preview.conflicts?.length > 0 || !jobId.trim() || outcome?.status === 'complete'} onClick={() => void run('restoreSavedStory', { snapshot: incoming.snapshot, restoreId: jobId }, async result => { setOutcome(result); if (result.status === 'complete') await onOpenSession?.(result.sessionId) })}>{outcome?.status === 'pending' ? '继续恢复' : conditional ? '暂存并验证目标路由' : '恢复完整存档'}</button>
      {outcome && <><p role="status">{outcome.status === 'complete' ? '完整存档恢复已完成。' : outcome.status === 'pending' ? '恢复尚未完成；保留任务 ID 后继续恢复。' : '存档恢复未完成，请查看诊断。'}</p><pre>{json(outcome)}</pre></>}
    </section>}
  </div>
}
