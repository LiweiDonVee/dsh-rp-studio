import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises'
import { resolve, join, isAbsolute } from 'node:path'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { assertRunDirectory, ownedRunPath } from './paths.mjs'

const execute = promisify(execFile)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
export const PACKAGE_NAMES = ['dsh-rp-database', 'dsh-rp-context', 'dsh-rp-last-step', 'dsh-rp-gm', 'dsh-rp-story-kit', 'dsh-rp-studio', 'dsh-loop-studio']
const fail = code => { throw new Error(code) }
const object = value => value && typeof value === 'object' && !Array.isArray(value)

export function validateInputs(input) {
  if (!object(input) || input.hostVersion !== '0.2.1-rc.3' || !['checkpoint', 'final'].includes(input.stage) || !Array.isArray(input.packages) || !input.packages.length || input.packages.length > PACKAGE_NAMES.length) fail('INPUT_MANIFEST_INVALID')
  const names = new Set()
  for (const item of input.packages) {
    if (!object(item) || !PACKAGE_NAMES.includes(item.name) || names.has(item.name) || !/^[a-zA-Z0-9.+-]+$/u.test(item.version) || !/^[a-f0-9]{64}$/u.test(item.sha256) || typeof item.path !== 'string' || !isAbsolute(item.path)) fail('INPUT_MANIFEST_INVALID')
    names.add(item.name)
  }
  if (input.stage === 'final' && PACKAGE_NAMES.some(name => !names.has(name))) fail('FINAL_INPUT_SET_INCOMPLETE')
  return input
}

async function tarBytes(archive, entry) {
  const { stdout } = await execute('tar', ['-xOf', archive, `package/${entry}`], { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024, windowsHide: true })
  return stdout
}
function packageFile(value) {
  if (typeof value !== 'string') fail('INPUT_PACKAGE_ENTRY_INVALID')
  const entry = value.replace(/^\.\//u, '')
  if (!/^[a-zA-Z0-9_./-]+$/u.test(entry) || entry.startsWith('/') || entry.split('/').some(part => part === '..' || part === '.')) fail('INPUT_PACKAGE_ENTRY_INVALID')
  return entry
}
export async function stageInputs(input, runDirectory, workspace) {
  validateInputs(input)
  runDirectory = await assertRunDirectory(workspace, runDirectory)
  await mkdir(runDirectory, { recursive: true })
  const directory = await ownedRunPath(workspace, runDirectory, resolve(runDirectory, 'inputs'))
  await mkdir(directory, { recursive: true })
  const packages = []
  for (const item of input.packages) {
    const bytes = await readFile(item.path)
    if (hash(bytes) !== item.sha256) fail('INPUT_HASH_MISMATCH')
    const archive = await ownedRunPath(workspace, runDirectory, join(directory, `${item.name}-${item.version}-${item.sha256}.tgz`))
    try { await writeFile(archive, bytes, { flag: 'wx' }) }
    catch (error) { if (error.code !== 'EEXIST') throw error }
    if (hash(await readFile(archive)) !== item.sha256) fail('IMMUTABLE_INPUT_CHANGED')
    const manifest = JSON.parse((await tarBytes(archive, 'package.json')).toString('utf8'))
    if (manifest.name !== item.name || manifest.version !== item.version) fail('INPUT_MANIFEST_MISMATCH')
    const entries = new Set(['package.json', packageFile(manifest.main), packageFile(manifest.exports?.['./client']), packageFile(manifest.dsh?.bundle?.patch)])
    const files = {}
    for (const entry of entries) files[entry] = hash(await tarBytes(archive, entry))
    packages.push({ ...item, sourcePath: item.path, archive, files })
  }
  const staged = { schemaVersion: 1, hostVersion: input.hostVersion, stage: input.stage, packages }
  await writeFile(await ownedRunPath(workspace, runDirectory, resolve(runDirectory, 'staged-inputs.json')), JSON.stringify(staged, null, 2) + '\n')
  return staged
}

export async function verifyInstalled(home, input) {
  const directory = await realpath(join(home, 'profiles', 'web', 'node_modules', input.name))
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
  if (manifest.name !== input.name || manifest.version !== input.version) fail('INSTALLED_MANIFEST_MISMATCH')
  const files = {}
  for (const [entry, expected] of Object.entries(input.files)) {
    files[entry] = hash(await readFile(join(directory, packageFile(entry))))
    if (files[entry] !== expected) fail(`INSTALLED_BYTES_MISMATCH:${input.name}/${entry}`)
  }
  return { name: input.name, manifest, sha256: input.sha256, archive: input.archive, directory, files }
}
