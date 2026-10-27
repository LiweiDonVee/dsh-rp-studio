import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import * as proof from './approval-proof.mjs'

test('fork evidence uses the real inclusive cut and inherited count without rewriting parent source records', () => {
  assert.equal(typeof proof.forkPrefix, 'function')
  const events = [{ seq: 0, time: 10, type: 'turn/start', data: { turn: 1 } }, { seq: 1, time: 11, type: 'step/start', data: { turn: 1, step: 1 } }, { seq: 2, time: 12, type: 'step/end', data: { turn: 1, step: 1 } }, { seq: 3, time: 13, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }, { seq: 4, time: 14, type: 'command/run', data: {} }, { seq: 5, time: 15, type: 'command/done', data: {} }, { seq: 6, time: 16, type: 'tool/result', data: {} }]
  const parent = { header: { id: 'parent' }, inheritedEventCount: 0, events }, child = { header: { id: 'child', parentSession: 'parent' }, inheritedEventCount: 6, events: [...structuredClone(events.slice(0, 6)), { seq: 6, time: 15, type: 'session/end-seed', data: { inherited: true } }] }
  assert.equal(proof.forkPrefix(child, parent, 5).events, 6)
  for (const mutate of [value => value.inheritedEventCount--, value => value.events[5].type = 'run-only', value => value.header.parentSession = 'unrelated', value => value.events[6].type = 'tool/call']) { const changed = structuredClone(child); mutate(changed); assert.throws(() => proof.forkPrefix(changed, parent, 5)) }
  assert.equal(parent.events[5].type, 'command/done')
})
test('restored revise routing requires the exact saved policy, actual route control, resolved config and GM activation', () => {
  assert.equal(typeof proof.restoredReviseRoute, 'function')
  const policy = { enabled: true, routes: { 'rp-gm.revise': { provider: 'studio-native-local', model: 'revise' } } }, loop = { policies: { session: policy }, graph: { nodes: [{ id: 'rp-gm.revise', control: 'route' }] } }, route = { provider: 'studio-native-local', model: 'revise' }, binding = { status: 'active' }
  assert.doesNotThrow(() => proof.restoredReviseRoute(policy, loop, route, binding))
  for (const mutate of [value => value.loop.graph.nodes[0].control = 'gate', value => value.route = null, value => value.route.model = 'gm', value => value.loop.policies.session.routes['rp-gm.revise'].model = 'writer', value => value.binding.status = 'restoring']) { const changed = structuredClone({ loop, route, binding }); mutate(changed); assert.throws(() => proof.restoredReviseRoute(policy, changed.loop, changed.route, changed.binding)) }
})
test('observed open-step fork suffix closes only the active parent cut controls, with exact order, data and seq', async () => {
  assert.equal(typeof proof.forkControlSuffix, 'function')
  const actual = JSON.parse(await readFile(new URL('./approval-fork-control.fixture.json', import.meta.url), 'utf8'))
  const prefix = [...actual.controls, actual.cutEvent], suffix = actual.openSuffix
  assert.doesNotThrow(() => proof.forkControlSuffix(prefix, suffix))
  for (const mutate of [
    value => value.suffix[1].data.turn++, value => value.suffix[1].data.step++, value => value.suffix[2].data.turn++, value => value.suffix[2].data.reason.kind = 'completed',
    value => value.suffix.reverse(), value => value.suffix[1].seq++, value => value.suffix.splice(1, 1), value => value.suffix.push(structuredClone(value.suffix[2])),
    value => value.suffix[0].data.inherited = false, value => value.suffix[1].data.extra = 'work', value => value.suffix[1].surfaceOp = 'append', value => value.suffix[1].time = '1793089222895',
    value => value.suffix[2].time = value.prefix.at(-1).time - 1, value => value.suffix[2].time = Infinity, value => value.suffix[0].type = 'request/header',
    value => value.prefix.at(-2).data.turn++, value => value.prefix.splice(5, 0, structuredClone(value.prefix[5])),
  ]) {
    const changed = structuredClone({ prefix, suffix }); mutate(changed)
    assert.throws(() => proof.forkControlSuffix(changed.prefix, changed.suffix))
  }
  for (const type of ['user/message', 'assistant/message', 'tool/call', 'tool/result', 'command/run', 'command/done', 'request/header']) {
    const changed = structuredClone(suffix); changed.splice(1, 0, { seq: 118, time: suffix[0].time, type, data: {} })
    assert.throws(() => proof.forkControlSuffix(prefix, changed))
  }
  // Later parent closes must not retroactively determine the actual cut's open controls.
  assert.throws(() => proof.forkControlSuffix([...prefix, ...actual.laterEnds], suffix))
})
test('observed closed cuts permit exactly their inherited seed and reject invented closures or turn-only ambiguity', async () => {
  assert.equal(typeof proof.forkControlSuffix, 'function')
  const actual = JSON.parse(await readFile(new URL('./approval-fork-control.fixture.json', import.meta.url), 'utf8'))
  const closed = [...actual.controls.filter(row => row.seq <= 106), actual.closedCutEvent]
  assert.doesNotThrow(() => proof.forkControlSuffix(closed, actual.closedSuffix))
  const fabricated = [actual.closedSuffix[0], { type: 'step/end', seq: 108, time: actual.closedSuffix[0].time, data: { turn: 5, step: 1 } }, { type: 'turn/end', seq: 109, time: actual.closedSuffix[0].time, data: { turn: 5, reason: { kind: 'forked' } } }]
  assert.throws(() => proof.forkControlSuffix(closed, fabricated))
  assert.throws(() => proof.forkControlSuffix(closed, []))
  assert.throws(() => proof.forkControlSuffix(closed, [actual.closedSuffix[0], actual.closedSuffix[0]]))
  const turnOnly = [...closed, actual.controls.find(row => row.type === 'turn/start' && row.data.turn === 6)]
  assert.throws(() => proof.forkControlSuffix(turnOnly, [{ type: 'session/end-seed', seq: 110, time: turnOnly.at(-1).time, data: { inherited: true } }]))
})
test('reading a fork preserves its saved full header, exact events and inherited count with no new model work', async () => {
  assert.equal(typeof proof.forkReaderUnchanged, 'function')
  const actual = JSON.parse(await readFile(new URL('./approval-fork-control.fixture.json', import.meta.url), 'utf8')), counts = Object.fromEntries(proof.MODEL_STAGES.map(stage => [stage, 0]))
  const saved = { header: { id: 'child', parentSession: actual.provenance.parentSessionId }, inheritedEventCount: actual.provenance.actualOpenInheritedEventCount, events: actual.openSuffix, models: { counts } }
  assert.doesNotThrow(() => proof.forkReaderUnchanged(saved, structuredClone(saved)))
  for (const mutate of [value => value.header.delegationDepth = 0, value => value.inheritedEventCount++, value => value.events[1].time++, value => value.events.push({ ...actual.openSuffix[0], seq: 120 }), value => value.models.counts.gm++]) {
    const changed = structuredClone(saved); mutate(changed)
    assert.throws(() => proof.forkReaderUnchanged(saved, changed))
  }
})
