// Acceptance-only observation and a deterministic local model. Product owners
// are always the installed artifacts; this fixture never supplies their APIs.
import { randomUUID, createHash } from 'node:crypto'

export const name = 'rp-umbrella-native-probe'
export const inject = ['connection', 'typertGateway', 'llm', 'agents', 'tools', 'skills', 'agentPresets', 'sessionPersistence', 'sessionQuery', 'sandboxPolicy', 'pluginManager']
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const textOf = message => typeof message.content === 'string' ? message.content : (message.content ?? []).filter(row => row.type === 'text').map(row => row.text).join('\n')
export const MIXED_FACT_TEXT = '根据玩家实际行动判断NPC反应，先通过已有事实工具确认状态变化。'
export const MIXED_PROSE_TEXT = '以第三人称短段落描写已确认结果，保持克制的动作细节。'

async function* prose(text) {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}
async function* toolCall(name, args) {
  const id = randomUUID(), argumentsText = JSON.stringify(args)
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: argumentsText }
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: argumentsText } }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}

export function apply(ctx) {
  const models = [], queued = [], handles = new Map(), retiredAgents = new Map()
  const adapter = {
    providerInfo: id => ({ id, name: 'RP umbrella local acceptance fixture' }),
    providerRetryPolicy: () => undefined,
    imageRequestPricing: () => undefined,
    imageRequestTarget: (_provider, _model, value) => value,
    listModels: async provider => [{ provider, id: 'umbrella', name: 'Local deterministic acceptance' }],
    resolveModel: async (provider, id) => {
      if (provider !== 'rp-umbrella-local' || id !== 'umbrella') throw new Error('UMBRELLA_UNKNOWN_MODEL')
      return { provider, id, name: 'Local deterministic acceptance' }
    },
    async prepareCall(provider, id) {
      return { model: await this.resolveModel(provider, id), stream: async function* (options) {
        if (models.length >= 128) throw new Error('UMBRELLA_MODEL_BUDGET_EXCEEDED')
        const messages = options.messages ?? [], all = [options.system ?? '', ...messages.map(textOf)].join('\n')
        const migration = all.includes('RP_LAST_STEP_MIGRATE')
        models.push({ time: new Date().toISOString(), provider, model: id, messageCount: messages.length, migration, tools: (options.tools ?? []).map(row => row.name), inputSha256: digest(all), inputBytes: Buffer.byteLength(all) })
        if (migration) {
          const input = JSON.parse(textOf(messages.at(-1)))
          const updates = (input.profile?.entries ?? []).filter(row => row.id === 'writer' && row.enabled !== false && !row.locked).map(row => ({ id: row.id, phase: 'render' }))
          const additions = []
          const mixed = input.profile?.entries?.find(row => row.id === 'mixed' && row.enabled !== false && !row.locked)
          if (mixed) {
            updates.push({ id: 'mixed', phase: 'agent', content: MIXED_FACT_TEXT })
            additions.push({ id: 'mixed-render', name: '从混合模块拆分的正文指令', phase: 'render', role: 'system', content: MIXED_PROSE_TEXT, order: mixed.order + 0.5, enabled: true, required: false, locked: false, source: { entryId: 'mixed', reason: '拆分事实处理与正文表现' } })
          }
          const patch = { updates, additions, report: { summary: 'Synthetic acceptance migration draft. Split simulation and prose responsibilities while retaining original sources and protected modules for human review.', changes: [...updates, ...additions].map(row => ({ entryId: row.id, phase: row.phase, reason: 'Separate synthetic fact resolution and prose responsibilities.' })), blocked: [], diagnostics: [] } }
          models.at(-1).migrationPatch = patch
          yield* prose(JSON.stringify(patch))
        } else if ((options.tools ?? []).some(row => row.name === 'rp_begin_story')) {
          const human = messages.findLastIndex(message => message.role === 'user' && ['user', 'user-rpc'].includes(message.source?.kind))
          const tail = messages.slice(human + 1), names = new Map()
          for (const message of tail) if (message.role === 'assistant') for (const block of Array.isArray(message.content) ? message.content : []) if (block.type === 'tool-call') names.set(block.id, block.name)
          const results = tail.filter(message => message.role === 'tool').map(message => { let value; try { value = JSON.parse(textOf(message)) } catch {} return { name: names.get(message.toolCallId), value, isError: message.isError } })
          if (results.some(row => row.isError)) { yield* prose('合成开局工具返回真实错误；请查看原始回执。'); return }
          if (results.some(row => row.name === 'rp_present')) { yield* prose('合成故事开场已由真实 owner 呈现。'); return }
          const begin = results.find(row => row.name === 'rp_begin_story')
          if (begin) { if (!begin.value?.id) throw new Error('UMBRELLA_OPENING_RECEIPT_MISSING'); yield* toolCall('rp_present', { factReceiptId: begin.value.id }) }
          else yield* toolCall('rp_begin_story', {})
        } else if (queued.length) {
          const next = queued.shift()
          yield* toolCall(next.name, next.arguments)
        } else yield* prose('已完成本次合成管理验收请求。请以真实工具读回结果为准。')
      } }
    },
  }
  ctx.effect(() => ctx.llm.registerAdapter(['rp-umbrella-local'], adapter), 'umbrella local-only model')
  const invoke = (method, request, signal) => ctx.typertGateway.invoke({ namespace: 'session', method, args: { request }, peer: ctx.connection.browserPeer, signal })
  const snapshot = async sessionId => {
    const view = await ctx.sessionQuery.observeSession(sessionId)
    try { return { header: view.header, events: view.events, live: !!ctx.agents.get(sessionId) } }
    finally { view[Symbol.dispose]() }
  }
  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/rp-umbrella-native-probe', methods: ['POST'], requestBody: 'buffered', fetch: async request => {
    try {
      const input = await request.json()
      let result
      if (input.action === 'ready') result = { presets: await ctx.agentPresets.list(), owners: Object.fromEntries(['rpDatabase', 'rpContext', 'rpLastStep', 'rpGM', 'rpStoryKit', 'loopStudio'].map(key => [key, !!ctx.get(key)])), models }
      else if (input.action === 'models') result = { models, queued: queued.length }
      else if (input.action === 'sessions') result = await ctx.sessionPersistence.list()
      else if (input.action === 'snapshot') result = await snapshot(input.sessionId)
      else if (input.action === 'agentContext') result = { sessionId: input.sessionId, text: ctx.get('rpLastStep').agentContext(input.sessionId) }
      else if (input.action === 'companionPluginEntry') result = (await ctx.pluginManager.listPlugins()).filter(row => row.patchId === 'preset-rp-companion')
      else if (input.action === 'setCompanionPreset') {
        const entry = (await ctx.pluginManager.listPlugins()).find(row => row.patchId === 'preset-rp-companion' && row.entryId === input.entryId)
        if (!entry || typeof input.enabled !== 'boolean') throw new Error('UMBRELLA_EXACT_PRESET_ENTRY_REQUIRED')
        result = await ctx.pluginManager.setPluginEnabled(entry.entryId, input.enabled)
      } else if (input.action === 'resolveCompanion') {
        try { result = { available: true, preset: await ctx.agentPresets.resolve('rp-companion') } }
        catch (error) { result = { available: false, error: { code: error.code, message: error.message } } }
      } else if (input.action === 'createCompanionAttempt') {
        try { result = { created: true, value: await invoke('create', { agentPreset: 'rp-companion' }, request.signal) } }
        catch (error) { result = { created: false, error: { code: error.code, message: error.message } } }
      } else if (input.action === 'compositions') result = ctx.agentPresets.inspectCompositions()
      else if (input.action === 'idle') {
        await ctx.agents.get(input.sessionId)?.whenIdle()
        await ctx.sessionPersistence.flush()
        result = await snapshot(input.sessionId)
      } else if (input.action === 'resume') {
        if (!ctx.agents.get(input.sessionId)) {
          const view = await snapshot(input.sessionId), preset = view.header.agentPreset
          if (!['umbrella-story', 'rp-gm', 'rp-companion'].includes(preset)) throw new Error('UMBRELLA_UNEXPECTED_PRESET')
          handles.set(input.sessionId, await ctx.agents.resume({ resumeSessionId: input.sessionId, agentOptions: { provider: 'rp-umbrella-local', model: 'umbrella' }, setup: async scope => { await ctx.agentPresets.mount(scope, preset) }, signal: request.signal }))
        }
        result = { sessionId: input.sessionId, live: !!ctx.agents.get(input.sessionId) }
      } else if (input.action === 'dispose') {
        const agent = ctx.agents.get(input.sessionId), handle = handles.get(input.sessionId)
        if (!handle) throw new Error('UMBRELLA_OWNED_HANDLE_REQUIRED')
        const retired = { agent, callerId: agent.id, callerSessionId: agent.session.id }
        await handle.dispose(); handles.delete(input.sessionId)
        retiredAgents.set(input.sessionId, retired)
        result = { live: !!ctx.agents.get(input.sessionId), remainingTools: ctx.tools.schemas(agent), globalTools: ctx.tools.schemas(), activeScopes: ctx.agents.list().map(value => ({ id: value.id, tools: ctx.tools.schemas(value) })) }
      } else if (input.action === 'retiredTool') {
        const retired = retiredAgents.get(input.sessionId)
        if (!retired || ctx.agents.get(retired.callerId)) throw new Error('UMBRELLA_DISPOSED_AGENT_REQUIRED')
        const signalAbortedBefore = request.signal.aborted
        const outcome = await ctx.tools.execute({ callId: randomUUID(), name: 'rp_companion_apply', arguments: input.arguments, agent: retired.agent, signal: request.signal })
        result = { outcome, callerId: retired.callerId, callerSessionId: retired.callerSessionId, signalAbortedBefore, signalAbortedAfter: request.signal.aborted }
      } else if (input.action === 'catalog') {
        const agent = ctx.agents.get(input.sessionId)
        if (!agent) throw new Error('UMBRELLA_REAL_AGENT_REQUIRED')
        const skills = await ctx.skills.list({ scope: agent, signal: request.signal })
        const bundled = await ctx.skills.get('managing-rp-studio', { scope: agent, signal: request.signal })
        result = { tools: ctx.tools.schemas(agent), skills, managementSkill: bundled ? { name: bundled.name, source: bundled.source, path: bundled.path, resourceBase: bundled.resourceBase, contentBytes: Buffer.byteLength(bundled.content), contentSha256: digest(bundled.content) } : null, sandbox: ctx.sandboxPolicy.resolve({ session: agent.session }) }
      } else if (input.action === 'enqueue') {
        if (queued.length || !['rp_companion_inspect', 'rp_companion_apply', 'rp_companion_import_file'].includes(input.name)) throw new Error('UMBRELLA_INVALID_LOCAL_CALL')
        queued.push({ name: input.name, arguments: input.arguments })
        result = { queued: true }
      } else if (input.action === 'prompt') {
        result = await invoke('prompt', { sessionId: input.sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: input.text ?? '执行已明确授权的本地合成管理验收步骤。' }] }, request.signal)
      } else if (input.action === 'tool') {
        const agent = ctx.agents.get(input.sessionId)
        if (!agent || !['rp_companion_inspect', 'rp_companion_apply', 'rp_companion_import_file'].includes(input.name)) throw new Error('UMBRELLA_INVALID_SCOPED_TOOL')
        result = await ctx.tools.execute({ callId: randomUUID(), name: input.name, arguments: input.arguments, agent, signal: request.signal })
      } else if (input.action === 'flush') { await ctx.sessionPersistence.flush(); result = { flushed: true } }
      else throw new Error('UMBRELLA_UNKNOWN_PROBE_ACTION')
      return Response.json({ ok: true, result })
    } catch (error) {
      console.error('UMBRELLA_NATIVE_PROBE_ERROR', error.stack ?? error)
      return Response.json({ ok: false, error: { code: error.code ?? 'UMBRELLA_PROBE_ERROR', message: error.message } }, { status: 503 })
    }
  } }), 'umbrella authenticated observation route')
}
