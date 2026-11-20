import React, { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StoryReader } from '../../../packages/plugin/src/StoryReader.jsx'
import { PlayerActions } from '../../../packages/plugin/src/PlayerActions.jsx'

const ref = number => ({ sessionId: 'story', presentationId: `turn-${number}`, assistantMessageId: `writer-${number}`, callSeq: number * 10, baseResultSeq: number * 10 + 1, resultSeq: number * 10 + 1 })
const record = number => ({ id: `prose-${number}`, ref: ref(number), turn: number, action: `行动 ${number}`, text: `已确认正文 ${number}。` })
const services = Object.fromEntries(['gm', 'storyKit', 'database', 'context', 'lastStep', 'loop'].map(key => [key, { available: true, apiVersion: 1 }]))

function fixture() {
  let records = Array.from({ length: 20 }, (_, index) => record(index + 1)), projection = 'projection-1', noteRevision = 13
  let drafts = [], note = { id: 'note', version: 2, status: 'claimed', text: '原作者注' }
  const handlers = {}, calls = []
  const actions = Object.fromEntries(['readingPage', 'turnDetails', 'narratives', 'drafts', 'createDraft', 'adoptDraft', 'authorNoteState', 'setAuthorNote'].map(name => [name, true]))
  const client = { action: vi.fn(async (name, input, signal) => {
    calls.push({ name, input: structuredClone(input), signal })
    if (handlers[name]) return handlers[name](input, signal)
    if (name === 'capabilities') return { schemaVersion: 1, services, actions, story: { generic: true } }
    if (name === 'readingPage') {
      if (input.before && input.before.projectionKey !== projection) throw Object.assign(new Error('正文已变化'), { code: 'STALE_READING', status: 409 })
      const end = input.before ? records.findIndex(item => item.ref.callSeq === input.before.callSeq && item.ref.presentationId === input.before.presentationId) : records.length
      const start = Math.max(0, end - input.limit), page = records.slice(start, end)
      return { schemaVersion: 1, projectionKey: projection, records: page, hasOlder: start > 0, nextBefore: start > 0 ? { projectionKey: projection, callSeq: page[0].ref.callSeq, presentationId: page[0].ref.presentationId } : null, totalCount: records.length }
    }
    if (name === 'turnDetails') return { schemaVersion: 1, projectionKey: projection, ref: input.basedOn, record: records.find(item => item.ref.presentationId === input.basedOn.presentationId), publicChanges: { available: true, source: 'frozen-packet', factReceiptRef: `fact-${input.basedOn.presentationId}`, resolvedChanges: [`冻结依据 ${input.basedOn.presentationId}`], visibleConsequences: [], openHooks: [], publicFactRefs: [], truncated: false }, context: { available: true, entries: [{ title: '已选条目', ref: { sourceKey: 'world', entryId: 'harbor', version: 3 } }], history: [{ id: 'history-2', mode: 'summary', source: ref(2) }], entriesCount: 1, historyCount: 1, truncated: false }, provenance: { status: 'rendered', models: { render: { provider: 'local', model: 'writer' } } } }
    if (name === 'narratives') return { records }
    if (name === 'drafts') return { drafts }
    if (name === 'createDraft') { const draft = { id: 'candidate', basedOn: input.basedOn, version: 2, kind: input.kind, status: 'ready', text: '候选稿全文。' }; drafts = [...drafts, draft]; return draft }
    if (name === 'adoptDraft') { const narrative = { ...records.at(-1), id: 'adopted', ref: { ...records.at(-1).ref, resultSeq: 999 }, text: drafts.find(item => item.id === input.draftId).text }; records = [...records.slice(0, -1), narrative]; projection = 'projection-2'; return { narrative } }
    if (name === 'authorNoteState') return { schemaVersion: 1, revision: noteRevision, note }
    if (name === 'setAuthorNote') { if (input.expectedRevision !== noteRevision) throw Object.assign(new Error('作者注版本已变化'), { code: 'REVISION_CONFLICT', status: 409 }); noteRevision++; note = { ...note, version: note.version + 1, text: input.text, status: 'pending' }; return { revision: noteRevision, note } }
    throw new Error(`Unexpected action ${name}`)
  }) }
  const detail = { session: { id: 'story', running: false }, card: { title: '长篇故事', protagonist: '旅人', world: '远山' }, state: { extensions: { reader: { status: 'available' }, gm: {} } }, messages: records.map(item => ({ id: item.id, role: 'gm', seq: item.ref.resultSeq, text: item.text })) }
  return { client, detail, handlers, calls, actions, setProjection(value) { projection = value }, setNoteRevision(value) { noteRevision = value }, reviseLatest() { records = [...records.slice(0, -1), { ...records.at(-1), ref: { ...records.at(-1).ref, resultSeq: 999 }, text: '已采用的新版本正文。' }]; projection = 'projection-adopted' }, appendTurn() { records = [...records, record(21)]; projection = 'projection-new-turn' } }
}

