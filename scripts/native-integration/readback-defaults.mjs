import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { chromium } from '@playwright/test'
import { assertRunDirectory, ownedRunPath } from './paths.mjs'
import { verifyInstalled } from './inputs.mjs'
import { startHost, defaultCli, runCli, closeOwnedResources, redact } from './host.mjs'

const { values } = parseArgs({ options: { run: { type: 'string' }, browser: { type: 'string' }, cli: { type: 'string' } } })
if (!values.run) throw new Error('Use an existing approved full run; this helper never installs or creates a home.')
const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '../..'), run = await assertRunDirectory(workspace, resolve(values.run)), cli = values.cli ?? defaultCli()
const read = async file => JSON.parse(await readFile(join(run, file), 'utf8')), hash = bytes => createHash('sha256').update(bytes).digest('hex')
const full = await read('full-result.json'), content = await read('content-pack.json'), saved = await read('saved-story.json'), opening = await read('opening.json')
assert.equal(full.fullChain.status, 'passed'); assert.equal(full.inputStage, 'final')
const output = await ownedRunPath(workspace, run, join(run, 'public-defaults-readback.json'))
await assert.rejects(access(output), { code: 'ENOENT' })
const expected = { sessionId: saved.minimalSnapshot.selectedSessionId, character: { assetId: content.minimalCharacter.id, version: content.minimalCharacter.version }, databaseRefs: content.minimalCharacter.databaseRefs, profileRef: content.minimalCharacter.profileRef, builtin: opening.state.binding.profile }
const report = { schemaVersion: 1, scope: 'bounded public owner readback; no prompt, resume, new story or restore job', originalResultSha256: hash(await readFile(join(run, 'full-result.json'))), expected, packages: full.packages, processes: [], status: 'running' }
const endpoints = { database: '/api/rp-database/request', lastStep: '/api/rp-last-step/request', storyKit: '/api/rp-story-kit/request', gm: '/api/rp-gm/request' }
async function readHome(name) {
  const home = join(run, name), segment = full.segments.find(row => row.name === name), evidence = { name, installed: [], requests: [] }
  assert.ok(segment); report.processes.push(evidence)
  const env = { ...process.env, DSH_HOME: home, DEEPSEEK_API_KEY: 'unused-local-studio-fixture', DSH_TOOLS_MODE: 'native' }
  evidence.hostVersion = await runCli(cli, ['--version'], env, workspace); assert.equal(evidence.hostVersion, '0.2.1-rc.3')
  for (const input of full.packages) evidence.installed.push(await verifyInstalled(home, input))
  let host, browser, page, failure, calls = 0
  try {
    host = await startHost({ cli, home, patch: join(run, `${name}.patch.yml`), workspace, env, logPath: join(run, `readback-${name}-${Date.now()}.host.log`) }); evidence.hostPid = host.child.pid
    browser = await chromium.launch({ headless: true, ...(values.browser ? { executablePath: values.browser } : {}) }); page = await browser.newPage()
    evidence.browserErrors = []; page.on('pageerror', error => evidence.browserErrors.push(error.message)); page.on('console', message => { if (['warn', 'error'].includes(message.type())) evidence.browserErrors.push(message.text()) })
    await page.goto(host.url, { waitUntil: 'networkidle' })
    const continuation = page.getByRole('button', { name: '继续', exact: true }); await continuation.waitFor({ timeout: 1000 }).catch(() => {}); if (await continuation.isVisible()) await continuation.click()
    const request = async (path, input) => {
      if (++calls > 32) throw new Error('READBACK_REQUEST_LIMIT')
      const response = await page.request.post(new URL(path, page.url()).href, { data: input, timeout: 15000 }), body = await response.json()
      evidence.requests.push({ path, action: input.action, status: response.status() })
      if (!response.ok() || body.error || body.ok === false) throw new Error(JSON.stringify(body))
      return body
    }
    const api = (owner, action, input = {}) => request(endpoints[owner], { action, ...input })
    evidence.actualApi = (await request('/api/studio-native-probe', { action: 'ready' })).result
    const state = await api('database', 'state'), asset = await api('storyKit', 'asset', { kind: 'character', ...expected.character }), databaseBinding = await api('database', 'effectiveV2', { sessionId: expected.sessionId }), lastStepBinding = await api('lastStep', 'state', { sessionId: expected.sessionId }), gmBinding = await api('gm', 'binding', { sessionId: expected.sessionId })
    const databases = []
    for (const ref of expected.databaseRefs) {
      const pinned = await api('database', 'database', { databaseId: ref.databaseId, version: ref.version }), latest = await api('database', 'database', { databaseId: ref.databaseId })
      const sourceId = state.databases.find(row => row.id === ref.databaseId)?.sourceId; assert.ok(sourceId)
      const source = await api('database', 'source', { sourceId }), originalBytes = source.source.dataBase64 !== undefined ? Buffer.from(source.source.dataBase64, 'base64') : Buffer.from(source.source.rawText, 'utf8')
      assert.equal(hash(originalBytes), source.source.sha256)
      const documentRefs = [...new Map(pinned.database.entries.filter(entry => entry.provenance?.kind === 'document-chunk').map(entry => [JSON.stringify([entry.provenance.documentId, entry.provenance.documentVersion]), { documentId: entry.provenance.documentId, version: entry.provenance.documentVersion }])).values()], documents = []
      for (const documentRef of documentRefs) { const value = await api('database', 'document', documentRef); assert.equal(hash(Buffer.from(value.document.dataBase64, 'base64')), value.document.sha256); documents.push({ ref: documentRef, response: value }) }
      databases.push({ ref, pinned, latest, source, originalBytesSha256: hash(originalBytes), documents })
    }
    const profile = { ref: expected.profileRef, pinned: await api('lastStep', 'profile', expected.profileRef), latest: await api('lastStep', 'profile', { profileId: expected.profileRef.profileId }) }, builtin = await api('lastStep', 'profile', expected.builtin)
    evidence.publicResponses = { state, asset, databases, profile, builtin, databaseBinding, lastStepBinding, gmBinding }
    evidence.models = (await request('/api/studio-native-probe', { action: 'models' })).result; assert.equal(evidence.models.total, 0); assert.ok(Object.values(evidence.models.counts).every(value => value === 0)); assert.deepEqual(evidence.browserErrors, [])
  } catch (error) { evidence.error = redact(error.stack ?? error.message); failure = error }
  finally {
    if (page && !evidence.models) try { const response = await page.request.post(new URL('/api/studio-native-probe', page.url()).href, { data: { action: 'models' }, timeout: 5000 }); evidence.models = (await response.json()).result } catch (error) { evidence.counterError = redact(error.message) }
    evidence.cleanupErrors = await closeOwnedResources(browser, host); evidence.cleanupStatus = evidence.cleanupErrors.length ? 'failed' : 'stopped'
    if (evidence.cleanupErrors.length && !failure) failure = new Error(JSON.stringify(evidence.cleanupErrors))
  }
  if (failure) throw failure
  return evidence.publicResponses
}
try {
  const source = await readHome('home-a'), target = await readHome('home-b')
  assert.deepEqual(target.asset.asset, source.asset.asset); assert.deepEqual(target.asset.asset.databaseRefs, expected.databaseRefs); assert.deepEqual(target.asset.asset.profileRef, expected.profileRef)
  for (const [index, item] of source.databases.entries()) {
    const restored = target.databases[index]; assert.equal(item.pinned.database.version, item.ref.version); assert.ok(item.latest.database.version > item.ref.version)
    assert.equal(restored.latest.database.version, item.ref.version); assert.deepEqual(restored.pinned.database, item.pinned.database); assert.deepEqual(restored.source.source, item.source.source); assert.deepEqual(restored.documents, item.documents)
  }
  assert.ok(source.profile.latest.profile.version > expected.profileRef.version); assert.equal(target.profile.latest.profile.version, expected.profileRef.version)
  assert.equal(target.profile.pinned.profile.status, 'draft'); assert.deepEqual(target.profile.pinned.profile, source.profile.pinned.profile)
  for (const value of [source, target]) {
    assert.deepEqual(value.databaseBinding.binding.sources, []); assert.deepEqual(value.gmBinding.sources, []); assert.deepEqual(value.gmBinding.profile, expected.builtin)
    assert.equal(value.lastStepBinding.binding.profileId, expected.builtin.profileId); assert.equal(value.lastStepBinding.binding.version, expected.builtin.version); assert.equal(value.builtin.profile.status, 'ready')
  }
  report.status = 'passed'
} catch (error) { report.status = 'failed'; report.error = redact(error.stack ?? error.message); process.exitCode = 1 }
finally { await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }) }
console.log(JSON.stringify({ output, status: report.status, processes: report.processes.map(row => ({ name: row.name, hostPid: row.hostPid, modelTotal: row.models?.total, cleanupStatus: row.cleanupStatus })), error: report.error }))
