import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createPresenter, normalizeDirectionPacket } from '../src/presenter.mjs';
import { createReceiptStore } from '../src/receipts.mjs';
import { createPresetStore } from '../src/store.mjs';

const baseModel = { provider: 'local', model: 'base', reasoningEffort: 'high' };
const configs = { migrate: { provider: 'local', model: 'migrator' }, assemble: { provider: 'local', model: 'assembler' }, render: { provider: 'cloud', model: 'writer', reasoningEffort: 'low' } };
const packet = { playerAction: 'Try the gate', resolvedChanges: ['The attempt failed.'], visibleConsequences: ['The gate stays shut.'], variables: { weather: 'rain' } };
const entry = (id, content, extra = {}) => ({ id, name: id, content, role: 'system', phase: 'render', enabled: true, locked: false, required: false, order: 0, ...extra });
const ready = (entries) => ({ id: 'preset', name: 'Preset', version: 1, status: 'ready', sourceId: null, entries });

async function fixture(t, { entries = [entry('style', 'Use vivid prose.')], steps, ...options } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'rp-presenter-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await createPresetStore({ directory: join(directory, 'presets') });
  const receipts = await createReceiptStore({ directory: join(directory, 'receipts') });
  await store.saveProfile(ready(entries), { expectedRevision: 0 });
  await store.bindSession('story', { profileId: 'preset', expectedRevision: 1 });
  const calls = [];
  const events = [];
  const queued = steps ?? [{ commit: true }, 'Rain falls against the shut gate.'];
  const callModel = async (request) => {
    calls.push(request);
    const step = queued.shift();
    let streamed = false;
    const scoped = { ...request, onText: request.onText ? async (value) => { streamed = true; await request.onText(value); } : undefined };
    const response = typeof step === 'function' ? await step(scoped) : step;
    if (response instanceof Error) throw response;
    const text = typeof response === 'string' ? response : JSON.stringify(response);
    if (!streamed) await request.onText?.(text);
    return { text, usage: {}, finish: { kind: 'stop' }, config: request.config };
  };
  const presenter = createPresenter({ store, receipts, callModel, resolveModels: () => configs, publish: (event) => events.push(event), skillText: 'MIGRATION SKILL', skillReference: 'ADAPTATION REFERENCE', ...options });
  return { directory, store, receipts, presenter, calls, events };
}
const present = (presenter, extra = {}) => presenter.present({ sessionId: 'story', contextKey: 'turn-1', packet, baseModel, ...extra });

test('direction packets whitelist visible fields and freeze detached facts', () => {
  const source = structuredClone(packet);
  const normalized = normalizeDirectionPacket(source);
  source.resolvedChanges[0] = 'Mutated';
  assert.equal(normalized.resolvedChanges[0], 'The attempt failed.');
  assert.equal(Object.isFrozen(normalized.variables), true);
  for (const invalid of [{ ...packet, rawState: {} }, { ...packet, tools: [] }, { ...packet, playerAction: '' }, { ...packet, variables: { secret: {} } }, { ...packet, openHooks: 'bad' }]) assert.throws(() => normalizeDirectionPacket(invalid), { code: 'INVALID_DIRECTION_PACKET' });
});

