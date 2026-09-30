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
    await writeFile(join(dshRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.0-rc.2', bin: { dsh: './lib/bin.js' } }))
    await writeFile(dshBin, '')
    await writeFile(gatewayEntry, '')

    const result = await discoverRuntimeSettings(defaultSettings(), desktop, join(repos, 'user-data'), { DSH_RUNTIME_ROOT: dshRoot, DSH_NODE_EXECUTABLE: 'C:/Node24/node.exe' }, async candidate => candidate.includes('Node24'))

    expect(result.nodeExecutable).toBe('C:/Node24/node.exe')
    expect(result.dshBin).toBe(dshBin)
    expect(result.runtimeRoot).toBe(dshRoot)
  })

  it('marks empty packaged settings incomplete instead of using bare node', async () => {
    await expect(validateRuntimeSettings(defaultSettings(), async () => false)).resolves.toEqual(expect.arrayContaining(['nodeExecutable', 'dshBin', 'gatewayEntry', 'dshHome', 'runtimeRoot']))
  })

  it('uses an isolated home and packaged Gateway instead of checkout paths', async () => {
    const install = await mkdtemp(join(tmpdir(), 'packaged-studio-'))
    directories.push(install)
    const appPath = join(install, 'resources', 'app.asar')
    const gateway = join(install, 'resources', 'studio', 'gateway', 'dist', 'server.js')
    await mkdir(join(gateway, '..'), { recursive: true })
    await writeFile(gateway, '')
    const userData = join(install, 'user-data')
    const result = await discoverRuntimeSettings(defaultSettings(), appPath, userData, {}, async () => false)

    expect(result.dshHome).toBe(userData)
    expect(result.gatewayEntry).toBe(gateway)
  })

  it('accepts an rc2 profile bundle home without a legacy agent-presets directory', async () => {
    const home = await mkdtemp(join(tmpdir(), 'desktop-dsh-home-'))
    directories.push(home)
    await mkdir(join(home, 'profiles', 'web'), { recursive: true })
    await writeFile(join(home, 'profiles', 'web', 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }))
    const settings = { ...defaultSettings(), nodeExecutable: 'C:/Node24/node.exe', dshBin: 'C:/runtime/dsh.js', gatewayEntry: 'C:/runtime/gateway.js', dshHome: home, runtimeRoot: 'C:/runtime' }
    await expect(validateRuntimeSettings(settings, async () => true)).resolves.not.toContain('dshHome')
  })

  it('resolves the CLI from the installed package manifest and honors DSH_ROOT', async () => {
    const repos = await mkdtemp(join(tmpdir(), 'desktop-discovery-'))
    directories.push(repos)
    const desktop = join(repos, 'dsh-rp-studio', 'apps', 'desktop')
    const dshRoot = join(repos, '自定义-dsh')
    const packageRoot = join(dshRoot, 'node_modules', '@deepseek-ai', 'dsh')
    const dshBin = join(packageRoot, 'cli', 'entry.mjs')
    await mkdir(join(dshBin, '..'), { recursive: true })
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.0-rc.2', bin: { dsh: './cli/entry.mjs' } }))
    await writeFile(dshBin, '')

    const result = await discoverRuntimeSettings(defaultSettings(), desktop, join(repos, 'user-data'), { DSH_ROOT: dshRoot }, async () => false)

    expect(result.dshBin).toBe(dshBin)
    expect(result.runtimeRoot).toBe(dshRoot)
  })

  it('discovers the installed official rc2 runtime and its launcher/node pair', async () => {
    const install = await mkdtemp(join(tmpdir(), 'official-dsh-'))
    directories.push(install)
    const root = join(install, 'Programs', 'DeepSeek Harness', 'resources', 'runtime')
    const dshBin = join(root, 'cli', 'bin', 'dsh.cmd')
    const node = join(root, 'primary-runtime', 'dependencies', 'node', 'bin', 'node.exe')
    const gatewayEntry = join(install, 'studio', 'apps', 'gateway', 'dist', 'server.js')
    await mkdir(join(root, 'primary-runtime'), { recursive: true })
    await mkdir(join(dshBin, '..'), { recursive: true })
    await mkdir(join(node, '..'), { recursive: true })
    await mkdir(join(gatewayEntry, '..'), { recursive: true })
    await writeFile(join(root, 'primary-runtime', 'runtime.json'), JSON.stringify({ desktopVersion: '0.2.0-rc.2' }))
    await writeFile(dshBin, '@echo off')
    await writeFile(node, '')
    await writeFile(gatewayEntry, '')

    const result = await discoverRuntimeSettings(defaultSettings(), join(install, 'studio', 'apps', 'desktop'), join(install, 'user-data'), { LOCALAPPDATA: install }, async candidate => candidate === node)

    expect(result.runtimeRoot).toBe(root)
    expect(result.dshBin).toBe(dshBin)
    expect(result.nodeExecutable).toBe(node)
  })

  it('does not select a runtime whose desktop version is older than rc2', async () => {
    const install = await mkdtemp(join(tmpdir(), 'old-dsh-'))
    directories.push(install)
    const root = join(install, 'Programs', 'DeepSeek Harness', 'resources', 'runtime')
    await mkdir(join(root, 'primary-runtime'), { recursive: true })
    await writeFile(join(root, 'primary-runtime', 'runtime.json'), JSON.stringify({ desktopVersion: '0.1.7-rc.2' }))

    const result = await discoverRuntimeSettings(defaultSettings(), join(install, 'studio', 'apps', 'desktop'), join(install, 'user-data'), { DSH_RUNTIME_ROOT: root }, async () => true)

    expect(result.dshBin).toBe('')
    expect(result.runtimeRoot).toBe(root)
  })

  it('prefers the installed official rc2 runtime over a persisted older root', async () => {
    const install = await mkdtemp(join(tmpdir(), 'runtime-priority-'))
    directories.push(install)
    const oldRoot = join(install, 'old-runtime')
    const officialRoot = join(install, 'Programs', 'DeepSeek Harness', 'resources', 'runtime')
    const officialLauncher = join(officialRoot, 'cli', 'bin', 'dsh.cmd')
    await mkdir(join(oldRoot, 'primary-runtime'), { recursive: true })
    await mkdir(join(officialRoot, 'primary-runtime'), { recursive: true })
    await mkdir(join(officialLauncher, '..'), { recursive: true })
    await writeFile(join(oldRoot, 'primary-runtime', 'runtime.json'), JSON.stringify({ desktopVersion: '0.1.7-rc.2' }))
    await writeFile(join(officialRoot, 'primary-runtime', 'runtime.json'), JSON.stringify({ desktopVersion: '0.2.0-rc.2' }))
    await writeFile(officialLauncher, '@echo off')

    const result = await discoverRuntimeSettings({ ...defaultSettings(), runtimeRoot: oldRoot, dshBin: join(oldRoot, 'old.js') }, join(install, 'studio', 'apps', 'desktop'), join(install, 'user-data'), { LOCALAPPDATA: install }, async () => false)

    expect(result.runtimeRoot).toBe(officialRoot)
    expect(result.dshBin).toBe(officialLauncher)
  })

  it('accepts only absolute independently validated Node 24 candidates from the environment or PATH', async () => {
    const validated: string[] = []
    const validate = async (candidate: string) => { validated.push(candidate); return candidate.endsWith('node.exe') }

    await expect(resolveIndependentNode({ DSH_NODE_EXECUTABLE: 'node' }, validate, async () => ['C:/Tools/node.exe'])).resolves.toBe('C:/Tools/node.exe')
    expect(validated).toEqual(['C:/Tools/node.exe'])
  })
})
