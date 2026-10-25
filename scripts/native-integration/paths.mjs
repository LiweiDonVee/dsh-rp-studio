import { resolve, join, relative, isAbsolute, sep } from 'node:path'
import { lstat, realpath, stat } from 'node:fs/promises'

const child = (base, target) => { const value = relative(base, target); return value !== '' && value !== '..' && !value.startsWith('..' + sep) && !isAbsolute(value) }

async function runtimePath(workspace, target) {
  const checkout = await realpath(resolve(workspace)), runtime = join(checkout, '.runtime'), requested = resolve(target)
  const logicalRuntime = resolve(workspace, '.runtime')
  const suffix = child(logicalRuntime, requested) ? relative(logicalRuntime, requested) : child(runtime, requested) ? relative(runtime, requested) : null
  if (suffix === null) throw new Error('RUN_DIRECTORY_OUTSIDE_WORKSPACE')
  const parts = ['.runtime', ...suffix.split(sep)]
  let current = checkout
  for (let index = 0; index < parts.length; index++) {
    const next = join(current, parts[index])
    try { await lstat(next) } catch (error) { if (error.code === 'ENOENT') return resolve(current, ...parts.slice(index)); throw error }
    let canonical
    try { canonical = await realpath(next) } catch { throw new Error('RUN_PATH_UNRESOLVED_REPARSE') }
    // The physical .runtime is rooted in this checkout; a linked ancestor or
    // target may not redirect any subsequent write outside that boundary.
    if (index === 0 ? relative(runtime, canonical) !== '' : !child(runtime, canonical)) throw new Error('RUN_DIRECTORY_REPARSE_OUTSIDE_WORKSPACE')
    if (index < parts.length - 1 && !(await stat(canonical)).isDirectory()) throw new Error('RUN_PATH_NOT_DIRECTORY')
    current = canonical
  }
  return current
}

export async function assertRunDirectory(workspace, directory) {
  const target = await runtimePath(workspace, directory)
  try { if (!(await stat(target)).isDirectory()) throw new Error('RUN_DIRECTORY_NOT_DIRECTORY') } catch (error) { if (error.code !== 'ENOENT') throw error }
  return target
}

export async function ownedRunPath(workspace, run, target) {
  const canonicalRun = await assertRunDirectory(workspace, run), canonicalTarget = await runtimePath(workspace, target)
  if (!child(canonicalRun, canonicalTarget)) throw new Error('RUN_PATH_OUTSIDE_RUN')
  return canonicalTarget
}
