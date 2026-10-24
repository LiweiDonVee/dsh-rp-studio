import assert from 'node:assert/strict';
import test from 'node:test';
import { PresetError } from '../src/core.mjs';
import * as module from '../src/routes.mjs';
const request = (body, signal) => new Request('http://localhost/api/rp-last-step/request', { method: 'POST', body: JSON.stringify(body), signal });

function fixture() {
  const calls = [];
  const listeners = new Set();
  const service = { subscribe: (id, listener) => { listeners.add(listener); return () => listeners.delete(listener); } };
  for (const action of ['state', 'profile', 'source', 'createProfile', 'importSillyTavern', 'saveProfile', 'bindSession', 'preview', 'migrate', 'authorize']) {
    service[action] = async (...args) => { calls.push({ action, args }); return { action }; };
  }
  return { calls, listeners, service };
}

test('dispatches only the exact owner library and session DTOs', async () => {
  assert.equal(typeof module.createRpLastStepRoutes, 'function');
  const f = fixture();
  const routes = module.createRpLastStepRoutes(f.service);
  const cases = [
    { action: 'state', sessionId: 'story' },
    { action: 'profile', profileId: 'preset', version: 2 },
    { action: 'source', sourceId: 'original' },
    { action: 'createProfile', name: 'New', expectedRevision: 0 },
    { action: 'importSillyTavern', rawText: '{"prompts":[]}', name: 'Imported', orderCharacterId: 12, expectedRevision: 1 },
    { action: 'saveProfile', profile: { id: 'preset', entries: [] }, expectedRevision: 2 },
    { action: 'bindSession', sessionId: 'story', profileId: 'preset', version: 2, expectedRevision: 3 },
    { action: 'preview', profile: { id: 'preset', entries: [] }, phase: 'agent', variables: { user: '玩家' } },
    { action: 'migrate', sessionId: 'story', profileId: 'preset', version: 2, expectedRevision: 4 },
  ];
  for (const body of cases) {
    const response = await routes.request(request(body));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { action: body.action });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const call = f.calls.at(-1);
    if (body.action === 'state') assert.equal(call.args[0], 'story');
    else { const { action: _action, ...args } = body; assert.deepEqual(call.args[0], args); }
    assert.equal(call.args[1] instanceof AbortSignal, true);
  }
  assert.equal(f.calls.length, 9);
});

test('rejects unknown actions, extra fields and malformed required arguments before dispatch', async () => {
  const f = fixture();
  const routes = module.createRpLastStepRoutes(f.service);
  for (const body of [
    null, [], { action: 'proxy', path: '/private' }, { action: 'state' }, { action: 'state', sessionId: 'story', rawState: {} },
    { action: 'profile', profileId: 'preset', version: -1 }, { action: 'source', sourceId: '' },
    { action: 'createProfile', name: 'Draft' }, { action: 'createProfile', name: 'Draft', expectedRevision: -1 },
    { action: 'bindSession', sessionId: 'story', profileId: 'preset', expectedRevision: 0 },
    { action: 'preview', profile: {}, phase: 'simulation' }, { action: 'preview', profile: {}, phase: 'render', variables: { secret: {} } },
    { action: 'migrate', sessionId: 'story', profileId: 'preset', version: 1, expectedRevision: 0, baseModel: { provider: 'cloud' } },
  ]) assert.equal((await routes.request(request(body))).status, 400);
  const malformed = new Request('http://localhost/api/rp-last-step/request', { method: 'POST', body: '{invalid' });
  assert.equal((await routes.request(malformed)).status, 400);
  assert.equal(f.calls.length, 0);
});

