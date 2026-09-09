import { describe, expect, it } from 'vitest'
import { isIpcOperationAllowed } from '../src/main/ipc-capability.js'

describe('IPC capability policy', () => {
  it('allows settings and runtime selection only on the bundled diagnostics page', () => {
    expect(isIpcOperationAllowed('local', 'get-settings')).toBe(true)
    expect(isIpcOperationAllowed('local', 'save-settings')).toBe(true)
    expect(isIpcOperationAllowed('local', 'choose-runtime-path')).toBe(true)
    expect(isIpcOperationAllowed('studio', 'get-settings')).toBe(false)
    expect(isIpcOperationAllowed('studio', 'save-settings')).toBe(false)
    expect(isIpcOperationAllowed('studio', 'choose-runtime-path')).toBe(false)
  })

  it('limits Studio to status and session-scoped safe operations', () => {
    expect(isIpcOperationAllowed('studio', 'status')).toBe(true)
    expect(isIpcOperationAllowed('studio', 'import-asset')).toBe(true)
    expect(isIpcOperationAllowed('studio', 'doctor')).toBe(false)
  })
})
