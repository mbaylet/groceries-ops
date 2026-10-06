import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dueItems, habitKey, isDue, medianInterval, nextDue, proposals, proposeMode, reconcile, recordAnswer, recordPurchases,
  type Habit, type HabitsFile,
} from '../scripts/lib/habits.ts';

const habit = (name: string, dates: string[], extra: Partial<Habit> = {}): Habit => ({
  key: habitKey({ name }), name, mode: 'ask', declines_in_row: 0,
  purchases: dates.map((date) => ({ date, status: 'confirmed' as const })), ...extra,
});
const file = (...habits: Habit[]): HabitsFile => {
  const f = { habits };
  reconcile(f, [], '2000-01-01'); // recompute intervals only
  return f;
};

test('medianInterval', () => {
  assert.equal(medianInterval(['2026-09-01', '2026-09-08', '2026-09-15']), 7);
  assert.equal(medianInterval(['2026-09-15', '2026-09-01', '2026-09-08', '2026-09-08']), 7);
  assert.equal(medianInterval(['2026-09-01', '2026-09-05', '2026-09-15', '2026-09-30']), 10);
  assert.equal(medianInterval(['2026-09-01', '2026-09-05', '2026-09-15']), 7);
  assert.equal(medianInterval(['2026-09-01']), undefined);
});

test('weekly bananas: due and proposed auto', () => {
  const f = file(habit('bananes', ['2026-09-08', '2026-09-15', '2026-09-22', '2026-09-29']));
  const h = f.habits[0];
  assert.equal(h.interval_days, 7);
  assert.ok(isDue(h, '2026-10-06'));
  assert.equal(proposeMode(h, '2026-10-06'), 'auto');
  assert.equal(nextDue(h), '2026-10-05');
});

test('toilet paper every 21 days: due threshold, proposed ask', () => {
  const f = file(habit('papier toilette', ['2026-08-01', '2026-08-22', '2026-09-12']));
  const h = f.habits[0];
  assert.ok(!isDue(h, '2026-09-28')); // 16 days < 0.85 × 21
  assert.ok(isDue(h, '2026-10-01'));  // 19 days
  assert.equal(proposeMode(h, '2026-10-01'), 'ask');
});

test('single or only-pending purchases: never due, never auto (review focus 4)', () => {
  const f = file(habit('cafe', ['2026-09-01']), habit('the', [], { purchases: [{ date: '2026-09-01', status: 'pending' }] }));
  for (const h of f.habits) {
    assert.equal(h.interval_days, undefined);
    assert.ok(!isDue(h, '2026-12-01'));
    assert.equal(proposeMode(h, '2026-12-01'), 'ask');
  }
  assert.deepEqual(proposals(f, '2026-12-01'), []);
});

test('declines: snooze same day, widen after 3', () => {
  const f = file(habit('cereales', ['2026-08-01', '2026-08-22', '2026-09-12']));
  recordAnswer(f, f.habits[0].key, 'no', '2026-10-01');
  assert.ok(!isDue(f.habits[0], '2026-10-01'));
  assert.ok(isDue(f.habits[0], '2026-10-02'));
  recordAnswer(f, f.habits[0].key, 'no', '2026-10-02');
  recordAnswer(f, f.habits[0].key, 'no', '2026-10-03');
  assert.equal(f.habits[0].interval_override, 32);
  assert.equal(f.habits[0].declines_in_row, 0);
  recordAnswer(f, f.habits[0].key, 'yes', '2026-10-04');
  assert.equal(f.habits[0].declines_in_row, 0);
  assert.throws(() => recordAnswer(f, 'name:nope', 'yes', '2026-10-04'), /Unknown habit/);
});

test('dueItems splits by mode', () => {
  const f = file(
    habit('bananes', ['2026-09-22', '2026-09-29'], { mode: 'auto' }),
    habit('papier toilette', ['2026-08-22', '2026-09-12']),
  );
  const d = dueItems(f, '2026-10-06');
  assert.deepEqual(d.auto.map((h) => h.name), ['bananes']);
  assert.deepEqual(d.ask.map((h) => h.name), ['papier toilette']);
});

test('record + reconcile: confirm, drop stale pending, add external', () => {
  const f: HabitsFile = { habits: [] };
  recordPurchases(f, [{ name: 'Bananes', ean: '111' }, { name: 'Lait' }], '2026-10-06', 'pending');
  recordPurchases(f, [{ name: 'Bananes', ean: '111' }], '2026-10-06', 'pending'); // idempotent
  recordPurchases(f, [{ name: 'Yaourts' }], '2026-09-20', 'pending');
  assert.equal(f.habits.find((h) => h.name === 'Bananes')?.purchases.length, 1);
  const res = reconcile(f, [{ date: '2026-10-07', items: [{ name: 'Bananes', ean: '111' }, { name: 'Lait' }, { name: 'Café', ean: '222' }] }], '2026-10-08');
  assert.deepEqual(res, { confirmed: 2, dropped: 1, added: 1 });
  const bananas = f.habits.find((h) => h.ean === '111');
  assert.deepEqual(bananas?.purchases, [{ date: '2026-10-07', status: 'confirmed' }]);
  assert.deepEqual(f.habits.find((h) => h.name === 'Yaourts')?.purchases, []);
  assert.equal(f.habits.find((h) => h.ean === '222')?.mode, 'ask');
});

test('name matching ignores case, accents and plurals', () => {
  const f: HabitsFile = { habits: [] };
  recordPurchases(f, [{ name: 'Céréales' }], '2026-09-01', 'confirmed');
  recordPurchases(f, [{ name: 'cereale' }], '2026-09-15', 'confirmed');
  assert.equal(f.habits.length, 1);
  assert.equal(f.habits[0].purchases.length, 2);
});
