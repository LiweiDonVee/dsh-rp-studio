import { LineBuffer, stripAnsi } from './lines.js'

export interface LogEntry {
  source: 'dsh' | 'studio'
  text: string
}

export interface SecretLogBufferOptions {
  secrets: string[]
  maxCharacters: number
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

export class SecretLogBuffer {
  private readonly secrets = new Set<string>()
  private readonly pending = new Map<string, LineBuffer>()
  private entries: LogEntry[] = []
  private characters = 0

  constructor(private readonly options: SecretLogBufferOptions) {
    for (const secret of options.secrets) this.addSecret(secret)
  }

  addSecret(secret: string): void {
    if (secret) {
      this.secrets.add(secret)
      this.entries = this.entries.map(entry => ({ ...entry, text: this.sanitize(entry.text) }))
      this.characters = this.entries.reduce((total, entry) => total + entry.text.length, 0)
      this.trim()
    }
  }

  push(source: LogEntry['source'], chunk: string | Uint8Array, stream: 'stdout' | 'stderr' = 'stdout'): void {
    const key = `${source}:${stream}`
    let buffer = this.pending.get(key)
    if (!buffer) {
      buffer = new LineBuffer(line => this.append(source, line), Math.max(1024, Math.min(65_536, this.options.maxCharacters)))
      this.pending.set(key, buffer)
    }
    buffer.push(chunk)
  }

  end(source: LogEntry['source'], stream?: 'stdout' | 'stderr'): void {
    for (const name of stream ? [stream] : ['stdout', 'stderr']) {
      const key = `${source}:${name}`
      this.pending.get(key)?.end()
      this.pending.delete(key)
    }
  }

  snapshot(): LogEntry[] {
    return this.entries.map(entry => ({ ...entry }))
  }

  sanitize(value: string): string {
    let clean = stripAnsi(value)
    for (const secret of [...this.secrets].sort((a, b) => b.length - a.length)) {
      clean = clean.replace(new RegExp(escapeRegExp(secret), 'gu'), '[REDACTED]')
    }
    return clean
      .replace(/([?&]token=)[^\s&#]+/giu, '$1[REDACTED]')
      .replace(/(\b(?:set-cookie|cookie)\s*:\s*)[^\r\n]+/giu, '$1[REDACTED]')
      .replace(/(\bdsh_session[\w-]*=)[^;\s]+/giu, '$1[REDACTED]')
      .replace(/(\b(?:dsh_web_token|prompt_presets_web_token|token)\s*[=:]\s*)[^\s]+/giu, '$1[REDACTED]')
  }

  private append(source: LogEntry['source'], value: string): void {
    const text = this.sanitize(value)
    if (!text) return
    this.entries.push({ source, text })
    this.characters += text.length
    this.trim()
  }

  private trim(): void {
    const limit = Math.max(0, this.options.maxCharacters)
    while (this.characters > limit && this.entries.length > 0) {
      const first = this.entries[0]
      if (!first) break
      const excess = this.characters - limit
      if (first.text.length <= excess) {
        this.entries.shift()
        this.characters -= first.text.length
      } else {
        first.text = first.text.slice(excess)
        this.characters -= excess
      }
    }
  }
}
