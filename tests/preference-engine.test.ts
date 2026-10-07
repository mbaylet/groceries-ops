import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeRules, computePacks, resolveItem } from '../scripts/lib/preference-engine.ts';
import { DEFAULT_SCORING, type Rule, type Scoring } from '../scripts/lib/rules.ts';
import type { Product } from '../scripts/lib/product-mapper.ts';

const P = (ean: string, title: string, unitPrice: number | undefined, extra: Partial<Product> = {}): Product => ({
  ean, title, unitPrice, unit: 'kg', price: unitPrice, available: true, text: title, ...extra,
});
const rules: Rule[] = [
  { id: 'oeufs', applies_to: { match: ['oeuf'] }, forbid: { any: ['sol', 'cage'] } },
  { id: 'poulet', applies_to: { match: ['poulet'], not_match: ['bouillon'] }, require: { any: ['plein air', 'label rouge', 'bio'] } },
  { id: 'enfant-bio', applies_to: { tags: ['enfant'] }, require: { any: ['bio'] }, priority: 10 },
  { id: 'bio-raisonnable', applies_to: 'all', prefer: { any: ['bio'] }, max_premium_pct: 20 },
];
const S = DEFAULT_SCORING;

test('hard forbid removes barn eggs; whole words only (review focus 3)', () => {
  const d = resolveItem({ item: 'oeufs' }, [
    P('1', 'Oeufs de poules élevées au sol x12', 2.5),
    P('2', 'Oeufs plein air x12', 3.5),
    P('3', 'Oeufs frais extra solaire x12', 3.6),
  ], rules, S);
  assert.equal(d.status, 'chosen');
  assert.equal(d.choice?.ean, '2');
  assert.deepEqual(d.eliminated, [{ ean: '1', title: 'Oeufs de poules élevées au sol x12', reasons: ['oeufs'] }]);
});

test('require with scope exclusions', () => {
  const ps = [P('a', 'Filet de poulet', 9), P('b', 'Filet de poulet fermier Label Rouge', 14)];
  assert.equal(resolveItem({ item: 'blanc de poulet' }, ps, rules, S).choice?.ean, 'b');
  assert.equal(resolveItem({ item: 'bouillon de poulet' }, ps, rules, S).choice?.ean, 'a');
});

test('capped preference wins within the cap, not beyond (lexicographic)', () => {
  const inCap = resolveItem({ item: 'lentilles' }, [P('n', 'Lentilles vertes', 10), P('b', 'Lentilles vertes bio', 11.9)], rules, S);
  assert.equal(inCap.choice?.ean, 'b');
  assert.ok(inCap.why.includes('bio-raisonnable:+19%'), inCap.why.join(','));
  const beyond = resolveItem({ item: 'lentilles' }, [P('n', 'Lentilles vertes', 10), P('b', 'Lentilles vertes bio', 12.1)], rules, S);
  assert.equal(beyond.choice?.ean, 'n');
});

test('capped preference ignores products without unit price (review focus 2)', () => {
  const d = resolveItem({ item: 'lentilles' }, [P('n', 'Lentilles vertes', 10), P('b', 'Lentilles vertes bio', undefined, { price: 2 })], rules, S);
  assert.equal(d.choice?.ean, 'n');
});

test('more specific rule shadows the general one (child food)', () => {
  const req = { item: 'compote', tags: ['enfant'] };
  assert.deepEqual(activeRules(rules, req).shadowed, ['bio-raisonnable']);
  const d = resolveItem(req, [P('n', 'Compote pomme', 3), P('b', 'Compote pomme bio', 6)], rules, S);
  assert.equal(d.choice?.ean, 'b');
  assert.ok(d.flags.includes('shadowed:bio-raisonnable'));
});

test('closed world: unknown attribute rejects, or asks', () => {
  const budget: Rule[] = [{ id: 'cafe', applies_to: { match: ['cafe'] }, budget: { max_price_per_kg: 25 } }];
  const ps = [P('x', 'Café moulu', undefined, { price: 4 })];
  const rejected = resolveItem({ item: 'café' }, ps, budget, S);
  assert.equal(rejected.status, 'none');
  assert.deepEqual(rejected.eliminated[0].reasons, ['unknown:cafe']);
  const asked = resolveItem({ item: 'café' }, ps, budget, { ...S, on_unknown: 'ask' });
  assert.equal(asked.status, 'ask');
  assert.equal(asked.options?.[0].ean, 'x');
});

test('soft rules are relaxed when nothing survives; hard rules never', () => {
  const soft: Rule[] = [{ id: 'cafe', applies_to: { match: ['cafe'] }, budget: { max_price_per_kg: 10 }, strictness: 'soft' }];
  const ps = [P('x', 'Café moulu', 18), P('y', 'Café grains', 22)];
  const relaxed = resolveItem({ item: 'café' }, ps, soft, S);
  assert.equal(relaxed.status, 'chosen');
  assert.deepEqual(relaxed.relaxed, ['cafe']);
  assert.equal(relaxed.choice?.ean, 'x');
  const hard = resolveItem({ item: 'café' }, ps, [{ ...soft[0], strictness: 'hard' }], S);
  assert.equal(hard.status, 'none');
  assert.deepEqual(hard.relaxed, []);
});

