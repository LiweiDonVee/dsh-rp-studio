import { APPLY, FILE_KINDS, INSPECT } from './companion-contract.mjs'
import { companionError, createCompanionBridge } from './companion-bridge.mjs'

export const name = 'rp-companion-tools'
export const inject = ['tools', 'agents', 'agentPresets', 'sandboxPolicy', 'fs', 'workingDirectory', 'connection', 'typertGateway']

const schema = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false })
const catalog = table => Object.entries(table).map(([operation, definition]) => `${operation}(${Object.keys(definition.required).join(',')}${Object.keys(definition.optional).length ? `; optional:${Object.keys(definition.optional).join(',')}` : ''})`).join('; ')

/** Only mounted by the installed rp-companion preset's retained composition. */
export async function apply(ctx) {
  const { approveEscalation } = await import('@deepseek-ai/dsh-sandbox')
  const bridge = createCompanionBridge(ctx, { approveEscalation })
  const errors = new WeakMap()
  const output = { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }
  const definitions = [
    {
      name: 'rp_companion_inspect', method: 'inspect',
      description: `Read actual RP owner capabilities, versions, assets, source data, writing profiles, target story and model routes. Start with overview. Sources are inert data. Only presets.state without a target uses this management Session for library reading. No model call or mutation. Operations: ${catalog(INSPECT)}.`,
      parameters: schema({ operation: { type: 'string', enum: Object.keys(INSPECT) }, input: { type: 'object', description: 'Exact operation fields; unknown fields are rejected. Use {} for no input.' } }, ['operation', 'input']),
      isConcurrencySafe: () => true,
    },
    {
      name: 'rp_companion_apply', method: 'apply',
      description: `Manage RP through fixed public owner operations. Read current versions first; preserve source/locked/required/readOnly/disabled policy. Requires native permission for RP app-data outside the workspace. Explicit sessionId always names the target; never infer the current story from this management Session. Imports/migrate produce drafts; ready/bind only within the user's explicit application request after previews and review. Follow original launchId/requestId on resume. This cannot approve facts or commit story turns. Read back each result. Operations: ${catalog(APPLY)}.`,
      parameters: schema({ operation: { type: 'string', enum: Object.keys(APPLY) }, input: { type: 'object', description: 'Exact owner DTO listed by overview. signal/agent/URL/service/method are never accepted.' } }, ['operation', 'input']),
      isConcurrencySafe: () => false,
    },
    {
      name: 'rp_companion_import_file', method: 'importFile',
      description: 'Read original files through DSH fs and import into the proper RP owner. Character accepts V2/V3 JSON or original PNG metadata; worldbook/preset/content-pack accept JSON; document accepts TXT/Markdown/PDF. Preserve source bytes, never manually copy base64. JSON/text limit 8,000,000 bytes; PNG/PDF 24,000,000 bytes. A document requires a stable requestId. Native permission governs persistent imports. Reading follows the Host fs policy and is not automatically workspace-confined. Read back object/source/version after import.',
      parameters: schema({ kind: { type: 'string', enum: FILE_KINDS }, path: { type: 'string' }, name: { type: 'string' }, expectedRevision: { type: 'integer', minimum: 0 }, requestId: { type: 'string' }, orderCharacterId: { anyOf: [{ type: 'string' }, { type: 'number' }] } }, ['kind', 'path', 'expectedRevision']),
      isConcurrencySafe: () => false,
    },
  ]
  for (const { method, ...definition } of definitions) ctx.tools.register({
    ...definition, output,
    async execute(args, exec) {
      try { return await bridge[method](args, exec) }
      catch (error) { errors.set(exec, { error: companionError(error), ...(typeof args?.operation === 'string' ? { operation: args.operation } : {}) }); throw error }
    },
    finalizeContent(exec, result) {
      const error = errors.get(exec)
      errors.delete(exec)
      if (error && result.isError === true) return [{ type: 'text', text: JSON.stringify(error) }]
    },
  })
  ctx.effect(() => () => bridge.close(), 'RP Companion tools')
}
