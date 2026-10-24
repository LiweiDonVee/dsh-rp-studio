/** Pure, versioned graph and policy kernel. Execution belongs to an adapter. */
export class LoopError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 256
const reject = message => { throw new LoopError('bad-request', message) }

export function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

/** Return a detached policy; only routing fields may enter durable policy data. */
export function validatePolicy(policy) {
  if (!object(policy) || typeof policy.enabled !== 'boolean' || !object(policy.routes)
    || Object.keys(policy).some(key => !['enabled', 'routes'].includes(key))) reject('A policy requires enabled and routes.')
  const routes = {}
  for (const [nodeId, route] of Object.entries(policy.routes)) {
    if (!text(nodeId) || !object(route) || !text(route.provider) || !text(route.model)
      || Object.keys(route).some(key => !['provider', 'model', 'reasoningEffort', 'maxTokens'].includes(key))
      || (route.reasoningEffort !== undefined && !text(route.reasoningEffort))
      || (route.maxTokens !== undefined && (!Number.isSafeInteger(route.maxTokens) || route.maxTokens <= 0))) reject('Invalid model route.')
    Object.defineProperty(routes, nodeId, { value: { provider: route.provider, model: route.model,
      ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
      ...(route.maxTokens === undefined ? {} : { maxTokens: route.maxTokens }),
    }, enumerable: true })
  }
  return { enabled: policy.enabled, routes }
}

/** Session enablement wins; enabled layers merge routes by stable node id. */
export function resolvePolicy(presetPolicy, sessionPolicy) {
  const preset = presetPolicy == null ? null : validatePolicy(presetPolicy)
  const session = sessionPolicy == null ? null : validatePolicy(sessionPolicy)
  const enabled = session?.enabled ?? preset?.enabled ?? false
  return freeze({ enabled, routes: enabled ? { ...(preset?.enabled ? preset.routes : {}), ...session?.routes } : {} })
}

export function buildGraph({ presetId = 'unassigned', supported = false } = {}) {
  const modelControl = supported ? 'route' : 'observe'
  return {
    schemaVersion: 1, id: `loop-studio:${encodeURIComponent(presetId)}:1`,
    nodes: [
      { id: 'host.context', label: '准备上下文', kind: 'program', control: 'observe', source: 'host', description: '每个步骤先装配系统提示词并检查步骤准入。' },
      { id: 'host.first', label: '首个模型请求', kind: 'model', control: modelControl, source: 'host', description: '每个回合的第 1 步。' },
      { id: 'host.tools', label: '执行工具', kind: 'tool', control: 'observe', source: 'host', description: '执行模型请求的工具；参数和原始结果保留在 DSH 中。' },
      { id: 'host.continuation', label: '后续模型请求', kind: 'model', control: modelControl, source: 'host', description: '第 1 步之后的请求；不推断规划或最终答案等语义。' },
      { id: 'host.end', label: '回合结束', kind: 'program', control: 'observe', source: 'host' },
    ],
    edges: [
      { id: 'host.context-first', from: 'host.context', to: 'host.first', label: '第 1 步' },
      { id: 'host.context-continuation', from: 'host.context', to: 'host.continuation', label: '后续步骤' },
      { id: 'host.first-tools', from: 'host.first', to: 'host.tools', label: '工具调用' },
      { id: 'host.tools-context', from: 'host.tools', to: 'host.context', label: '继续循环' },
      { id: 'host.continuation-tools', from: 'host.continuation', to: 'host.tools', label: '工具调用' },
      { id: 'host.first-end', from: 'host.first', to: 'host.end', label: '无待处理工作' },
      { id: 'host.continuation-end', from: 'host.continuation', to: 'host.end', label: '无待处理工作' },
    ],
  }
}

