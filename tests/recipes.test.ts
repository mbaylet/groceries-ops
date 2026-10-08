import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { effectiveTotalMin, filterRecipe, type FilterCriteria } from '../scripts/lib/recipe-filter.ts';
import { listRecipes, loadRecipe, markUsed, recentIds, saveRecipe } from '../scripts/lib/recipe-store.ts';
import { runFetch } from '../scripts/recipes.ts';
import type { Recipe } from '../scripts/recipe-sources/types.ts';
import type { Profile } from '../scripts/lib/profile.ts';
import { paths } from '../scripts/lib/paths.ts';
import { VALID_PROFILE_YAML, useTempRoot } from './helpers.ts';

const BLANQUETTE = 'https://www.marmiton.org/recettes/recette_blanquette-de-veau-facile_19219.aspx';
const fixtureHtml = readFileSync(join(paths.fixtures('marmiton'), 'recipe-blanquette.html'), 'utf8');
const base: Recipe = { source: 'x', url: 'https://x/a', slug: 'a', name: 'Poulet curry', ingredients: ['400 g de poulet', '2 oignons'], steps: ['Cuire.'], tags: [], totalMin: 25 };
const crit: FilterCriteria = { maxTotalMin: 30, exclusions: [], tools: ['oven'], recentIds: [], rejectedIds: [] };

beforeEach(() => useTempRoot());

test('filter: time, fallback, no-time (review focus 5)', () => {
  assert.deepEqual(filterRecipe(base, crit), { keep: true, reasons: [] });
  assert.deepEqual(filterRecipe({ ...base, totalMin: 45 }, crit).reasons, ['too-long:45>30']);
  const noTotal = { ...base, totalMin: undefined, prepMin: 10, cookMin: 15 };
  assert.equal(effectiveTotalMin(noTotal), 25);
  assert.ok(filterRecipe(noTotal, crit).keep);
  assert.deepEqual(filterRecipe({ ...base, totalMin: undefined }, crit).reasons, ['no-time']);
  assert.equal(effectiveTotalMin({ ...base, totalMin: 0, prepMin: 5 }), 5);
});

test('filter: exclusions, tools, recent, rejected', () => {
  assert.deepEqual(filterRecipe(base, { ...crit, exclusions: ['oignons'] }).reasons, ['excluded:oignons']);
  assert.deepEqual(filterRecipe({ ...base, name: 'Poulet curry au Cookeo' }, crit).reasons, ['needs-tool:cookeo']);
  assert.ok(filterRecipe({ ...base, name: 'Poulet curry au Cookeo' }, { ...crit, tools: ['cookeo'] }).keep);
  assert.deepEqual(filterRecipe(base, { ...crit, recentIds: ['x-a'] }).reasons, ['recent']);
  assert.deepEqual(filterRecipe(base, { ...crit, rejectedIds: ['x-a'] }).reasons, ['rejected']);
});

test('filter: minimum rating; unrated recipes fail it', () => {
  const rated = (value: number) => ({ ...base, rating: { value, count: 12 } });
  assert.ok(filterRecipe(rated(4), { ...crit, minRating: 4 }).keep);
  assert.deepEqual(filterRecipe(rated(3.8), { ...crit, minRating: 4 }).reasons, ['low-rating:3.8<4']);
  assert.deepEqual(filterRecipe(base, { ...crit, minRating: 4 }).reasons, ['no-rating']);
  assert.ok(filterRecipe(base, crit).keep); // no minimum → rating ignored
});

test('store: save, load, mark used, recent', () => {
  const s = saveRecipe(base, '2026-10-01');
  assert.equal(s.id, 'x-a');
  assert.equal(s.parsed_ingredients[0].key, 'poulet');
  markUsed('x-a', '2026-09-20');
  saveRecipe({ ...base, name: 'Poulet curry v2' }, '2026-10-02'); // re-save keeps history
  const loaded = loadRecipe('x-a');
  assert.equal(loaded.name, 'Poulet curry v2');
  assert.deepEqual(loaded.used_on, ['2026-09-20']);
  assert.deepEqual(recentIds(3, '2026-10-06'), ['x-a']);
  assert.deepEqual(recentIds(2, '2026-10-06'), []);
  assert.equal(listRecipes().length, 1);
  assert.throws(() => loadRecipe('nope'), /Unknown recipe "nope"/);
});

test('runFetch: keeps, saves, rejects, reports errors', async () => {
  const profile = YAML.parse(VALID_PROFILE_YAML) as Profile; // excludes champignon
  const fetcher = async (u: string) => {
    if (u.includes('broken')) throw new Error('HTTP 500');
    return fixtureHtml;
  };
  const day = '2026-10-06';

  const [excluded] = await runFetch([BLANQUETTE], { maxMin: 180, rejectIds: [], today: day }, { profile, fetcher });
  assert.deepEqual(excluded.reasons, ['excluded:champignon']);
  assert.ok(!existsSync(join(paths.recipes(), 'marmiton-blanquette-de-veau-facile-19219.md')));

  const open = { ...profile, food: { ...profile.food, exclusions: [] } };
  const [tooLong] = await runFetch([BLANQUETTE], { rejectIds: [], today: day }, { profile: open, fetcher });
  assert.deepEqual(tooLong.reasons, ['too-long:135>30']);

  const [kept] = await runFetch([BLANQUETTE], { maxMin: 180, rejectIds: [], today: day }, { profile: open, fetcher });
  assert.ok(kept.keep);
  assert.equal(kept.id, 'marmiton-blanquette-de-veau-facile-19219');
  assert.equal(kept.summary?.totalMin, 135);
  assert.ok(existsSync(join(paths.recipes(), 'marmiton-blanquette-de-veau-facile-19219.md')));

  const results = await runFetch(
    ['https://www.marmiton.org/recettes/recette_broken_1.aspx', 'https://unknown.org/r'],
    { rejectIds: [], today: day }, { profile: open, fetcher });
  assert.equal(results[0].error, 'HTTP 500');
  assert.match(results[1].error ?? '', /No recipe source handles/);

  const disabled = { ...open, recipes: { sources: ['other'] } };
  const [off] = await runFetch([BLANQUETTE], { rejectIds: [], today: day }, { profile: disabled, fetcher });
  assert.deepEqual(off.reasons, ['source-disabled:marmiton']);

  const picky = { ...open, recipes: { ...open.recipes, min_rating: 4.95 } }; // fixture is rated 4.9
  const [low] = await runFetch([BLANQUETTE], { maxMin: 180, rejectIds: [], today: day }, { profile: picky, fetcher });
  assert.deepEqual(low.reasons, ['low-rating:4.9<4.95']);
});
