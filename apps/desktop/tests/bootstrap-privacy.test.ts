import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('desktop bootstrap privacy', () => {
  it('does not ship a named-card release bootstrap or write legacy preset directories', async () => {
    const source = join(process.cwd(), 'src', 'main', 'bootstrap.ts')
    await expect(access(source)).rejects.toThrow()
  })
})
