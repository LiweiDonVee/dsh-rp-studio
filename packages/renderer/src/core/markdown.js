export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function findClosing(text, marker, start) {
  let cursor = start
  while ((cursor = text.indexOf(marker, cursor)) !== -1) {
    if (text[cursor - 1] !== '\\') return cursor
    cursor += marker.length
  }
  return -1
}

function rawTagAt(tail) {
  return /^(?:<!--[^]*?-->|<\/?[A-Za-z][^>\n]*>)/.exec(tail)?.[0]
}

function isAsciiPunctuation(value) {
  const code = value.codePointAt(0)
  return (code >= 0x21 && code <= 0x2f)
    || (code >= 0x3a && code <= 0x40)
    || (code >= 0x5b && code <= 0x60)
    || (code >= 0x7b && code <= 0x7e)
}

export function renderInline(input, depth = 0) {
  const text = String(input ?? '')
  if (depth > 24) return escapeHtml(text)
  let html = ''
  let index = 0
  while (index < text.length) {
    const tail = text.slice(index)
    if (text[index] === '\\' && index + 1 < text.length && isAsciiPunctuation(text[index + 1])) {
      html += escapeHtml(text[index + 1])
      index += 2
      continue
    }
    if (text[index] === '`') {
      const end = findClosing(text, '`', index + 1)
      if (end !== -1) {
        html += `<code>${escapeHtml(text.slice(index + 1, end).replace(/\s*\n\s*/g, ' '))}</code>`
        index = end + 1
        continue
      }
    }
    const image = /^!\[([^\]]*)\]\((\S+?)(?:\s+["']([^"']*)["'])?\)/.exec(tail)
    if (image !== null) {
      html += `<img src="${escapeHtml(image[2])}" alt="${escapeHtml(image[1])}"${image[3] ? ` title="${escapeHtml(image[3])}"` : ''}>`
      index += image[0].length
      continue
    }
    const link = /^\[([^\]]+)\]\((\S+?)(?:\s+["']([^"']*)["'])?\)/.exec(tail)
    if (link !== null) {
      html += `<a href="${escapeHtml(link[2])}"${link[3] ? ` title="${escapeHtml(link[3])}"` : ''}>${renderInline(link[1], depth + 1)}</a>`
      index += link[0].length
      continue
    }
    if (text[index] === '<') {
      const tag = rawTagAt(tail)
      if (tag !== undefined) {
        html += tag
        index += tag.length
        continue
      }
    }
    const formats = [
      ['**', 'strong'], ['__', 'strong'], ['~~', 'del'], ['++', 'u'], ['*', 'em'], ['_', 'em'],
    ]
    let formatted = false
    for (const [marker, tag] of formats) {
      if (!tail.startsWith(marker)) continue
      const end = findClosing(text, marker, index + marker.length)
      if (end <= index + marker.length) continue
      html += `<${tag}>${renderInline(text.slice(index + marker.length, end), depth + 1)}</${tag}>`
      index = end + marker.length
      formatted = true
      break
    }
    if (formatted) continue
    html += escapeHtml(text[index])
    index += 1
  }
  return html
}

function isFence(line) {
  return /^\s*(`{3,}|~{3,})([^`]*)$/.exec(line)
}

function listMatch(line) {
  const match = /^(\s*)([-+*]|\d+[.)])\s+(.+)$/.exec(line)
  if (match === null) return null
  return { indent: match[1].replaceAll('\t', '    ').length, ordered: /^\d/.test(match[2]), text: match[3] }
}

