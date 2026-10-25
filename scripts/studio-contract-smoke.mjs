// Real Studio UI and action adapter, synthetic owner services. This is ST-A,
// not an installed native-host or model/restore acceptance test.
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium, expect } from '@playwright/test'
import { createStudioActions } from '../packages/plugin/src/actions.mjs'

const { build } = createRequire(new URL('../packages/plugin/package.json', import.meta.url))('esbuild')
const root = process.cwd(), evidence = resolve('.runtime/evidence/studio-contract')
await mkdir(evidence, { recursive: true })
const ref = { sessionId: 'story', presentationId: 'presentation', assistantMessageId: 'assistant', callSeq: 2, baseResultSeq: 3, resultSeq: 3 }
let current = { id: '["presentation",3]', ref, turn: 1, action: '推开门', text: '清晨的码头渐渐醒来。', createdAt: '2026-10-25T00:00:00Z' }
const drafts = [], sessions = ['story'], card = { id: 'generic-gm', title: '码头来信', world: '公开合成世界', protagonist: '旅人', description: '港口的向导', art: 'generic-gm', accent: 'jade' }
const gmState = { schemaVersion: 1, bindingId: 'binding', scene: { schemaVersion: 1, title: '抵港', location: '码头', presentActorIds: [] }, facts: { schemaVersion: 1, items: [{ id: 'arrived', text: '旅人已到港。' }] }, capabilities: { rollback: true, fork: true, autoplay: false } }
function detail(id) {
  return { session: { id, cardId: card.id, title: id === 'story' ? card.title : '回退子故事', running: false, blank: false, updatedAt: 1 }, card: { ...card, title: id === 'story' ? card.title : '回退子故事' }, state: { started: true, statusLines: [], extensions: { gm: gmState }, checkpoints: { canRollback: false, count: 0, activeTurn: null } }, messages: [{ id: current.id, seq: current.ref.resultSeq, role: 'gm', text: current.text, createdAt: 1, status: 'complete' }] }
}
const services = {
  rpLastStep: {
    narratives: async ({ sessionId }) => ({ records: [{ ...current, ref: { ...current.ref, sessionId } }] }),
    drafts: async () => ({ drafts }),
    presentationSummaries: async () => ({ presentations: [{ presentationId: 'failed', status: 'failed', createdAt: '2026-10-25T00:00:00Z', canRetry: false, retryBlockCode: 'RETRY_SUPERSEDED' }], capabilities: { retryDispatch: false } }),
    createDraft: async input => { const draft = { id: `draft-${drafts.length}`, version: 1, sessionId: input.sessionId, basedOn: input.basedOn, kind: input.kind, text: current.text, status: 'ready', createdAt: '2026-10-25T00:00:00Z' }; drafts.push(draft); return draft },
    editDraft: async input => { const draft = drafts.find(item => item.id === input.draftId); if (draft.version !== input.expectedDraftVersion) throw Object.assign(new Error('版本冲突'), { code: 'DRAFT_CONFLICT', status: 409 }); Object.assign(draft, { version: draft.version + 1, kind: 'manual', text: input.text }); return draft },
    adoptDraft: async input => { const draft = drafts.find(item => item.id === input.draftId); if (input.expectedDraftVersion !== draft.version) throw Object.assign(new Error('候选版本已改变'), { code: 'DRAFT_VERSION_CONFLICT', status: 409 }); current = { ...current, id: '["presentation",9]', ref: { ...current.ref, resultSeq: 9 }, text: draft.text }; return { narrative: current } },
    material: async ({ presentationId }) => ({ presentationId, packet: { playerAction: '推开门' }, storySnapshot: { title: '码头来信', character: { assetId: 'guide', version: 1, name: '港口向导', description: '仅用于合成合同测试的固定来源。' }, persona: { assetId: 'traveler', version: 1, name: '旅人', description: '来访者。' }, examples: '' }, contextPreparation: { candidates: [{ ref: { sourceKey: 'world', entryId: '0' }, title: '港口' }] }, compiled: { text: '公开合成冻结模块。' }, models: { render: { provider: 'synthetic', model: 'contract-only' } }, status: 'complete' }),
  },
  rpContext: { authorNote: async () => ({ id: 'note', version: 1, text: '多一些停顿。', status: 'pending' }) },
  rpStoryKit: { apiVersion: 1, state: async () => ({ capabilities: { readingExport: true } }), exportReading: async () => ({ fileName: 'reading.md', mimeType: 'text/markdown', text: `# 阅读稿\n${current.text}` }) },
  rpDatabase: { apiVersion: 2 },
}
const actions = createStudioActions({ getService: name => services[name], authorize: async id => { if (!sessions.includes(id)) throw Object.assign(new Error('无权访问故事。'), { code: 'FORBIDDEN', status: 403 }) } })
const bundle = await build({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {Workspace} from './packages/plugin/src/Workspace.jsx';
function Fixture(){const [id,setId]=React.useState('story');return <Workspace key={id} sessionId={id} openSession={async child=>setId(child)} openOwner={kind=>{window.__openedOwner=kind}} hasOwnerTab={kind=>['rp-story-kit','rp-context','rp-last-step','rp-database'].includes(kind)}/>};createRoot(document.getElementById('mount')).render(<Fixture/>);`, resolveDir: root, sourcefile: 'studio-contract-fixture.jsx', loader: 'jsx' }, bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', nodePaths: [resolve('apps/web/node_modules'), resolve('packages/plugin/node_modules')] })
const css = await readFile(resolve('packages/plugin/src/workspace.css'), 'utf8')
const streams = new Set()
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1')
  if (url.pathname === '/') { response.setHeader('content-type', 'text/html; charset=utf-8'); response.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Studio ST-A contract fixture</title><style>html,body{margin:0;height:100%;background:#eee}#mount{width:460px;max-width:100%;height:100vh;margin-left:auto}#mount.full{width:100%}${css}</style><body><div id="mount"></div><script src="/fixture.js"></script></body></html>`); return }
  if (url.pathname === '/fixture.js') { response.setHeader('content-type', 'text/javascript'); response.end(bundle.outputFiles[0].text); return }
  if (url.pathname === '/api/rp-studio/events') { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write(`event: connected\ndata: ${JSON.stringify({ type: 'connected', sessionId: url.searchParams.get('sessionId') })}\n\n`); streams.add(response); response.on('close', () => streams.delete(response)); return }
  const chunks = []; for await (const chunk of request) chunks.push(chunk)
  const bytes = Buffer.concat(chunks), body = JSON.parse(bytes.toString() || '{}')
  if (url.pathname === '/api/rp-studio/actions') { const result = await actions.request(new Request(`http://127.0.0.1${url.pathname}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: bytes })); response.writeHead(result.status, Object.fromEntries(result.headers)); response.end(Buffer.from(await result.arrayBuffer())); return }
  if (url.pathname === '/api/rp-studio/request') {
    let data
    if (body.path === '/api/v1/cards') data = []
    else if (body.path === '/api/v1/sessions') data = sessions.map(id => detail(id).session)
    else if (body.path.endsWith('/rollback')) { if (!sessions.includes('child')) sessions.push('child'); data = { accepted: true, sessionId: 'child' } }
    else data = detail(decodeURIComponent(body.path.split('/').at(-1)))
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ ok: true, protocolVersion: 1, data })); return
  }
  response.writeHead(404); response.end()
})
await new Promise(done => server.listen(0, '127.0.0.1', done))
let browser
try {
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors = []
  page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (['error', 'warn'].includes(message.type())) errors.push(message.text()) })
  await page.goto(`http://127.0.0.1:${server.address().port}/`)
  await page.getByText('旅人已到港。', { exact: true }).waitFor()
  await expect(page.getByRole('button', { name: '自动续写', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: '沉浸阅读', exact: true }).click()
  const summary = page.locator('.rp-owner-tools > summary').filter({ hasText: '正文与材料' })
  await summary.focus(); await page.keyboard.press('Enter')
  await page.getByRole('button', { name: '手改当前正文', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '候选正文', exact: true })).toBeFocused()
  await page.getByRole('textbox', { name: '候选正文', exact: true }).fill('手工采用后的码头正文。')
  await page.getByRole('button', { name: '保存候选修改', exact: true }).click()
  await page.getByText('候选修改已保存。', { exact: true }).waitFor()
  await page.getByRole('button', { name: '采用这个候选', exact: true }).click()
  await expect(page.locator('.rp-message-gm')).toContainText('手工采用后的码头正文。')
  await page.getByText('已采用正式正文版本 9。', { exact: false }).waitFor()
  const metrics = []
  for (const [name, width, full] of [['sidebar', 1440, false], ['full', 1440, true], ['narrow', 360, true]]) {
    await page.setViewportSize({ width, height: 1000 })
    await page.evaluate(value => document.getElementById('mount').classList.toggle('full', value), full)
    const tools = page.locator('.rp-owner-tools > summary').filter({ hasText: '正文与材料' })
    if (!await tools.evaluate(element => element.parentElement.open)) await tools.click()
    await page.getByRole('button', { name: '查看当前正文材料', exact: true }).click()
    await page.getByText('公开合成冻结模块。', { exact: false }).waitFor()
    const size = await page.locator('.dsh-rp-workspace').evaluate(element => ({ width: element.clientWidth, overflow: element.scrollWidth > element.clientWidth, contentOverflow: [...element.querySelectorAll('.rp-story,.rp-owner-tools')].some(node => node.scrollWidth > node.clientWidth + 1) }))
    expect(size.overflow).toBe(false); expect(size.contentOverflow).toBe(false)
    metrics.push({ name, ...size })
    await page.screenshot({ path: resolve(evidence, `${name}.png`) })
  }
  await page.getByRole('button', { name: '回退', exact: true }).click()
  await page.getByRole('heading', { name: '回退子故事', exact: true }).first().waitFor()
  expect(errors).toEqual([])
  const report = { scope: 'ST-A real Studio UI + actual action adapter with synthetic owner services; not native-host whole-stack evidence', metrics, browserErrors: errors, checks: ['keyboard summary toggle', 'manual editor focus', 'save/adopt/refresh', 'preserved host maintenance notice', 'current frozen material', 'generic autoplay unavailable', 'rollback child navigation'], evidence }
  await writeFile(resolve(evidence, 'result.json'), jsonReport(report))
  console.log(JSON.stringify(report))
} finally {
  actions.close(); await browser?.close(); for (const stream of streams) stream.end(); server.closeAllConnections(); await new Promise(done => server.close(done))
}
function jsonReport(value) { return JSON.stringify(value, null, 2) + '\n' }
