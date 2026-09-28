import { rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))

export function buildOutputDirectories(root = repositoryRoot) {
  return [
    join(root, 'apps', 'desktop', 'dist'),
    join(root, 'apps', 'gateway', 'dist'),
    join(root, 'apps', 'web', 'dist'),
    join(root, 'packages', 'domain', 'dist'),
    join(root, 'packages', 'local-data', 'dist'),
    join(root, 'packages', 'protocol', 'dist'),
    join(root, 'packages', 'supervisor', 'dist'),
  ]
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await Promise.all(buildOutputDirectories().map(path => rm(path, { recursive: true, force: true })))
}
