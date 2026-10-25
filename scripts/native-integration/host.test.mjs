import test from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { join, basename, sep } from 'node:path'
import { mkdtemp, mkdir, symlink, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { assertRunDirectory, redact, installInputs, runCli, stopOwned, closeOwnedResources } from './host.mjs'
import { spawn } from 'node:child_process'
import { once } from 'node:events'

async function scratch(work) {
  const root = await mkdtemp(join(tmpdir(), 'studio-native-guard-test-'))
  try { return await work(root) } finally {
    const absolute = resolve(root)
    assert.ok(absolute.startsWith(resolve(tmpdir()) + sep) && basename(absolute).startsWith('studio-native-guard-test-'))
    await rm(absolute, { recursive: true, force: true })
  }
}

test('native run ownership does not include workspace root, sibling homes or path-prefix lookalikes', () => scratch(async root => {
  const workspace = join(root, 'workspace')
  await mkdir(join(workspace, '.runtime'), { recursive: true })
  assert.equal(await assertRunDirectory(workspace, resolve(workspace, '.runtime', 'one')), resolve(workspace, '.runtime', 'one'))
  for (const directory of [workspace, resolve(workspace, '.runtime-other', 'one'), resolve(workspace, '..', 'another', 'home')]) await assert.rejects(async () => assertRunDirectory(workspace, directory), /RUN_DIRECTORY_OUTSIDE_WORKSPACE/u)
}))

for (const position of ['runtime', 'ancestor', 'run', 'home']) test(`canonical boundary rejects an outside ${position} junction before any write`, () => scratch(async root => {
  const workspace = join(root, 'workspace'), outside = join(root, 'outside')
  await mkdir(workspace); await mkdir(outside)
  let link, target
  if (position === 'runtime') { link = join(workspace, '.runtime'); target = join(link, 'run') }
  else {
    await mkdir(join(workspace, '.runtime'))
    if (position === 'ancestor') { link = join(workspace, '.runtime', 'parent'); target = join(link, 'run') }
    if (position === 'run') { link = join(workspace, '.runtime', 'run'); target = link }
    if (position === 'home') { await mkdir(join(workspace, '.runtime', 'run')); link = join(workspace, '.runtime', 'run', 'home-a'); target = link }
  }
  await symlink(outside, link, 'junction')
  let error
  try { const accepted = await assertRunDirectory(workspace, target); await mkdir(accepted, { recursive: true }); await writeFile(join(accepted, 'sentinel'), 'must not escape') } catch (cause) { error = cause }
  assert.deepEqual(await readdir(outside), [])
  assert.match(error?.message ?? '', /RUN_.*(?:OUTSIDE|REPARSE)/u)
}))

test('inspection refuses any existing home even without a root package manifest', () => scratch(async root => {
  const workspace = join(root, 'workspace'), home = join(workspace, '.runtime', 'run', 'home-a')
  await mkdir(join(home, 'sessions'), { recursive: true }); await mkdir(join(home, 'profiles'))
  const existing = '{"syntheticExistingSession":true}\n'
  await writeFile(join(home, 'sessions', 'existing.json'), existing)
  const cli = join(root, process.platform === 'win32' ? 'version.cmd' : 'version.sh')
  await writeFile(cli, process.platform === 'win32' ? '@echo off\r\necho 0.2.1-rc.3\r\n' : '#!/bin/sh\necho 0.2.1-rc.3\n', { mode: 0o700 })
  await assert.rejects(installInputs({ staged: { hostVersion: '0.2.1-rc.3', packages: [] }, workspace, home, cli, log() {} }), /INSPECTION_HOME_ALREADY_USED/u)
  assert.equal(await readFile(join(home, 'sessions', 'existing.json'), 'utf8'), existing)
  await assert.rejects(readFile(join(home, 'package.json')), { code: 'ENOENT' })
}))

test('Windows percent argv is rejected rather than silently expanded by CMD', { skip: process.platform !== 'win32' }, () => scratch(async root => {
  const cli = join(root, 'echo.cmd')
  await writeFile(cli, '@echo off\r\necho %1\r\n')
  await assert.rejects(runCli(cli, ['literal-%STUDIO_NATIVE_TEST_ARG%-archive.tgz'], { ...process.env, STUDIO_NATIVE_TEST_ARG: 'expanded' }, root), /CLI_PERCENT_ARGUMENT_UNSUPPORTED/u)
}))

test('browser cleanup failure does not skip terminating the owned process or hide a host cleanup error', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' })
  await once(child, 'spawn')
  let hostClosed = false
  try {
    const errors = await closeOwnedResources({ close() { throw new Error('synthetic browser close failure') } }, { async close() { await stopOwned(child); hostClosed = true; throw new Error('synthetic evidence write failure') } })
    assert.equal(hostClosed, true)
    assert.notEqual(child.exitCode, null)
    assert.deepEqual(errors.map(error => error.resource), ['browser', 'host'])
  } finally { await stopOwned(child) }
})
test('launch credentials are removed before host logs become evidence', () => {
  assert.equal(redact('http://127.0.0.1:1/?token=synthetic-secret\nBearer synthetic-key'), 'http://127.0.0.1:1/?token=[REDACTED]\nBearer [REDACTED]')
})
