import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createReceiptStore, publicReceipt } from '../src/receipts.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'rp-receipts-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, receipts: await createReceiptStore({ directory }) };
}

test('receipt snapshots survive restart while raw composition stays private', async (t) => {
  const { directory, receipts } = await fixture(t);
  const input = { sessionId: '../story', contextKey: 'turn-1', status: 'prepared', packet: { playerAction: 'Wait' }, profile: { id: 'p', entries: ['PRIVATE MODULE'] }, profileId: 'p', profileVersion: 2, profileHash: 'hash', models: { render: { provider: 'local', model: 'writer' } } };
  const first = await receipts.create(input);
  input.profile.entries[0] = 'mutated';
  first.packet.playerAction = 'mutated';
  const second = await createReceiptStore({ directory });
  const saved = await second.get(first.id);
  assert.equal(saved.profile.entries[0], 'PRIVATE MODULE');
  assert.equal(saved.packet.playerAction, 'Wait');
  const updated = await second.update(first.id, { status: 'rendered', text: 'Public prose' });
  assert.deepEqual(publicReceipt(updated), { id: first.id, text: 'Public prose', status: 'rendered', createdAt: first.createdAt, profileId: 'p', profileVersion: 2, profileHash: 'hash', models: { render: { provider: 'local', model: 'writer' } } });
  assert.equal((await second.findByContextKey('../story', 'turn-1')).id, first.id);
  assert.equal((await second.list('../story')).length, 1);
  assert.deepEqual(await second.list('other'), []);
  assert.equal(await second.get('not-a-uuid'), null);
});

test('safe hashed session indexes isolate special identifiers and handles serialize updates', async (t) => {
  const { directory, receipts } = await fixture(t);
  const second = await createReceiptStore({ directory });
  const created = await Promise.all([
    receipts.create({ sessionId: '__proto__', contextKey: 'same', status: 'prepared' }),
    second.create({ sessionId: '__proto__', contextKey: 'other', status: 'prepared' }),
    second.create({ sessionId: '../escape', contextKey: 'same', status: 'prepared' }),
  ]);
  assert.equal((await receipts.list('__proto__')).length, 2);
  assert.equal((await receipts.list('../escape')).length, 1);
  const names = await readdir(join(directory, 'sessions'));
  assert.equal(names.every((name) => /^[a-f0-9]{64}\.json$/u.test(name)), true);
  await assert.rejects(receipts.update(created[0].id, { sessionId: 'other' }), { code: 'RECEIPT_IDENTITY_IMMUTABLE' });
  await assert.rejects(receipts.update(created[0].id, { status: 'invented' }), { code: 'INVALID_RECEIPT' });
});

test('context reservations are atomic across store handles so duplicate attempts cannot dispatch models', async (t) => {
  const { directory, receipts } = await fixture(t);
  const second = await createReceiptStore({ directory });
  const attempts = await Promise.allSettled([
    receipts.create({ sessionId: 'story', contextKey: 'turn', status: 'prepared' }),
    second.create({ sessionId: 'story', contextKey: 'turn', status: 'prepared' }),
  ]);
  assert.equal(attempts.filter((value) => value.status === 'fulfilled').length, 1);
  assert.equal(attempts.find((value) => value.status === 'rejected').reason.code, 'PRESENTATION_BUSY');
  assert.equal((await receipts.list('story')).length, 1);
});
