import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { compileProfile, createProfile } from '../src/core.mjs';
import { createPresetStore } from '../src/store.mjs';

async function temporaryStore(t) {
  const directory = await mkdtemp(join(tmpdir(), 'rp-preset-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, store: await createPresetStore({ directory }) };
}

function readyProfile(id = 'native') {
  return {
    ...createProfile({ id, name: 'Native' }), status: 'ready',
    entries: [{ id: 'style', name: 'Style', content: 'Original', role: 'system', order: 0, enabled: true, phase: 'render', required: true, locked: true }],
  };
}

test('sources roundtrip exactly after restart and imported profiles remain draft', async (t) => {
  const { directory, store } = await temporaryStore(t);
  const rawText = '{\r\n "prompts":[{"identifier":"a","enabled":false,"content":"A"}],"extensions":{"unknown":[1,2]}\r\n}\r\n';
  const imported = await store.importSource(rawText, { name: 'Imported', expectedRevision: 0 });
  assert.equal(imported.revision, 1);
  assert.equal(imported.version, 1);
  const profile = await store.profile(imported.profileId);
  assert.equal(profile.status, 'draft');
  assert.equal((await store.source(profile.sourceId)).rawText, rawText);
  const restarted = await createPresetStore({ directory });
  assert.equal((await restarted.source(profile.sourceId)).rawText, rawText);
  assert.equal((await restarted.snapshot()).revision, 1);
  await assert.rejects(store.bindSession('story', { profileId: profile.id, expectedRevision: 1 }), { code: 'PROFILE_NOT_READY' });
  assert.equal((await store.snapshot()).revision, 1);
});

test('owner edits create immutable versions and do not change the session pinned version or locks', async (t) => {
  const { directory, store } = await temporaryStore(t);
  await store.saveProfile(readyProfile(), { expectedRevision: 0 });
  await store.bindSession('story', { profileId: 'native', expectedRevision: 1 });
  const ownerEdit = structuredClone(await store.profile('native'));
  ownerEdit.entries[0].content = 'Owner changed locked content';
  const saved = await store.saveProfile(ownerEdit, { expectedRevision: 2 });
  assert.deepEqual(saved, { revision: 3, profileId: 'native', version: 2 });
  assert.equal((await store.profile('native', 1)).entries[0].content, 'Original');
  assert.equal((await store.profile('native')).entries[0].content, 'Owner changed locked content');
  const restarted = await createPresetStore({ directory });
  const binding = await restarted.binding('story');
  assert.equal(binding.profileId, 'native');
  assert.equal(binding.version, 1);
  assert.equal(binding.profile.entries[0].content, 'Original');
  await assert.rejects(restarted.applyOperations('story', [{ op: 'replace', entryId: 'style', content: 'Agent change' }], { expectedRevision: 3 }), { code: 'ENTRY_LOCKED' });
  await restarted.bindSession('story', { profileId: 'native', version: 2, expectedRevision: 3 });
  assert.equal((await restarted.binding('story')).profile.entries[0].content, 'Owner changed locked content');
});

test('a stale base profile cannot overwrite newer content or locks with a fresh global revision', async (t) => {
  const { directory, store } = await temporaryStore(t);
  const original = readyProfile();
  original.entries[0].locked = false;
  await store.saveProfile(original, { expectedRevision: 0 });
  const stale = await store.profile('native', 1);
  const latest = await store.profile('native');
  latest.entries[0].content = 'New owner content';
  latest.entries[0].locked = true;
  await store.saveProfile(latest, { expectedRevision: 1 });
  stale.entries[0].content = 'Old window content';
  const before = await store.snapshot();
  const persisted = await readFile(join(directory, 'preset-store.json'), 'utf8');
  await assert.rejects(store.saveProfile(stale, { expectedRevision: before.revision }), { code: 'PROFILE_VERSION_CONFLICT', status: 409 });
  assert.deepEqual(await store.snapshot(), before);
  assert.equal(await store.profile('native', 3), null);
  assert.equal((await store.profile('native')).entries[0].locked, true);
  assert.equal(await readFile(join(directory, 'preset-store.json'), 'utf8'), persisted);
});

test('an existing profile save requires its explicit current base version', async (t) => {
  const { store } = await temporaryStore(t);
  await store.saveProfile(readyProfile(), { expectedRevision: 0 });
  const edit = await store.profile('native');
  delete edit.version;
  await assert.rejects(store.saveProfile(edit, { expectedRevision: 1 }), { code: 'PROFILE_VERSION_CONFLICT', status: 409 });
  assert.equal((await store.snapshot()).revision, 1);
  assert.equal((await store.profile('native')).version, 1);
});

test('all mutations require a current global revision and concurrent edits serialize', async (t) => {
  const { store } = await temporaryStore(t);
  await assert.rejects(store.saveProfile(readyProfile()), { code: 'EXPECTED_REVISION_REQUIRED', status: 400 });
  await assert.rejects(store.importSource('{"prompts":[]}'), { code: 'EXPECTED_REVISION_REQUIRED' });
  const [first, second] = await Promise.allSettled([
    store.saveProfile(readyProfile('one'), { expectedRevision: 0 }),
    store.saveProfile(readyProfile('two'), { expectedRevision: 0 }),
  ]);
  assert.equal(first.status, 'fulfilled');
  assert.equal(second.status, 'rejected');
  assert.equal(second.reason.code, 'REVISION_CONFLICT');
  assert.equal(second.reason.status, 409);
  await assert.rejects(store.bindSession('story', { profileId: 'one', expectedRevision: 0 }), { code: 'REVISION_CONFLICT' });
  await assert.rejects(store.applyOperations('story', [], { expectedRevision: 0 }), { code: 'REVISION_CONFLICT' });
  await store.bindSession('story', { profileId: 'one', expectedRevision: 1 });
  assert.equal((await store.snapshot()).revision, 2);
});

test('session overlays persist, stay isolated, and cannot mutate original profiles or bindings', async (t) => {
  const { directory, store } = await temporaryStore(t);
  const native = readyProfile();
  native.entries[0].locked = false;
  await store.saveProfile(native, { expectedRevision: 0 });
  await store.bindSession('a', { profileId: 'native', expectedRevision: 1 });
  await store.bindSession('b', { profileId: 'native', expectedRevision: 2 });
  const result = await store.applyOperations('a', [
    { op: 'replace', entryId: 'style', content: 'Story A style' },
    { op: 'add', entry: { id: '../unsafe/name', content: 'Temporary', order: 1 } },
  ], { expectedRevision: 3 });
  assert.equal(result.revision, 4);
  assert.equal((await store.profile('native')).entries[0].content, 'Original');
  const restarted = await createPresetStore({ directory });
  const a = await restarted.binding('a');
  const b = await restarted.binding('b');
  assert.equal(compileProfile(a.profile, a.overlay).text, 'Story A style\n\nTemporary');
  assert.equal(compileProfile(b.profile, b.overlay).text, 'Original');
  await assert.rejects(restarted.applyOperations('a', [{ op: 'bind', profileId: 'other' }], { expectedRevision: 4 }), { code: 'INVALID_OPERATION' });
  assert.equal((await restarted.binding('a')).version, 1);
  assert.equal((await restarted.snapshot()).revision, 4);
});

test('read snapshots cannot change store state and identifiers never become file paths', async (t) => {
  const { directory, store } = await temporaryStore(t);
  await store.saveProfile(readyProfile('../profile'), { expectedRevision: 0 });
  await store.bindSession('__proto__', { profileId: '../profile', expectedRevision: 1 });
  const snapshot = await store.snapshot();
  const copy = structuredClone(snapshot);
  copy.profiles[0].entries[0].locked = false;
  copy.bindings.__proto__.version = 99;
  assert.equal((await store.profile('../profile')).entries[0].locked, true);
  assert.equal((await store.binding('__proto__')).version, 1);
  const serialized = JSON.parse(await readFile(join(directory, 'preset-store.json'), 'utf8'));
  assert.equal(serialized.revision, 2);
});

test('ready bindings reject active unclassified modules while explicit variables may remain unresolved until runtime', async (t) => {
  const { store } = await temporaryStore(t);
  const bad = readyProfile('unclassified');
  bad.entries[0].phase = 'unclassified';
  await store.saveProfile(bad, { expectedRevision: 0 });
  await assert.rejects(store.bindSession('story', { profileId: bad.id, expectedRevision: 1 }), { code: 'PROFILE_NOT_READY' });
  const native = readyProfile('variables');
  native.entries[0].content = 'Confirmed outcome {{result}}';
  await store.saveProfile(native, { expectedRevision: 1 });
  await store.bindSession('story', { profileId: native.id, expectedRevision: 2 });
  assert.equal((await store.binding('story')).profile.id, native.id);
});

test('unknown sources, bindings, profiles and versions are reported without changing revision', async (t) => {
  const { store } = await temporaryStore(t);
  assert.equal(await store.profile('absent'), null);
  assert.equal(await store.source('absent'), null);
  assert.equal(await store.binding('absent'), null);
  await assert.rejects(store.applyOperations('absent', [], { expectedRevision: 0 }), { code: 'BINDING_NOT_FOUND', status: 404 });
  await assert.rejects(store.saveProfile({ ...readyProfile(), sourceId: 'missing' }, { expectedRevision: 0 }), { code: 'SOURCE_NOT_FOUND' });
  await store.saveProfile(readyProfile(), { expectedRevision: 0 });
  await assert.rejects(store.bindSession('story', { profileId: 'native', version: 99, expectedRevision: 1 }), { code: 'PROFILE_NOT_FOUND' });
  assert.equal((await store.snapshot()).revision, 1);
});

test('independent handles share revisions and failed batches do not partially persist', async (t) => {
  const { directory, store } = await temporaryStore(t);
  const second = await createPresetStore({ directory });
  const native = readyProfile();
  native.entries[0].locked = false;
  const [saved, stale] = await Promise.allSettled([
    store.saveProfile(native, { expectedRevision: 0 }),
    second.saveProfile(readyProfile('other'), { expectedRevision: 0 }),
  ]);
  assert.equal(saved.status, 'fulfilled');
  assert.equal(stale.reason.code, 'REVISION_CONFLICT');
  await second.bindSession('story', { profileId: 'native', expectedRevision: 1 });
  await assert.rejects(store.applyOperations('story', [
    { op: 'replace', entryId: 'style', content: 'Should not persist' },
    { op: 'disable', entryId: 'style' },
  ], { expectedRevision: 2 }), { code: 'ENTRY_REQUIRED' });
  const binding = await second.binding('story');
  assert.equal(compileProfile(binding.profile, binding.overlay).text, 'Original');
  assert.equal((await second.snapshot()).revision, 2);
});
