import { describe, expect, it } from 'vitest'
import {
  API_PROTOCOL_VERSION,
  apiEnvelopeSchema,
  publicGameStateSchema,
} from './index.js'

describe('RP API protocol', () => {
  it('accepts a versioned success envelope', () => {
    const parsed = apiEnvelopeSchema.parse({
      ok: true,
      protocolVersion: 1,
      data: { connected: true },
    })

    expect(API_PROTOCOL_VERSION).toBe(1)
    expect(parsed.ok).toBe(true)
  })

  it('rejects backend-only state roots', () => {
    const result = publicGameStateSchema.safeParse({
      started: true,
      statusLines: ['Day 1'],
      secrets: { canary: 'HIDDEN_CANARY' },
    })

    expect(result.success).toBe(false)
  })
})