test('returns safe owner conflicts and never exposes provider or gateway errors', async () => {
  const f = fixture();
  const routes = module.createRpLastStepRoutes(f.service);
  const conflict = new PresetError('REVISION_CONFLICT', 'The profile changed.', 409);
  conflict.diagnostics = [{ code: 'UNRESOLVED_MACRO', severity: 'error', message: 'Needs adaptation', entryId: 'one' }];
  f.service.saveProfile = async () => { throw conflict; };
  const response = await routes.request(request({ action: 'saveProfile', profile: {}, expectedRevision: 0 }));
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: { code: 'REVISION_CONFLICT', message: 'The profile changed.', diagnostics: conflict.diagnostics } });
  for (const [error, status, code] of [
    [Object.assign(new Error('PRIVATE path/key'), { code: 'gateway/forbidden' }), 403, 'FORBIDDEN'],
    [Object.assign(new Error('PRIVATE path/key'), { code: 'session/not-found' }), 404, 'SESSION_NOT_FOUND'],
    [new Error('provider token=secret'), 503, 'UNAVAILABLE'],
    [new DOMException('secret abort', 'AbortError'), 499, 'CANCELLED'],
  ]) {
    f.service.state = async () => { throw error; };
    const failed = await routes.request(request({ action: 'state', sessionId: 'story' }));
    assert.equal(failed.status, status);
    const body = await failed.json();
    assert.equal(body.error.code, code);
    assert.doesNotMatch(JSON.stringify(body), /secret|PRIVATE|token=/u);
  }
});

test('authorizes event access and emits only bounded metadata with abort and cancel cleanup', async () => {
  const f = fixture();
  const routes = module.createRpLastStepRoutes(f.service);
  const abort = new AbortController();
  const response = await routes.events(new Request('http://localhost/api/rp-last-step/events?sessionId=story', { signal: abort.signal }));
  assert.equal(response.status, 200);
  assert.equal(f.calls[0].action, 'authorize');
  assert.equal(f.calls[0].args[0], 'story');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  assert.match(decoder.decode((await reader.read()).value), /event: connected/u);
  const [listener] = f.listeners;
  listener({ type: 'stage', sessionId: 'other', stageId: 'rp-last-step.render', status: 'rendering', delta: 'Thought or public text', secret: 'secret', packet: {} });
  const stage = decoder.decode((await reader.read()).value);
  assert.match(stage, /event: stage/u);
  assert.match(stage, /"sessionId":"story"/u);
  assert.doesNotMatch(stage, /delta|secret|packet|other/u);
  listener({ type: 'changed', sessionId: 'story' });
  assert.match(decoder.decode((await reader.read()).value), /event: changed/u);
  abort.abort();
  assert.equal((await reader.read()).done, true);
  assert.equal(f.listeners.size, 0);
  const second = await routes.events(new Request('http://localhost/api/rp-last-step/events?sessionId=story'));
  await second.body.cancel();
  assert.equal(f.listeners.size, 0);
  await routes.close();
});

test('stalled SSE queues and plugin unload release subscribers', async () => {
  const f = fixture();
  const routes = module.createRpLastStepRoutes(f.service);
  const response = await routes.events(new Request('http://localhost/api/rp-last-step/events?sessionId=story'));
  const [listener] = f.listeners;
  for (let index = 0; index < 500; index++) listener({ type: 'changed' });
  assert.equal(f.listeners.size, 0);
  await response.body.cancel();
  const live = await routes.events(new Request('http://localhost/api/rp-last-step/events?sessionId=story'));
  assert.equal(f.listeners.size, 1);
  await routes.close();
  assert.equal(f.listeners.size, 0);
  const reader = live.body.getReader();
  await reader.read();
  assert.equal((await reader.read()).done, true);
  assert.equal((await routes.request(request({ action: 'state', sessionId: 'story' }))).status, 503);
  assert.equal((await routes.events(new Request('http://localhost/api/rp-last-step/events?sessionId=story'))).status, 503);
});

test('denied and malformed SSE requests never subscribe', async () => {
  const f = fixture();
  const routes = module.createRpLastStepRoutes(f.service);
  assert.equal((await routes.events(new Request('http://localhost/api/rp-last-step/events'))).status, 400);
  f.service.authorize = async () => { throw Object.assign(new Error('private session'), { code: 'gateway/access-denied' }); };
  assert.equal((await routes.events(new Request('http://localhost/api/rp-last-step/events?sessionId=story'))).status, 403);
  assert.equal(f.listeners.size, 0);
});
