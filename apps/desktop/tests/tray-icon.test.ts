import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { trayIconPath, trayIconSource } from '../src/main/tray-icon.js'

describe('tray icon', () => {
  it('ships a visible built-in image asset instead of an empty native image', async () => {
    const path = trayIconPath(process.cwd())
    const asset = await readFile(join(process.cwd(), 'assets', 'tray-icon.svg'), 'utf8')

    expect(path).toBe(join(process.cwd(), 'dist', 'assets', 'tray-icon.svg'))
    expect(asset).toContain('<svg')
    expect(asset.length).toBeGreaterThan(150)
    expect(trayIconSource(path)).toEqual({ type: 'path', path })
  })
})
