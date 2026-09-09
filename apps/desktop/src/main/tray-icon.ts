import { join } from 'node:path'

export function trayIconPath(appPath: string): string {
  return join(appPath, 'dist', 'assets', 'tray-icon.svg')
}

export function trayIconSource(path: string): { type: 'path'; path: string } {
  return { type: 'path', path }
}

export function trayIconPixels(): Buffer {
  const pixels = Buffer.alloc(32 * 32 * 4)
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
    const offset = (y * 32 + x) * 4
    const ink = (x >= 8 && x <= 11 && y >= 7 && y <= 24) || (x >= 11 && x <= 21 && (y >= 7 && y <= 10 || y >= 21 && y <= 24)) || (x >= 21 && x <= 24 && y >= 10 && y <= 21)
    pixels.set(ink ? [255, 255, 255, 255] : [101, 139, 22, 255], offset)
  }
  return pixels
}

export const trayIconDataUrl = 'data:image/svg+xml;charset=utf-8,%3Csvg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"%3E%3Crect width="32" height="32" rx="6" fill="%23658b16"/%3E%3Cpath d="M8 7h16v4h-12v3h9v4h-9v3h12v4h-16z" fill="white"/%3E%3C/svg%3E'