test('assembly reads and patches the latest local overlay, then freezes only render/shared inputs for the writer', async (t) => {
  const f = await fixture(t, { entries: [entry('style', 'Old style'), entry('unused', 'DO NOT LOAD THIS', { enabled: false }), entry('simulation', 'PRIVATE AGENT RULE', { phase: 'agent' }), entry('slot', 'Mood {{mood}}')], steps: [
    { read: ['style'], operations: [{ op: 'replace', entryId: 'style', content: 'New style' }], commit: false },
    (request) => {
      assert.equal(request.input.feedback.entries[0].content, 'New style');
      return { operations: [{ op: 'fill', entryId: 'slot', key: 'mood', value: 'quiet' }, { op: 'add', entry: { id: 'turn', content: 'Keep the failure.', order: 10 } }], commit: true };
    },
    (request) => {
      assert.equal(request.stageId, 'rp-last-step.render');
      assert.equal(request.config.model, 'writer');
      assert.equal(request.input.modules.map((item) => item.content).join('|'), 'New style|Mood quiet|Keep the failure.');
      assert.deepEqual(request.input.packet, packet);
      assert.deepEqual(request.input.recentProse, ['Earlier public prose.']);
      assert.doesNotMatch(JSON.stringify(request.input), /PRIVATE AGENT RULE|DO NOT LOAD THIS/u);
      assert.equal(request.tools, undefined);
      return 'Rain falls against the shut gate.';
    },
  ] });
  const result = await present(f.presenter, { recentProse: ['Earlier public prose.'] });
  assert.equal(result.status, 'rendered');
  assert.equal(result.text, 'Rain falls against the shut gate.');
  assert.equal(f.calls[0].config.model, 'assembler');
  assert.doesNotMatch(JSON.stringify(f.calls[0].input), /Old style|DO NOT LOAD THIS|PRIVATE AGENT RULE/u);
  assert.equal((await f.store.snapshot()).revision, 3);
  assert.equal((await f.store.profile('preset')).entries[0].content, 'Old style');
  const stored = await f.receipts.get(result.id);
  assert.equal(stored.compiled.text, 'New style\n\nMood quiet\n\nKeep the failure.');
  assert.equal(stored.packet.resolvedChanges[0], 'The attempt failed.');
  assert.equal(f.events.some((event) => event.committed === true), false);
  await f.presenter.commit({ sessionId: 'story', presentationId: result.id, seq: 42 });
  assert.equal((await f.presenter.state('story'))[0].status, 'complete');
  assert.equal(f.events.at(-1).committed, true);
  assert.equal(f.events.at(-1).seq, 42);
  await assert.rejects(f.presenter.commit({ sessionId: 'other', presentationId: result.id }), { code: 'RECEIPT_NOT_FOUND' });
});

test('locked writes and required-empty or unresolved content block the writer without persisting edits', async (t) => {
  for (const { entries, step, code } of [
    { entries: [entry('style', 'Locked', { locked: true })], step: { operations: [{ op: 'replace', entryId: 'style', content: 'Changed' }], commit: true }, code: 'ASSEMBLY_LIMIT' },
    { entries: [entry('style', '', { required: true })], step: { commit: true }, code: 'ASSEMBLY_LIMIT' },
    { entries: [entry('style', '{{unknown}}')], step: { commit: true }, code: 'ASSEMBLY_LIMIT' },
    { entries: [entry('style', '', { marker: true })], step: { commit: true }, code: 'ASSEMBLY_LIMIT' },
  ]) {
    const f = await fixture(t, { entries, steps: [step], maxAssemblySteps: 1 });
    await assert.rejects(present(f.presenter), { code });
    assert.equal(f.calls.length, 1);
    assert.equal((await f.store.snapshot()).revision, 2);
    assert.equal((await f.presenter.state('story'))[0].status, 'failed');
  }
});

test('captured revision conflicts stop both patched and unchanged commits before writing', async (t) => {
  for (const operations of [[], [{ op: 'replace', entryId: 'style', content: 'New style' }]]) {
    let f;
    f = await fixture(t, { steps: [async () => {
      await f.store.saveProfile({ ...ready([entry('style', 'Owner edit')]), id: 'other' }, { expectedRevision: 2 });
      return { operations, commit: true };
    }] });
    await assert.rejects(present(f.presenter), { code: 'REVISION_CONFLICT' });
    assert.equal(f.calls.length, 1);
    assert.deepEqual((await f.store.binding('story')).overlay, { entries: {}, additions: [] });
  }
});

test('successful context keys are idempotent and concurrent duplicate presentations are busy', async (t) => {
  let unblock;
  const pending = new Promise((resolve) => { unblock = resolve; });
  const f = await fixture(t, { steps: [async () => { await pending; return { commit: true }; }, 'Public prose.'] });
  const first = present(f.presenter);
  await new Promise((resolve) => setTimeout(resolve, 10));
  await assert.rejects(present(f.presenter), { code: 'PRESENTATION_BUSY' });
  unblock();
  const saved = await first;
  const repeated = await present(f.presenter);
  assert.equal(repeated.id, saved.id);
  assert.equal(f.calls.length, 2);
  const restarted = createPresenter({ store: f.store, receipts: await createReceiptStore({ directory: join(f.directory, 'receipts') }), callModel: () => { throw new Error('Must not call'); } });
  assert.equal((await present(restarted)).id, saved.id);
});

test('known thought tags split across deltas never enter public narrative while literary tags survive', async (t) => {
  const f = await fixture(t, { steps: [{ commit: true }, async (request) => {
    for (const delta of ['<thi', 'nk>SECRET', '</th', 'ink>Rain <em>', 'falls</em>. <analysis>HIDDEN</analysis>']) await request.onText(delta);
    return '<think>SECRET</think>Rain <em>falls</em>. <analysis>HIDDEN</analysis>';
  }] });
  const result = await present(f.presenter);
  assert.equal(result.text, 'Rain <em>falls</em>. ');
  assert.equal(f.events.filter((event) => event.delta).map((event) => event.delta).join(''), result.text);
  assert.doesNotMatch(JSON.stringify(f.events), /SECRET|HIDDEN|<think|<analysis/u);
});

