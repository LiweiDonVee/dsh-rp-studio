import { escapeHtml, markdownToHtml } from './markdown.js'

export const DOCUMENT_TEMPLATE_IDS = Object.freeze([
  'letter', 'exam', 'postcard', 'cipher', 'telegram', 'newspaper', 'dossier', 'diary',
])

const DOCUMENT_TYPES = new Set(DOCUMENT_TEMPLATE_IDS)
const OPEN_DIRECTIVE = /^\s{0,3}:::([a-z][\w-]{0,31})\s*$/i
const CLOSE_DIRECTIVE = /^\s{0,3}:::\s*$/
const FIELD_LINE = /^([a-z][\w-]{0,31})\s*:\s*(.*)$/i
const MAX_FIELDS = 32
const MAX_FIELD_LENGTH = 2_000
const SLOT_START = '\uE000DTRDOC'
const SLOT_END = '\uE001'

function field(fields, name, fallback = '') {
  const value = fields[name]
  return escapeHtml(value === undefined || value === '' ? fallback : value)
}

function row(label, value, extraClass = '') {
  if (value === '') return ''
  const classes = ['custom-dtr-doc-field', extraClass].filter(Boolean).join(' ')
  return `<div class="${classes}"><small>${escapeHtml(label)}</small><span>${value}</span></div>`
}

function bodyHtml(body) {
  return markdownToHtml(body.trim()) || '<p></p>'
}

function liveBadge(streaming) {
  return streaming
    ? '<span class="custom-dtr-doc-draft" role="status"><span aria-hidden="true"></span>Draft</span>'
    : ''
}

function wrapper(type, label, streaming, content) {
  const classes = [
    'custom-dtr-doc',
    `custom-dtr-doc-${type}`,
    streaming ? 'custom-dtr-doc-streaming' : '',
  ].filter(Boolean).join(' ')
  return `<article class="${classes}" aria-label="${escapeHtml(label)}">${content}</article>`
}

function renderLetter(fields, body, context, streaming) {
  const from = field(fields, 'from', context.char ?? 'Assistant')
  const to = field(fields, 'to', context.user ?? 'User')
  const subject = field(fields, 'subject', 'Personal correspondence')
  const seal = ['crimson', 'navy', 'black', 'gold'].includes(fields.seal?.toLowerCase())
    ? fields.seal.toLowerCase()
    : 'crimson'
  return wrapper('letter', 'Letter', streaming, [
    '<span class="custom-dtr-doc-paper-grain" aria-hidden="true"></span>',
    '<div class="custom-dtr-letter-fold" aria-hidden="true"></div>',
    '<div class="custom-dtr-doc-head">',
    '<div><small>Private correspondence</small>',
    `<h3>${subject}</h3></div>${liveBadge(streaming)}`,
    '</div>',
    '<div class="custom-dtr-letter-routing">',
    row('To', to), row('From', from), row('Place', field(fields, 'place')), row('Date', field(fields, 'date')),
    '</div>',
    `<section class="custom-dtr-doc-body custom-dtr-letter-body">${bodyHtml(body)}</section>`,
    '<div class="custom-dtr-letter-footer">',
    `<div>${row('Signed', from, 'custom-dtr-letter-signature')}</div>`,
    `<span class="custom-dtr-letter-seal custom-dtr-letter-seal-${seal}" aria-hidden="true">${escapeHtml(from.slice(0, 1).toUpperCase() || 'S')}</span>`,
    '</div>',
  ].join(''))
}

function renderExam(fields, body, context, streaming) {
  const title = field(fields, 'title', 'Examination paper')
  const instructions = field(fields, 'instructions')
  return wrapper('exam', 'Examination paper', streaming, [
    '<div class="custom-dtr-exam-rule" aria-hidden="true"><span></span><span></span></div>',
    `<div class="custom-dtr-doc-head"><div><small>${field(fields, 'course', 'Assessment')}</small><h3>${title}</h3></div>${liveBadge(streaming)}</div>`,
    '<div class="custom-dtr-exam-candidate">',
    row('Candidate', field(fields, 'student', context.user ?? 'User')),
    row('Date', field(fields, 'date')),
    row('Duration', field(fields, 'duration', 'Not specified')),
    `<div class="custom-dtr-exam-score"><small>Total</small><strong>${field(fields, 'total', '--')}</strong></div>`,
    '</div>',
    instructions ? `<aside class="custom-dtr-exam-instructions"><strong>Instructions</strong><span>${instructions}</span></aside>` : '',
    `<section class="custom-dtr-doc-body custom-dtr-exam-body">${bodyHtml(body)}</section>`,
    '<div class="custom-dtr-exam-footer"><span>End of paper</span><span>Check all pages before submitting</span></div>',
  ].join(''))
}

