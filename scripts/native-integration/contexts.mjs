import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { chromium } from '@playwright/test'
import { installInputs, startHost, copyFixtureFiles, closeOwnedResources, redact } from './host.mjs'
import { ownedRunPath } from './paths.mjs'
import { verifyInstalled } from './inputs.mjs'

const endpoints = { database: '/api/rp-database/request', context: '/api/rp-context/request', lastStep: '/api/rp-last-step/request', storyKit: '/api/rp-story-kit/request', gm: '/api/rp-gm/request', studio: '/api/rp-studio/actions' }
const readActions = new Set(['capabilities', 'reviewState', 'storyHistory', 'presentationSummaries'])
const safeURL = value => value.replace(/([?&]token=)[^&]+/giu, '$1[REDACTED]')
const stamp = () => ({ time: new Date().toISOString(), monotonicMs: performance.now() })
let segmentSequence = 0
export function observeHttpError(response) {
  if (response.status() < 400) return null
  const request = response.request(); let input = null, inputError
  if (request.method() === 'POST') try { input = request.postDataJSON() } catch (error) { inputError = String(error.message).slice(0, 300) }
  return { time: new Date().toISOString(), url: safeURL(response.url()), status: response.status(), method: request.method(), input, ...(inputError ? { inputError } : {}) }
}
export function observeNativeContext({ name, home, httpErrors = [], bodyLimit = 16384, bodyTimeoutMs = 5000 }) {
  const evidence = { name, home, segmentId: `${name}-${++segmentSequence}`, hostPid: null, clock: { originUTC: new Date(performance.timeOrigin).toISOString(), monotonicUnit: 'milliseconds' }, reads: [], requestFailures: [], lifecycle: [] }
  const requests = new WeakMap(), pending = new Set()
  const record = (event, detail = {}) => evidence.lifecycle.push({ event, ...stamp(), home: name, segmentId: evidence.segmentId, hostPid: evidence.hostPid, ...detail })
  function start(request, observed = true) {
    if (requests.has(request)) return requests.get(request)
    let input
    try {
      if (request.method() !== 'POST' || new URL(request.url()).pathname !== endpoints.studio) return
      input = request.postDataJSON()
    } catch { return }
    if (!readActions.has(input?.action) || typeof input.sessionId !== 'string') return
    const row = { requestId: `${evidence.segmentId}-request-${evidence.reads.length + 1}`, action: input.action, sessionId: input.sessionId, home: name, segmentId: evidence.segmentId, hostPid: evidence.hostPid, url: safeURL(request.url()), method: request.method(), requestStarted: observed ? stamp() : null, ...(!observed ? { requestStartError: 'Request event was not observed' } : {}) }
    requests.set(request, row); evidence.reads.push(row)
    return row
  }
  async function readBody(response, row, errorObservation) {
    let timer
    try {
      const text = redact(await Promise.race([Promise.resolve().then(() => response.text()), new Promise((_done, reject) => { timer = setTimeout(() => reject(new Error(`NATIVE_RESPONSE_BODY_TIMEOUT:${bodyTimeoutMs}ms`)), bodyTimeoutMs) })]))
      Object.assign(row, { body: text.slice(0, bodyLimit), bodyReadStatus: 'recorded', bodyTruncated: text.length > bodyLimit, bodyLength: text.length })
    } catch (error) { Object.assign(row, { bodyReadStatus: 'failed', bodyReadError: redact(error?.message ?? error).slice(0, 600) }) }
    finally { clearTimeout(timer); row.bodyReadSettled = stamp(); if (errorObservation) Object.assign(errorObservation, row) }
  }
  return { evidence, record,
    attach(page) {
      page.on('request', request => { start(request) })
      page.on('response', response => {
        const errorObservation = observeHttpError(response)
        if (errorObservation) httpErrors.push(errorObservation)
        const row = start(response.request(), false)
        if (!row) return
        Object.assign(row, { status: response.status(), responseReceived: stamp(), bodyReadStatus: 'pending' })
        if (errorObservation) Object.assign(errorObservation, row)
        const operation = readBody(response, row, errorObservation)
        pending.add(operation); void operation.then(() => pending.delete(operation))
      })
      page.on('requestfailed', request => {
        const row = start(request, false)
        if (row) evidence.requestFailures.push({ requestId: row.requestId, action: row.action, sessionId: row.sessionId, home: name, segmentId: evidence.segmentId, hostPid: evidence.hostPid, url: row.url, ...stamp(), error: redact(request.failure()?.errorText ?? 'Request failed without a response').slice(0, 600) })
      })
    },
    async settle() { while (pending.size) await Promise.all(pending) },
  }
}
export async function finishNativeContext(context, segment) {
  const errors = []
  if (context.observations) segment.observations = context.observations
  try { segment.models = await context.probe('models'); segment.modelStatus = 'recorded' }
  catch (error) { segment.modelStatus = 'failed'; segment.counterError = redact(error.message); errors.push(error) }
  try { await context.close(); segment.cleanupStatus = 'stopped' }
  catch (error) { segment.cleanupStatus = 'failed'; segment.cleanupError = redact(error.message); errors.push(error) }
  if (errors.length) { segment.finalizationErrors ??= []; segment.finalizationErrors.push(...errors.map(error => redact(error.message))); throw new AggregateError(errors, 'Native context finalization failed') }
}
export async function restartNativeContext(context, finish, open) {
  context.recordLifecycle?.('restart-requested')
  await finish(context)
  context.recordLifecycle?.('next-context-open-invoked', { nextHome: context.name })
  await context.persistObservations?.()
  return open(context.name, context.installed)
}
export async function closeFailedContext(error, { name, installed, errors, browser, host, observer, persistObservations }) {
  const cleanupErrors = await closeOwnedResources(browser, host, observer?.record)
  await observer?.settle()
  try { await persistObservations?.() } catch (failure) { cleanupErrors.push({ resource: 'observations', message: redact(failure.message) }) }
  error.nativeStartup = { name, hostPid: host?.child?.pid, installed: installed.installed, hostVersion: installed.version, startupError: redact(error.message), browserErrors: [...errors], cleanupErrors, cleanupStatus: cleanupErrors.length ? 'failed' : 'stopped', ...(observer ? { observations: observer.evidence } : {}) }
  return error
}
export async function openNativeContext({ workspace, run, staged, cli, browserPath, providerURL, name, existing, approval = false }) {
  const home = join(run, name), fixture = join(run, 'fixture')
  const errors = [], actionProofs = [], httpErrors = []
  const observer = observeNativeContext({ name, home, httpErrors })
  observer.record('context-open-requested', { reusedHome: !!existing })
  const persistObservations = async () => {
    await observer.settle()
    const path = await ownedRunPath(workspace, run, join(run, `${observer.evidence.segmentId}.observations.json`))
    observer.evidence.path = path
    await writeFile(path, JSON.stringify(observer.evidence, null, 2) + '\n')
  }
  const installed = existing ?? await installInputs({ staged, home, cli, workspace, log: message => console.log(`[full:${name}] ${message}`) })
  if (existing) for (const input of staged.packages) await verifyInstalled(home, input)
  await copyFixtureFiles(workspace, fixture)
  const patch = await ownedRunPath(workspace, run, join(run, `${name}.patch.yml`))
  await writeFile(patch, `- id: session-title-llm\n  disabled: true\n- id: llm-deepseek\n  disabled: true\n- id: llm-deepseek-account\n  disabled: true\n- id: llm-pi-ai\n  disabled: true\n- id: agent-default-model\n  config:\n    provider: studio-native-local\n    model: gm\n- id: tools\n  config:\n    mode: native\n- id: rp-database\n  config:\n    embedding:\n      baseURL: ${providerURL}\n      model: studio-native-embedding\n    reranking:\n      baseURL: ${providerURL}\n      model: studio-native-rerank\n- insert:\n    - id: studio-native-probe\n      name: ${JSON.stringify(join(fixture, 'fixture.mjs').replaceAll('\\', '/'))}\n    - id: studio-native-legacy\n      name: '@deepseek-ai/dsh-agent-preset'\n      config:\n        id: studio-legacy-fixture\n        name: Studio full legacy regression\n        description: Public no-model legacy fixture\n        plugins:\n          - id: rp-runtime\n            name: '@deepseek-ai/dsh-persona'\n            config:\n              prefix: Public synthetic old preset.\n`)
  let host, browser
  try {
    host = await startHost({ cli, home, patch, workspace, env: { ...installed.env, STUDIO_NATIVE_APPROVAL: approval ? '1' : '0' }, logPath: join(run, `${name}-${Date.now()}.host.log`), recordLifecycle: observer.record })
    observer.evidence.hostPid = host.child.pid
    browser = await chromium.launch({ headless: true, ...(browserPath ? { executablePath: browserPath } : {}) })
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    page.setDefaultTimeout(15000)
    page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (['error', 'warn'].includes(message.type())) errors.push(message.text()) })
    observer.attach(page)
    await page.addInitScript(() => { Object.defineProperty(window, '__ModuleLoader__', { configurable: true, set(target) {
      Object.defineProperty(window, '__ModuleLoader__', { configurable: true, writable: true, value: target })
      let load = target.load.bind(target)
      const wrapped = row => load(row.id !== 'dsh-rp-studio' ? row : { ...row, factory(require) { const plugin = row.factory(require); return { ...plugin, apply(ctx) { window.__nativeStudioCtx = ctx; return plugin.apply(ctx) } } } })
      Object.defineProperty(target, 'load', { configurable: true, get: () => wrapped, set(next) { load = next.bind(target) } })
    } }) })
    await page.goto(host.url, { waitUntil: 'networkidle' })
    const preview = page.getByRole('button', { name: '继续', exact: true })
    await preview.waitFor({ state: 'visible', timeout: 1000 }).catch(() => {}); if (await preview.isVisible()) await preview.click()
    await page.waitForFunction(() => !!window.__nativeStudioCtx)
    async function request(path, body) {
      const response = await page.request.post(new URL(path, page.url()).href, { headers: { 'content-type': 'application/json' }, data: body, timeout: 45000 })
      const value = { status: response.status(), body: await response.json() }
      if (value.status >= 400 || value.body?.error || value.body?.ok === false) throw Object.assign(new Error(`${value.status}:${JSON.stringify(value.body)}`), { status: value.status, code: value.body?.error?.code, detail: value.body })
      return value.body
    }
    const api = (owner, action, input = {}) => { if (!endpoints[owner]) throw new Error('UNKNOWN_OWNER_ENDPOINT'); return request(endpoints[owner], { action, ...input }) }
    const studio = async (method, path, body) => (await request('/api/rp-studio/request', { method, path, ...(body === undefined ? {} : { body }) })).data
    const probe = async (action, input = {}) => (await request('/api/studio-native-probe', { action, ...input })).result
    const openStudio = async sessionId => {
      await page.evaluate(id => window.__nativeStudioCtx.uiWorkspace.openSession(id), sessionId)
      await page.getByRole('button', { name: '打开 RP Studio', exact: true }).first().click()
      await page.locator(`.dsh-rp-workspace[data-rp-session="${sessionId}"]`).waitFor()
      await page.locator('.rp-empty').waitFor({ state: 'hidden' })
    }
    return { name, home, installed, page, hostPid: host.child.pid, errors, httpErrors, observations: observer.evidence, recordLifecycle: observer.record, settleObservations: observer.settle, persistObservations, actionProofs, api, studio, probe, request, openStudio, snapshot: sessionId => probe('snapshot', { sessionId }), idle: sessionId => probe('idle', { sessionId }), close: async () => {
      const failures = await closeOwnedResources(browser, host, observer.record)
      try { await persistObservations() } catch (failure) { failures.push({ resource: 'observations', message: redact(failure.message) }) }
      if (failures.length) throw new Error(JSON.stringify(failures))
    } }
  } catch (error) { throw await closeFailedContext(error, { name, installed, errors, browser, host, observer, persistObservations }) }
}

export async function waitForNative(read, accept, label, timeout = 45000) {
  const deadline = Date.now() + timeout
  let last
  while (Date.now() < deadline) { last = await read(); if (accept(last)) return last; await new Promise(done => setTimeout(done, 100)) }
  throw new Error(`NATIVE_WAIT_TIMEOUT:${label}:${JSON.stringify(last).slice(0, 2000)}`)
}
