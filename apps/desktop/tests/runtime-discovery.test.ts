import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { discoverRuntimeSettings, resolveIndependentNode, validateRuntimeSettings } from '../src/main/runtime-discovery.js'
import { defaultSettings } from '../src/main/settings.js'

const directories: string[] = []
afterEach(async () => Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))))

describe('runtime discovery', () => {
  it('discovers the sibling deepseek harness CLI and an explicit validated Node executable', async () => {
    const repos = await mkdtemp(join(tmpdir(), 'desktop-discovery-'))
    directories.push(repos)
    const desktop = join(repos, 'dsh-rp-studio', 'apps', 'desktop')
    const dshRoot = join(repos, 'deepseek-harness-local')
    const dshBin = join(dshRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    const gatewayEntry = join(repos, 'dsh-rp-studio', 'apps', 'gateway', 'dist', 'server.js')
    await mkdir(join(dshBin, '..'), { recursive: true })
    await mkdir(join(gatewayEntry, '..'), { recursive: true })
    await writeFile(join(dshRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), JSON.stringify({ bin: { dsh: './lib/bin.js' } }))
    await writeFile(dshBin, '')
    await writeFile(gatewayEntry, '')

    const result = await discoverRuntimeSettings(defaultSettings(), desktop, join(repos, 'user-data'), { DSH_NODE_EXECUTABLE: 'C:/Node24/node.exe' }, async candidate => candidate.includes('Node24'))

    expect(result.nodeExecutable).toBe('C:/Node24/node.exe')
    expect(result.dshBin).toBe(dshBin)
    expect(result.runtimeRoot).toBe(dshRoot)
  })

  it('marks empty packaged settings incomplete instead of using bare node', async () => {
    await expect(validateRuntimeSettings(defaultSettings(), async () => false)).resolves.toEqual(expect.arrayContaining(['nodeExecutable', 'dshBin', 'gatewayEntry', 'dshHome', 'runtimeRoot']))
  })

  it('does not silently create a blank DSH home for ordinary startup', async () => {
    const result = await discoverRuntimeSettings(defaultSettings(), 'C:/app/resources/app.asar', 'C:/new-empty-home', {}, async () => false, false)

    expect(result.dshHome).toBe('')
  })

  it('resolves the CLI from the installed package manifest and honors DSH_ROOT', async () => {
    const repos = await mkdtemp(join(tmpdir(), 'desktop-discovery-'))
    directories.push(repos)
    const desktop = join(repos, 'dsh-rp-studio', 'apps', 'desktop')
    const dshRoot = join(repos, '自定义-dsh')
    const packageRoot = join(dshRoot, 'node_modules', '@deepseek-ai', 'dsh')
    const dshBin = join(packageRoot, 'cli', 'entry.mjs')
    await mkdir(join(dshBin, '..'), { recursive: true })
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ bin: { dsh: './cli/entry.mjs' } }))
    await writeFile(dshBin, '')

    const result = await discoverRuntimeSettings(defaultSettings(), desktop, join(repos, 'user-data'), { DSH_ROOT: dshRoot }, async () => false)

    expect(result.dshBin).toBe(dshBin)
    expect(result.runtimeRoot).toBe(dshRoot)
  })

  it('accepts only absolute independently validated Node 24 candidates from the environment or PATH', async () => {
    const validated: string[] = []
    const validate = async (candidate: string) => { validated.push(candidate); return candidate.endsWith('node.exe') }

    await expect(resolveIndependentNode({ DSH_NODE_EXECUTABLE: 'node' }, validate, async () => ['C:/Tools/node.exe'])).resolves.toBe('C:/Tools/node.exe')
    expect(validated).toEqual(['C:/Tools/node.exe'])
  })
})
