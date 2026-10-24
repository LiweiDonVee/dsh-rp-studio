import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const output = resolve(root, 'artifacts')
const staging = await mkdtemp(join(tmpdir(), 'dsh-rp-studio-pack-'))
const local = relative(tmpdir(), staging)
if (isAbsolute(local) || local.startsWith('..') || !local.startsWith('dsh-rp-studio-pack-')) throw new Error('Unexpected staging path')
try {
  await mkdir(output, { recursive: true })
  for (const file of ['dist', 'cordis.patch.yml', 'README.md', 'LICENSE']) await cp(join(root, file), join(staging, file), { recursive: true })
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  // Both entry points are bundled; the installable plugin has no workspace dependencies.
  for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'scripts']) delete manifest[key]
  await writeFile(join(staging, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
  const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--pack-destination', process.platform === 'win32' ? `"${output}"` : output], { cwd: staging, shell: process.platform === 'win32', stdio: 'inherit', windowsHide: true })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`npm pack exited with ${result.status}`)
  const fileName = `${manifest.name}-${manifest.version}.tgz`
  const hash = createHash('sha256').update(await readFile(join(output, fileName))).digest('hex')
  await writeFile(join(output, 'SHA256SUMS.txt'), `${hash}  ${fileName}\n`)
} finally {
  await rm(staging, { recursive: true, force: true })
}
