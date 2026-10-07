import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SCORING, resolveScoring, ruleKind, scopesOverlap, validateRules, validateScoring, type Rule } from '../scripts/lib/rules.ts';

const ok: unknown[] = [
  { id: 'oeufs', applies_to: { match: ['oeuf'] }, forbid: { any: ['sol', 'cage'] } },
  { id: 'enfant-bio', applies_to: { tags: ['enfant'] }, require: { any: ['bio'] }, priority: 10 },
  { id: 'bio-raisonnable', applies_to: 'all', prefer: { any: ['bio'] }, max_premium_pct: 20 },
  { id: 'cafe', applies_to: { match: ['cafe'] }, budget: { max_price_per_kg: 25 }, strictness: 'soft' },
];

test('valid rules pass', () => {
  assert.deepEqual(validateRules(ok, ['enfant']), []);
  assert.equal(ruleKind(ok[3] as Rule), 'budget');
});

test('errors name the rule and field', () => {
  const errs = validateRules([
    { id: 'a', applies_to: 'all' },
    { id: 'a', applies_to: { match: [] }, require: { any: ['x'] } },
    { id: 'b', applies_to: { tags: ['bebe'] }, prefer: { anything: ['x'] }, strictness: 'hard' },
    { id: 'c', applies_to: 'all', forbid: { any: ['x'] }, max_premium_pct: 10, weight: 2 },
    { id: 'd', applies_to: 'all', budget: { max_price: -1 } },
    { applies_to: 'all', require: { any: ['x'] } },
  ], ['enfant']).join('\n');
  for (const s of [
    'product_rules.a: needs exactly one of',
    'product_rules.a: duplicate id',
    'product_rules.a.applies_to.match: must be a non-empty list',
    'unknown tag "bebe"',
    'product_rules.b.prefer.anything: unknown key',
    'product_rules.b.strictness: not allowed with prefer',
    'product_rules.c.max_premium_pct: only allowed with prefer',
    'product_rules.c.weight: only allowed with prefer',
    'product_rules.d.budget.max_price: must be a positive number',
    'product_rules[5]: id: must be a non-empty string',
  ]) assert.ok(errs.includes(s), `missing "${s}" in:\n${errs}`);
});

test('contradictions between require and forbid on overlapping scopes', () => {
  const errs = validateRules([
    { id: 'need-bio', applies_to: { match: ['lait'] }, require: { all: ['bio'] } },
    { id: 'no-bio', applies_to: 'all', forbid: { any: ['bio'] } },
  ], []);
  assert.ok(errs.some((e) => e.includes('contradiction')), errs.join('\n'));
  // `any` with an allowed alternative is not a contradiction
  assert.deepEqual(validateRules([
    { id: 'poulet', applies_to: { match: ['poulet'] }, require: { any: ['plein air', 'bio'] } },
    { id: 'no-bio', applies_to: 'all', forbid: { any: ['bio'] } },
  ], []), []);
});

test('scopesOverlap', () => {
  const r = (applies_to: Rule['applies_to']): Rule => ({ id: 'x', applies_to, require: { any: ['y'] } });
  assert.ok(scopesOverlap(r('all'), r({ match: ['oeuf'] })));
  assert.ok(scopesOverlap(r({ match: ['oeufs'] }), r({ match: ['oeuf'] })));
  assert.ok(!scopesOverlap(r({ match: ['oeuf'] }), r({ match: ['poulet'] })));
  assert.ok(scopesOverlap(r({ tags: ['enfant'] }), r({ tags: ['enfant'], match: ['compote'] })));
});

test('scoring validation and defaults', () => {
  assert.deepEqual(validateScoring({ weights: { price_per_unit: 1 }, on_unknown: 'ask' }), []);
  const errs = validateScoring({ weights: { price_per_unit: -1, foo: 1 }, indifference_pct: 80, on_unknown: 'maybe' }).join('\n');
  for (const s of ['scoring.weights.price_per_unit', 'scoring.weights.foo', 'scoring.indifference_pct', 'scoring.on_unknown'])
    assert.ok(errs.includes(s), s);
  assert.deepEqual(validateScoring({ weights: { price_per_unit: 0, preferences: 0, rating: 0 } }), ['scoring.weights: at least one weight must be > 0']);
  assert.deepEqual(resolveScoring(), DEFAULT_SCORING);
  assert.deepEqual(resolveScoring({ weights: { rating: 0 }, on_unknown: 'ask' }).weights, { price_per_unit: 0.6, preferences: 0.35, rating: 0 });
});