test('unclosed and malformed private tags fail receipts and never publish their buffered text', async (t) => {
  for (const text of ['<think>SECRET', '<thinking extra>SECRET</thinking>', '<reason', '</analysis>SECRET', '<think<em>SECRET</em>']) {
    const f = await fixture(t, { steps: [{ commit: true }, text] });
    await assert.rejects(present(f.presenter), { code: 'UNSAFE_THOUGHT_STREAM' });
    assert.equal((await f.presenter.state('story'))[0].status, 'failed');
    assert.equal(f.events.some((event) => event.delta), false);
    assert.doesNotMatch(JSON.stringify(f.events), /SECRET/u);
  }
});

test('receipts record the prepared model controls actually used by each stage', async (t) => {
  const f = await fixture(t);
  const presenter = createPresenter({ store: f.store, receipts: f.receipts, resolveModels: () => configs, callModel: async ({ stageId, onText, config }) => {
    if (stageId.endsWith('assemble')) return { text: '{"commit":true}', config: { ...config, maxTokens: 101 } };
    await onText('Public prose.');
    return { text: 'Public prose.', config: { ...config, maxTokens: 202 }, finish: { kind: 'stop' } };
  } });
  const result = await present(presenter);
  assert.equal(result.models.assemble.maxTokens, 101);
  assert.equal(result.models.render.maxTokens, 202);
});

test('a literary less-than before a private tag cannot smuggle thought bytes into a delta', async (t) => {
  const f = await fixture(t, { steps: [{ commit: true }, 'A < B <think>SECRET</think>C'] });
  const result = await present(f.presenter);
  assert.equal(result.text, 'A < B C');
  assert.doesNotMatch(JSON.stringify(f.events), /SECRET|<think/u);
});

test('a plain trailing less-than remains literary text for the downstream sanitizer', async (t) => {
  const f = await fixture(t, { steps: [{ commit: true }, 'The sign ends with <'] });
  assert.equal((await present(f.presenter)).text, 'The sign ends with <');
});

test('cancellation is durable, never completes, and does not silently rerun a failed context', async (t) => {
  const controller = new AbortController();
  const f = await fixture(t, { steps: [() => { controller.abort(); throw new DOMException('Stop', 'AbortError'); }] });
  await assert.rejects(present(f.presenter, { signal: controller.signal }), { name: 'AbortError' });
  const [receipt] = await f.presenter.state('story');
  assert.equal(receipt.status, 'cancelled');
  await assert.rejects(present(f.presenter), { code: 'PRESENTATION_FAILED' });
  await assert.rejects(f.presenter.commit({ sessionId: 'story', presentationId: receipt.id }), { code: 'PRESENTATION_NOT_RENDERED' });
  assert.equal(f.calls.length, 1);
});

test('writer max tokens are recorded as partial output and failure hides provider details', async (t) => {
  const f = await fixture(t);
  const presenter = createPresenter({ store: f.store, receipts: f.receipts, callModel: async ({ stageId, onText, config }) => {
    if (stageId.endsWith('assemble')) return { text: '{"commit":true}', config };
    await onText('Partial prose');
    return { text: 'Partial prose', finish: { kind: 'max-tokens' }, config };
  } });
  const output = await present(presenter);
  assert.equal(output.truncated, true);
  assert.equal(output.status, 'rendered');
  const failed = await presenter.fail({ sessionId: 'story', presentationId: output.id, error: new Error('SECRET provider credential') });
  assert.equal(failed.status, 'failed');
  assert.doesNotMatch(JSON.stringify(failed), /SECRET|credential/u);
});