function startsBlock(lines, index) {
  const line = lines[index] ?? ''
  if (line.trim() === '') return true
  if (isFence(line) !== null || listMatch(line) !== null) return true
  if (/^\s{0,3}(?:#{1,6}\s+|>\s?|(?:-{3,}|\*{3,}|_{3,})\s*$)/.test(line)) return true
  if (index + 1 < lines.length && /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/.test(lines[index + 1])) return true
  return false
}

function splitTableRow(line) {
  return line.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim())
}

function renderTable(lines, start) {
  const headers = splitTableRow(lines[start])
  let index = start + 2
  const rows = []
  while (index < lines.length && lines[index].includes('|') && lines[index].trim() !== '') {
    rows.push(splitTableRow(lines[index]))
    index += 1
  }
  const head = `<thead><tr>${headers.map(cell => `<th>${renderInline(cell)}</th>`).join('')}</tr></thead>`
  const body = rows.length === 0 ? '' : `<tbody>${rows.map(row => `<tr>${headers.map((_, cell) => `<td>${renderInline(row[cell] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody>`
  return { html: `<table>${head}${body}</table>`, next: index }
}

function renderList(lines, start) {
  const first = listMatch(lines[start])
  const tag = first.ordered ? 'ol' : 'ul'
  const baseIndent = first.indent
  const items = []
  let index = start
  while (index < lines.length) {
    const current = listMatch(lines[index])
    if (current === null || current.indent !== baseIndent || current.ordered !== first.ordered) break
    index += 1
    const continuations = []
    while (index < lines.length) {
      const next = listMatch(lines[index])
      if (lines[index].trim() === '') break
      if (next !== null && next.indent === baseIndent) break
      if (next !== null && next.indent > baseIndent) {
        const nested = renderList(lines, index)
        continuations.push(nested.html)
        index = nested.next
      } else {
        continuations.push(renderInline(lines[index].trim()))
        index += 1
      }
    }
    items.push(`<li>${renderInline(current.text)}${continuations.length ? `<div>${continuations.join('<br>')}</div>` : ''}</li>`)
    if (lines[index]?.trim() === '') break
  }
  return { html: `<${tag}>${items.join('')}</${tag}>`, next: index }
}

/** Dependency-free Markdown renderer. Raw HTML is deliberately deferred to sanitizeHtml(). */
export function markdownToHtml(input) {
  const lines = String(input ?? '').replace(/\r\n?/g, '\n').split('\n')
  const blocks = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    if (line.trim() === '') {
      index += 1
      continue
    }
    const fence = isFence(line)
    if (fence !== null) {
      const marker = fence[1]
      const language = fence[2].trim().split(/\s+/)[0].replace(/[^\w-]/g, '')
      const code = []
      index += 1
      while (index < lines.length && !new RegExp(`^\\s*${marker[0]}{${marker.length},}\\s*$`).test(lines[index])) {
        code.push(lines[index++])
      }
      if (index < lines.length) index += 1
      blocks.push(`<pre><code${language ? ` class="language-${escapeHtml(language)}"` : ''}>${escapeHtml(code.join('\n'))}</code></pre>`)
      continue
    }
    const heading = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
    if (heading !== null) {
      blocks.push(`<h${heading[1].length}>${renderInline(heading[2])}</h${heading[1].length}>`)
      index += 1
      continue
    }
    if (/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push('<hr>')
      index += 1
      continue
    }
    if (/^\s{0,3}>/.test(line)) {
      const quote = []
      while (index < lines.length && /^\s{0,3}>/.test(lines[index])) {
        quote.push(lines[index].replace(/^\s{0,3}>\s?/, ''))
        index += 1
      }
      blocks.push(`<blockquote>${markdownToHtml(quote.join('\n'))}</blockquote>`)
      continue
    }
    if (listMatch(line) !== null) {
      const list = renderList(lines, index)
      blocks.push(list.html)
      index = list.next
      continue
    }
    if (index + 1 < lines.length && line.includes('|') && /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/.test(lines[index + 1])) {
      const table = renderTable(lines, index)
      blocks.push(table.html)
      index = table.next
      continue
    }
    const paragraph = [line]
    index += 1
    while (index < lines.length && lines[index].trim() !== '' && !startsBlock(lines, index)) {
      paragraph.push(lines[index])
      index += 1
    }
    blocks.push(`<p>${paragraph.map(value => renderInline(value)).join('<br>')}</p>`)
  }
  return blocks.join('\n')
}
