import { rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { isAbsolute, relative, resolve, sep } from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
for (const output of ['apps/web/dist', 'apps/gateway/dist', 'packages/domain/dist', 'packages/protocol/dist']) {
  const target = resolve(root, output)
  const scoped = relative(root, target)
  if (!scoped || isAbsolute(scoped) || scoped === '..' || scoped.startsWith('..' + sep)) throw new Error('Build output outside project')
  await rm(target, { recursive: true, force: true })
}
