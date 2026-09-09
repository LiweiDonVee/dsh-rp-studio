import { StringDecoder } from 'node:string_decoder'

// Discard oversized lines in their entirety: retaining a suffix can expose a secret.
export class LineBuffer {
  private readonly decoder = new StringDecoder('utf8')
  private pending = ''
  private dropped = false
  private ansi: 'text' | 'escape' | 'csi' | 'osc' | 'osc-escape' = 'text'

  constructor(private readonly onLine: (line: string) => void, private readonly limit = 65_536) {}

  push(chunk: string | Uint8Array): void {
    const text = typeof chunk === 'string' ? chunk : this.decoder.write(Buffer.from(chunk))
    for (const char of text) {
      const code = char.charCodeAt(0)
      if (char === '\n') {
        if (!this.dropped) this.onLine(this.pending.replace(/\r$/u, ''))
        this.pending = ''
        this.dropped = false
        // An unterminated control sequence must never grow a buffer.
        this.ansi = 'text'
        continue
      }
      if (this.ansi === 'osc') {
        if (code === 7) this.ansi = 'text'
        else if (code === 27) this.ansi = 'osc-escape'
        continue
      }
      if (this.ansi === 'osc-escape') {
        this.ansi = char === '\\' ? 'text' : 'osc'
        continue
      }
      if (this.ansi === 'csi') {
        if (code >= 64 && code <= 126) this.ansi = 'text'
        continue
      }
      if (this.ansi === 'escape') {
        this.ansi = char === '[' ? 'csi' : char === ']' ? 'osc' : 'text'
        continue
      }
      if (code === 27) { this.ansi = 'escape'; continue }
      if (this.dropped) continue
      this.pending += char
      if (this.pending.length > this.limit) { this.pending = ''; this.dropped = true }
    }
  }

  end(): void {
    this.push(this.decoder.end())
    if (!this.dropped && this.pending) this.onLine(this.pending)
    this.pending = ''
    this.dropped = false
    this.ansi = 'text'
  }
}

export function stripAnsi(text: string): string {
  const lines: string[] = []
  const buffer = new LineBuffer(line => lines.push(line), Math.max(1, text.length))
  buffer.push(text)
  buffer.end()
  return lines.join('\n')
}
