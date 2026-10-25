import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, access, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, basename, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const execute = promisify(execFile)

test('full mode refuses checkpoint input before staging or creating a home', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'studio-full-gate-test-')), workspace = resolve(fileURLToPath(new URL('../../', import.meta.url))), run = join(workspace, '.runtime', `must-not-start-full-${Date.now()}`)
  try {
    const manifest = join(scratch, 'checkpoint.json')
    await writeFile(manifest, JSON.stringify({ stage: 'checkpoint', hostVersion: '0.2.1-rc.3', packages: [] }))
    await assert.rejects(execute(process.execPath, [join(workspace, 'scripts/native-integration/run.mjs'), '--manifest', manifest, '--mode', 'full', '--run', run], { cwd: workspace }), error => error.stderr.includes('FULL_REQUIRES_APPROVED_FINAL_INPUTS'))
    await assert.rejects(access(run), { code: 'ENOENT' })
  } finally {
    const absolute = resolve(scratch)
    assert.ok(absolute.startsWith(resolve(tmpdir()) + sep) && basename(absolute).startsWith('studio-full-gate-test-'))
    await rm(absolute, { recursive: true, force: true })
  }
})
