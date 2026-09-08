import { describe, expect, it } from 'vitest'
import {
  API_PROTOCOL_VERSION,
  apiEnvelopeSchema,
  promptSessionSchema,
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

  it('accepts an empty optional prompt stack and rejects prompt content leakage', () => {
    const prompt = {
      available: true,
      revision: 4,
      coreProfileIds: ['rp-narrative-base', 'fixture-card'],
      optionalProfiles: [{
        id: 'fixture-profile',
        name: '测试方法组',
        description: 'optional',
        version: 1,
        entries: [{
          id: 'fixture-method-a',
          name: '测试方法 A',
          slot: 'render-style',
          selection: 'single',
          tags: ['rp'],
          enabledByDefault: false,
          renderOnly: true,
        }],
      }],
      enabledEntryIds: [],
      appliesFromNextTurn: false,
    }

    expect(promptSessionSchema.parse(prompt).enabledEntryIds).toEqual([])
    expect(promptSessionSchema.safeParse({
      ...prompt,
      optionalProfiles: [{ ...prompt.optionalProfiles[0]!, entries: [{ ...prompt.optionalProfiles[0]!.entries[0]!, content: 'SECRET PROMPT' }] }],
    }).success).toBe(false)
  })
})
