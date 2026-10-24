import assert from 'node:assert/strict';
import test from 'node:test';
import * as module from '../src/agent.mjs';

function fixture() {
  const calls = [];
  const tools = new Map();
  const globalTools = new Map();
  const codeTools = new Map();
  const contexts = new Map();
  const toolProviders = new Set();
  const listeners = new Map();
  const bound = new Set(['story']);
  const ptc = new Set(['code']);
  const service = {
    isEnabled: (id) => bound.has(id),
    hasBinding: (id) => bound.has(id),
    bindingMarker: (id) => bound.has(id) ? JSON.stringify({ contract: 'rp-last-step/v1', enabled: true, profileId: 'preset', version: 2 }) : '',
    agentContext: (id) => bound.has(id) ? 'AGENT ONLY RULES' : '',
    catalog: async (input) => { calls.push(['catalog', input]); return { revision: 7, profileId: 'preset', version: 2, entries: [] }; },
    read: async (input) => { calls.push(['read', input]); return { revision: 7, entries: [{ id: 'style', content: 'Public style' }] }; },
    patch: async (input) => { calls.push(['patch', input]); return { revision: 8, overlay: { entries: {}, additions: [] } }; },
    present: async (input) => { calls.push(['present', input]); return { id: '00000000-0000-4000-8000-000000000001', status: 'rendered', text: 'The gate stays shut.' }; },
  };
  let current;
  const ctx = {
    tools: {
      register: (tool) => { globalTools.set(tool.name, tool); return () => globalTools.delete(tool.name); },
      get: (name, agent) => name === 'run_code' && ptc.has(agent?.session?.id) ? { name: 'run_code' } : (agent?.session?.id === 'story' ? tools.get(name) : codeTools.get(name)) ?? globalTools.get(name),
    },
    systemPrompt: {
      context: (entry) => { contexts.set(entry.name, entry); return () => contexts.delete(entry.name); },
      tools: (provider) => { toolProviders.add(provider); return () => toolProviders.delete(provider); },
    },
    agents: { currentInitiator: () => current },
    on: (name, listener) => { listeners.set(name, listener); return () => listeners.delete(name); },
  };
  const agent = { id: 'story', ctx: { tools: { register: (tool) => { tools.set(tool.name, tool); return () => tools.delete(tool.name); } } }, session: { id: 'story', deriveMessages: () => [{ id: 'assistant-1', role: 'assistant', content: [{ type: 'tool-call', id: 'call-1', name: 'rp_present', arguments: '{}' }] }] } };
  const codeAgent = { id: 'code', ctx: { tools: { register: (tool) => { codeTools.set(tool.name, tool); return () => codeTools.delete(tool.name); } } }, session: { id: 'code' } };
  const agents = new Map([['story', agent], ['code', codeAgent]]);
  ctx.agents.list = () => [...agents.values()];
  ctx.agents.get = (id) => agents.get(id);
  let concluded = 0;
  const exec = { agent, callId: 'call-1', rootCallId: 'call-1', signal: new AbortController().signal, concludeTurn: () => concluded++ };
  return { ctx, service, calls, tools, globalTools, codeTools, contexts, toolProviders, listeners, bound, ptc, agent, codeAgent, exec, concluded: () => concluded, current: (value) => { current = value; } };
}

test('installs tools only in a ready bound native agent scope and leaves unbound PTC catalogs clear', async () => {
  assert.equal(typeof module.registerRpLastStepAgent, 'function');
  const f = fixture();
  const dispose = module.registerRpLastStepAgent(f.ctx, f.service);
  assert.equal(f.globalTools.size, 0);
  assert.equal(f.codeTools.size, 0);
  assert.deepEqual([...f.tools.keys()], ['rp_last_step_catalog', 'rp_last_step_read', 'rp_last_step_patch', 'rp_present']);
  f.current(f.agent);
  assert.deepEqual(JSON.parse(f.contexts.get('rp-last-step-binding').text({})), { contract: 'rp-last-step/v1', enabled: true, profileId: 'preset', version: 2 });
  assert.equal(f.contexts.get('rp-last-step-binding').required, true);
  assert.equal(f.contexts.get('rp-last-step-binding').interpolate, false);
  assert.equal(f.contexts.get('rp-last-step-agent').text({}), 'AGENT ONLY RULES');
  const result = { sections: [], contexts: [], variables: {}, tools: [{ name: 'lookup' }, ...[...f.tools.keys()].map((name) => ({ name }))] };
  const filter = f.listeners.get('system-prompt/assemble');
  assert.equal((await filter(result, {}, async () => result)).tools.length, 5);
  f.current({ id: 'code', session: { id: 'code' } });
  assert.deepEqual((await filter(result, {}, async () => result)).tools, [{ name: 'lookup' }]);
  assert.equal(f.contexts.get('rp-last-step-binding').text({}), '');
  assert.equal(f.contexts.get('rp-last-step-agent').text({}), '');
  assert.equal(f.contexts.get('rp-last-step-workflow').text({}), '');
  dispose();
  assert.equal(f.tools.size + f.contexts.size + f.listeners.size, 0);
});

