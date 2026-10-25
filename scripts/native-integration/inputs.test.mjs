import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join, basename, sep } from 'node:path'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { stageInputs, verifyInstalled, validateInputs } from './inputs.mjs'

const execute = promisify(execFile), sha = bytes => createHash('sha256').update(bytes).digest('hex')
async function fixture(work) {
  const root = await mkdtemp(join(tmpdir(), 'studio-native-test-'))
  try { return await work(root) } finally {
    const absolute = resolve(root)
    assert.ok(absolute.startsWith(resolve(tmpdir()) + sep) && basename(absolute).startsWith('studio-native-test-'))
    await rm(absolute, { recursive: true, force: true })
  }
}
async function archive(root, text) {
  const directory = join(root, 'archive')
  await mkdir(join(directory, 'package', 'dist'), { recursive: true })
  await writeFile(join(directory, 'package', 'package.json'), JSON.stringify({ name: 'dsh-rp-studio', version: '1.3.0', main: 'dist/host.js', exports: { './client': './dist/client.js' }, dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  await writeFile(join(directory, 'package', 'dist', 'host.js'), text)
  await writeFile(join(directory, 'package', 'dist', 'client.js'), 'export const client = true')
  await writeFile(join(directory, 'package', 'cordis.patch.yml'), '- insert: []')
  const path = join(root, 'same-version.tgz')
  await execute('tar', ['-czf', path, '-C', directory, 'package'])
  return { name: 'dsh-rp-studio', version: '1.3.0', path, sha256: sha(await readFile(path)) }
}

test('same-version repacks get different immutable input URLs and old bytes stay unchanged', () => fixture(async root => {
  const first = await archive(root, 'export const revision = 1')
  const a = await stageInputs({ hostVersion: '0.2.1-rc.3', stage: 'checkpoint', packages: [first] }, join(root, 'run'))
  const original = await readFile(a.packages[0].archive)
  const second = await archive(root, 'export const revision = 2')
  const b = await stageInputs({ hostVersion: '0.2.1-rc.3', stage: 'checkpoint', packages: [second] }, join(root, 'run'))
  assert.notEqual(a.packages[0].archive, b.packages[0].archive)
  assert.ok(b.packages[0].archive.includes(second.sha256))
  assert.deepEqual(await readFile(a.packages[0].archive), original)
  assert.equal(a.packages[0].files['dist/host.js'], sha(Buffer.from('export const revision = 1')))
}))

test('input bytes and archive manifest must match the approved metadata', () => fixture(async root => {
  const input = await archive(root, 'export const revision = 1')
  await assert.rejects(stageInputs({ hostVersion: '0.2.1-rc.3', stage: 'checkpoint', packages: [{ ...input, sha256: '0'.repeat(64) }] }, join(root, 'bad-hash')), /INPUT_HASH_MISMATCH/u)
  await assert.rejects(stageInputs({ hostVersion: '0.2.1-rc.3', stage: 'checkpoint', packages: [{ ...input, version: '1.2.0' }] }, join(root, 'bad-manifest')), /INPUT_MANIFEST_MISMATCH/u)
}))

test('the installed entry bytes are checked even when name and version match', () => fixture(async root => {
  const input = await archive(root, 'export const revision = 1')
  const prepared = await stageInputs({ hostVersion: '0.2.1-rc.3', stage: 'checkpoint', packages: [input] }, join(root, 'run'))
  const home = join(root, 'home'), installed = join(home, 'profiles', 'web', 'node_modules', 'dsh-rp-studio')
  await mkdir(installed, { recursive: true })
  await execute('tar', ['-xzf', input.path, '-C', installed, '--strip-components=1'])
  const verified = await verifyInstalled(home, prepared.packages[0])
  assert.equal(verified.manifest.version, '1.3.0')
  assert.equal(verified.files['dist/host.js'], prepared.packages[0].files['dist/host.js'])
  await writeFile(join(installed, 'dist', 'host.js'), 'stale cached host')
  await assert.rejects(verifyInstalled(home, prepared.packages[0]), /INSTALLED_BYTES_MISMATCH/u)
}))

test('a partial checkpoint cannot be labeled as a complete final input set', () => {
  const item = { name: 'dsh-rp-studio', version: '1.3.0', path: resolve('approved.tgz'), sha256: 'a'.repeat(64) }
  assert.throws(() => validateInputs({ hostVersion: '0.2.1-rc.3', stage: 'final', packages: [item] }), /FINAL_INPUT_SET_INCOMPLETE/u)
  assert.throws(() => validateInputs({ hostVersion: '0.2.1-rc.3', stage: 'checkpoint', packages: [item, item] }), /INPUT_MANIFEST_INVALID/u)
})
