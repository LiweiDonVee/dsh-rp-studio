import { evaluateInlineExpressions } from './expression.js'
import { extractDocumentBlocks, restoreDocumentBlocks } from './documents.js'
import { createMacroEngine } from './macros.js'
import { markdownToHtml } from './markdown.js'
import { applyRegexRules, parseRegexRule } from './regex.js'
import { sanitizeHtml } from './sanitize.js'
import { applyRoleTemplate, DEFAULT_TEMPLATES } from './templates.js'

const REQUIRED_ORDER = ['regex', 'macros', 'expressions', 'documents', 'markdown', 'sanitize', 'template']

function variableScope(context) {
  const scope = { ...context }
  delete scope.variables
  for (const [name, value] of context.variables) {
    if (/^[A-Za-z_$][\w$]*$/.test(name)) scope[name] = value
  }
  return scope
}

export class RenderPipeline {
  constructor(stages) {
    this.stages = [...stages]
  }

  register(stage) {
    if (stage === null || typeof stage !== 'object' || typeof stage.name !== 'string' || typeof stage.run !== 'function') {
      throw new TypeError('stage requires name and run')
    }
    if (this.stages.some(item => item.name === stage.name)) throw new Error(`stage already registered: ${stage.name}`)
    let index = this.stages.length
    if (stage.before !== undefined) {
      index = this.stages.findIndex(item => item.name === stage.before)
      if (index === -1) throw new Error(`unknown before stage: ${stage.before}`)
    } else if (stage.after !== undefined) {
      const target = this.stages.findIndex(item => item.name === stage.after)
      if (target === -1) throw new Error(`unknown after stage: ${stage.after}`)
      index = target + 1
    }
    this.stages.splice(index, 0, { enabled: true, ...stage })
    return () => {
      const current = this.stages.findIndex(item => item.name === stage.name)
      if (current !== -1) this.stages.splice(current, 1)
    }
  }

  setEnabled(name, enabled) {
    const stage = this.stages.find(item => item.name === name)
    if (stage === undefined) throw new Error(`unknown stage: ${name}`)
    stage.enabled = Boolean(enabled)
  }

  run(input, state) {
    let value = String(input ?? '')
    const trace = []
    for (const stage of this.stages) {
      if (stage.enabled === false) continue
      try {
        value = String(stage.run(value, state) ?? '')
        trace.push({ name: stage.name })
      } catch (error) {
        trace.push({ name: stage.name, error: error instanceof Error ? error.message : String(error) })
      }
    }
    return { html: value, trace }
  }
}

export class TavernRenderer {
  constructor(suppliedOptions = {}) {
    this.options = {
      char: 'Assistant',
      user: 'User',
      maxInputLength: 1024 * 1024,
      regexRules: [],
      templates: DEFAULT_TEMPLATES,
      expression: {},
      stages: {},
      ...suppliedOptions,
    }
    this.options.templates = { ...DEFAULT_TEMPLATES, ...(suppliedOptions.templates ?? {}) }
    this.options.regexRules = (suppliedOptions.regexRules ?? []).map(parseRegexRule)
    this.variables = suppliedOptions.variables instanceof Map ? suppliedOptions.variables : new Map()
    this.macros = suppliedOptions.macros ?? createMacroEngine()
    this.pipeline = new RenderPipeline([
      {
        name: 'regex',
        run: (value, state) => {
          const result = applyRegexRules(value, this.options.regexRules, state.context, this.macros)
          state.diagnostics.push(...result.diagnostics.map(item => ({ stage: 'regex', ...item })))
          return result.value
        },
      },
      { name: 'macros', run: (value, state) => this.macros.evaluate(value, state.context) },
      { name: 'expressions', run: (value, state) => evaluateInlineExpressions(value, variableScope(state.context), this.options.expression) },
      {
        name: 'documents',
        run: (value, state) => {
          const result = extractDocumentBlocks(value, state.context)
          state.documents = result.slots
          state.diagnostics.push(...result.diagnostics.map(item => ({ stage: 'documents', ...item })))
          return result.value
        },
      },
      { name: 'markdown', run: (value, state) => restoreDocumentBlocks(markdownToHtml(value), state.documents) },
      { name: 'sanitize', run: value => sanitizeHtml(value) },
      {
        name: 'template',
        run: (value, state) => sanitizeHtml(
          applyRoleTemplate(value, state.context.role, state.context, this.options.templates),
          { preservePluginClasses: true },
        ),
      },
    ])
    for (const name of REQUIRED_ORDER) {
      if (this.options.stages[name] === false) this.pipeline.setEnabled(name, false)
    }
  }

  render(input, suppliedContext = {}) {
    const source = String(input ?? '')
    if (source.length > this.options.maxInputLength) throw new Error('message input length limit exceeded')
    const context = {
      char: this.options.char,
      user: this.options.user,
      role: 'assistant',
      variables: this.variables,
      ...suppliedContext,
    }
    if (!(context.variables instanceof Map)) context.variables = new Map(Object.entries(context.variables ?? {}))
    const diagnostics = []
    const result = this.pipeline.run(source.replace(/\r\n?/g, '\n'), {
      context, diagnostics, documents: [], renderer: this,
    })
    return { ...result, diagnostics }
  }

  configure(partial = {}) {
    if (partial.regexRules !== undefined) this.options.regexRules = partial.regexRules.map(parseRegexRule)
    if (partial.templates !== undefined) this.options.templates = { ...this.options.templates, ...partial.templates }
    if (partial.stages !== undefined) {
      for (const [name, enabled] of Object.entries(partial.stages)) this.setStageEnabled(name, enabled)
    }
    this.options = { ...this.options, ...partial, regexRules: this.options.regexRules, templates: this.options.templates }
  }

  registerMacro(name, resolver) { return this.macros.registerMacro(name, resolver) }
  unregisterMacro(name) { return this.macros.unregisterMacro(name) }
  registerStage(stage) { return this.pipeline.register(stage) }
  setStageEnabled(name, enabled) { this.pipeline.setEnabled(name, enabled) }
}

export function createRenderer(options) {
  return new TavernRenderer(options)
}
