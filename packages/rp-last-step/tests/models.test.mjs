import assert from 'node:assert/strict';
import test from 'node:test';
import { createModelCaller, resolveModelConfig } from '../src/models.mjs';

function runtime(chunks, inspect = () => {}) {
  return { llm: { async prepareCall(config, signal) {
    inspect('prepare', { config, signal });
    return { config: { ...config, maxTokens: config.maxTokens ?? 50 }, async *stream(options) {
      inspect('stream', options);
      for (const chunk of chunks) yield chunk;
    } };
  } } };
}
const options = { sessionId: 'story', stageId: 'rp-last-step.render', config: { provider: 'local', model: 'writer' }, system: 'Write public prose', input: { playerAction: 'Wait' } };

test('model overrides clear effort belonging to another route and discard unrelated controls', () => {
  const base = { provider: 'local', model: 'one', reasoningEffort: 'high', maxTokens: 20, tools: ['bad'], secret: 'private' };
  assert.deepEqual(resolveModelConfig(base, { model: 'two' }), { provider: 'local', model: 'two', maxTokens: 20 });
  assert.deepEqual(resolveModelConfig(base, { provider: 'cloud', reasoningEffort: 'low' }), { provider: 'cloud', model: 'one', reasoningEffort: 'low', maxTokens: 20 });
  assert.equal(Object.isFrozen(resolveModelConfig(base)), true);
  assert.throws(() => resolveModelConfig({}, {}), { code: 'INVALID_MODEL_CONFIG' });
  assert.throws(() => resolveModelConfig(base, { maxTokens: 0 }), { code: 'INVALID_MODEL_CONFIG' });
});

test('public SDK calls use only the selected model and isolated system plus one JSON user input', async () => {
  let request;
  const call = createModelCaller(runtime([
    { type: 'reasoning-delta', index: 0, text: 'PRIVATE REASONING' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'PRIVATE REASONING' } },
    { type: 'text-delta', index: 1, text: 'Rain ' },
    { type: 'text-delta', index: 1, text: 'falls.' },
    { type: 'block-end', index: 1, block: { type: 'text', text: 'Rain falls.' } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 4, private: 'do not copy' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ], (phase, value) => { if (phase === 'stream') request = value; }));
  const deltas = [];
  const result = await call({ ...options, onText: (value) => deltas.push(value) });
  assert.equal(result.text, 'Rain falls.');
  assert.equal(deltas.join(''), 'Rain falls.');
  assert.deepEqual(request, { provider: 'local', model: 'writer', maxTokens: 50, system: 'Write public prose', messages: [{ role: 'user', content: [{ type: 'text', text: '{"playerAction":"Wait"}' }] }], signal: undefined });
  assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 4 });
  assert.deepEqual(result.config, { provider: 'local', model: 'writer', maxTokens: 50 });
});

test('block-end-only text and suffixes count once and max-token finish remains explicit', async () => {
  const deltas = [];
  const call = createModelCaller(runtime([
    { type: 'block-end', index: 0, block: { type: 'text', text: 'A' } },
    { type: 'text-delta', index: 1, text: 'B' },
    { type: 'block-end', index: 1, block: { type: 'text', text: 'BC' } },
    { type: 'text-delta', index: 1, text: 'ignored straggler' },
    { type: 'finish', reason: { kind: 'max-tokens' } },
  ]));
  const result = await call({ ...options, onText: (text) => deltas.push(text) });
  assert.equal(result.text, 'ABC');
  assert.equal(deltas.join(''), 'ABC');
  assert.deepEqual(result.finish, { kind: 'max-tokens' });
});

test('provider failures and unexpected tools expose only a safe error', async () => {
  for (const chunks of [
    [{ type: 'tool-call-delta', index: 0, id: 'x', name: 'world_write', argumentsDelta: '{"secret":1}' }],
    [{ type: 'block-end', index: 0, block: { type: 'tool-call', id: 'x', name: 'world_write', arguments: 'SECRET' } }],
    [{ type: 'finish', reason: { kind: 'error', failure: { message: 'SECRET TOKEN' } } }],
    [{ type: 'text-delta', index: 0, text: 'incomplete' }],
  ]) {
    await assert.rejects(createModelCaller(runtime(chunks))(options), (error) => {
      assert.match(error.code, /MODEL_/u);
      assert.doesNotMatch(error.message, /SECRET|world_write/u);
      return true;
    });
  }
  const call = createModelCaller({ llm: { prepareCall() { throw new Error('SECRET URL KEY'); } } });
  await assert.rejects(call(options), (error) => error.code === 'MODEL_CALL_FAILED' && !error.message.includes('SECRET'));
});

test('abort is honored before dispatch and during streamed output', async () => {
  const first = new AbortController();
  first.abort();
  let prepared = false;
  await assert.rejects(createModelCaller(runtime([], () => { prepared = true; }))({ ...options, signal: first.signal }), { name: 'AbortError' });
  assert.equal(prepared, false);
  const second = new AbortController();
  const deltas = [];
  const call = createModelCaller(runtime([
    { type: 'text-delta', index: 0, text: 'A' }, { type: 'text-delta', index: 0, text: 'B' },
    { type: 'finish', reason: { kind: 'stop' } },
  ]));
  await assert.rejects(call({ ...options, signal: second.signal, onText(value) { deltas.push(value); second.abort(); } }), { name: 'AbortError' });
  assert.deepEqual(deltas, ['A']);
});

test('a stream cannot relabel a separate reasoning block as public text', async () => {
  for (const ending of [
    { type: 'text-delta', index: 0, text: 'SECRET REASONING' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'SECRET REASONING' } },
  ]) {
    const deltas = [];
    const call = createModelCaller(runtime([
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'SECRET REASONING' },
      ending,
      { type: 'finish', reason: { kind: 'stop' } },
    ]));
    await assert.rejects(call({ ...options, onText: (value) => deltas.push(value) }), { code: 'MODEL_STREAM_INVALID' });
    assert.deepEqual(deltas, []);
  }
});
