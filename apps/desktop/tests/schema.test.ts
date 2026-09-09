import { describe, expect, it } from 'vitest'
import { assetSuccessSchema, backupSuccessSchema, ipcRequestSchema, parseIpcRequest } from '../src/shared/ipc-schema.js'

describe('IPC schemas', () => {
  it('rejects renderer notification requests and unknown request shapes', () => {
    expect(ipcRequestSchema.safeParse({ type: 'notify', kind: 'diagnostic' }).success).toBe(false)
    expect(() => parseIpcRequest({ type: 'read-file', path: 'C:/secret' })).toThrow()
  })

  it('requires a session before an asset chooser can be requested', () => {
    expect(ipcRequestSchema.safeParse({ type: 'import-asset' }).success).toBe(false)
    expect(parseIpcRequest({ type: 'import-asset', sessionId: '会话-7' })).toEqual({ type: 'import-asset', sessionId: '会话-7' })
  })

  it('accepts opaque selections and rejects arbitrary path injection', () => {
    expect(parseIpcRequest({ type: 'choose-runtime-path', field: 'runtimeRoot' })).toEqual({ type: 'choose-runtime-path', field: 'runtimeRoot' })
    expect(ipcRequestSchema.safeParse({ type: 'choose-runtime-path', field: 'token' }).success).toBe(false)
    expect(ipcRequestSchema.safeParse({ type: 'save-settings', nodeExecutable: 'C:/injected/node.exe' }).success).toBe(false)
    expect(ipcRequestSchema.safeParse({ type: 'save-settings', selections: { nodeExecutable: '00000000-0000-4000-8000-000000000007' }, dshPort: 0, studioPort: 0 }).success).toBe(true)
  })

  it('defines strict success schemas for asset and backup IPC responses', () => {
    expect(assetSuccessSchema.parse({ selected: true, ok: true, assetId: 'sha256:' + 'a'.repeat(64) })).toEqual({ selected: true, ok: true, assetId: 'sha256:' + 'a'.repeat(64) })
    expect(backupSuccessSchema.parse({ selected: true, ok: true, backupId: 'backup-7' })).toEqual({ selected: true, ok: true, backupId: 'backup-7' })
    expect(assetSuccessSchema.safeParse({ selected: true, ok: true, assetId: 'asset', token: 'secret' }).success).toBe(false)
    expect(backupSuccessSchema.safeParse({ selected: true, ok: true, backupId: 'backup-7', path: 'C:/secret' }).success).toBe(false)
  })
})
