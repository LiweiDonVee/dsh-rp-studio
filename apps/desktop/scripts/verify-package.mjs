import { stat } from 'node:fs/promises'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..', 'artifacts')
const required = [
  join(root, 'win-unpacked', 'resources', 'studio', 'gateway', 'dist', 'server.js'),
  join(root, 'win-unpacked', 'resources', 'studio', 'web', 'dist', 'index.html'),
  join(root, 'DSH RP Studio-1.0.0-x64.exe'),
  join(root, 'DSH RP Studio-1.0.0-x64.zip'),
]

for (const path of required) {
  const file = await stat(path)
  if (!file.isFile() || file.size === 0) throw new Error(`Package resource is empty: ${path}`)
}

process.stdout.write('Desktop package resources and artifacts verified\n')
