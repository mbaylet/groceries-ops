import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { addPending, loadPending, removePending, savePending, type PendingFile } from '../scripts/lib/pending.ts';
import { useTempRoot } from './helpers.ts';

beforeEach(() => useTempRoot());

test('parking an item keeps the wording, date and optional quantity', () => {
  const f: PendingFile = { items: [] };
  const r = addPending(f, 'pastilles lave-vaisselle', '2026-10-08', '2 boîtes');
  assert.equal(r.duplicate, false);
  assert.deepEqual(f.items[0], { key: 'pastille lave vaisselle', item: 'pastilles lave-vaisselle', qty: '2 boîtes', added: '2026-10-08' });
});

test('parking the same thing twice keeps one entry; the latest quantity wins', () => {
  const f: PendingFile = { items: [] };
  addPending(f, 'Pastilles lave-vaisselle', '2026-10-08');
  const again = addPending(f, 'pastilles lave vaisselle', '2026-10-09', '3 boîtes');
  assert.equal(again.duplicate, true);
  assert.equal(f.items.length, 1);
  assert.equal(f.items[0].added, '2026-10-08');
  assert.equal(f.items[0].qty, '3 boîtes');
});

test('removing / marking done matches by name and returns what was removed', () => {
  const f: PendingFile = { items: [] };
  addPending(f, 'pastilles lave-vaisselle', '2026-10-08');
  addPending(f, 'lait d’avoine', '2026-10-08');
  assert.deepEqual(removePending(f, ['Pastilles lave-vaisselle', 'inconnu']).map((i) => i.item), ['pastilles lave-vaisselle']);
  assert.equal(f.items.length, 1);
});

test('the list survives a save/load round trip and starts empty', () => {
  assert.deepEqual(loadPending(), { items: [] });
  const f = loadPending();
  addPending(f, 'sacs poubelle', '2026-10-08');
  savePending(f);
  assert.equal(loadPending().items[0].item, 'sacs poubelle');
  assert.throws(() => addPending(loadPending(), '   ', '2026-10-08'), /empty item/);
});
