import { escapeHtml } from './markdown.js'

export const DEFAULT_TEMPLATES = Object.freeze({
  system: '<aside class="dsh-tr-message dsh-tr-system" data-role="system"><div class="dsh-tr-message-content">{{content}}</div></aside>',
  user: '<section class="dsh-tr-message dsh-tr-user" data-role="user"><div class="dsh-tr-message-content">{{content}}</div></section>',
  assistant: '<article class="dsh-tr-message dsh-tr-assistant" data-role="assistant"><div class="dsh-tr-message-content">{{content}}</div></article>',
})

export function applyRoleTemplate(content, suppliedRole, context = {}, suppliedTemplates = DEFAULT_TEMPLATES) {
  const role = ['system', 'user', 'assistant'].includes(suppliedRole) ? suppliedRole : 'assistant'
  const templates = { ...DEFAULT_TEMPLATES, ...suppliedTemplates }
  const template = String(templates[role])
  const substitutions = {
    role,
    char: escapeHtml(context.char ?? 'Assistant'),
    user: escapeHtml(context.user ?? 'User'),
  }
  let output = template
  for (const [name, value] of Object.entries(substitutions)) output = output.replaceAll(`{{${name}}}`, value)
  return output.replaceAll('{{content}}', String(content ?? ''))
}