test('migration uses skill-guided minimal patches, preserves literal tags/source/default-off, and saves only a review draft', async (t) => {
  const f = await fixture(t);
  const raw = '{\r\n"prompts":[{"identifier":"mixed","content":"<think>Literal</think> Simulate; write."},{"identifier":"off","enabled":false,"content":"OFF"}],"extensions":{"inert":"SCRIPT"}\r\n}';
  const imported = await f.store.importSource(raw, { expectedRevision: 2 });
  const original = await f.store.profile(imported.profileId);
  let request;
  const presenter = createPresenter({ store: f.store, receipts: f.receipts, resolveModels: () => configs, skillText: 'SKILL CONTENT', skillReference: 'REFERENCE CONTENT', callModel: async (value) => {
    request = value;
    return { text: '<think>PRIVATE</think>\n```json\n' + JSON.stringify({ updates: [{ id: 'mixed', content: '<think>Literal</think> Write.', phase: 'render' }, { id: 'off', phase: 'render' }], additions: [entry('rules', 'Simulation rule.', { phase: 'agent', source: { entryId: 'mixed' } })], report: { summary: 'Split mixed duties.' } }) + '\n```', config: value.config };
  } });
  const result = await presenter.migrate({ sessionId: 'story', profileId: original.id, version: 1, expectedRevision: 3, baseModel });
  assert.equal(request.stageId, 'rp-last-step.migrate');
  assert.equal(request.config.model, 'migrator');
  assert.match(request.system, /SKILL CONTENT[\s\S]*REFERENCE CONTENT/u);
  const migrated = await f.store.profile(original.id, result.version);
  assert.equal(migrated.status, 'draft');
  assert.equal(migrated.entries.find((item) => item.id === 'mixed').content, '<think>Literal</think> Write.');
  assert.equal(migrated.entries.find((item) => item.id === 'off').enabled, false);
  assert.deepEqual(migrated.entries[0].source, original.entries[0].source);
  assert.equal((await f.store.source(original.sourceId)).rawText, raw);
  assert.equal((await f.store.binding('story')).profileId, 'preset');
});

test('migration policy conflicts preserve the entire original and return a blocked draft for owner review', async (t) => {
  for (const update of [{ id: 'locked', content: 'changed' }, { id: 'required', enabled: false }, { id: 'off', enabled: true }, { id: 'locked', source: { entryId: 'new' } }]) {
    const f = await fixture(t, { entries: [entry('locked', 'Locked', { locked: true }), entry('required', 'Required', { required: true }), entry('off', 'Off', { enabled: false })] });
    const presenter = createPresenter({ store: f.store, receipts: f.receipts, callModel: async () => ({ text: JSON.stringify({ updates: [update], report: { summary: 'Attempted migration' } }) }), skillText: 'Migration skill' });
    const result = await presenter.migrate({ sessionId: 'story', profileId: 'preset', version: 1, expectedRevision: 2, baseModel });
    assert.equal(result.report.blocked.length > 0, true);
    const draft = await f.store.profile('preset', result.version);
    assert.equal(draft.status, 'draft');
    assert.deepEqual(draft.entries, (await f.store.profile('preset', 1)).entries);
  }
});

test('migration JSON repairs are bounded and never rebase a stale expected revision', async (t) => {
  const f = await fixture(t);
  const calls = [];
  const presenter = createPresenter({ store: f.store, receipts: f.receipts, skillText: 'Skill', maxMigrationAttempts: 2, callModel: async (request) => {
    calls.push(request);
    return { text: calls.length === 1 ? '{bad json' : '{"updates":[],"report":{"summary":"No changes"}}' };
  } });
  const migrated = await presenter.migrate({ sessionId: 'story', profileId: 'preset', version: 1, expectedRevision: 2, baseModel });
  assert.equal(calls.length, 2);
  assert.equal(migrated.version, 2);
  await assert.rejects(presenter.migrate({ sessionId: 'story', profileId: 'preset', version: 1, expectedRevision: 2, baseModel }), { code: 'REVISION_CONFLICT' });
  assert.equal(calls.length, 2);
});

