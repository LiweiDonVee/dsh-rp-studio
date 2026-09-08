import { describe, expect, it, vi } from 'vitest'
import { assertPromptPresetsUrl, createPromptPresetsClient } from './prompt-presets-client.js'

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

describe('Prompt Presets loopback client', () => {
  it('rejects non-loopback upstreams', () => {
    expect(() => assertPromptPresetsUrl('https://example.com/prompt-presets/api')).toThrow('loopback')
    expect(() => assertPromptPresetsUrl('http://0.0.0.0:3091/prompt-presets/api')).toThrow('loopback')
  })

  it('returns sanitized profile metadata and never exposes prompt content', async () => {
    const requestedUrls: string[] = []
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      requestedUrls.push(String(url))
      return json({
      ok: true,
      profile: {
        id: 'fixture-profile', name: '测试方法组', description: 'optional', version: 1,
        entries: [{
          id: 'style', name: '实验文风', enabled: false, group: 'style', selection: 'single', slot: 'render-style',
          tags: ['rp'], renderOnly: true, content: 'PROMPT_CANARY_SECRET', source: { sourcePath: '/synthetic/secret' },
        }],
      },
      })
    }) as unknown as typeof fetch
    const client = createPromptPresetsClient({ fetchImpl })
    const profile = await client.profile('fixture-profile', 1)

    expect(requestedUrls).toEqual(['http://127.0.0.1:3091/prompt-presets/api/profiles/fixture-profile?version=1'])
    expect(profile.entries).toEqual([{
      id: 'style', name: '实验文风', enabled: false, group: 'style', selection: 'single', slot: 'render-style', tags: ['rp'], renderOnly: true,
    }])
    expect(JSON.stringify(profile)).not.toContain('PROMPT_CANARY_SECRET')
    expect(JSON.stringify(profile)).not.toContain('/synthetic/secret')
  })

  it('sends a CAS overlay and surfaces revision conflicts', async () => {
    let body: unknown
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      body = init?.body ? JSON.parse(String(init.body)) : undefined
      return json({ ok: false, error: 'revision conflict', currentRevision: 8 }, 409)
    }) as unknown as typeof fetch
    const client = createPromptPresetsClient({ fetchImpl })

    await expect(client.setOverlay('session-1', ['base', 'optional'], ['style'], 7)).rejects.toMatchObject({ status: 409, currentRevision: 8 })
    expect(body).toEqual({ profileIds: ['base', 'optional'], overlay: { enabledEntries: ['style'], disabledEntries: [] }, expectedRevision: 7 })
  })

  it('aborts a stalled loopback request after the configured timeout', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal
      if (!signal) return reject(new Error('missing abort signal'))
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })) as unknown as typeof fetch
    const client = createPromptPresetsClient({ fetchImpl, timeoutMs: 5 })

    await expect(client.catalog()).rejects.toThrow('Prompt Presets request failed')
  })
})
