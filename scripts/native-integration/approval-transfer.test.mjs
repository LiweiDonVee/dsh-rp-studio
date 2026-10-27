import test from 'node:test'
import assert from 'node:assert/strict'
import * as proof from './approval-proof.mjs'

test('fork evidence uses the real inclusive cut and inherited count without rewriting parent source records', () => {
  assert.equal(typeof proof.forkPrefix, 'function')
  const parent = { header: { id: 'parent' }, inheritedEventCount: 0, events: [{ seq: 0, type: 'turn/start' }, { seq: 1, type: 'command/run' }, { seq: 2, type: 'command/done' }, { seq: 3, type: 'tool/result' }] }, child = { header: { id: 'child', parentSession: 'parent' }, inheritedEventCount: 3, events: [{ seq: 0, type: 'turn/start' }, { seq: 1, type: 'command/run' }, { seq: 2, type: 'command/done' }, { seq: 3, type: 'session/end-seed' }] }
  assert.equal(proof.forkPrefix(child, parent, 2).events, 3)
  for (const mutate of [value => value.inheritedEventCount--, value => value.events[2].type = 'run-only', value => value.header.parentSession = 'unrelated', value => value.events[3].type = 'tool/call']) { const changed = structuredClone(child); mutate(changed); assert.throws(() => proof.forkPrefix(changed, parent, 2)) }
  assert.equal(parent.events[2].type, 'command/done')
})
test('restored revise routing requires the exact saved policy, actual route control, resolved config and GM activation', () => {
  assert.equal(typeof proof.restoredReviseRoute, 'function')
  const policy = { enabled: true, routes: { 'rp-gm.revise': { provider: 'studio-native-local', model: 'revise' } } }, loop = { policies: { session: policy }, graph: { nodes: [{ id: 'rp-gm.revise', control: 'route' }] } }, route = { provider: 'studio-native-local', model: 'revise' }, binding = { status: 'active' }
  assert.doesNotThrow(() => proof.restoredReviseRoute(policy, loop, route, binding))
  for (const mutate of [value => value.loop.graph.nodes[0].control = 'gate', value => value.route = null, value => value.route.model = 'gm', value => value.loop.policies.session.routes['rp-gm.revise'].model = 'writer', value => value.binding.status = 'restoring']) { const changed = structuredClone({ loop, route, binding }); mutate(changed); assert.throws(() => proof.restoredReviseRoute(policy, changed.loop, changed.route, changed.binding)) }
})