test('migration sees immutable ST insertion/order/extension metadata and persists unsupported behavior without sending it to the writer', async (t) => {
  const f = await fixture(t);
  const source = {
    prompts: [{ identifier: 'deep', name: 'Depth style', content: 'Use descriptive prose.', role: 'system', injection_depth: 6, injection_position: 1, injection_order: 101, forbid_overrides: true, marker: true }],
    prompt_order: [
      { character_id: 11, order: [{ identifier: 'deep', enabled: false }] },
      { character_id: 100001, order: [{ identifier: 'deep', enabled: true }] },
    ],
    temperature: 0.7, api_key: 'SOURCE_CREDENTIAL', reverse_proxy: 'https://private-source.invalid',
    extensions: {
      regex_scripts: [{ id: 'regex-one', scriptName: 'Source regex', disabled: false, findRegex: 'FOO', replaceString: 'BAR', placement: [1, 2], minDepth: 6, maxDepth: 9, runOnEdit: true, api_key: 'SCRIPT_CREDENTIAL' }],
      TavernHelper: { enabled: true, scripts: [{ id: 'js-one', name: 'Helper script', enabled: true, content: 'throw new Error("DO_NOT_EXECUTE_SCRIPT")' }], endpoint: 'https://private-helper.invalid' },
      custom_extension: { enabled: true, mode: 'custom', access_token: 'EXTENSION_CREDENTIAL' },
    },
  };
  const raw = JSON.stringify(source, null, 2);
  const imported = await f.store.importSource(raw, { expectedRevision: 2 });
  let migrationInput;
  const subsequentInputs = [];
  const presenter = createPresenter({ store: f.store, receipts: f.receipts, skillText: 'Source-aware migration skill', callModel: async (request) => {
    if (request.stageId.endsWith('migrate')) {
      migrationInput = request.input;
      const metadata = request.input.sourceMetadata;
      assert.equal(metadata.entries[0].originalPrompt.injection_depth, 6);
      assert.equal(metadata.entries[0].originalPrompt.injection_position, 1);
      assert.equal(metadata.entries[0].originalPrompt.injection_order, 101);
      assert.equal(metadata.entries[0].originalPrompt.forbid_overrides, true);
      assert.equal(metadata.entries[0].originalPrompt.marker, true);
      assert.equal(metadata.entries[0].originalPrompt.content, undefined);
      assert.equal(metadata.entries[0].promptOrder.enabled, true);
      assert.equal(metadata.promptOrder.selectedCharacterId, 100001);
      assert.deepEqual(metadata.promptOrder.selected, source.prompt_order[1]);
      assert.deepEqual(metadata.promptOrder.groups, source.prompt_order);
      assert.equal(metadata.settings.temperature, 0.7);
      assert.equal(metadata.extensions.regex_scripts[0].findRegex, 'FOO');
      assert.equal(metadata.extensions.regex_scripts[0].minDepth, 6);
      assert.equal(metadata.extensions.TavernHelper.enabled, true);
      assert.equal(Object.isFrozen(metadata.entries[0].originalPrompt), true);
      assert.equal(metadata.unsupportedFeatures.some((item) => item.code === 'INJECTION_REQUIRES_ADAPTATION' && item.entryId === 'deep'), true);
      assert.equal(metadata.unsupportedFeatures.some((item) => item.code === 'REGEX_SCRIPTS_INERT'), true);
      assert.equal(metadata.unsupportedFeatures.some((item) => item.code === 'TAVERN_HELPER_SCRIPTS_INERT'), true);
      assert.doesNotMatch(JSON.stringify(metadata), /SOURCE_CREDENTIAL|SCRIPT_CREDENTIAL|EXTENSION_CREDENTIAL|private-source|private-helper|DO_NOT_EXECUTE_SCRIPT/u);
      assert.equal(JSON.stringify(request.input).match(/Use descriptive prose\./gu).length, 1);
      return { text: JSON.stringify({ updates: [{ id: 'deep', phase: 'render' }], report: { summary: 'Classified prose; retained unsupported ST behavior for review.' } }) };
    }
    subsequentInputs.push(request.input);
    if (request.stageId.endsWith('assemble')) return { text: '{"commit":true}' };
    return { text: 'The gate stays shut.' };
  } });
  const result = await presenter.migrate({ sessionId: 'story', profileId: imported.profileId, version: 1, expectedRevision: 3, baseModel });
  assert.ok(migrationInput);
  assert.equal(result.report.diagnostics.some((item) => item.code === 'INJECTION_REQUIRES_ADAPTATION'), true);
  assert.equal(result.report.diagnostics.some((item) => item.code === 'REGEX_SCRIPTS_INERT'), true);
  const draft = await f.store.profile(imported.profileId, result.version);
  assert.deepEqual(draft.migrationReport.diagnostics, result.report.diagnostics);
  assert.equal((await f.store.source(draft.sourceId)).rawText, raw);
  assert.deepEqual(draft.entries[0].source.originalPrompt, source.prompts[0]);
  const saved = await f.store.saveProfile({ ...draft, status: 'ready' }, { expectedRevision: 4 });
  await f.store.bindSession('story', { profileId: imported.profileId, version: saved.version, expectedRevision: 5 });
  const rendered = await present(presenter);
  assert.equal(rendered.text, 'The gate stays shut.');
  assert.equal(subsequentInputs.length, 2);
  assert.doesNotMatch(JSON.stringify(subsequentInputs), /sourceMetadata|injection_depth|regex_scripts|TavernHelper|FOO|SOURCE_CREDENTIAL|DO_NOT_EXECUTE_SCRIPT/u);
});
