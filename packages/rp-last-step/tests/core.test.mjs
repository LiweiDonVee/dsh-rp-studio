import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import * as core from '../src/core.mjs';

const {
  importSillyTavern, createProfile, validateProfile, emptyOverlay,
  applyAgentOperations, compileProfile,
} = core;

function profile(entries, overrides = {}) {
  return validateProfile({
    id: 'native', name: 'A preset', version: 1, status: 'ready', sourceId: null,
    entries: entries.map((entry, order) => ({
      name: entry.id, content: 'Text', role: 'system', order, enabled: true,
      phase: 'render', required: false, locked: false, ...entry,
    })), ...overrides,
  });
}

test('import keeps the exact original and inert extensions without applying ST lock policy', () => {
  const rawText = '{\r\n "name":"Original", "prompts":[{"identifier":"style","content":"Write {{char}}","role":"user","enabled":false,"forbid_overrides":true}],"extensions":{"unknown":{"script":"throw new Error()"}}\r\n}\r\n';
  const result = importSillyTavern(rawText, { id: 'source-a' });
  assert.equal(result.source.rawText, rawText);
  assert.equal(result.source.sha256, createHash('sha256').update(rawText).digest('hex'));
  assert.deepEqual(JSON.parse(result.source.rawText).extensions, { unknown: { script: 'throw new Error()' } });
  assert.equal(result.profile.sourceId, result.source.id);
  assert.equal(result.profile.status, 'draft');
  assert.equal(result.profile.entries[0].phase, 'unclassified');
  assert.equal(result.profile.entries[0].enabled, false);
  assert.equal(result.profile.entries[0].role, 'user');
  assert.equal(result.profile.entries[0].locked, false);
  assert.equal(result.profile.entries[0].source.entryId, 'style');
  assert.equal(result.profile.entries[0].source.originalPrompt.forbid_overrides, true);
  assert.throws(() => { result.source.rawText = '{}'; }, TypeError);
});

test('locked entries reject agent disabling, replacing and filling', () => {
  const preset = profile([{ id: 'locked', content: '{{style}}', locked: true }]);
  for (const operation of [
    { op: 'disable', entryId: 'locked' },
    { op: 'replace', entryId: 'locked', content: 'Changed' },
    { op: 'fill', entryId: 'locked', key: 'style', value: 'Changed' },
  ]) {
    assert.throws(() => applyAgentOperations(preset, emptyOverlay(), [operation]), { code: 'ENTRY_LOCKED', status: 403 });
  }
});

test('chosen prompt_order owns enablement and order; unlisted prompts stay disabled', () => {
  const raw = JSON.stringify({
    prompts: [
      { identifier: 'a', enabled: true, content: 'A' },
      { identifier: 'b', enabled: false, content: 'B' },
      { identifier: 'c', enabled: true, content: 'C' },
    ],
    prompt_order: [
      { character_id: 0, order: [{ identifier: 'a', enabled: true }] },
      { character_id: 100001, order: [{ identifier: 'b', enabled: true }, { identifier: 'a', enabled: false }] },
    ],
  });
  const imported = importSillyTavern(raw);
  assert.deepEqual(imported.profile.entries.map(({ id, enabled, order }) => ({ id, enabled, order })), [
    { id: 'a', enabled: false, order: 1 }, { id: 'b', enabled: true, order: 0 }, { id: 'c', enabled: false, order: 4 },
  ]);
  assert.deepEqual(importSillyTavern(raw, { orderCharacterId: 0 }).profile.entries.map(({ enabled }) => enabled), [true, false, false]);
  assert.throws(() => importSillyTavern(raw, { orderCharacterId: 404 }), { code: 'INVALID_ORDER' });
  assert.equal(importSillyTavern(JSON.stringify({ prompts: [{ identifier: 'a', enabled: true }], prompt_order: [] })).profile.entries[0].enabled, false);
});

test('invalid duplicate prompt IDs and absent order targets fail instead of silently activating entries', () => {
  assert.throws(() => importSillyTavern('{"prompts":[{"identifier":"a"},{"identifier":"a"}]}'), { code: 'DUPLICATE_ENTRY' });
  assert.throws(() => importSillyTavern('{"prompts":[{"identifier":"a"}],"prompt_order":[{"order":[{"identifier":"missing","enabled":true}]}]}'), { code: 'INVALID_ORDER' });
  assert.throws(() => importSillyTavern('{"prompts":[{"identifier":"a"}],"prompt_order":[{"order":[{"identifier":"a","enabled":true},{"identifier":"a","enabled":false}]}]}'), { code: 'INVALID_ORDER' });
});