function ReaderWithComposer({ onAppendAction, ...props }) {
  const [source, setSource] = useState(null)
  return <><StoryReader {...props} onReadingSource={setSource} /><footer><PlayerActions source={source?.sessionId === props.sessionId ? source : null} client={props.client} disabled={props.detail.session.running || props.factReviewPending} onAppendAction={onAppendAction} /></footer></>
}
function mount(h, extra = {}) {
  const Reader = extra.onAppendAction ? ReaderWithComposer : StoryReader
  return render(<Reader sessionId="story" detail={h.detail} streaming={{}} client={h.client} narrativeRevision="same" onAdopt={vi.fn()} {...extra} />)
}
const card = (view, number) => within(view.container.querySelector(`[data-rp-reading-presentation="turn-${number}"]`))
const openDetails = async summary => { fireEvent.click(await screen.findByText(summary)); await act(async () => {}) }

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('recent story reader', () => {
  it('remembers already displayed confirmed prose before passive reads finish and ignores late prior-story responses', async () => {
    const h = fixture(), remembered = vi.fn(), pending = []
    h.handlers.capabilities = (_input, signal) => new Promise(resolve => pending.push({ resolve, signal }))
    const view = mount(h, { onReadingOpened: remembered })
    await screen.findByText('已确认正文 20。')
    expect(remembered).toHaveBeenCalledExactlyOnceWith('story')
    expect(h.calls.some(call => call.name === 'readingPage')).toBe(false)
    const other = { ...h.detail, session: { id: 'other', running: false }, messages: [{ id: 'other-prose', role: 'gm', status: 'complete', text: '另一个故事已经显示的正文。' }] }
    view.rerender(<StoryReader sessionId="other" detail={other} streaming={{}} client={h.client} narrativeRevision="other" onReadingOpened={remembered} />)
    expect(remembered.mock.calls).toEqual([['story'], ['other']])
    await act(async () => { for (const request of pending) request.resolve({ schemaVersion: 1, services, actions: {} }) })
    expect(remembered.mock.calls).toEqual([['story'], ['other']])
    expect(pending.some(request => request.signal.aborted)).toBe(true)
  })

  it('remembers a canonical-only body once it is displayed without repeating on readback', async () => {
    const h = fixture(), remembered = vi.fn()
    h.detail.messages = []
    const view = mount(h, { onReadingOpened: remembered })
    await screen.findByText('已确认正文 20。')
    expect(remembered).toHaveBeenCalledExactlyOnceWith('story')
    view.rerender(<StoryReader sessionId="story" detail={h.detail} streaming={{}} client={h.client} narrativeRevision="refresh" onReadingOpened={remembered} />)
    await waitFor(() => expect(h.calls.filter(call => call.name === 'readingPage')).toHaveLength(2))
    expect(remembered).toHaveBeenCalledExactlyOnceWith('story')
  })

  it.each(['empty', 'player', 'streaming', 'cancelled', 'other-session'])('does not remember %s content as current confirmed reading', async kind => {
    const h = fixture(), remembered = vi.fn()
    h.detail.messages = kind === 'empty' ? [] : [{ id: 'prose', role: kind === 'player' ? 'player' : 'gm', text: '屏幕中的文字。', status: ['streaming', 'cancelled'].includes(kind) ? kind : 'complete' }]
    if (kind === 'other-session') h.detail.session.id = 'other'
    h.handlers.readingPage = () => ({ schemaVersion: 1, projectionKey: 'empty', records: [], hasOlder: false, nextBefore: null, totalCount: 0 })
    mount(h, { onReadingOpened: remembered })
    await waitFor(() => expect(h.calls.some(call => call.name === 'readingPage')).toBe(true))
    await waitFor(() => expect(screen.queryByText('正在读取最近正文…')).toBeNull())
    expect(remembered).not.toHaveBeenCalled()
  })

  it('surfaces helper-opening failures and ignores duplicate clicks while preserving the exact selected reference', async () => {
    const h = fixture()
    let rejectOpening
    const companion = vi.fn(() => new Promise((_resolve, reject) => { rejectOpening = reject }))
    const view = mount(h, { onOpenCompanion: companion })
    await waitFor(() => expect(view.container.querySelectorAll('[data-rp-reading-presentation]')).toHaveLength(8))
    const ask = card(view, 13).getByRole('button', { name: '问 RP 助手' })
    fireEvent.click(ask); fireEvent.click(ask)
    expect(companion).toHaveBeenCalledOnce()
    expect(companion).toHaveBeenCalledWith({ operation: 'story.turnDetails', basedOn: ref(13) })
    expect(ask).toBeDisabled()
    await act(async () => rejectOpening(new Error('输入框暂不能接收草稿')))
    expect(await screen.findByRole('alert')).toHaveTextContent('输入框暂不能接收草稿')
    expect(ask).not.toBeDisabled()
    expect(h.calls.some(call => ['createDraft', 'adoptDraft', 'regenerateProse'].includes(call.name))).toBe(false)
  })

  it('loads only the recent full prose page; basis, drafts, traces and models stay idle until selected', async () => {
    const h = fixture(), companion = vi.fn(), view = mount(h, { onOpenCompanion: companion })
    await waitFor(() => expect(view.container.querySelectorAll('[data-rp-reading-presentation]')).toHaveLength(8))
    expect(screen.queryByText('已确认正文 1。')).toBeNull()
    expect(h.calls.filter(call => !['capabilities', 'readingPage'].includes(call.name))).toHaveLength(0)
    expect(h.calls.find(call => call.name === 'readingPage').input).toEqual({ sessionId: 'story', limit: 8 })
    fireEvent.click(card(view, 13).getByRole('button', { name: '本轮依据' }))
    await screen.findByText('冻结依据 turn-13')
    expect(h.calls.find(call => call.name === 'turnDetails').input).toEqual({ sessionId: 'story', basedOn: ref(13) })
    expect(screen.queryByText('冻结依据 turn-20')).toBeNull()
    fireEvent.click(card(view, 13).getByRole('button', { name: '问 RP 助手' }))
    expect(companion).toHaveBeenCalledWith({ operation: 'story.turnDetails', basedOn: ref(13) })
    fireEvent.click(card(view, 13).getByRole('button', { name: '其他写法' }))
    await screen.findByText('历史回合可浏览已保存版本；生成与采用仅对当前可修订的最新正文开放。')
    expect(h.calls.some(call => ['createDraft', 'adoptDraft', 'regenerateProse'].includes(call.name))).toBe(false)
  })

  it('loads older confirmed pages on demand and follows an exact historical evidence link', async () => {
    const h = fixture(), view = mount(h)
    await waitFor(() => expect(view.container.querySelectorAll('[data-rp-reading-presentation]')).toHaveLength(8))
    fireEvent.click(card(view, 20).getByRole('button', { name: '本轮依据' }))
    fireEvent.click(await screen.findByRole('button', { name: '载入并定位该轮正文' }))
    await waitFor(() => expect(view.container.querySelectorAll('[data-rp-reading-presentation]')).toHaveLength(20))
    expect(h.calls.filter(call => call.name === 'readingPage')).toHaveLength(3)
    expect(h.calls.filter(call => call.name === 'readingPage')[1].input.before).toEqual({ projectionKey: 'projection-1', callSeq: 130, presentationId: 'turn-13' })
    expect(screen.getByText('已确认正文 2。')).toBeTruthy()
    expect(screen.getByRole('button', { name: '回到该轮正文' })).toBeTruthy()
    expect(h.calls.some(call => ['createDraft', 'regenerateProse', 'adoptDraft'].includes(call.name))).toBe(false)
  })

  it('opens the same historical scene beside a long reading viewport and closes without moving it', async () => {
    const h = fixture(), open = vi.fn()
    h.actions.forkStoryAtReading = true
    const records = Array.from({ length: 8 }, (_, index) => ({ ...record(index + 13), ...(index === 0 ? { text: '长正文中的一段。\n\n'.repeat(600) } : {}) }))
    h.handlers.readingPage = () => ({ schemaVersion: 1, projectionKey: 'long-page', records, hasOlder: false, nextBefore: null, totalCount: 8 })
    h.handlers.forkStoryAtReading = input => ({ sessionId: 'child', binding: { sessionId: 'child' }, parentSessionId: 'story', basedOn: input.basedOn, branchRef: { ...input.basedOn, sessionId: 'child' } })
    const view = mount(h, { onOpenSession: open })
    await waitFor(() => expect(view.container.querySelectorAll('[data-rp-reading-presentation]')).toHaveLength(8))
    const reader = view.container.querySelector('[data-rp-reader]'), prose = view.container.querySelector('[data-rp-reading-presentation="turn-13"]')
    Object.defineProperties(reader, { clientHeight: { configurable: true, get: () => 500 }, scrollHeight: { configurable: true, get: () => 12000 } })
    reader.scrollTop = 4800; fireEvent.scroll(reader)
    const trigger = card(view, 13).getByRole('button', { name: '本轮依据' }), focus = vi.spyOn(trigger, 'focus')
    fireEvent.click(trigger)
    const panel = await screen.findByRole('region', { name: '本轮阅读工具' })
    await within(panel).findByText('冻结依据 turn-13')
    expect(reader.contains(panel)).toBe(false)
    expect(panel.parentElement).toBe(reader.parentElement)
    expect(panel).toHaveAttribute('data-rp-tool-presentation', 'turn-13')
    expect(prose.firstElementChild).toHaveClass('rp-reading-actions')
    expect(reader.scrollTop).toBe(4800)
    expect(h.calls.find(call => call.name === 'turnDetails').input.basedOn).toEqual(ref(13))
    fireEvent.click(within(panel).getByRole('button', { name: '其他写法' }))
    await within(panel).findByText('历史回合可浏览已保存版本；生成与采用仅对当前可修订的最新正文开放。')
    expect(reader.scrollTop).toBe(4800)
    expect(h.calls.some(call => ['createDraft', 'adoptDraft', 'suggestPlayerActions'].includes(call.name))).toBe(false)
    fireEvent.click(within(panel).getByRole('button', { name: '从这一幕另走' }))
    await waitFor(() => expect(open).toHaveBeenCalledWith('child', 'story'))
    expect(h.calls.find(call => call.name === 'forkStoryAtReading').input.basedOn).toEqual(ref(13))
    fireEvent.click(within(panel).getByRole('button', { name: '关闭阅读工具' }))
    expect(screen.queryByRole('region', { name: '本轮阅读工具' })).toBeNull()
    expect(reader.scrollTop).toBe(4800)
    expect(view.container.querySelector('[data-rp-reading-presentation="turn-13"]')).toBe(prose)
    expect(focus).toHaveBeenCalledWith({ preventScroll: true })
  })

  it('keeps a changed selected scene explicit instead of retargeting the open reading tools', async () => {
    const h = fixture(), view = mount(h)
    await waitFor(() => expect(view.container.querySelectorAll('[data-rp-reading-presentation]')).toHaveLength(8))
    fireEvent.click(card(view, 20).getByRole('button', { name: '本轮依据' }))
    await screen.findByText('冻结依据 turn-20')
    h.reviseLatest()
    view.rerender(<StoryReader sessionId="story" detail={h.detail} streaming={{}} client={h.client} narrativeRevision="changed" />)
    const panel = screen.getByRole('region', { name: '本轮阅读工具' })
    await within(panel).findByText('所选正文已变化，请在阅读中重新选择这一幕。')
    expect(within(panel).queryByRole('button', { name: '其他写法' })).toBeNull()
    expect(h.calls.filter(call => call.name === 'turnDetails')).toHaveLength(1)
  })

  it('preserves visible anchors and loaded nodes while prepending and on an identical readback', async () => {
    const h = fixture(), view = mount(h)
    await waitFor(() => expect(view.container.querySelectorAll('[data-rp-reading-presentation]')).toHaveLength(8))
    const reader = view.container.querySelector('[data-rp-reader]')
    Object.defineProperties(reader, { clientHeight: { configurable: true, get: () => 400 }, scrollHeight: { configurable: true, get: () => reader.querySelectorAll('[data-rp-reading-presentation]').length * 100 } })
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function () {
      const index = [...reader.querySelectorAll('[data-rp-reading-presentation]')].indexOf(this)
      const top = index < 0 ? 0 : index * 100 - reader.scrollTop
      return { top, bottom: top + 100, left: 0, right: 300, width: 300, height: 100, x: 0, y: top, toJSON() {} }
    })
    reader.scrollTop = 200; fireEvent.scroll(reader)
    const anchored = view.container.querySelector('[data-rp-reading-presentation="turn-15"]')
    const top = anchored.getBoundingClientRect().top
    fireEvent.click(screen.getByRole('button', { name: '加载更早' }))
    await waitFor(() => expect(view.container.querySelectorAll('[data-rp-reading-presentation]')).toHaveLength(16))
    expect(view.container.querySelector('[data-rp-reading-presentation="turn-15"]')).toBe(anchored)
    expect(anchored.getBoundingClientRect().top).toBe(top)
    const before = reader.scrollTop
    view.rerender(<StoryReader sessionId="story" detail={{ ...h.detail }} streaming={{}} client={h.client} narrativeRevision="noop-refresh" />)
    await waitFor(() => expect(h.calls.filter(call => call.name === 'readingPage')).toHaveLength(3))
    expect(view.container.querySelectorAll('[data-rp-reading-presentation]')).toHaveLength(16)
    expect(reader.scrollTop).toBe(before)
  })

  it('keeps the loaded page after a stale cursor without raw-history fallback', async () => {
    const h = fixture(), view = mount(h)
    await waitFor(() => expect(view.container.querySelectorAll('[data-rp-reading-presentation]')).toHaveLength(8))
    h.setProjection('changed')
    fireEvent.click(screen.getByRole('button', { name: '加载更早' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('STALE_READING')
    expect(view.container.querySelectorAll('[data-rp-reading-presentation]')).toHaveLength(8)
    expect(h.calls.some(call => ['narratives', 'storyHistory', 'material'].includes(call.name))).toBe(false)
  })

  it.each(['adoption', 'new turn'])('rebuilds the opened canonical window and preserves its browsing anchor after %s', async change => {
    const h = fixture(), view = mount(h)
    await waitFor(() => expect(view.container.querySelectorAll('[data-rp-reading-presentation]')).toHaveLength(8))
    fireEvent.click(screen.getByRole('button', { name: '加载更早' }))
    await waitFor(() => expect(view.container.querySelectorAll('[data-rp-reading-presentation]')).toHaveLength(16))
    const reader = view.container.querySelector('[data-rp-reader]')
    Object.defineProperties(reader, { clientHeight: { configurable: true, get: () => 400 }, scrollHeight: { configurable: true, get: () => reader.querySelectorAll('[data-rp-reading-presentation]').length * 100 } })
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function () {
      const index = [...reader.querySelectorAll('[data-rp-reading-presentation]')].indexOf(this)
      const top = index < 0 ? 0 : index * 100 - reader.scrollTop
      return { top, bottom: top + 100, left: 0, right: 300, width: 300, height: 100, x: 0, y: top, toJSON() {} }
    })
    reader.scrollTop = 200; fireEvent.scroll(reader)
    const anchored = view.container.querySelector('[data-rp-reading-presentation="turn-7"]'), top = anchored.getBoundingClientRect().top
    if (change === 'adoption') h.reviseLatest()
    else h.appendTurn()
    view.rerender(<StoryReader sessionId="story" detail={{ ...h.detail }} streaming={{}} client={h.client} narrativeRevision={change} />)
    await waitFor(() => expect(h.calls.filter(call => call.name === 'readingPage')).toHaveLength(4))
    await waitFor(() => expect(view.container.querySelectorAll('[data-rp-reading-presentation]')).toHaveLength(change === 'adoption' ? 16 : 17))
    expect(view.container.querySelector('[data-rp-reading-presentation]')).toHaveAttribute('data-rp-reading-presentation', 'turn-5')
    expect(view.container.querySelector('[data-rp-reading-presentation="turn-7"]')).toBe(anchored)
    expect(anchored.getBoundingClientRect().top).toBe(top)
    expect(h.calls.filter(call => call.name === 'readingPage')[3].input.before.projectionKey).toBe(change === 'adoption' ? 'projection-adopted' : 'projection-new-turn')
    if (change === 'adoption') expect(screen.getByText('已采用的新版本正文。')).toBeTruthy()
    else expect(screen.getByText('已确认正文 21。')).toBeTruthy()
    expect(h.calls.some(call => ['createDraft', 'adoptDraft', 'regenerateProse', 'narratives', 'storyHistory'].includes(call.name))).toBe(false)
  })

  it('discards a delayed basis response after switching the exact selected round', async () => {
    const h = fixture(), view = mount(h)
    let finish
    h.handlers.turnDetails = input => input.basedOn.presentationId === 'turn-20' ? new Promise(resolve => { finish = () => resolve({ schemaVersion: 1, ref: input.basedOn, publicChanges: { available: false }, context: { available: false }, provenance: {} }) }) : Promise.resolve({ schemaVersion: 1, ref: input.basedOn, publicChanges: { available: true, resolvedChanges: ['保留第十九轮依据'] }, context: { available: false }, provenance: {} })
    await waitFor(() => expect(view.container.querySelectorAll('[data-rp-reading-presentation]')).toHaveLength(8))
    fireEvent.click(card(view, 20).getByRole('button', { name: '本轮依据' }))
    await waitFor(() => expect(finish).toBeTypeOf('function'))
    fireEvent.click(card(view, 19).getByRole('button', { name: '本轮依据' }))
    await screen.findByText('保留第十九轮依据')
    await act(async () => finish())
    expect(h.calls.find(call => call.name === 'turnDetails').signal.aborted).toBe(true)
    expect(screen.getByText('保留第十九轮依据')).toBeTruthy()
    expect(screen.queryByText('本轮未保存可读取的公开事实快照。')).toBeNull()
  })

  it('explicitly generates a writer candidate, previews it, and adopts with current narrative and draft CAS', async () => {
    const h = fixture(), adopted = vi.fn(), view = mount(h, { onAdopt: adopted })
    await waitFor(() => expect(view.container.querySelectorAll('[data-rp-reading-presentation]')).toHaveLength(8))
    fireEvent.click(card(view, 20).getByRole('button', { name: '其他写法' }))
    const generate = await screen.findByRole('button', { name: '生成候选稿' })
    await waitFor(() => expect(generate).not.toBeDisabled())
    expect(h.calls.some(call => call.name === 'createDraft')).toBe(false)
    fireEvent.change(screen.getByRole('textbox', { name: '候选稿写作要求' }), { target: { value: '保留雨声' } })
    fireEvent.click(generate)
    await screen.findByText('候选稿全文。')
    expect(h.calls.find(call => call.name === 'createDraft').input).toEqual({ sessionId: 'story', basedOn: ref(20), kind: 'writer', instruction: '保留雨声' })
    expect(h.calls.some(call => call.name === 'adoptDraft')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: '明确采用' }))
    await waitFor(() => expect(adopted).toHaveBeenCalledOnce())
    expect(h.calls.find(call => call.name === 'adoptDraft').input).toEqual({ sessionId: 'story', draftId: 'candidate', expectedDraftVersion: 2, expectedNarrative: ref(20) })
    expect(h.calls.some(call => call.name === 'regenerateProse')).toBe(false)
  })

  it('retains a selected candidate and writing direction after an adoption conflict', async () => {
    const h = fixture(), view = mount(h)
    h.handlers.adoptDraft = async () => { throw Object.assign(new Error('正式版本已变化'), { code: 'NARRATIVE_CONFLICT', status: 409 }) }
    await waitFor(() => expect(view.container.querySelectorAll('[data-rp-reading-presentation]')).toHaveLength(8))
    fireEvent.click(card(view, 20).getByRole('button', { name: '其他写法' }))
    const generate = await screen.findByRole('button', { name: '生成候选稿' })
    await waitFor(() => expect(generate).not.toBeDisabled())
    fireEvent.change(screen.getByRole('textbox', { name: '候选稿写作要求' }), { target: { value: '保留的写作方向' } })
    fireEvent.click(generate)
    await screen.findByText('候选稿全文。')
    fireEvent.click(screen.getByRole('button', { name: '明确采用' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('NARRATIVE_CONFLICT')
    expect(screen.getByRole('textbox', { name: '候选稿写作要求' })).toHaveValue('保留的写作方向')
    expect(screen.getByText('候选稿全文。')).toBeTruthy()
  })

  it('keeps the focused candidate direction mounted during a passive canonical readback', async () => {
    const h = fixture(), view = mount(h)
    await waitFor(() => expect(view.container.querySelectorAll('[data-rp-reading-presentation]')).toHaveLength(8))
    fireEvent.click(card(view, 20).getByRole('button', { name: '其他写法' }))
    const generate = await screen.findByRole('button', { name: '生成候选稿' })
    await waitFor(() => expect(generate).not.toBeDisabled())
    const input = screen.getByRole('textbox', { name: '候选稿写作要求' })
    fireEvent.change(input, { target: { value: '被动同步时保留输入与焦点' } }); input.focus()
    let finish
    h.handlers.readingPage = () => new Promise(resolve => { finish = () => resolve({ schemaVersion: 1, projectionKey: 'projection-1', records: Array.from({ length: 8 }, (_, index) => record(index + 13)), hasOlder: true, nextBefore: { projectionKey: 'projection-1', callSeq: 130, presentationId: 'turn-13' }, totalCount: 20 }) })
    view.rerender(<StoryReader sessionId="story" detail={h.detail} streaming={{}} client={h.client} narrativeRevision="passive-refresh" factReviewPending />)
    await waitFor(() => expect(finish).toBeTypeOf('function'))
    expect(screen.getByRole('textbox', { name: '候选稿写作要求' })).toBe(input)
    expect(document.activeElement).toBe(input)
    expect(generate).toBeDisabled()
    await act(async () => finish())
    view.rerender(<StoryReader sessionId="story" detail={h.detail} streaming={{}} client={h.client} narrativeRevision="passive-refresh" factReviewPending={false} />)
    expect(input).toHaveValue('被动同步时保留输入与焦点')
    expect(document.activeElement).toBe(input)
    expect(generate).not.toBeDisabled()
  })

  it('aborts waiting for a candidate and ignores a late reply without adopting it', async () => {
    const h = fixture(), view = mount(h)
    let finish
    h.handlers.createDraft = input => new Promise(resolve => { finish = () => resolve({ id: 'late', basedOn: input.basedOn, text: '迟到的候选', version: 1, status: 'ready' }) })
    await waitFor(() => expect(view.container.querySelectorAll('[data-rp-reading-presentation]')).toHaveLength(8))
    fireEvent.click(card(view, 20).getByRole('button', { name: '其他写法' }))
    const generate = await screen.findByRole('button', { name: '生成候选稿' })
    await waitFor(() => expect(generate).not.toBeDisabled())
    fireEvent.click(generate)
    fireEvent.click(await screen.findByRole('button', { name: '停止等待候选操作' }))
    expect(h.calls.find(call => call.name === 'createDraft').signal.aborted).toBe(true)
    await act(async () => finish())
    expect(screen.queryByText('迟到的候选')).toBeNull()
    expect(h.calls.some(call => call.name === 'adoptDraft')).toBe(false)
  })

  it('loads author notes on opening and saves with Context state revision while preserving late typing', async () => {
    const h = fixture(), view = mount(h)
    await waitFor(() => expect(view.container.querySelectorAll('[data-rp-reading-presentation]')).toHaveLength(8))
    expect(h.calls.some(call => call.name === 'authorNoteState')).toBe(false)
    await openDetails('下一轮作者注')
    const input = await screen.findByRole('textbox', { name: '下一轮作者注文字' })
    expect(input).toHaveValue('原作者注')
    fireEvent.change(input, { target: { value: '下一轮多些停顿' } })
    let finish
    h.handlers.setAuthorNote = body => new Promise(resolve => { finish = () => resolve({ revision: 14, note: { id: 'note', text: body.text, version: 3, status: 'pending' } }) })
    fireEvent.click(screen.getByRole('button', { name: '保存下一轮作者注' }))
    fireEvent.change(input, { target: { value: '下一轮多些停顿。继续输入。' } })
    await act(async () => finish())
    expect(h.calls.find(call => call.name === 'setAuthorNote').input).toEqual({ sessionId: 'story', text: '下一轮多些停顿', expectedRevision: 13 })
    expect(input).toHaveValue('下一轮多些停顿。继续输入。')
    expect(screen.getByRole('button', { name: '保存下一轮作者注' })).not.toBeDisabled()
  })

  it('forks the exact chosen historical scene and opens only a matching owner receipt', async () => {
    const h = fixture(), open = vi.fn()
    h.actions.forkStoryAtReading = true
    h.handlers.forkStoryAtReading = input => ({ sessionId: 'child', binding: { sessionId: 'child' }, parentSessionId: 'story', basedOn: input.basedOn, branchRef: { ...input.basedOn, sessionId: 'child' } })
    const view = mount(h, { onOpenSession: open })
    await waitFor(() => expect(view.container.querySelectorAll('[data-rp-reading-presentation]')).toHaveLength(8))
    expect(h.calls.some(call => call.name === 'forkStoryAtReading')).toBe(false)
    fireEvent.click(card(view, 13).getByRole('button', { name: '从这一幕另走' }))
    await waitFor(() => expect(open).toHaveBeenCalledWith('child', 'story'))
    expect(h.calls.find(call => call.name === 'forkStoryAtReading').input).toEqual({ sessionId: 'story', basedOn: ref(13) })
    expect(h.calls.some(call => call.name === 'forkStory')).toBe(false)
  })

  it.each(['running', 'pending review'])('keeps an earlier scene fork available while a later turn is %s, without enabling suggestions', async status => {
    const h = fixture(), open = vi.fn()
    h.detail.session.running = status === 'running'
    h.actions.forkStoryAtReading = true; h.actions.suggestPlayerActions = true
    let finish
    h.handlers.forkStoryAtReading = input => new Promise(resolve => { finish = () => resolve({ sessionId: 'child', binding: { sessionId: 'child' }, parentSessionId: 'story', basedOn: input.basedOn, branchRef: { ...input.basedOn, sessionId: 'child' } }) })
    const view = mount(h, { onOpenSession: open, onAppendAction: vi.fn(), factReviewPending: status === 'pending review' })
    await waitFor(() => expect(view.container.querySelectorAll('[data-rp-reading-presentation]')).toHaveLength(8))
    expect(screen.getByRole('button', { name: '陪我想下一步' })).toBeDisabled()
    const earlier = card(view, 13).getByRole('button', { name: '从这一幕另走' })
    expect(earlier).not.toBeDisabled()
    fireEvent.click(earlier)
    expect(card(view, 14).getByRole('button', { name: '从这一幕另走' })).toBeDisabled()
    fireEvent.click(earlier)
    expect(h.calls.filter(call => call.name === 'forkStoryAtReading')).toHaveLength(1)
    expect(h.calls.find(call => call.name === 'forkStoryAtReading').input.basedOn).toEqual(ref(13))
    await act(async () => finish())
    expect(open).toHaveBeenCalledExactlyOnceWith('child', 'story')
    expect(h.calls.some(call => ['forkStory', 'suggestPlayerActions'].includes(call.name))).toBe(false)
  })

  it('shows the owner refusal for an earlier scene without falling back or replaying', async () => {
    const h = fixture(), open = vi.fn()
    h.actions.forkStoryAtReading = true
    h.handlers.forkStoryAtReading = () => { throw Object.assign(new Error('这一幕的分支前缀尚不可用。'), { code: 'READING_FORK_UNAVAILABLE' }) }
    const view = mount(h, { onOpenSession: open, factReviewPending: true })
    await waitFor(() => expect(view.container.querySelectorAll('[data-rp-reading-presentation]')).toHaveLength(8))
    fireEvent.click(card(view, 13).getByRole('button', { name: '从这一幕另走' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('READING_FORK_UNAVAILABLE：这一幕的分支前缀尚不可用。')
    expect(open).not.toHaveBeenCalled()
    expect(h.calls.filter(call => call.name === 'forkStoryAtReading')).toHaveLength(1)
    expect(h.calls.some(call => call.name === 'forkStory')).toBe(false)
  })

  it.each(['basedOn', 'branchRef', 'parentSessionId', 'binding'])('rejects a mismatched %s in a reading fork receipt', async field => {
    const h = fixture(), open = vi.fn()
    h.actions.forkStoryAtReading = true
    h.handlers.forkStoryAtReading = input => ({ sessionId: 'child', binding: { sessionId: 'child' }, parentSessionId: 'story', basedOn: input.basedOn, branchRef: { ...input.basedOn, sessionId: 'child' }, [field]: field === 'parentSessionId' ? 'other' : { ...input.basedOn, sessionId: 'other' } })
    const view = mount(h, { onOpenSession: open })
    await waitFor(() => expect(view.container.querySelectorAll('[data-rp-reading-presentation]')).toHaveLength(8))
    fireEvent.click(card(view, 20).getByRole('button', { name: '从这一幕另走' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('未收到与这一幕一致的分支确认')
    expect(open).not.toHaveBeenCalled()
    expect(h.calls.filter(call => call.name === 'forkStoryAtReading')).toHaveLength(1)
  })

  it('generates two editable next actions only on click and appends only the chosen text', async () => {
    const h = fixture(), append = vi.fn()
    h.actions.suggestPlayerActions = true
    h.handlers.suggestPlayerActions = input => ({ sessionId: 'story', basedOn: input.basedOn, options: [{ text: '我查看纸条。' }, { text: '我询问守卫。' }] })
    const view = mount(h, { onAppendAction: append })
    const button = await screen.findByRole('button', { name: '陪我想下一步' })
    expect(h.calls.some(call => call.name === 'suggestPlayerActions')).toBe(false)
    expect(card(view, 13).queryByRole('button', { name: '陪我想下一步' })).toBeNull()
    fireEvent.click(button)
    const option = await screen.findByRole('textbox', { name: '行动建议 1' })
    expect(screen.getAllByRole('textbox', { name: /行动建议/u })).toHaveLength(2)
    fireEvent.change(option, { target: { value: '我小心展开纸条。' } })
    fireEvent.click(screen.getByRole('button', { name: '将选项 1 加入行动草稿' }))
    expect(append).toHaveBeenCalledExactlyOnceWith({ sessionId: 'story', basedOn: ref(20), text: '我小心展开纸条。' })
    expect(h.calls.filter(call => call.name === 'suggestPlayerActions')).toHaveLength(1)
    expect(h.calls.some(call => ['createDraft', 'adoptDraft', 'regenerateProse', 'forkStory'].includes(call.name))).toBe(false)
  })

  it.each(['forkStoryAtReading', 'suggestPlayerActions'])('drops late %s responses after a story change without replay', async action => {
    const h = fixture(), open = vi.fn(), append = vi.fn()
    h.actions[action] = true
    let finish
    h.handlers[action] = input => new Promise(resolve => { finish = () => resolve(action === 'forkStoryAtReading'
      ? { sessionId: 'child', binding: { sessionId: 'child' }, parentSessionId: 'story', basedOn: input.basedOn, branchRef: { ...input.basedOn, sessionId: 'child' } }
      : { sessionId: 'story', basedOn: input.basedOn, options: [{ text: '我观察。' }, { text: '我等待。' }] }) })
    const view = mount(h, { onOpenSession: open, onAppendAction: append })
    await waitFor(() => expect(view.container.querySelectorAll('[data-rp-reading-presentation]')).toHaveLength(8))
    fireEvent.click(action === 'forkStoryAtReading' ? card(view, 20).getByRole('button', { name: '从这一幕另走' }) : screen.getByRole('button', { name: '陪我想下一步' }))
    view.rerender(<ReaderWithComposer sessionId="other" detail={{ ...h.detail, session: { id: 'other', running: false } }} streaming={{}} client={h.client} narrativeRevision="other" onOpenSession={open} onAppendAction={append} />)
    expect(h.calls.find(call => call.name === action).signal.aborted).toBe(true)
    await act(async () => finish())
    expect(open).not.toHaveBeenCalled()
    expect(append).not.toHaveBeenCalled()
    expect(screen.queryByRole('textbox', { name: '行动建议 1' })).toBeNull()
    expect(h.calls.filter(call => call.name === action)).toHaveLength(1)
  })

  it('does not append previously shown options after the confirmed body is revised', async () => {
    const h = fixture(), append = vi.fn()
    h.actions.suggestPlayerActions = true
    h.handlers.suggestPlayerActions = input => ({ sessionId: 'story', basedOn: input.basedOn, options: [{ text: '我观察。' }, { text: '我等待。' }] })
    const view = mount(h, { onAppendAction: append })
    fireEvent.click(await screen.findByRole('button', { name: '陪我想下一步' }))
    await screen.findByRole('textbox', { name: '行动建议 1' })
    h.reviseLatest()
    view.rerender(<ReaderWithComposer sessionId="story" detail={h.detail} streaming={{}} client={h.client} narrativeRevision="revised" onAppendAction={append} />)
    await screen.findByText('已采用的新版本正文。')
    expect(screen.queryByRole('button', { name: '将选项 1 加入行动草稿' })).toBeNull()
    expect(append).not.toHaveBeenCalled()
    expect(h.calls.filter(call => call.name === 'suggestPlayerActions')).toHaveLength(1)
  })
})
