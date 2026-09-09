import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { build } from 'esbuild'

const directories: string[] = []
afterEach(async () => Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))))

describe('preload build', () => {
  it('produces a runnable CommonJS bundle with Electron externalized', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'desktop-preload-'))
    directories.push(directory)
    const output = join(directory, 'preload.cjs')
    await build({ entryPoints: [join(process.cwd(), 'src', 'preload', 'preload.ts')], bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: output })

    const bundled = await readFile(output, 'utf8')
    expect(bundled).toContain('require("electron")')
    expect(bundled).toContain('exposeInMainWorld')
  })
})
