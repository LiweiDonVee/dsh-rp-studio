const VALID_FLAGS = /^[dgimsuvy]*$/

function findDelimiter(source, start) {
  let escaped = false
  for (let index = start; index < source.length; index += 1) {
    const char = source[index]
    if (char === '/' && !escaped) return index
    if (char === '\\') escaped = !escaped
    else escaped = false
  }
  return -1
}

function validatePattern(pattern) {
  if (pattern.length > 1024) throw new Error('regex pattern exceeds 1024 characters')
  // Reject the most common catastrophic shape while treating regex rules as trusted configuration.
  if (/\([^)]*[+*][^)]*\)\s*(?:[+*]|\{\d)/.test(pattern)) {
    throw new Error('regex contains a nested quantified group')
  }
}

function validateFlags(flags) {
  if (!VALID_FLAGS.test(flags)) throw new Error(`invalid regex flags: ${flags}`)
  if (new Set(flags).size !== flags.length) throw new Error(`duplicate regex flags: ${flags}`)
}

function parseFindRegex(source) {
  const value = String(source)
  if (!value.startsWith('/')) return { pattern: value, flags: 'g' }
  const end = findDelimiter(value, 1)
  if (end === -1) throw new Error('unterminated findRegex literal')
  const flags = value.slice(end + 1)
  validateFlags(flags)
  return { pattern: value.slice(1, end), flags }
}

/** Parse `/pattern/replacement/flags` or normalize an ST-shaped rule object. */
export function parseRegexRule(input) {
  if (typeof input === 'object' && input !== null) {
    const find = parseFindRegex(input.findRegex ?? input.pattern ?? '')
    validatePattern(find.pattern)
    const flags = String(input.flags ?? find.flags)
    validateFlags(flags)
    return {
      pattern: find.pattern,
      flags,
      replacement: String(input.replaceString ?? input.replacement ?? ''),
      enabled: input.enabled ?? !input.disabled,
      roles: input.roles === undefined ? undefined : [...input.roles],
      trimStrings: Array.isArray(input.trimStrings) ? input.trimStrings.map(String) : [],
      name: String(input.name ?? input.scriptName ?? ''),
    }
  }
  const source = String(input)
  if (!source.startsWith('/')) throw new Error('compact regex rule must start with /')
  const patternEnd = findDelimiter(source, 1)
  if (patternEnd === -1) throw new Error('compact regex rule is missing the pattern delimiter')
  const replacementEnd = findDelimiter(source, patternEnd + 1)
  if (replacementEnd === -1) throw new Error('compact regex rule is missing the replacement delimiter')
  const pattern = source.slice(1, patternEnd)
  const replacement = source.slice(patternEnd + 1, replacementEnd).replace(/\\\//g, '/')
  const flags = source.slice(replacementEnd + 1)
  validatePattern(pattern)
  validateFlags(flags)
  return { pattern, replacement, flags, enabled: true, trimStrings: [], name: '' }
}

function trimCapture(value, trimStrings) {
  let result = value ?? ''
  for (const trim of trimStrings) result = result.split(trim).join('')
  return result
}

function interpolateReplacement(template, match, captures, groups, before, after, trimStrings) {
  const source = template.replace(/\{\{match\}\}/gi, '$&')
  return source.replace(/\$(\$|&|`|'|<([A-Za-z_$][\w$]*)>|(\d{1,2}))/g, (token, kind, groupName, digits) => {
    if (kind === '$') return '$'
    if (kind === '&') return trimCapture(match, trimStrings)
    if (kind === '`') return before
    if (kind === "'") return after
    if (groupName !== undefined) return trimCapture(groups?.[groupName], trimStrings)
    const index = Number(digits)
    if (index > 0 && index <= captures.length) return trimCapture(captures[index - 1], trimStrings)
    if (digits.length === 2) {
      const first = Number(digits[0])
      if (first > 0 && first <= captures.length) return `${trimCapture(captures[first - 1], trimStrings)}${digits[1]}`
    }
    return token
  })
}

function normalizedRule(rule) {
  return typeof rule === 'string' || !('pattern' in rule) ? parseRegexRule(rule) : rule
}

export function applyRegexRules(input, rules, context, macroEngine) {
  let value = String(input ?? '')
  const diagnostics = []
  for (let index = 0; index < (rules ?? []).length; index += 1) {
    try {
      const rule = normalizedRule(rules[index])
      if (rule.enabled === false) continue
      if (Array.isArray(rule.roles) && !rule.roles.includes(context.role)) continue
      const regex = new RegExp(rule.pattern, rule.flags)
      value = value.replace(regex, (...args) => {
        const match = args[0]
        const maybeGroups = args.at(-1)
        const hasGroups = typeof maybeGroups === 'object' && maybeGroups !== null
        const source = args.at(hasGroups ? -2 : -1)
        const offset = args.at(hasGroups ? -3 : -2)
        const captures = args.slice(1, hasGroups ? -3 : -2)
        const replacement = interpolateReplacement(
          rule.replacement,
          match,
          captures,
          hasGroups ? maybeGroups : undefined,
          source.slice(0, offset),
          source.slice(offset + match.length),
          rule.trimStrings ?? [],
        )
        return macroEngine === undefined ? replacement : macroEngine.evaluate(replacement, context)
      })
    } catch (error) {
      diagnostics.push({ index, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return { value, diagnostics }
}
