import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path'
import { DataIntegrityError, DataValidationError } from './errors.js'

export interface StoragePaths {
  root: string
  assets: string
  backups: string
  database: string
}

export async function prepareStorage(dataDir: string): Promise<StoragePaths> {
  if (typeof dataDir !== 'string' || !dataDir || !isAbsolute(dataDir)) throw new DataValidationError('dataDir must be an absolute path')
  await ensureDirectory(resolve(dataDir))
  const requested = normalize(resolve(dataDir))
  const canonical = await realpath(dataDir)
  if (requested !== normalize(canonical)) throw new DataValidationError('dataDir must not traverse symbolic links')
  const assets = join(canonical, 'assets')
  const backups = join(canonical, 'backups')
  await ensureDirectory(assets)
  await ensureDirectory(backups)
  await assertDirectory(assets, canonical)
  await assertDirectory(backups, canonical)
  const database = join(canonical, 'local-data.sqlite3')
  for (const suffix of ['', '-wal', '-shm', '-journal']) await assertMissingOrRegular(`${database}${suffix}`, canonical)
  return { root: canonical, assets, backups, database }
}

export async function assetPath(root: string, assetId: string, createShard = false): Promise<string> {
  const match = /^sha256:([a-f0-9]{64})$/u.exec(assetId)
  if (!match) throw new DataValidationError('Invalid asset id')
  const digest = match[1]!
  const shard = join(root, digest.slice(0, 2))
  if (createShard) await ensureDirectory(shard)
  await assertDirectory(shard, root)
  const path = join(shard, `${digest}.blob`)
  assertContained(root, path)
  return path
}

export async function writeAtomic(path: string, bytes: Uint8Array, hooks: { rename?: typeof rename } = {}): Promise<void> {
  await assertDirectory(dirname(path), dirname(path))
  await assertMissingOrRegular(path, dirname(path))
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  assertContained(dirname(path), temporary)
  try {
    try {
      const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
      try {
        await handle.writeFile(bytes)
        await handle.sync()
      } finally {
        await handle.close()
      }
      await assertDirectory(dirname(path), dirname(path))
      await assertMissingOrRegular(path, dirname(path))
      await (hooks.rename ?? rename)(temporary, path)
    } catch (error) {
      try {
        const existing = await readRegular(path, dirname(path), bytes.byteLength)
        if (digest(existing) === digest(bytes)) return
      } catch {
        // The original write/rename failure is the useful error.
      }
      throw error
    }
    // POSIX needs the directory entry flushed as well as the file contents.
    if (process.platform !== 'win32') {
      const directory = await open(dirname(path), constants.O_RDONLY)
      try { await directory.sync() } finally { await directory.close() }
    }
  } finally {
    await rm(temporary, { force: true })
  }
}

export async function readRegular(path: string, root: string, maxBytes = 32 * 1024 * 1024): Promise<Buffer> {
  assertContained(root, path)
  await assertDirectory(dirname(path), root)
  const before = await lstat(path)
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) throw new DataIntegrityError('Storage object must be an unlinked regular file')
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== before.dev || stat.ino !== before.ino) throw new DataIntegrityError('Storage object changed while opening')
    if (stat.size > maxBytes) throw new DataIntegrityError('Storage object exceeds its size limit')
    const bytes = Buffer.alloc(stat.size)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (bytesRead === 0) throw new DataIntegrityError('Storage object was truncated during read')
      offset += bytesRead
    }
    const after = await handle.stat()
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new DataIntegrityError('Storage object changed during read')
    await assertDirectory(dirname(path), root)
    return bytes
  } finally {
    await handle.close()
  }
}

export function assertContained(root: string, candidate: string): void {
  const rel = relative(resolve(root), resolve(candidate))
  if (rel === '..' || rel.startsWith(`..${requireSeparator()}`) || isAbsolute(rel)) throw new DataValidationError('Storage path escapes its root')
}

async function assertDirectory(path: string, root: string): Promise<void> {
  assertContained(root, path)
  for (const component of directoryChain(path)) {
    const stat = await lstat(component)
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new DataValidationError('Storage directory must be a real directory')
  }
  const canonical = await realpath(path)
  assertContained(root, canonical)
}

async function ensureDirectory(path: string): Promise<void> {
  for (const component of directoryChain(path)) {
    try { await mkdir(component, { mode: 0o700 }) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const stat = await lstat(component)
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new DataValidationError('Storage directories cannot traverse links')
  }
}

async function assertMissingOrRegular(path: string, root: string): Promise<void> {
  assertContained(root, path)
  try {
    const stat = await lstat(path)
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) throw new DataValidationError('Storage target must be a regular file without hard links')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

function normalize(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path
}

function requireSeparator(): string {
  return process.platform === 'win32' ? '\\' : '/'
}

function digest(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function directoryChain(path: string): string[] {
  const result: string[] = []
  let current = resolve(path)
  while (current !== parse(current).root) {
    result.unshift(current)
    current = dirname(current)
  }
  return result
}

// Restore uses synchronous verified reads while holding SQLite's write transaction.
export function readRegularSync(path: string, root: string, maxBytes: number): Buffer {
  assertContained(root, path)
  for (const component of directoryChain(dirname(path))) {
    const stat = lstatSync(component)
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new DataIntegrityError('Storage directory cannot traverse links')
  }
  assertContained(root, realpathSync(dirname(path)))
  const before = lstatSync(path)
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) throw new DataIntegrityError('Storage object is not a regular file')
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(descriptor)
    if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== before.dev || stat.ino !== before.ino || stat.size > maxBytes) throw new DataIntegrityError('Storage object changed or exceeds its size limit')
    const bytes = Buffer.alloc(stat.size)
    let offset = 0
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset)
      if (!count) throw new DataIntegrityError('Storage object was truncated during read')
      offset += count
    }
    const after = fstatSync(descriptor)
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new DataIntegrityError('Storage object changed during read')
    return bytes
  } finally {
    closeSync(descriptor)
  }
}
