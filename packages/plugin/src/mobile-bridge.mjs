export const MOBILE_VIEWS = Object.freeze({ overview: 'state', reading: 'story', facts: 'state', archive: 'archive' })
const defaultOwners = Object.freeze({ assets: 'rp-story-kit', context: 'rp-context', routes: 'loop-studio' })
const ownerPages = Object.freeze({
  assets: ['rp-story-kit', 'rp-database'], context: ['rp-context', 'rp-database'],
  routes: ['rp-last-step'], reading: ['rp-story-kit', 'rp-database', 'rp-last-step', 'rp-context'],
})
const ownerRoots = Object.freeze({
  'rp-story-kit': 'data-story-kit-root', 'rp-database': 'data-rp-database-session', 'rp-last-step': 'data-rp-last-step-root',
  'rp-context': 'data-rp-context-root', 'loop-studio': 'data-loop-session',
})
const pages = [...Object.keys(MOBILE_VIEWS), ...Object.keys(defaultOwners)]
const fields = ['requestId', 'sessionId', 'page', 'presentationId', 'ownerKind']
const isId = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 256
const failure = (code, message) => Object.assign(new Error(message), { code })

function parseRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !fields.includes(key)) || !isId(input.requestId)) {
    throw failure('INVALID_REQUEST', '工作区定位参数无效。')
  }
  const { requestId, page, presentationId, ownerKind } = input
  if (page === 'tasks') throw failure('PAGE_UNAVAILABLE', '任务和审批请在原生 RP 工作区查看。')
  if (!pages.includes(page)) throw failure('INVALID_REQUEST', '工作区页面无效。')
  const global = page === 'assets' && input.sessionId == null
  if ((!global && !isId(input.sessionId)) || (presentationId !== undefined && (page !== 'reading' || !isId(presentationId)))
    || (ownerKind !== undefined && !ownerPages[page]?.includes(ownerKind))) {
    throw failure('INVALID_REQUEST', '工作区定位参数无效。')
  }
  return { requestId, sessionId: global ? null : input.sessionId, page, presentationId, ownerKind: presentationId === undefined ? ownerKind : undefined }
}

async function until(read, signal) {
  while (true) {
    signal.throwIfAborted()
    const value = read()
    if (value) return value
    await new Promise((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(signal.reason) }
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, 32)
      signal.addEventListener('abort', abort, { once: true })
    })
  }
}

function visible(doc, element) {
  return element.isConnected && element.getClientRects().length > 0 && !element.closest('[hidden],[inert]')
    && doc.defaultView?.getComputedStyle(element).visibility === 'visible'
}

