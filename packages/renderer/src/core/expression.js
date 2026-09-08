const FORBIDDEN_IDENTIFIERS = new Set([
  'window', 'document', 'globalThis', 'self', 'parent', 'top', 'frames',
  'constructor', 'prototype', '__proto__', 'eval', 'Function', 'fetch',
  'XMLHttpRequest', 'WebSocket', 'import', 'require', 'process', 'new', 'this',
])

const BINDING_POWER = new Map([
  ['??', 1], ['||', 2], ['&&', 3],
  ['==', 4], ['!=', 4], ['===', 4], ['!==', 4],
  ['<', 5], ['<=', 5], ['>', 5], ['>=', 5],
  ['+', 6], ['-', 6], ['*', 7], ['/', 7], ['%', 7],
])

function syntax(message, position) {
  return new SyntaxError(`${message} at ${position}`)
}

class Tokenizer {
  constructor(source, maxTokens) {
    this.source = source
    this.maxTokens = maxTokens
    this.position = 0
    this.count = 0
  }

  next() {
    while (/\s/u.test(this.source[this.position] ?? '')) this.position += 1
    if (++this.count > this.maxTokens) throw syntax('expression token limit exceeded', this.position)
    const start = this.position
    if (start >= this.source.length) return { type: 'eof', value: '', position: start }
    const tail = this.source.slice(start)
    const number = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(tail)
    if (number !== null) {
      this.position += number[0].length
      return { type: 'literal', value: Number(number[0]), position: start }
    }
    const char = this.source[start]
    if (char === '"' || char === "'") return this.readString(char, start)
    const identifier = /^[A-Za-z_$][\w$]*/.exec(tail)
    if (identifier !== null) {
      this.position += identifier[0].length
      return { type: 'identifier', value: identifier[0], position: start }
    }
    for (const operator of ['===', '!==', '??', '||', '&&', '==', '!=', '<=', '>=']) {
      if (tail.startsWith(operator)) {
        this.position += operator.length
        return { type: 'operator', value: operator, position: start }
      }
    }
    if ('()+-*/%!<>?:'.includes(char)) {
      this.position += 1
      return { type: 'operator', value: char, position: start }
    }
    throw syntax(`token ${JSON.stringify(char)} is not allowed`, start)
  }

  readString(quote, start) {
    this.position += 1
    let value = ''
    while (this.position < this.source.length) {
      const char = this.source[this.position++]
      if (char === quote) return { type: 'literal', value, position: start }
      if (char === '\n' || char === '\r') throw syntax('newline in string literal', this.position - 1)
      if (char !== '\\') {
        value += char
        continue
      }
      const escaped = this.source[this.position++]
      const simple = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '\\': '\\', '"': '"', "'": "'" }
      if (escaped in simple) value += simple[escaped]
      else throw syntax(`escape \\${escaped ?? ''} is not allowed`, this.position - 2)
    }
    throw syntax('unterminated string literal', start)
  }
}

class Parser {
  constructor(source, options) {
    this.tokenizer = new Tokenizer(source, options.maxTokens)
    this.maxDepth = options.maxDepth
    this.current = this.tokenizer.next()
  }

  consume(value) {
    if (this.current.value !== value) throw syntax(`expected ${value}`, this.current.position)
    this.current = this.tokenizer.next()
  }

  parse() {
    const expression = this.parseExpression(0, 0)
    if (this.current.type !== 'eof') {
      const suffix = this.current.value === '(' ? 'function calls are not allowed' : `unexpected token ${this.current.value}`
      throw syntax(suffix, this.current.position)
    }
    return expression
  }

  parseExpression(minPower, depth) {
    if (depth > this.maxDepth) throw syntax('expression nesting limit exceeded', this.current.position)
    let left = this.parsePrefix(depth + 1)
    while (this.current.type === 'operator') {
      if (this.current.value === '?' && minPower <= 0) {
        this.consume('?')
        const consequent = this.parseExpression(0, depth + 1)
        this.consume(':')
        const alternate = this.parseExpression(0, depth + 1)
        left = { type: 'conditional', test: left, consequent, alternate }
        continue
      }
      const power = BINDING_POWER.get(this.current.value)
      if (power === undefined || power <= minPower) break
      const operator = this.current.value
      this.current = this.tokenizer.next()
      const right = this.parseExpression(power, depth + 1)
      left = { type: 'binary', operator, left, right }
    }
    return left
  }