/** Merge declarative participant stages. These edges never schedule execution. */
export function mergeParticipants(graph, participants = []) {
  const result = structuredClone(graph)
  const ids = new Set(result.nodes.map(node => node.id))
  const edgeIds = new Set(result.edges.map(edge => edge.id))
  for (const participant of participants) {
    if (!/^[a-z][a-z0-9-]*$/u.test(participant.id) || participant.id === 'host' || !Array.isArray(participant.nodes)) reject('Invalid participant.')
    const qualify = id => id.startsWith('host.') || id.startsWith(`${participant.id}.`) ? id : `${participant.id}.${id}`
    for (const node of participant.nodes) {
      if (!text(node.id) || !text(node.label) || !['model', 'tool', 'program'].includes(node.kind)
        || !['route', 'observe'].includes(node.control) || (node.control === 'route' && node.kind !== 'model')) reject('Invalid participant stage.')
      const id = qualify(node.id)
      if (id.startsWith('host.') || ids.has(id)) reject('Duplicate or reserved stage id.')
      ids.add(id)
      result.nodes.push({ id, label: node.label, kind: node.kind, control: node.control, source: participant.id,
        ...(typeof node.description === 'string' ? { description: node.description } : {}),
      })
    }
    for (const edge of participant.edges ?? []) {
      if (!text(edge.id) || !text(edge.from) || !text(edge.to)) reject('Invalid participant edge.')
      const id = `${participant.id}.${edge.id}`
      const from = qualify(edge.from)
      const to = qualify(edge.to)
      if (edgeIds.has(id) || !ids.has(from) || !ids.has(to)) reject('Duplicate edge or unknown stage.')
      edgeIds.add(id)
      result.edges.push({ id, from, to, ...(typeof edge.label === 'string' ? { label: edge.label } : {}) })
    }
  }
  return result
}

export const modelNodeId = step => step > 1 ? 'host.continuation' : 'host.first'

/** Whitelist reported usage counters; never copy an adapter's opaque payload. */
export function tokenMetadata(usage) {
  if (!object(usage)) return undefined
  const tokens = {}
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) {
    if (Number.isFinite(usage[key]) && usage[key] >= 0) tokens[key] = usage[key]
  }
  return Object.keys(tokens).length ? tokens : undefined
}

/** Project a durable host event to metadata, discarding prompt, stream and tool bodies. */
export function projectTraceEvent(event, context) {
  const data = event.data ?? {}
  const turn = data.turn ?? context.turn
  const step = data.step ?? context.step
  const base = {
    id: `${context.sessionId}:${event.seq}`, type: event.type, nodeId: modelNodeId(step),
    sessionId: context.sessionId, graphId: context.graphId, graphSchemaVersion: 1,
    timestamp: event.time,
    ...(turn === undefined ? {} : { turn }), ...(step === undefined ? {} : { step }),
    ...(Number.isSafeInteger(event.seq) ? { seq: event.seq } : {}),
  }
  switch (event.type) {
    case 'turn/start': return { ...base, nodeId: 'host.context', status: 'running' }
    case 'turn/end': return { ...base, nodeId: 'host.end', status: data.reason?.kind === 'error' ? 'failed' : 'completed' }
    case 'step/start': return { ...base, status: 'preparing' }
    case 'step/end': return { ...base, status: 'completed' }
    case 'request/header': {
      const config = data.header?.config ?? {}
      return { ...base, status: 'prepared', ...(typeof config.provider === 'string' ? { provider: config.provider } : {}), ...(typeof config.model === 'string' ? { model: config.model } : {}) }
    }
    case 'assistant/message': {
      const source = data.message?.source ?? {}
      const tokens = tokenMetadata(data.usage)
      return { ...base, status: data.interrupted ? 'interrupted' : 'completed',
        ...(typeof source.provider === 'string' ? { provider: source.provider } : {}),
        ...(typeof source.model === 'string' ? { model: source.model } : {}),
        ...(tokens ? { tokens } : {}),
      }
    }
    case 'assistant/attempt': return { ...base, status: 'settled' }
    case 'tool/call': return { ...base, nodeId: 'host.tools', ...(typeof data.name === 'string' ? { toolName: data.name } : {}), status: 'running' }
    case 'tool/result': return { ...base, nodeId: 'host.tools', ...(context.toolName ? { toolName: context.toolName } : {}), status: data.message?.isError ? 'failed' : 'completed' }
    default: return null
  }
}
