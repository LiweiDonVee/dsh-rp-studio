import test from 'node:test'
import assert from 'node:assert/strict'
import { buildGraph, mergeParticipants, resolvePolicy, validatePolicy, projectTraceEvent } from '../src/core.mjs'

const first = { provider: 'cloud', model: 'fast' }
const continuation = { provider: 'local', model: 'quality', maxTokens: 1024 }

test('an explicitly disabled session overrides an enabled preset', () => {
  assert.deepEqual(resolvePolicy({ enabled: true, routes: { 'host.first': first } }, { enabled: false, routes: {} }), { enabled: false, routes: {} })
})

test('session routes override matching preset nodes and inherit other nodes', () => {
  const preset = { enabled: true, routes: { 'host.first': first, 'host.continuation': continuation } }
  const session = { enabled: true, routes: { 'host.first': { provider: 'cloud', model: 'large' } } }
  assert.deepEqual(resolvePolicy(preset, session), { enabled: true, routes: { 'host.first': { provider: 'cloud', model: 'large' }, 'host.continuation': continuation } })
  assert.deepEqual(resolvePolicy(null, null), { enabled: false, routes: {} })
})

test('policy snapshots cannot be changed through their input records', () => {
  const policy = { enabled: true, routes: { 'host.first': { ...first } } }
  const effective = resolvePolicy(null, policy)
  policy.routes['host.first'].model = 'changed'
  assert.equal(effective.routes['host.first'].model, 'fast')
  assert.throws(() => { effective.routes['host.first'].model = 'also-changed' }, TypeError)
})

test('policies reject malformed output caps and non-route payloads', () => {
  assert.throws(() => validatePolicy({ enabled: true, routes: { 'host.first': { ...first, maxTokens: 0 } } }), { code: 'bad-request' })
  assert.throws(() => validatePolicy({ enabled: true, routes: { 'host.first': { ...first, prompt: 'private' } } }), { code: 'bad-request' })
  assert.throws(() => validatePolicy({ enabled: 'yes', routes: {} }), { code: 'bad-request' })
})

test('host graph has stable first and continuation nodes with a real tool loop', () => {
  const graph = buildGraph({ presetId: 'standard', supported: true })
  const again = buildGraph({ presetId: 'standard', supported: true })
  assert.deepEqual(graph, again)
  assert.equal(graph.schemaVersion, 1)
  assert.equal(graph.nodes.find(node => node.id === 'host.first').control, 'route')
  assert.equal(graph.nodes.find(node => node.id === 'host.continuation').control, 'route')
  assert.equal(graph.nodes.find(node => node.id === 'host.tools').control, 'observe')
  assert.ok(graph.edges.some(edge => edge.from === 'host.tools' && edge.to === 'host.context'))
  assert.ok(graph.edges.some(edge => edge.from === 'host.context' && edge.to === 'host.continuation'))
  assert.ok(graph.edges.some(edge => edge.from === 'host.continuation' && edge.to === 'host.tools'))
  assert.equal(new Set(graph.edges.map(edge => edge.id)).size, graph.edges.length)
})

test('unknown drivers keep host model nodes read-only', () => {
  assert.ok(buildGraph({ presetId: 'custom', supported: false }).nodes.every(node => node.control === 'observe'))
})

test('participant graph stages are namespaced and cannot replace host nodes', () => {
  const graph = mergeParticipants(buildGraph({ presetId: 'standard', supported: true }), [{
    id: 'example', nodes: [{ id: 'review', label: 'Review', kind: 'model', control: 'route' }],
    edges: [{ id: 'review-end', from: 'review', to: 'host.end' }],
  }])
  assert.equal(graph.nodes.find(node => node.id === 'example.review').source, 'example')
  assert.ok(graph.edges.some(edge => edge.from === 'example.review' && edge.to === 'host.end'))
  assert.throws(() => mergeParticipants(graph, [{ id: 'example', nodes: [{ id: 'review', label: 'Duplicate', kind: 'model', control: 'route' }] }]), { code: 'bad-request' })
})

test('replay emits only reported model and tool metadata', () => {
  const context = { sessionId: 'one', graphId: 'graph', turn: 2, step: 3 }
  const model = projectTraceEvent({ seq: 8, time: 100, type: 'assistant/message', data: {
    turn: 2, step: 3, message: { source: { provider: 'local', model: 'quality' }, content: [{ type: 'reasoning', text: 'secret' }] },
    stream: [{ text: 'secret' }], usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17, hidden: 'secret' },
  } }, context)
  assert.equal(model.nodeId, 'host.continuation')
  assert.equal(model.provider, 'local')
  assert.deepEqual(model.tokens, { inputTokens: 12, outputTokens: 5, totalTokens: 17 })
  assert.equal(JSON.stringify(model).includes('secret'), false)
  const tool = projectTraceEvent({ seq: 9, time: 110, type: 'tool/call', data: { turn: 2, step: 3, name: 'search', arguments: 'private arguments' } }, context)
  assert.equal(tool.toolName, 'search')
  assert.equal(JSON.stringify(tool).includes('arguments'), false)
  assert.equal(projectTraceEvent({ seq: 10, time: 120, type: 'system/message', data: { message: 'private prompt' } }, context), null)
})