test('unavailable products are eliminated; empty search → none', () => {
  const d = resolveItem({ item: 'riz' }, [P('x', 'Riz', 2, { available: false })], [], S);
  assert.equal(d.status, 'none');
  assert.deepEqual(d.eliminated[0].reasons, ['unavailable']);
  assert.equal(resolveItem({ item: 'riz' }, [], [], S).status, 'none');
});

test('indifference: near-equal prices tie and the cheaper wins without a close call', () => {
  const d = resolveItem({ item: 'riz' }, [P('a', 'Riz long', 2.0), P('b', 'Riz long grain', 2.04)], [], S);
  assert.equal(d.status, 'chosen');
  assert.equal(d.choice?.ean, 'a');
});

test('close call only for a real trade-off between preferences', () => {
  const pref: Rule[] = [{ id: 'label-rouge', applies_to: 'all', prefer: { any: ['label rouge'] }, weight: 1 }];
  const sc: Scoring = { ...S, weights: { price_per_unit: 0.9, preferences: 0.1, rating: 0 } };
  const close = resolveItem({ item: 'poulet entier' }, [P('a', 'Poulet entier', 10), P('b', 'Poulet entier Label Rouge', 10.8)], pref, sc);
  assert.equal(close.status, 'close_call');
  assert.deepEqual(close.options?.map((o) => o.ean), ['b', 'a']);
  const clear = resolveItem({ item: 'poulet entier' }, [P('a', 'Poulet entier', 10), P('b', 'Poulet entier Label Rouge', 10.5)], pref, sc);
  assert.equal(clear.status, 'chosen');
  assert.equal(clear.choice?.ean, 'b');
});

test('status quo: remembered product kept within indifference only', () => {
  const ps = [P('a', 'Lait demi-écrémé', 1.0), P('b', 'Lait demi-écrémé UHT', 1.02), P('c', 'Lait demi-écrémé bouteille', 1.2)];
  const kept = resolveItem({ item: 'lait' }, ps, [], S, { preferredEans: ['b'] });
  assert.equal(kept.choice?.ean, 'b');
  assert.ok(kept.why.includes('status-quo'));
  const replaced = resolveItem({ item: 'lait' }, ps, [], S, { preferredEans: ['c'] });
  assert.equal(replaced.choice?.ean, 'a');
});

test('remembered product never bypasses a hard rule', () => {
  const d = resolveItem({ item: 'oeufs' }, [P('1', 'Oeufs élevés au sol', 2.5), P('2', 'Oeufs plein air', 3.5)], rules, S, { preferredEans: ['1'] });
  assert.equal(d.choice?.ean, '2');
});

test('pareto pruning keeps dominated products out of options', () => {
  const pref: Rule[] = [{ id: 'label-rouge', applies_to: 'all', prefer: { any: ['label rouge'] }, weight: 1 }];
  const sc: Scoring = { ...S, weights: { price_per_unit: 0.9, preferences: 0.1, rating: 0 } };
  const d = resolveItem({ item: 'poulet entier' }, [
    P('a', 'Poulet entier', 10), P('b', 'Poulet entier Label Rouge', 10.8), P('z', 'Poulet entier premium', 13),
  ], pref, sc);
  assert.ok(!(d.options ?? []).some((o) => o.ean === 'z'));
});

test('computePacks', () => {
  assert.deepEqual(computePacks({ qty: 400, unit: 'g' }, P('x', 'x', 1, { packQty: 250, packUnit: 'g' })), { packs: 2 });
  assert.deepEqual(computePacks({ qty: 6 }, P('x', 'x', 1, { packQty: 4, packUnit: 'piece' })), { packs: 2 });
  assert.deepEqual(computePacks({ qty: 1, unit: 'kg' }, P('x', 'x', 1, { packQty: 1000, packUnit: 'g' })), { packs: 1 });
  assert.deepEqual(computePacks({ qty: 2, unit: 'cas' }, P('x', 'x', 1, { packQty: 500, packUnit: 'g' })), { packs: 1, flag: 'qty-unknown' });
  assert.deepEqual(computePacks(undefined, P('x', 'x', 1)), { packs: 1 });
});

test('irrelevant search results never win (relevance to the requested item)', () => {
  const d = resolveItem({ item: 'blanc de poulet' }, [
    P('c', 'Chips saveur poulet', 8),
    P('b', 'Blanc de poulet fermier plein air', 14),
  ], rules, S);
  assert.equal(d.choice?.ean, 'b');
  assert.deepEqual(d.eliminated.find((e) => e.ean === 'c')?.reasons, ['not-relevant']);
  assert.equal(resolveItem({ item: 'lait' }, [P('x', 'Biscuits chocolat', 0.4)], [], S).status, 'none');
});

test('prices in different units are never compared directly', () => {
  const d = resolveItem({ item: 'bananes' }, [
    P('k', 'Bananes', 1.99, { unit: 'kg' }),
    P('p', 'Bananes x5', 0.3, { unit: 'piece' }),
    P('k2', 'Bananes bio', 2.6, { unit: 'kg' }),
  ], [], S);
  assert.equal(d.choice?.ean, 'k');
});