test('only the calling session can catalog, read and patch its current overlay', async () => {
  const f = fixture();
  module.registerRpLastStepAgent(f.ctx, f.service);
  await f.tools.get('rp_last_step_catalog').execute({}, f.exec);
  await f.tools.get('rp_last_step_read').execute({ entryIds: ['style'] }, f.exec);
  await f.tools.get('rp_last_step_patch').execute({ expectedRevision: 7, operations: [{ op: 'disable', entryId: 'style' }] }, f.exec);
  assert.deepEqual(f.calls.map(([name, input]) => [name, input.sessionId]), [['catalog', 'story'], ['read', 'story'], ['patch', 'story']]);
  assert.equal(f.calls.at(-1)[1].expectedRevision, 7);
  assert.equal(f.tools.get('rp_last_step_patch').isConcurrencySafe, undefined);
  for (const args of [{ sessionId: 'other' }, { profileId: 'another' }]) await assert.rejects(f.tools.get('rp_last_step_catalog').execute(args, f.exec), { code: 'INVALID_TOOL_ARGUMENTS' });
  await assert.rejects(f.tools.get('rp_last_step_read').execute({ entryIds: 'all' }, f.exec), { code: 'INVALID_TOOL_ARGUMENTS' });
  await assert.rejects(f.tools.get('rp_last_step_patch').execute({ operations: [] }, f.exec), { code: 'EXPECTED_REVISION_REQUIRED' });
  await assert.rejects(f.tools.get('rp_last_step_catalog').execute({}, { ...f.exec, agent: undefined }), { code: 'AGENT_REQUIRED' });
  f.bound.clear();
  await assert.rejects(f.tools.get('rp_last_step_catalog').execute({}, f.exec), { code: 'BINDING_NOT_FOUND' });
});

test('an accepted assembly cannot expose one agent binding outside its initiator', async () => {
  const f = fixture();
  module.registerRpLastStepAgent(f.ctx, f.service);
  f.current(f.agent);
  const context = { agent: f.agent, scope: f.agent };
  for (const provider of f.toolProviders) provider(context);
  assert.notEqual(f.contexts.get('rp-last-step-binding').text(context), '');
  f.current({ id: 'code', session: { id: 'code' } });
  assert.equal(f.contexts.get('rp-last-step-binding').text(context), '');
  assert.equal(f.contexts.get('rp-last-step-agent').text(context), '');
  const assembly = { sections: [], contexts: [], variables: {}, tools: [{ name: 'lookup' }, { name: 'rp_present' }] };
  assert.deepEqual((await f.listeners.get('system-prompt/assemble')(assembly, context, async () => assembly)).tools, [{ name: 'lookup' }]);
});

test('rp_present accepts only one direct call in the latest assistant message and concludes after success', async () => {
  const f = fixture();
  module.registerRpLastStepAgent(f.ctx, f.service);
  const tool = f.tools.get('rp_present');
  const packet = { playerAction: 'Try the gate', resolvedChanges: ['The attempt failed.'] };
  const result = await tool.execute({ packet }, f.exec);
  assert.equal(f.concluded(), 1);
  assert.equal(f.calls[0][1].contextKey, '["story","assistant-1","call-1"]');
  assert.deepEqual(f.calls[0][1].packet, packet);
  assert.deepEqual(tool.output.render({}, result), [{ type: 'text', text: 'The gate stays shut.' }]);
  assert.deepEqual(tool.output.presentationMeta({}, result), { rpLastStep: { schemaVersion: 1, record: { ...result, status: 'complete' } } });
  const invalidExecutions = [
    { ...f.exec, rootCallId: 'outer' },
    { ...f.exec, parent: Symbol('nested') },
  ];
  for (const exec of invalidExecutions) await assert.rejects(tool.execute({ packet }, exec), { code: 'PRESENTATION_NOT_TERMINAL' });
  for (const content of [
    [{ type: 'tool-call', id: 'call-1', name: 'rp_present' }, { type: 'tool-call', id: 'lookup', name: 'lookup' }],
    [{ type: 'tool-call', id: 'other', name: 'rp_present' }],
    [{ type: 'tool-call', id: 'call-1', name: 'lookup' }],
    [],
  ]) {
    f.agent.session.deriveMessages = () => [{ id: 'assistant-1', role: 'assistant', content }];
    await assert.rejects(tool.execute({ packet }, f.exec), { code: 'PRESENTATION_NOT_TERMINAL' });
  }
  assert.equal(f.calls.length, 1);
  assert.equal(f.concluded(), 1);
});

test('presenter failure or cancellation cannot conclude the main turn', async () => {
  const f = fixture();
  module.registerRpLastStepAgent(f.ctx, f.service);
  f.service.present = async () => { throw new Error('writer failed'); };
  await assert.rejects(f.tools.get('rp_present').execute({ packet: { playerAction: 'Wait' } }, f.exec));
  assert.equal(f.concluded(), 0);
  f.service.present = async () => { f.exec.signal = AbortSignal.abort(); return { text: 'Too late' }; };
  await assert.rejects(f.tools.get('rp_present').execute({ packet: { playerAction: 'Wait' } }, f.exec), { name: 'AbortError' });
  assert.equal(f.concluded(), 0);
});