function renderPostcard(fields, body, context, streaming) {
  const stamp = ['airmail', 'express', 'vintage', 'local'].includes(fields.stamp?.toLowerCase())
    ? fields.stamp.toLowerCase()
    : 'vintage'
  return wrapper('postcard', 'Postcard', streaming, [
    '<div class="custom-dtr-postcard-edge" aria-hidden="true"></div>',
    `<div class="custom-dtr-postcard-caption"><span>Post card</span><strong>${field(fields, 'location', 'Somewhere memorable')}</strong>${liveBadge(streaming)}</div>`,
    '<div class="custom-dtr-postcard-grid">',
    `<section class="custom-dtr-doc-body custom-dtr-postcard-message">${bodyHtml(body)}${row('From', field(fields, 'from', context.char ?? 'Assistant'))}</section>`,
    '<section class="custom-dtr-postcard-address">',
    `<div class="custom-dtr-postcard-stamp custom-dtr-postcard-stamp-${stamp}" aria-label="${escapeHtml(stamp)} stamp"><span>${stamp}</span></div>`,
    '<div class="custom-dtr-postmark" aria-hidden="true"><span></span><span></span><span></span></div>',
    row('Deliver to', field(fields, 'to', context.user ?? 'User')),
    row('Date', field(fields, 'date')),
    '<div class="custom-dtr-address-lines" aria-hidden="true"><span></span><span></span><span></span></div>',
    '</section></div>',
  ].join(''))
}

function renderCipher(fields, body, _context, streaming) {
  const classification = field(fields, 'classification', 'Classified')
  return wrapper('cipher', 'Cipher memorandum', streaming, [
    `<div class="custom-dtr-cipher-band"><strong>${classification}</strong><span>${field(fields, 'code', 'NO CODE')}</span>${liveBadge(streaming)}</div>`,
    '<div class="custom-dtr-cipher-grid" aria-hidden="true"></div>',
    '<div class="custom-dtr-cipher-routing">',
    row('Origin', field(fields, 'from')), row('Recipient', field(fields, 'to')),
    row('Cipher key', field(fields, 'key', 'WITHHELD')), row('Date', field(fields, 'date')),
    '</div>',
    '<div class="custom-dtr-cipher-redactions" aria-hidden="true"><span></span><span></span><span></span></div>',
    `<section class="custom-dtr-doc-body custom-dtr-cipher-body">${bodyHtml(body)}</section>`,
    `<div class="custom-dtr-cipher-footer"><span>Authentication: ${field(fields, 'status', 'unverified')}</span><strong>Destroy after reading</strong></div>`,
  ].join(''))
}

function renderTelegram(fields, body, _context, streaming) {
  return wrapper('telegram', 'Telegram', streaming, [
    '<div class="custom-dtr-telegram-perforation" aria-hidden="true"></div>',
    `<div class="custom-dtr-doc-head"><div><small>Wire transmission</small><h3>${field(fields, 'priority', 'Telegram')}</h3></div>${liveBadge(streaming)}</div>`,
    '<div class="custom-dtr-telegram-route">',
    row('To', field(fields, 'to')), row('From', field(fields, 'from')),
    row('Station', field(fields, 'station')), row('Filed', [field(fields, 'date'), field(fields, 'time')].filter(Boolean).join(' / ')),
    '</div>',
    `<section class="custom-dtr-doc-body custom-dtr-telegram-body">${bodyHtml(body)}</section>`,
    '<div class="custom-dtr-telegram-footer">',
    `<span>${field(fields, 'charge', 'Standard charge')}</span><span>Operator ${field(fields, 'operator', '--')}</span>`,
    '</div>',
  ].join(''))
}

function renderNewspaper(fields, body, _context, streaming) {
  return wrapper('newspaper', 'Newspaper clipping', streaming, [
    '<div class="custom-dtr-newspaper-masthead">',
    `<small>${field(fields, 'edition', 'Daily edition')}</small><h2>${field(fields, 'name', 'The Daily Chronicle')}</h2><span>${field(fields, 'date')}</span>`,
    '</div>',
    `<div class="custom-dtr-newspaper-section"><span>${field(fields, 'section', 'News')}</span>${liveBadge(streaming)}</div>`,
    `<h3 class="custom-dtr-newspaper-headline">${field(fields, 'headline', 'Untitled report')}</h3>`,
    fields.deck ? `<p class="custom-dtr-newspaper-deck">${field(fields, 'deck')}</p>` : '',
    `<div class="custom-dtr-newspaper-byline">By ${field(fields, 'byline', 'Staff correspondent')}</div>`,
    `<section class="custom-dtr-doc-body custom-dtr-newspaper-body">${bodyHtml(body)}</section>`,
    '<div class="custom-dtr-newspaper-footer">Continued in the archive edition</div>',
  ].join(''))
}

