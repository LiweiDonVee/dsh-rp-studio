import { createHash } from 'node:crypto'
import { fail, object, TRANSCRIPT_MAX_BYTES, TRANSCRIPT_MAX_CHARS } from './companion-contract.mjs'

export function transcriptSource({ kind, format, path, identity, version, bytes, text, label }) {
  const hash = createHash('sha256').update(JSON.stringify(kind === 'file' ? [kind, identity, version, format] : [kind, format])).update(kind === 'text' ? text : '').digest('hex')
  return { id: hash, kind, format, ...(path === undefined ? {} : { path }), ...(version === undefined ? {} : { version }), ...(bytes === undefined ? {} : { bytes }), ...(label === undefined ? {} : { label }) }
}

// A call-local buffer only. Lookahead consumes at most the next provider chunk,
// rather than reading the remaining file to count lines or establish EOF.
function lineReader(chunks, signal) {
  const iterator = chunks[Symbol.asyncIterator]?.() ?? chunks[Symbol.iterator]?.()
  if (!iterator) fail('CAPABILITY_UNAVAILABLE', '宿主未提供兼容的流式文本读取。', 503)
  let buffer = '', done = false, bytes = 0, number = 0
  async function fill() {
    signal?.throwIfAborted()
    const item = await iterator.next()
    signal?.throwIfAborted()
    if (item.done) { done = true; return }
    if (typeof item.value !== 'string') fail('CAPABILITY_UNAVAILABLE', '宿主文本流返回了不兼容的数据。', 503)
    bytes += Buffer.byteLength(item.value, 'utf8')
    if (bytes > TRANSCRIPT_MAX_BYTES) fail('FILE_TOO_LARGE', `读取超过 ${TRANSCRIPT_MAX_BYTES} bytes；原件未被截断。`)
    buffer += item.value
  }
  return {
    get line() { return number },
    async next() {
      while (!done && !buffer.includes('\n')) await fill()
      if (!buffer.length && done) return null
      const end = buffer.indexOf('\n'), raw = end < 0 ? buffer : buffer.slice(0, end)
      buffer = end < 0 ? '' : buffer.slice(end + 1)
      return { number: ++number, text: end >= 0 && raw.endsWith('\r') ? raw.slice(0, -1) : raw }
    },
    async hasMore() { while (!buffer.length && !done) await fill(); return buffer.length > 0 },
    async close() { await iterator.return?.() },
  }
}

function message(line, format) {
  if (format !== 'sillytavern-jsonl') return { text: line.text, speaker: { role: 'unknown' } }
  const raw = line.number === 1 ? line.text.replace(/^\uFEFF/u, '') : line.text
  if (!raw.trim()) return null
  let value
  try { value = JSON.parse(raw) } catch { fail('INVALID_TRANSCRIPT', `会话第 ${line.number} 行不是有效的 JSON 对象。`) }
  if (!object(value)) fail('INVALID_TRANSCRIPT', `会话第 ${line.number} 行不是有效的 JSON 对象。`)
  // ST's current text is mes. Headers and non-message rows have no mes;
  // swipes, extra, tool data and instructions embedded in them are never read.
  if (value.mes === undefined) return null
  if (typeof value.mes !== 'string') fail('INVALID_TRANSCRIPT', `会话第 ${line.number} 行的 mes 必须是文本。`)
  const role = value.is_system === true ? 'system' : value.is_user === true ? 'user' : value.is_user === false ? 'assistant' : 'unknown'
  const speaker = { role, ...(typeof value.name === 'string' ? { name: value.name.slice(0, 256), ...(value.name.length > 256 ? { nameTruncated: true } : {}) } : {}) }
  const sendDate = typeof value.send_date === 'number' && Number.isFinite(value.send_date) ? value.send_date : typeof value.send_date === 'string' ? value.send_date.slice(0, 256) : undefined
  return { text: value.mes, speaker, ...(sendDate === undefined ? {} : { sendDate }), ...(typeof value.send_date === 'string' && value.send_date.length > 256 ? { sendDateTruncated: true } : {}) }
}

const low = value => value >= 0xdc00 && value <= 0xdfff
const high = value => value >= 0xd800 && value <= 0xdbff

/** Reads data only; source roles and text never become model/host instructions. */
export async function readTranscriptPage(chunks, input, source, signal) {
  if (input.cursor && input.cursor.sourceId !== source.id) fail('TRANSCRIPT_CONFLICT', '会话来源或版本已变化，请从明确的 offset 重新读取。', 409)
  const reader = lineReader(chunks, signal), records = []
  let turn = 0, scanned = 0, chars = 0, ignoredLines = 0, nextCursor = null, selectedLine = false
  const cursor = (line, charOffset = 0) => ({ sourceId: source.id, line, charOffset })
  try {
    for (let line = await reader.next(); line !== null; line = await reader.next()) {
      signal?.throwIfAborted()
      const value = message(line, source.format)
      if (value) turn++
      if (line.number < input.offset) continue
      selectedLine = true; scanned++
      const startChar = line.number === input.offset ? input.cursor?.charOffset ?? 0 : 0
      if (!value) {
        if (startChar) fail('INVALID_ARGUMENTS', '续读字符位置不能指向会话元数据或空行。')
        ignoredLines++
      } else {
        if (startChar > value.text.length || startChar > 0 && low(value.text.charCodeAt(startChar)) && high(value.text.charCodeAt(startChar - 1))) fail('INVALID_ARGUMENTS', '续读字符位置不在完整消息字符边界内。')
        let endChar = Math.min(value.text.length, startChar + TRANSCRIPT_MAX_CHARS - chars)
        if (endChar < value.text.length && low(value.text.charCodeAt(endChar)) && high(value.text.charCodeAt(endChar - 1))) endChar--
        if (endChar > startChar || !value.text.length) {
          const { text, ...metadata } = value
          records.push({ ref: { sourceId: source.id, line: line.number, ...(source.format === 'sillytavern-jsonl' ? { turn } : {}), startChar, endChar }, ...metadata, text: text.slice(startChar, endChar), complete: endChar === text.length })
          chars += endChar - startChar
        }
        if (endChar < value.text.length) { nextCursor = cursor(line.number, endChar); break }
      }
      if (scanned >= input.limit || chars >= TRANSCRIPT_MAX_CHARS) {
        if (await reader.hasMore()) nextCursor = cursor(line.number + 1)
        break
      }
    }
    if (!selectedLine && input.cursor?.charOffset) fail('INVALID_ARGUMENTS', '续读位置不在会话原文中。')
    signal?.throwIfAborted()
    return { schemaVersion: 1, source, trust: 'untrusted-source', offset: input.offset, limit: input.limit, records, ignoredLines, hasMore: nextCursor !== null, nextCursor, ...(nextCursor === null ? { totalLines: reader.line } : {}) }
  } finally { await reader.close() }
}
