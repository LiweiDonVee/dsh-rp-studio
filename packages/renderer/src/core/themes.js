import { sanitizeCss } from './sanitize.js'

export const THEMES = Object.freeze(['harness', 'tavern-dark', 'paper'])

const THEME_CSS = `
[data-dsh-tavern-renderer] {
  --dtr-surface: var(--dsw-alias-bg-base, #fff);
  --dtr-surface-raised: var(--dsw-alias-bg-layer-1, #f7f7f8);
  --dtr-text: var(--dsw-alias-label-primary, #17181a);
  --dtr-muted: var(--dsw-alias-label-tertiary, #6a6f78);
  --dtr-border: var(--dsw-alias-divider, #dfe1e5);
  --dtr-accent: #17806d;
  --dtr-quote: #b54747;
  --dtr-code: #f2f3f5;
}
[data-dsh-tavern-theme="tavern-dark"] [data-dsh-tavern-renderer] {
  --dtr-surface: #1f2227;
  --dtr-surface-raised: #292d33;
  --dtr-text: #edf0f2;
  --dtr-muted: #a9b0b8;
  --dtr-border: #454b53;
  --dtr-accent: #67c7ad;
  --dtr-quote: #e39882;
  --dtr-code: #17191d;
}
[data-dsh-tavern-theme="paper"] [data-dsh-tavern-renderer] {
  --dtr-surface: #fbfaf7;
  --dtr-surface-raised: #f0f2ee;
  --dtr-text: #242826;
  --dtr-muted: #626a66;
  --dtr-border: #cdd3cf;
  --dtr-accent: #146b63;
  --dtr-quote: #9f3f48;
  --dtr-code: #e9ece9;
}
`

const THEME_KEY = 'dsh-tavern-renderer.theme'
const CSS_KEY = 'dsh-tavern-renderer.custom-css'

function storageGet(storage, key, fallback) {
  try { return storage?.getItem(key) ?? fallback } catch { return fallback }
}

function storageSet(storage, key, value) {
  try { storage?.setItem(key, value) } catch { /* Browser storage may be disabled. */ }
}

export class ThemeManager {
  constructor(ownerDocument = globalThis.document, storage = globalThis.localStorage) {
    if (ownerDocument?.head === undefined) throw new Error('ThemeManager requires a browser Document')
    this.document = ownerDocument
    this.storage = storage
    this.baseStyle = null
    this.customStyle = null
    this.theme = 'harness'
    this.customCss = ''
  }

  install() {
    if (this.baseStyle !== null) return
    this.baseStyle = this.document.createElement('style')
    this.baseStyle.dataset.dshTavernOwned = 'theme'
    this.baseStyle.textContent = THEME_CSS
    this.customStyle = this.document.createElement('style')
    this.customStyle.dataset.dshTavernOwned = 'custom'
    this.document.head.append(this.baseStyle, this.customStyle)
    const storedTheme = storageGet(this.storage, THEME_KEY, 'harness')
    this.setTheme(THEMES.includes(storedTheme) ? storedTheme : 'harness')
    this.setCustomCss(storageGet(this.storage, CSS_KEY, ''))
  }

  setTheme(name) {
    if (!THEMES.includes(name)) throw new Error(`unknown theme: ${name}`)
    this.theme = name
    this.document.documentElement.dataset.dshTavernTheme = name
    storageSet(this.storage, THEME_KEY, name)
  }

  setCustomCss(css) {
    if (this.customStyle === null) throw new Error('ThemeManager is not installed')
    this.customCss = String(css ?? '')
    this.customStyle.textContent = sanitizeCss(this.customCss, {
      scope: '[data-dsh-tavern-renderer]',
      preservePluginClasses: true,
    })
    storageSet(this.storage, CSS_KEY, this.customCss)
  }

  getCustomStyleElement() {
    return this.customStyle
  }

  dispose() {
    this.baseStyle?.remove()
    this.customStyle?.remove()
    this.baseStyle = null
    this.customStyle = null
    delete this.document.documentElement.dataset.dshTavernTheme
  }
}
