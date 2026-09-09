import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url))

describe('root runtime validation', () => {
  it('accepts the required Node 24 runtime through its executable check', async () => {
    const result = await execFileAsync(process.execPath, ['scripts/check-node-version.mjs'], { cwd: repositoryRoot })

    expect(result.stdout.trim()).toMatch(/^Node 24\.\d+\.\d+ satisfies the required Node 24 runtime$/u)
  })

  it('rejects a runtime outside major version 24 through its public validator', async () => {
    const module = await import('../../scripts/check-node-version.mjs')

    expect(() => module.assertNodeVersion('v23.11.0')).toThrowError()
  })

  it('reports the real Desktop toolchain from a normal workspace installation', async () => {
    const result = await execFileAsync(process.execPath, ['scripts/workspace-doctor.mjs'], { cwd: repositoryRoot })

    expect(result.stdout).toContain('electron:')
    expect(result.stdout).toContain('electron-builder:')
    expect(result.stdout).toContain('esbuild:')
    expect(result.stdout).toContain('typescript:')
    expect(result.stdout).toContain('vitest:')
    expect(result.stdout).toContain('@types/node:')
    expect(result.stdout).toContain('zod:')
  })
})
