import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertContained, prepareStorage } from './files.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function scratch(): Promise<string> {
  const path = await mkdtemp(join(await realpath(tmpdir()), 'dsh-storage-files-'))
  directories.push(path)
  return path
}

describe('storage paths', () => {
  it('canonicalizes an absolute directory without treating filesystem aliases as links', async () => {
    // Windows TEMP may contain an 8.3 name even when every component is a real directory.
    const directory = await mkdtemp(join(tmpdir(), 'dsh-storage-alias-'))
    directories.push(directory)
    const canonical = await realpath(directory)

    expect(await prepareStorage(directory)).toEqual({
      root: canonical,
      assets: join(canonical, 'assets'),
      backups: join(canonical, 'backups'),
      database: join(canonical, 'local-data.sqlite3'),
    })
  })

  it.each(['root', 'ancestor'])('rejects a directory link at the %s', async position => {
    const directory = await scratch()
    const outside = join(directory, 'outside')
    const link = join(directory, 'link')
    await mkdir(outside)
    await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir')

    await expect(prepareStorage(position === 'root' ? link : join(link, 'child'))).rejects.toThrow('links')
  })

  it.each(['assets', 'backups'])('rejects a linked %s directory', async name => {
    const directory = await scratch()
    const root = join(directory, 'data')
    const outside = join(directory, 'outside')
    await mkdir(root)
    await mkdir(outside)
    await symlink(outside, join(root, name), process.platform === 'win32' ? 'junction' : 'dir')

    await expect(prepareStorage(root)).rejects.toThrow('links')
  })

  it('rejects a path that escapes the storage root', async () => {
    const directory = await scratch()
    expect(() => assertContained(join(directory, 'data'), join(directory, 'data', '..', 'outside'))).toThrow('escapes')
  })
})
