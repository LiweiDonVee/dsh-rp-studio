export function isAllowedNavigation(candidate: string, studioUrl?: string, bundledPage?: string): boolean {
  try {
    if (bundledPage && candidate === bundledPage) return true
    if (!studioUrl) return false
    const actual = new URL(candidate)
    const expected = new URL(studioUrl)
    return expected.protocol === 'http:' && expected.hostname === '127.0.0.1' && actual.origin === expected.origin
  } catch { return false }
}

export function isAllowedWindowOpen(_candidate: string): boolean { return false }
export function shouldBlockDownload(): boolean { return true }
export function shouldRevokeStudioTrust(status: { state: string; lastError?: { code: string } | undefined }): boolean {
  return status.state !== 'running' || status.lastError?.code === 'child-exited'
}
export function shouldBlockProtocol(protocolOrUrl: string): boolean {
  try { return new URL(protocolOrUrl).protocol !== 'http:' } catch { return true }
}
