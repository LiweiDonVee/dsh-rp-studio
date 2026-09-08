const ALLOWED_TAGS = new Set([
  'a', 'abbr', 'article', 'aside', 'b', 'blockquote', 'br', 'code', 'del', 'details', 'div', 'em',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'kbd', 'li', 'ol',
  'p', 'pre', 's', 'section', 'small', 'span', 'strong', 'style', 'sub', 'summary', 'sup',
  'table', 'tbody', 'td', 'th', 'thead', 'tr', 'u', 'ul',
])

const DROP_WITH_CONTENT = new Set([
  'script', 'iframe', 'object', 'embed', 'svg', 'math', 'template', 'noscript',
  'form', 'input', 'button', 'textarea', 'select', 'option', 'link', 'meta', 'base',
  'audio', 'video', 'source', 'track', 'canvas',
])

const GLOBAL_ATTRIBUTES = new Set(['class', 'title', 'aria-label', 'aria-hidden', 'dir', 'lang'])
const TAG_ATTRIBUTES = {
  a: new Set(['href']),
  img: new Set(['src', 'alt', 'width', 'height']),
  span: new Set(['role']),
  ol: new Set(['start', 'reversed']),
  li: new Set(['value']),
  td: new Set(['colspan', 'rowspan']),
  th: new Set(['colspan', 'rowspan', 'scope']),
  details: new Set(['open']),
}

const ALLOWED_CSS_PROPERTIES = new Set([
  'accent-color', 'align-items', 'align-self', 'background', 'background-color',
  'border', 'border-block', 'border-bottom', 'border-color', 'border-inline',
  'border-left', 'border-radius', 'border-right', 'border-style', 'border-top',
  'border-width', 'box-shadow', 'box-sizing', 'color', 'column-gap', 'display',
  'flex', 'flex-basis', 'flex-direction', 'flex-grow', 'flex-shrink', 'flex-wrap',
  'font', 'font-family', 'font-size', 'font-style', 'font-weight', 'gap', 'grid',
  'grid-column', 'grid-row', 'height', 'justify-content', 'letter-spacing',
  'line-height', 'list-style', 'margin', 'margin-block', 'margin-bottom',
  'margin-inline', 'margin-left', 'margin-right', 'margin-top', 'max-height',
  'max-width', 'min-height', 'min-width', 'opacity', 'outline', 'overflow',
  'overflow-wrap', 'padding', 'padding-block', 'padding-bottom', 'padding-inline',
  'padding-left', 'padding-right', 'padding-top', 'row-gap', 'text-align',
  'text-decoration', 'text-overflow', 'text-transform', 'transform',
  'transition', 'vertical-align', 'white-space', 'width', 'word-break',
])

function safeUrl(value, protocols) {
  try {
    const url = new URL(value)
    return protocols.has(url.protocol) ? url.href : null
  } catch {
    return null
  }
}

function customClass(name, preservePluginClasses = false) {
  const clean = name.replace(/[^A-Za-z0-9_-]/g, '')
  if (clean === '') return ''
  if (preservePluginClasses && clean.startsWith('dsh-tr-')) return clean
  if (clean.startsWith('custom-') || clean.startsWith('language-') || clean === 'dsh-tr-expression-error') return clean
  return `custom-${clean}`
}

function rewriteClasses(value, preservePluginClasses = false) {
  return value.split(/\s+/).map(name => customClass(name, preservePluginClasses)).filter(Boolean).join(' ')
}

function rewriteSelectorClasses(selector, preservePluginClasses) {
  return selector.replace(/\.(-?[_A-Za-z][\w-]*)/g, (_match, name) => `.${customClass(name, preservePluginClasses)}`)
}