  parsePrefix(depth) {
    const token = this.current
    if (token.type === 'literal') {
      this.current = this.tokenizer.next()
      return { type: 'literal', value: token.value }
    }
    if (token.type === 'identifier') {
      this.current = this.tokenizer.next()
      if (token.value === 'true') return { type: 'literal', value: true }
      if (token.value === 'false') return { type: 'literal', value: false }
      if (token.value === 'null') return { type: 'literal', value: null }
      if (token.value === 'undefined') return { type: 'literal', value: undefined }
      if (FORBIDDEN_IDENTIFIERS.has(token.value)) throw syntax(`identifier ${token.value} is not allowed`, token.position)
      return { type: 'identifier', name: token.value, position: token.position }
    }
    if (token.type === 'operator' && ['!', '+', '-'].includes(token.value)) {
      this.current = this.tokenizer.next()
      return { type: 'unary', operator: token.value, argument: this.parseExpression(8, depth + 1) }
    }
    if (token.value === '(') {
      this.consume('(')
      const expression = this.parseExpression(0, depth + 1)
      this.consume(')')
      return expression
    }
    throw syntax(`unexpected token ${token.value || 'end of expression'}`, token.position)
  }
}

function looseEqual(left, right) {
  if (left === right) return true
  if ((left === null && right === undefined) || (left === undefined && right === null)) return true
  if (typeof left === 'boolean') return Number(left) === Number(right)
  if (typeof right === 'boolean') return Number(left) === Number(right)
  if ((typeof left === 'number' && typeof right === 'string') || (typeof left === 'string' && typeof right === 'number')) {
    return Number(left) === Number(right)
  }
  return false
}

function evaluate(node, scope, budget) {
  if (--budget.remaining < 0) throw new Error('expression operation limit exceeded')
  switch (node.type) {
    case 'literal': return node.value
    case 'identifier':
      if (!Object.prototype.hasOwnProperty.call(scope, node.name)) throw syntax(`unknown identifier ${node.name}`, node.position)
      return scope[node.name]
    case 'unary': {
      const value = evaluate(node.argument, scope, budget)
      if (node.operator === '!') return !value
      if (node.operator === '+') return +value
      return -value
    }
    case 'conditional':
      return evaluate(node.test, scope, budget)
        ? evaluate(node.consequent, scope, budget)
        : evaluate(node.alternate, scope, budget)
    case 'binary': {
      const left = evaluate(node.left, scope, budget)
      if (node.operator === '&&') return left && evaluate(node.right, scope, budget)
      if (node.operator === '||') return left || evaluate(node.right, scope, budget)
      if (node.operator === '??') return left ?? evaluate(node.right, scope, budget)
      const right = evaluate(node.right, scope, budget)
      switch (node.operator) {
        case '+': return left + right
        case '-': return left - right
        case '*': return left * right
        case '/': return left / right
        case '%': return left % right
        case '<': return left < right
        case '<=': return left <= right
        case '>': return left > right
        case '>=': return left >= right
        case '===': return left === right
        case '!==': return left !== right
        case '==': return looseEqual(left, right)
        case '!=': return !looseEqual(left, right)
        default: throw new Error(`unsupported operator ${node.operator}`)
      }
    }
    default: throw new Error(`unsupported expression node ${node.type}`)
  }
}

export function safeEvaluateExpression(source, suppliedScope = {}, suppliedOptions = {}) {
  const options = { maxLength: 512, maxTokens: 256, maxDepth: 32, maxOperations: 512, ...suppliedOptions }
  const expression = String(source).trim()
  if (expression.length === 0) return ''
  if (expression.length > options.maxLength) throw new Error('expression length limit exceeded')
  const scope = Object.create(null)
  for (const [name, value] of Object.entries(suppliedScope ?? {})) {
    if (!FORBIDDEN_IDENTIFIERS.has(name) && /^[A-Za-z_$][\w$]*$/.test(name)) scope[name] = value
  }
  const ast = new Parser(expression, options).parse()
  return evaluate(ast, scope, { remaining: options.maxOperations })
}

function expressionText(value) {
  if (value === undefined || value === null) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

export function evaluateInlineExpressions(input, scope = {}, options = {}) {
  return String(input ?? '').replace(/\{\{js::([\s\S]*?)\}\}/gi, (_token, expression) => {
    try {
      return expressionText(safeEvaluateExpression(expression, scope, options))
    } catch {
      return '[expression error]'
    }
  })
}
