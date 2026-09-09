import { access, readFile, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { assertNodeVersion } from './check-node-version.mjs'

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))
const desktopManifest = fileURLToPath(new URL('../apps/desktop/package.json', import.meta.url))
const desktopRequire = createRequire(desktopManifest)
const requiredDesktopPackages = ['electron', 'electron-builder', 'esbuild', 'typescript', 'vitest', '@types/node', 'zod']

async function packageRecord(name) {
  const manifestPath = desktopRequire.resolve(`${name}/package.json`)
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  return { name, version: manifest.version, path: await realpath(dirname(manifestPath)) }
}

async function electronBinary() {
  const binary = desktopRequire('electron')
  if (typeof binary !== 'string') throw new Error('The Electron package did not resolve an executable path')
  await access(binary)
  return realpath(binary)
}

export async function inspectWorkspace() {
  const nodeVersion = assertNodeVersion(process.version)
  const packages = await Promise.all(requiredDesktopPackages.map(packageRecord))
  const electron = await electronBinary()
  return { repositoryRoot: await realpath(repositoryRoot), nodeVersion, packages, electron: await electron }
}

export async function runWorkspaceDoctor() {
  const report = await inspectWorkspace()
  process.stdout.write(`node: ${report.nodeVersion}\n`)
  for (const dependency of report.packages) process.stdout.write(`${dependency.name}: ${dependency.version} (${dependency.path})\n`)
  process.stdout.write(`electron-binary: ${report.electron}\n`)
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined
if (entry === import.meta.url) {
  runWorkspaceDoctor().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
