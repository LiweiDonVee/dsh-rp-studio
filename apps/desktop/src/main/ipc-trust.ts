import type { TrustedPage } from './ipc-capability.js'

export interface IpcSenderLike { sender: unknown; frameId?: number; senderFrame?: { url?: string } | null }

export function trustedPageForIpcSender(event: IpcSenderLike, contents: unknown, studioUrl?: string, bundledPage?: string): TrustedPage | undefined {
  if (event.sender !== contents || !event.senderFrame?.url) return undefined
  const mainFrame = typeof contents === 'object' && contents !== null && 'mainFrame' in contents
    ? (contents as { mainFrame?: unknown }).mainFrame
    : undefined
  if (mainFrame !== undefined ? event.senderFrame !== mainFrame : (event.frameId ?? 0) !== 0) return undefined
  if (bundledPage && event.senderFrame.url === bundledPage) return 'local'
  if (!studioUrl) return undefined
  try {
    const actual = new URL(event.senderFrame.url)
    const expected = new URL(studioUrl)
    return expected.protocol === 'http:' && expected.hostname === '127.0.0.1' && actual.origin === expected.origin ? 'studio' : undefined
  } catch { return undefined }
}

export function isTrustedIpcSender(event: IpcSenderLike, contents: unknown, studioUrl?: string, bundledPage?: string): boolean {
  return trustedPageForIpcSender(event, contents, studioUrl, bundledPage) !== undefined
}
