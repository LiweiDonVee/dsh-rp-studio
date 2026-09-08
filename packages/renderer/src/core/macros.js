const MACRO_PATTERN = /\{\{([^{}]*)\}\}/g
const VARIABLE_NAME = /^[\w.-]{1,128}$/u

function valueText(value) {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function variableName(raw) {
  const name = String(raw ?? '').trim()
  if (!VARIABLE_NAME.test(name)) throw new Error(`invalid variable name: ${name || '(empty)'}`)
  return name
}

function localDate(context) {
  const value = context.now instanceof Date ? context.now : new Date(context.now ?? Date.now())
  return Number.isNaN(value.getTime()) ? new Date(0) : value
}

/** Case-insensitive macro registry. Resolvers receive context, arguments, and the original token. */
export class MacroRegistry {
  #resolvers = new Map()

  register(name, resolver) {
    const key = String(name).trim().toLowerCase()
    if (!/^[a-z][\w-]{0,63}$/.test(key)) throw new Error(`invalid macro name: ${name}`)
    if (typeof resolver !== 'function') throw new TypeError(`macro ${key} resolver must be a function`)
    if (this.#resolvers.has(key)) throw new Error(`macro already registered: ${key}`)
    this.#resolvers.set(key, resolver)
    return () => this.unregister(key)
  }

  unregister(name) {
    return this.#resolvers.delete(String(name).trim().toLowerCase())
  }

  resolve(name) {
    return this.#resolvers.get(String(name).trim().toLowerCase())
  }

  has(name) {
    return this.#resolvers.has(String(name).trim().toLowerCase())
  }
}

function installBuiltins(registry) {
  const identity = key => ({ context }) => valueText(context[key])
  registry.register('char', identity('char'))
  registry.register('user', identity('user'))
  registry.register('role', identity('role'))
  registry.register('persona', identity('persona'))
  registry.register('description', identity('description'))
  registry.register('scenario', identity('scenario'))
  registry.register('newline', () => '\n')
  registry.register('time', ({ context }) => localDate(context).toLocaleTimeString())
  registry.register('date', ({ context }) => localDate(context).toLocaleDateString())
  registry.register('weekday', ({ context }) => localDate(context).toLocaleDateString(undefined, { weekday: 'long' }))
  registry.register('isotime', ({ context }) => localDate(context).toISOString().slice(11, 19))
  registry.register('isodate', ({ context }) => localDate(context).toISOString().slice(0, 10))
  registry.register('getvar', ({ args, context }) => valueText(context.variables.get(variableName(args[0]))))
  registry.register('setvar', ({ args, context }) => {
    const name = variableName(args[0])
    const value = args.slice(1).join('::')
    context.variables.set(name, value)
    return ''
  })
  registry.register('addvar', ({ args, context }) => {
    const name = variableName(args[0])
    const incoming = args.slice(1).join('::')
    const current = context.variables.get(name) ?? ''
    const left = Number(current)
    const right = Number(incoming)
    const next = current !== '' && incoming !== '' && Number.isFinite(left) && Number.isFinite(right)
      ? left + right
      : `${valueText(current)}${incoming}`
    context.variables.set(name, next)
    return ''
  })
  registry.register('incvar', ({ args, context }) => {
    const name = variableName(args[0])
    const current = Number(context.variables.get(name) ?? 0)
    const amount = args[1] === undefined || args[1] === '' ? 1 : Number(args[1])
    const next = (Number.isFinite(current) ? current : 0) + (Number.isFinite(amount) ? amount : 0)
    context.variables.set(name, next)
    return valueText(next)
  })
}

export class MacroEngine {
  constructor({ registry = new MacroRegistry(), maxPasses = 20, installDefaults = true } = {}) {
    this.registry = registry
    this.maxPasses = maxPasses
    if (installDefaults) installBuiltins(registry)
  }

  registerMacro(name, resolver) {
    return this.registry.register(name, resolver)
  }

  unregisterMacro(name) {
    return this.registry.unregister(name)
  }

  evaluate(input, suppliedContext = {}) {
    const context = {
      char: 'Assistant',
      user: 'User',
      role: 'assistant',
      variables: new Map(),
      ...suppliedContext,
    }
    if (!(context.variables instanceof Map)) context.variables = new Map(Object.entries(context.variables ?? {}))
    let value = String(input ?? '')
    for (let pass = 0; pass < this.maxPasses; pass += 1) {
      let changed = false
      const next = value.replace(MACRO_PATTERN, (token, body) => {
        const [rawName = '', ...args] = String(body).split('::')
        const name = rawName.trim().toLowerCase()
        // Expressions intentionally run in the following pipeline stage.
        if (name === 'js') return token
        const resolver = this.registry.resolve(name)
        if (resolver === undefined) return token
        try {
          const replacement = valueText(resolver({ name, args, context, token, engine: this }))
          if (replacement !== token) changed = true
          return replacement
        } catch {
          return token
        }
      })
      value = next
      if (!changed) return value
    }
    return value
  }
}

export function createMacroEngine(options) {
  return new MacroEngine(options)
}