function renderDossier(fields, body, _context, streaming) {
  return wrapper('dossier', 'Case dossier', streaming, [
    `<div class="custom-dtr-dossier-tab">${field(fields, 'file', 'UNFILED')}</div>`,
    '<div class="custom-dtr-dossier-head">',
    `<div><small>${field(fields, 'agency', 'Records bureau')}</small><h3>${field(fields, 'subject', 'Unknown subject')}</h3></div>`,
    `<strong>${field(fields, 'classification', 'Restricted')}</strong>${liveBadge(streaming)}`,
    '</div>',
    '<div class="custom-dtr-dossier-index">',
    row('File', field(fields, 'file')), row('Status', field(fields, 'status', 'Open')),
    row('Handler', field(fields, 'handler')), row('Updated', field(fields, 'date')),
    '</div>',
    `<section class="custom-dtr-doc-body custom-dtr-dossier-body">${bodyHtml(body)}</section>`,
    '<div class="custom-dtr-dossier-stamps" aria-hidden="true"><span>Filed</span><span>Copy</span></div>',
  ].join(''))
}

function renderDiary(fields, body, context, streaming) {
  return wrapper('diary', 'Diary entry', streaming, [
    '<div class="custom-dtr-diary-ribbon" aria-hidden="true"></div>',
    '<div class="custom-dtr-diary-head">',
    `<div><small>${field(fields, 'owner', context.char ?? 'Private journal')}</small><h3>${field(fields, 'title', 'Journal entry')}</h3></div>${liveBadge(streaming)}`,
    '<div class="custom-dtr-diary-date">',
    `<strong>${field(fields, 'date', 'Undated')}</strong><span>${field(fields, 'time')}</span>`,
    '</div></div>',
    '<div class="custom-dtr-diary-context">',
    row('Place', field(fields, 'location')), row('Mood', field(fields, 'mood')), row('Weather', field(fields, 'weather')),
    '</div>',
    `<section class="custom-dtr-doc-body custom-dtr-diary-body">${bodyHtml(body)}</section>`,
    '<div class="custom-dtr-diary-flourish" aria-hidden="true"><span></span></div>',
  ].join(''))
}

const RENDERERS = Object.freeze({
  letter: renderLetter,
  exam: renderExam,
  postcard: renderPostcard,
  cipher: renderCipher,
  telegram: renderTelegram,
  newspaper: renderNewspaper,
  dossier: renderDossier,
  diary: renderDiary,
})

function parseFields(lines) {
  const fields = Object.create(null)
  let count = 0
  for (const line of lines) {
    const match = FIELD_LINE.exec(line)
    if (match === null || count >= MAX_FIELDS) continue
    fields[match[1].toLowerCase()] = match[2].trim().slice(0, MAX_FIELD_LENGTH)
    count += 1
  }
  return fields
}

export function renderDocument(type, fields = {}, body = '', context = {}, { streaming = false } = {}) {
  const key = String(type ?? '').toLowerCase()
  const renderer = RENDERERS[key]
  if (renderer === undefined) throw new Error(`unknown document template: ${key || '(empty)'}`)
  const normalizedFields = Object.fromEntries(
    Object.entries(fields).slice(0, MAX_FIELDS).map(([name, value]) => [
      String(name).toLowerCase(), String(value ?? '').slice(0, MAX_FIELD_LENGTH),
    ]),
  )
  return renderer(normalizedFields, String(body ?? ''), context, Boolean(streaming))
}

/** Replace complete document directives with private slots that survive Markdown parsing. */
export function extractDocumentBlocks(input, context = {}) {
  const source = String(input ?? '')
  const lines = source.split('\n')
  const output = []
  const slots = []
  const diagnostics = []
  let slotNonce = 0
  let index = 0
  while (index < lines.length) {
    const open = OPEN_DIRECTIVE.exec(lines[index])
    const type = open?.[1].toLowerCase()
    if (open === null || !DOCUMENT_TYPES.has(type)) {
      output.push(lines[index])
      index += 1
      continue
    }

    let close = index + 1
    while (close < lines.length && !CLOSE_DIRECTIVE.test(lines[close])) close += 1
    const complete = close < lines.length
    if (!complete && context.streaming !== true) {
      output.push(...lines.slice(index))
      break
    }

    const payload = lines.slice(index + 1, complete ? close : lines.length)
    const separator = payload.findIndex(line => /^\s*---\s*$/.test(line))
    if (separator === -1 && complete) {
      diagnostics.push({ type: 'malformed-document', documentType: type, message: 'missing metadata separator' })
      output.push(...lines.slice(index, close + 1))
      index = close + 1
      continue
    }

    const fields = parseFields(separator === -1 ? payload : payload.slice(0, separator))
    const body = separator === -1 ? '' : payload.slice(separator + 1).join('\n')
    let token
    do {
      token = `${SLOT_START}${slotNonce}:${slots.length}${SLOT_END}`
      slotNonce += 1
    } while (source.includes(token))
    slots.push({
      token,
      html: renderDocument(type, fields, body, context, { streaming: !complete }),
    })
    output.push('', token, '')
    index = complete ? close + 1 : lines.length
  }
  return { value: output.join('\n'), slots, diagnostics }
}

export function restoreDocumentBlocks(html, slots = []) {
  let output = String(html ?? '')
  for (const slot of slots) {
    output = output.replaceAll(`<p>${slot.token}</p>`, slot.html)
    output = output.replaceAll(slot.token, slot.html)
  }
  return output
}