function sanitizeDeclarations(source) {
  const declarations = []
  for (const chunk of source.split(';')) {
    const colon = chunk.indexOf(':')
    if (colon <= 0) continue
    const property = chunk.slice(0, colon).trim().toLowerCase()
    const value = chunk.slice(colon + 1).trim()
    if (!(ALLOWED_CSS_PROPERTIES.has(property) || /^--[\w-]{1,64}$/.test(property))) continue
    if (value === '' || /url\s*\(|(?:image-set|cross-fade|paint|element|src)\s*\(|expression\s*\(|@import|javascript:|behavior\s*:|-moz-binding|[{}\\]/i.test(value)) continue
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) continue
    declarations.push(`${property}: ${value}`)
  }
  return declarations.join('; ')
}

function sanitizeSelector(selector, scope, preservePluginClasses) {
  const value = selector.trim()
  if (value === '' || value.startsWith('@')) return null
  if (/(^|[\s>+~])(html|body|head|:root)(?=$|[\s>+~.#:[{])/i.test(value)) return null
  if (value.includes('#') || /[^\w\s.*+>~:(),=[\]"'|-]/.test(value)) return null
  const rewritten = rewriteSelectorClasses(value, preservePluginClasses)
  if (rewritten === scope || rewritten.startsWith(`${scope} `) || rewritten.startsWith(`${scope}:`)) return rewritten
  return `${scope} ${rewritten}`
}

/** Sanitize a conservative flat CSS rule subset and scope every selector. */
export function sanitizeCss(input, { scope = '.dsh-tr-message-content', preservePluginClasses = false } = {}) {
  const css = String(input ?? '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/@(import|charset|namespace)[^;{}]*;/gi, '')
  const output = []
  const rulePattern = /([^{}]+)\{([^{}]*)\}/g
  let match
  while ((match = rulePattern.exec(css)) !== null) {
    const declarations = sanitizeDeclarations(match[2])
    if (declarations === '') continue
    const selectors = match[1].split(',').map(selector => sanitizeSelector(selector, scope, preservePluginClasses)).filter(Boolean)
    if (selectors.length > 0) output.push(`${selectors.join(', ')} { ${declarations}; }`)
  }
  return output.join('\n')
}

function sanitizeAttributes(element, tag, preservePluginClasses) {
  for (const attribute of [...element.attributes]) {
    const name = attribute.name.toLowerCase()
    const allowed = GLOBAL_ATTRIBUTES.has(name) || TAG_ATTRIBUTES[tag]?.has(name)
    if (!allowed || name.startsWith('on') || name === 'style' || name === 'id' || name === 'srcset') {
      element.removeAttribute(attribute.name)
    }
  }
  if (element.hasAttribute('class')) {
    const classes = rewriteClasses(element.getAttribute('class') ?? '', preservePluginClasses)
    if (classes === '') element.removeAttribute('class')
    else element.setAttribute('class', classes)
  }
  if (element.hasAttribute('role') && element.getAttribute('role') !== 'status') element.removeAttribute('role')
  if (tag === 'a') {
    const href = safeUrl(element.getAttribute('href') ?? '', new Set(['http:', 'https:', 'mailto:']))
    if (href === null) element.removeAttribute('href')
    else {
      element.setAttribute('href', href)
      element.setAttribute('target', '_blank')
      element.setAttribute('rel', 'noopener noreferrer')
    }
  }
  if (tag === 'img') {
    const src = safeUrl(element.getAttribute('src') ?? '', new Set(['http:', 'https:']))
    if (src === null) {
      element.remove()
      return false
    }
    element.setAttribute('src', src)
    element.setAttribute('loading', 'lazy')
    element.setAttribute('decoding', 'async')
    element.setAttribute('referrerpolicy', 'no-referrer')
  }
  return true
}

function sanitizeElement(element, preservePluginClasses) {
  const tag = element.localName.toLowerCase()
  if (DROP_WITH_CONTENT.has(tag)) {
    element.remove()
    return
  }
  if (!ALLOWED_TAGS.has(tag)) {
    for (const child of [...element.children]) sanitizeElement(child, preservePluginClasses)
    element.replaceWith(...element.childNodes)
    return
  }
  if (tag === 'style') {
    const css = sanitizeCss(element.textContent, { preservePluginClasses })
    if (css === '') element.remove()
    else {
      for (const attribute of [...element.attributes]) element.removeAttribute(attribute.name)
      element.textContent = css
    }
    return
  }
  if (!sanitizeAttributes(element, tag, preservePluginClasses)) return
  for (const child of [...element.children]) sanitizeElement(child, preservePluginClasses)
}

/** Parse and sanitize untrusted message HTML with explicit element/attribute policies. */
export function sanitizeHtml(input, { document: suppliedDocument, preservePluginClasses = false } = {}) {
  const owner = suppliedDocument ?? globalThis.document
  if (owner?.createElement === undefined) throw new Error('sanitizeHtml requires a browser Document')
  const root = owner.createElement('div')
  root.innerHTML = String(input ?? '')
  for (const child of [...root.children]) sanitizeElement(child, preservePluginClasses)
  for (const comment of [...root.childNodes].filter(node => node.nodeType === 8)) comment.remove()
  return root.innerHTML
}
