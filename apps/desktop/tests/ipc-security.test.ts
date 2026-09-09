import { describe, expect, it } from 'vitest'
import { isTrustedIpcSender } from '../src/main/ipc-trust.js'

describe('IPC sender validation', () => {
  it('requires the owning top-level frame and exact loopback origin', () => {
    const contents = {}
    expect(isTrustedIpcSender({ sender: contents, frameId: 0, senderFrame: { url: 'http://127.0.0.1:4317/' } }, contents, 'http://127.0.0.1:4317/')).toBe(true)
    expect(isTrustedIpcSender({ sender: {}, frameId: 0, senderFrame: { url: 'http://127.0.0.1:4317/' } }, contents, 'http://127.0.0.1:4317/')).toBe(false)
    expect(isTrustedIpcSender({ sender: contents, frameId: 1, senderFrame: { url: 'http://127.0.0.1:4317/' } }, contents, 'http://127.0.0.1:4317/')).toBe(false)
    expect(isTrustedIpcSender({ sender: contents, frameId: 0, senderFrame: { url: 'https://127.0.0.1:4317/' } }, contents, 'http://127.0.0.1:4317/')).toBe(false)
  })
})
