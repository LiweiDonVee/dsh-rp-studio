import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('desktop package layout', () => {
  it('verifies packaged Gateway and Web resources before reporting a release', async () => {
    const manifest = JSON.parse(await readFile(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as {
      scripts: { package: string }
      build: { extraResources: { from: string; to: string }[] }
    }

    expect(manifest.scripts.package).toContain('verify-package.mjs')
    expect(manifest.build.extraResources).toEqual(expect.arrayContaining([
      { from: 'dist/gateway', to: 'studio/gateway' },
      { from: '../web/dist', to: 'studio/web/dist' },
    ]))
  })
})