test('native profiles start draft and validation returns an independent protected snapshot', () => {
  const draft = createProfile({ id: 'new', name: 'New' });
  assert.deepEqual(draft, { id: 'new', name: 'New', version: 1, status: 'draft', sourceId: null, entries: [] });
  const mutable = structuredClone(profile([{ id: 'one', fills: { style: 'soft' }, content: '{{style}}' }]));
  const validated = validateProfile(mutable);
  mutable.entries[0].fills.style = 'changed';
  assert.equal(validated.entries[0].fills.style, 'soft');
  assert.throws(() => validateProfile({ ...mutable, entries: [...mutable.entries, mutable.entries[0]] }), { code: 'DUPLICATE_ENTRY' });
  assert.throws(() => validateProfile({ ...mutable, entries: [{ ...mutable.entries[0], role: 'tool' }] }), { code: 'INVALID_PROFILE' });
  assert.throws(() => validateProfile({ ...mutable, entries: [{ ...mutable.entries[0], required: true, enabled: false }] }), { code: 'INVALID_PROFILE' });
});

test('required editable entries can change text while policy and source entries remain protected', () => {
  const preset = profile([{ id: 'required', required: true }, { id: 'optional', enabled: false }]);
  const original = emptyOverlay();
  const edited = applyAgentOperations(preset, original, [
    { op: 'replace', entryId: 'required', content: 'Edited' },
    { op: 'enable', entryId: 'optional' },
  ]);
  assert.equal(compileProfile(preset, edited).text, 'Edited\n\nText');
  assert.deepEqual(original, { entries: {}, additions: [] });
  assert.equal(preset.entries[0].content, 'Text');
  assert.throws(() => applyAgentOperations(preset, edited, [{ op: 'disable', entryId: 'required' }]), { code: 'ENTRY_REQUIRED' });
  assert.throws(() => applyAgentOperations(preset, edited, [{ op: 'remove', entryId: 'optional' }]), { code: 'SOURCE_ENTRY' });
  assert.throws(() => applyAgentOperations(preset, edited, [{ op: 'replace', entryId: 'required', content: 'X', locked: false }]), { code: 'INVALID_OPERATION' });
  assert.throws(() => applyAgentOperations(preset, edited, [{ op: 'bind', profileId: 'elsewhere' }]), { code: 'INVALID_OPERATION' });
});

test('temporary additions are render only, cannot shadow originals and can be removed', () => {
  const preset = profile([{ id: 'source', locked: true }]);
  const added = applyAgentOperations(preset, emptyOverlay(), [{ op: 'add', entry: { id: 'temp', name: 'Temporary', content: 'Extra', role: 'assistant', order: 2 } }]);
  assert.equal(compileProfile(preset, added).text, 'Text\n\nExtra');
  assert.equal(added.additions[0].phase, 'render');
  for (const entry of [{ id: 'source' }, { id: 'bad', phase: 'agent' }, { id: 'bad', required: true }, { id: 'bad', locked: true }, { id: 'bad', source: { entryId: 'source' } }]) {
    assert.throws(() => applyAgentOperations(preset, emptyOverlay(), [{ op: 'add', entry: { content: 'X', ...entry } }]), core.PresetError);
  }
  const removed = applyAgentOperations(preset, added, [{ op: 'remove', entryId: 'temp' }]);
  assert.equal(compileProfile(preset, removed).text, 'Text');
});

test('render compilation excludes agent instructions and preserves static role and ordering', () => {
  const preset = profile([
    { id: 'late', role: 'assistant', order: 30, content: 'Narrate the failed result' },
    { id: 'agent', order: 10, phase: 'agent', content: 'Call the result tool' },
    { id: 'shared', order: 0, phase: 'shared', content: 'Shared rule' },
    { id: 'off', enabled: false, content: 'Disabled' },
  ]);
  const render = compileProfile(preset, emptyOverlay());
  assert.equal(render.blocked, false);
  assert.deepEqual(render.messages, [{ role: 'system', content: 'Shared rule' }, { role: 'assistant', content: 'Narrate the failed result' }]);
  assert.deepEqual(compileProfile(preset, emptyOverlay(), { phase: 'agent' }).messages.map(({ content }) => content), ['Shared rule', 'Call the result tool']);
  assert.equal(render.hash, compileProfile(preset, emptyOverlay()).hash);
  assert.notEqual(render.hash, compileProfile(preset, emptyOverlay(), { phase: 'agent' }).hash);
});

test('drafts, unclassified active entries, missing macros and unmapped markers block strict compilation', () => {
  const imported = importSillyTavern('{"prompts":[{"identifier":"one","content":"{{char}}"}]}');
  assert.equal(compileProfile(imported.profile, emptyOverlay()).blocked, true);
  assert.equal(compileProfile(imported.profile, emptyOverlay(), { allowDraft: true }).blocked, true);
  const ready = profile([{ id: 'style', content: '{{unknown}} {{setvar::trust::3}}' }, { id: 'history', marker: true, content: '' }]);
  const output = compileProfile(ready, emptyOverlay());
  assert.equal(output.blocked, true);
  assert.ok(output.diagnostics.some(({ code }) => code === 'UNRESOLVED_MACRO'));
  assert.ok(output.diagnostics.some(({ code }) => code === 'UNMAPPED_MARKER'));
  const preview = profile([{ id: 'one' }], { status: 'draft' });
  assert.equal(compileProfile(preview, emptyOverlay()).blocked, true);
  assert.equal(compileProfile(preview, emptyOverlay(), { allowDraft: true }).blocked, false);
});

