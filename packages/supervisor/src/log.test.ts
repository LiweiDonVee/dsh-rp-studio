import { describe, expect, it } from 'vitest'
import { SecretLogBuffer } from './log.js'

describe('SecretLogBuffer', () => {
  it('decodes UTF-8 across byte chunks and sanitizes cookies', () => {
    const logs = new SecretLogBuffer({ secrets: [], maxCharacters: 200 })
    const bytes = Buffer.from('\u4e2d\u6587\nCookie: dsh_session=cookie-canary; another=value\n')
    for (const byte of bytes) logs.push('dsh', Buffer.from([byte]))
    expect(logs.snapshot()[0]?.text).toBe('\u4e2d\u6587')
    expect(JSON.stringify(logs.snapshot())).not.toContain('cookie-canary')
  })

  it('drops an oversized unterminated line without exposing a sliced secret', () => {
    const logs = new SecretLogBuffer({ secrets: ['private-canary'], maxCharacters: 32 })
    for (let i = 0; i < 100; i++) logs.push('dsh', 'private-canary'.repeat(1_000))
    expect(JSON.stringify(logs).length).toBeLessThan(10_000)
    logs.push('dsh', '\nnext line\n')
    expect(JSON.stringify(logs.snapshot())).not.toContain('canary')
    expect(logs.snapshot().at(-1)?.text).toBe('next line')
  })
  it('removes ANSI and redacts a token split across chunks', () => {
    const logs = new SecretLogBuffer({ secrets: ['cross-chunk-secret'], maxCharacters: 100 })

    logs.push('dsh', '\u001b[32mURL ?token=cross-')
    logs.push('dsh', 'chunk-secret\u001b[0m ready\n')
    logs.end('dsh')

    expect(logs.snapshot()).toEqual([{ source: 'dsh', text: 'URL ?token=[REDACTED] ready' }])
    expect(JSON.stringify(logs.snapshot())).not.toContain('cross-chunk-secret')
    expect(JSON.stringify(logs.snapshot())).not.toContain('\u001b[')
  })

  it('keeps only a bounded tail', () => {
    const logs = new SecretLogBuffer({ secrets: [], maxCharacters: 12 })
    logs.push('studio', 'first line\nsecond line\nthird line\n')
    logs.end('studio')

    const text = logs.snapshot().map(entry => entry.text).join('\n')
    expect(logs.snapshot().reduce((total, entry) => total + entry.text.length, 0)).toBeLessThanOrEqual(12)
    expect(text).toContain('third')
    expect(text).not.toContain('first')
  })
})