/** Only navigation is exposed on the authenticated DSH page. Root markers confirm the owner has rendered. */
export function installMobileBridge({ ctx, tabKind, validateSession, target = globalThis.window, timeoutMs = 11_000 }) {
  if (typeof target?.DshRpMobile?.postMessage !== 'function') return () => {}
  const doc = target.document
  const right = ctx.sidebarRight
  const mounted = () => right.mounted.getSnapshot()
  const post = value => target.DshRpMobile.postMessage(JSON.stringify({ schemaVersion: 1, ...value }))
  const roots = attr => Array.from(doc.querySelectorAll(`[${attr}]`)).filter(element => visible(doc, element))
  const isBlank = id => ctx.sessions?.list.getSnapshot().byId[id]?.blank === true
  const lifetime = new AbortController()
  let pending, confirmed, globalSeat, lastState, lastSidebar
  const sidebar = () => {
    const frame = doc.querySelector('[data-sidebar-drawer]')
    if (!frame || typeof ctx.layout?.toggleSidebar !== 'function') {
      throw failure('SIDEBAR_UNAVAILABLE', '当前页面没有可用的移动导航抽屉。')
    }
    return { schemaVersion: 1, open: !frame.hasAttribute('data-sidebar-collapsed') }
  }
  const readState = (sessionId, previous, opening = false) => {
    if (mounted() !== sessionId) return
    const kind = right.active()?.kind
    if (kind !== tabKind) {
      if (!Object.hasOwn(ownerRoots, kind) || !roots(ownerRoots[kind]).some(element => kind === 'rp-story-kit' || element.getAttribute(ownerRoots[kind]) === sessionId)) return
      const page = ownerPages[previous.page]?.includes(kind) ? previous.page : Object.keys(defaultOwners).find(key => defaultOwners[key] === kind)
        ?? (kind === 'rp-database' ? 'assets' : 'routes')
      return { kind, page }
    }
    const root = roots('data-rp-mobile-page').find(element => element.getAttribute('data-rp-session') === sessionId
      && (!opening || element.getAttribute('data-rp-mobile-request') === previous.requestId))
    if (!root) return
    const page = root.getAttribute('data-rp-mobile-page')
    if (root.querySelector('[data-rp-presentation-missing]')) throw failure('PRESENTATION_NOT_FOUND', '指定正文呈现已不可用，请刷新后重新定位。')
    const presentation = root.querySelector('[data-rp-presentation]')
    const presentationId = presentation && visible(doc, presentation) ? presentation.getAttribute('data-rp-presentation') : undefined
    return { kind, page, presentationId }
  }
  const stateFor = (location, request, seat) => {
    if (!location) return
    const { kind, page, presentationId } = location
    if (request.sessionId === null) {
      if (!isBlank(seat) || !ownerPages.assets.includes(kind)) return
      return { sessionId: null, page: 'assets', ownerKind: kind, seatSessionId: seat }
    }
    const ownerKind = ownerPages[page]?.includes(kind) && (kind !== defaultOwners[page] || request.ownerKind === kind) ? kind : undefined
    return { sessionId: request.sessionId, page, ...(presentationId === undefined ? {} : { presentationId }), ...(ownerKind === undefined ? {} : { ownerKind }) }
  }
  const publishSidebar = () => {
    let next
    try { next = { available: true, open: sidebar().open } }
    catch { next = { available: false } }
    const key = JSON.stringify(next)
    if (key !== lastSidebar) { lastSidebar = key; post({ type: 'sidebar', ...next }) }
  }
  const publishState = () => {
    if (!pending && confirmed) {
      try {
        const state = stateFor(readState(confirmed.seat, confirmed.request), confirmed.request, confirmed.seat)
        const key = JSON.stringify(state)
        if (state && lastState !== key) { lastState = key; post({ type: 'state', ...state }) }
      } catch { /* An unresolved presentation is reported by open, which owns the request. */ }
    }
    publishSidebar()
  }
  const setDrawer = async open => {
    lifetime.signal.throwIfAborted()
    if (sidebar().open === open) return sidebar()
    if (open && right.isExpanded()) right.toggleExpanded()
    ctx.layout.toggleSidebar()
    const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(2_000)])
    const result = await until(() => sidebar().open === open && sidebar(), signal)
    publishSidebar()
    return result
  }
  const observer = new target.MutationObserver(publishState)
  observer.observe(doc.documentElement, {
    subtree: true, childList: true, attributes: true,
    attributeFilter: ['hidden', 'inert', 'class', 'style', 'data-sidebar-drawer', 'data-sidebar-collapsed', 'data-rp-mobile-page', 'data-rp-mobile-request', 'data-rp-presentation', 'data-rp-presentation-missing', ...Object.values(ownerRoots)],
  })
  const off = right.mounted.subscribe(publishState)
  const bridge = {
    version: 1,
    ready() { if (!lifetime.signal.aborted) { post({ type: 'ready', pages }); publishSidebar() } },
    sidebarOpen: sidebar,
    toggleSidebar: () => setDrawer(!sidebar().open),
    closeSidebar: () => setDrawer(false),
    async open(input) {
      let request
      try { request = parseRequest(input) }
      catch (error) {
        post({ type: 'error', ...(isId(input?.requestId) ? { requestId: input.requestId } : {}), code: error.code, message: error.message })
        return { ok: false, code: error.code }
      }
      pending?.abort(failure('NAVIGATION_SUPERSEDED', '已改为打开另一个工作区请求。'))
      const current = new AbortController()
      pending = current
      confirmed = undefined
      const signal = AbortSignal.any([lifetime.signal, current.signal, AbortSignal.timeout(timeoutMs)])
      try {
        signal.throwIfAborted()
        let seat = request.sessionId
        const kind = request.ownerKind ?? (Object.hasOwn(defaultOwners, request.page) ? defaultOwners[request.page] : tabKind)
        if (ctx.sidebarRightTabs.get(kind) === undefined) throw failure('OWNER_PAGE_UNAVAILABLE', '所属插件页面未注册。')
        if (seat === null) {
          if (!ctx.sessions?.list || !ctx.workspaces?.list || typeof ctx.sessions.create !== 'function') {
            throw failure('WORKSPACE_UNAVAILABLE', '当前 DSH 无法打开素材工作区。')
          }
          await until(() => ctx.sessions.list.getSnapshot().phase === 'ready' && ctx.workspaces.list.getSnapshot().phase === 'ready', signal)
          const { items, archivedSessionIds } = ctx.workspaces.list.getSnapshot()
          const currentWorkspace = items.find(item => item.sessionIds.includes(mounted())) ?? items[0]
          if (!currentWorkspace) throw failure('WORKSPACE_REQUIRED', '请先在 DSH 中选择或创建工作区，再打开素材。')
          const reusable = globalSeat && isBlank(globalSeat) && !archivedSessionIds.includes(globalSeat)
          // Mint a blank UI seat. The generic workspace shortcut may reuse an empty RP story.
          seat = reusable ? globalSeat : await ctx.sessions.create({ workspaceId: currentWorkspace.workspaceId })
          signal.throwIfAborted()
          if (!isId(seat)) throw failure('WORKSPACE_UNAVAILABLE', 'DSH 未返回素材会话座位。')
          globalSeat = seat
          if (mounted() !== seat) ctx.uiWorkspace.openSession(seat)
          await until(() => mounted() === seat && isBlank(seat), signal)
        } else {
          await validateSession(seat, signal)
          signal.throwIfAborted()
          if (mounted() !== seat) ctx.uiWorkspace.openSession(seat)
          await until(() => mounted() === seat, signal)
        }
        signal.throwIfAborted()
        const params = kind === tabKind ? {
          view: MOBILE_VIEWS[request.page], mobilePage: request.page, mobileRequest: request.requestId,
          ...(request.presentationId === undefined ? {} : { presentationId: request.presentationId }),
        }
          : seat !== request.sessionId ? { cacheScope: 'global-assets' } : {}
        right.openTab(kind, { params })
        await until(() => {
          if (mounted() !== seat || request.sessionId === null && !isBlank(seat)) throw failure('TARGET_MISMATCH', '目标会话已改变。')
          const location = readState(seat, request, true)
          return location?.kind === kind && (kind !== tabKind || location.page === request.page && location.presentationId === request.presentationId)
        }, signal)
        const state = request.sessionId === null
          ? { sessionId: null, page: 'assets', ownerKind: kind, seatSessionId: seat }
          : { sessionId: seat, page: request.page, ...(request.ownerKind === undefined ? {} : { ownerKind: request.ownerKind }), ...(request.presentationId === undefined ? {} : { presentationId: request.presentationId }) }
        confirmed = { request, seat }
        lastState = JSON.stringify(state)
        post({ type: 'opened', requestId: request.requestId, ok: true, ...state })
        return { ok: true, ...state }
      } catch (error) {
        const code = error.code && typeof error.code === 'string' ? error.code : error.name === 'TimeoutError' ? 'WORKSPACE_UNAVAILABLE' : 'NAVIGATION_FAILED'
        const message = error.name === 'TimeoutError' ? '目标页面未完成挂载，请检查插件后重试。' : error.message
        if (!lifetime.signal.aborted) post({ type: 'error', requestId: request.requestId, code, message })
        return { ok: false, code }
      } finally {
        if (pending === current) pending = undefined
      }
    },
  }
  target.__dshRpMobile = bridge
  bridge.ready()
  return () => {
    observer.disconnect()
    off()
    post({ type: 'sidebar', available: false })
    lifetime.abort(failure('BRIDGE_UNAVAILABLE', 'RP Studio 已停用。'))
    if (target.__dshRpMobile === bridge) delete target.__dshRpMobile
  }
}