test('runtime values win over local fills, remain immutable, and unavailable facts are blocked', () => {
  const preset = profile([
    { id: 'locked', locked: true, content: 'Result {{result}}; {{tone}}', fills: { tone: 'fixed' } },
    { id: 'editable', content: 'Style {{tone}}, outcome {{result}}' },
    { id: 'history', marker: true, content: '' },
  ]);
  const overlay = applyAgentOperations(preset, emptyOverlay(), [
    { op: 'fill', entryId: 'editable', key: 'tone', value: 'gentle' },
    { op: 'fill', entryId: 'editable', key: 'result', value: 'success' },
  ]);
  const variables = { result: 'failure', history: 'Known history' };
  const output = compileProfile(preset, overlay, { variables });
  assert.equal(output.blocked, false);
  assert.deepEqual(output.messages.map(({ content }) => content), ['Result failure; fixed', 'Style gentle, outcome failure', 'Known history']);
  assert.deepEqual(variables, { result: 'failure', history: 'Known history' });
  assert.throws(() => applyAgentOperations(preset, overlay, [{ op: 'fill', entryId: 'editable', key: 'not-a-slot', value: 'X' }]), { code: 'INVALID_FILL' });
  assert.equal(compileProfile(preset, overlay, { variables: { history: 'Known history' } }).blocked, true);
});

test('owner fills in locked required entries win over caller variables while unfilled facts and other modules stay local', () => {
  const preset = profile([
    { id: 'locked', locked: true, required: true, content: 'Tone: {{tone}}; Fact: {{fact}}', fills: { tone: 'owner-fixed' } },
    { id: 'editable', content: 'Tone: {{tone}}', fills: { tone: 'editable-default' } },
  ]);
  const overlay = applyAgentOperations(preset, emptyOverlay(), [{ op: 'fill', entryId: 'editable', key: 'tone', value: 'module-local' }]);
  const variables = { tone: 'agent-replacement', fact: 'confirmed outcome' };
  const compiled = compileProfile(preset, overlay, { variables });
  assert.equal(compiled.blocked, false);
  assert.deepEqual(compiled.messages.map(({ content }) => content), [
    'Tone: owner-fixed; Fact: confirmed outcome', 'Tone: agent-replacement',
  ]);
  assert.deepEqual(variables, { tone: 'agent-replacement', fact: 'confirmed outcome' });
  assert.deepEqual(compileProfile(preset, overlay, { variables: { fact: 'confirmed outcome' } }).messages.map(({ content }) => content), [
    'Tone: owner-fixed; Fact: confirmed outcome', 'Tone: module-local',
  ]);
  assert.equal(preset.entries[0].fills.tone, 'owner-fixed');
});

test('compile rejects forged overlays that bypass locked, required, phase or identity constraints', () => {
  const preset = profile([{ id: 'locked', locked: true }, { id: 'required', required: true }, { id: 'editable' }]);
  for (const overlay of [
    { entries: { locked: { content: 'Changed' } }, additions: [] },
    { entries: { required: { enabled: false } }, additions: [] },
    { entries: { editable: { phase: 'agent' } }, additions: [] },
    { entries: { absent: { enabled: true } }, additions: [] },
    { entries: {}, additions: [{ ...preset.entries[2], id: 'locked' }] },
  ]) {
    assert.throws(() => compileProfile(preset, overlay), core.PresetError);
  }
});

test('required entries that resolve to empty content cannot be bypassed by a replacement or fill', () => {
  const preset = profile([{ id: 'required', content: '{{rule}}', required: true }]);
  for (const operations of [
    [{ op: 'replace', entryId: 'required', content: '' }],
    [{ op: 'fill', entryId: 'required', key: 'rule', value: '' }],
  ]) {
    const compiled = compileProfile(preset, applyAgentOperations(preset, emptyOverlay(), operations));
    assert.equal(compiled.blocked, true);
    assert.ok(compiled.diagnostics.some(({ code }) => code === 'REQUIRED_EMPTY'));
  }
});

test('failed batches are atomic and fills for special entry IDs stay local', () => {
  const preset = profile([{ id: '__proto__', content: '{{tone}}' }, { id: 'locked', content: '{{tone}}', locked: true }]);
  const initial = emptyOverlay();
  assert.throws(() => applyAgentOperations(preset, initial, [
    { op: 'fill', entryId: '__proto__', key: 'tone', value: 'local' },
    { op: 'disable', entryId: 'locked' },
  ]), { code: 'ENTRY_LOCKED' });
  assert.deepEqual(initial, { entries: {}, additions: [] });
  const overlay = applyAgentOperations(preset, initial, [{ op: 'fill', entryId: '__proto__', key: 'tone', value: 'local' }]);
  const compiled = compileProfile(preset, overlay);
  assert.equal(compiled.entries[0].content, 'local');
  assert.equal(compiled.entries[1].content, '{{tone}}');
  assert.equal(compiled.blocked, true);
});
