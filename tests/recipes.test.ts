import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { effectiveTotalMin, filterRecipe, type FilterCriteria } from '../scripts/lib/recipe-filter.ts';
import { listRecipes, loadRecipe, markUsed, recentIds, saveRecipe } from '../scripts/lib/recipe-store.ts';
import { runFetch, runFind } from '../scripts/recipes.ts';
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

test('filter: total is prep + cook when both exist, even if totalTime disagrees', () => {
  const lying = { ...base, totalMin: 10, prepMin: 10, cookMin: 60 }; // site reports total = prep
  assert.equal(effectiveTotalMin(lying), 70);
  assert.deepEqual(filterRecipe(lying, crit).reasons, ['too-long:70>30']);
  assert.equal(effectiveTotalMin({ ...base, totalMin: 40, prepMin: 10 }), 40); // cook missing → totalTime
  assert.equal(effectiveTotalMin({ ...base, totalMin: undefined, prepMin: 10, cookMin: 0 }), 10);
});

test('filter: preparation cap', () => {
  const timed = (prepMin: number | undefined, cookMin = 10) => ({ ...base, totalMin: undefined, prepMin, cookMin });
  const capped = { ...crit, maxPrepMin: 10 };
  assert.ok(filterRecipe(timed(10), capped).keep);
  assert.deepEqual(filterRecipe(timed(15), capped).reasons, ['prep-too-long:15>10']);
  assert.deepEqual(filterRecipe(timed(undefined), capped).reasons, ['no-prep-time']);
  assert.ok(filterRecipe(timed(15), crit).keep); // no cap → prep ignored
});

test('filter: minimum number of ratings', () => {
  const rated = (value: number, count: number) => ({ ...base, rating: { value, count } });
  const c = { ...crit, minRating: 4.5, minRatingCount: 10 };
  assert.ok(filterRecipe(rated(4.6, 10), c).keep);
  assert.deepEqual(filterRecipe(rated(5, 2), c).reasons, ['few-ratings:2<10']);
  assert.deepEqual(filterRecipe(rated(4.2, 50), c).reasons, ['low-rating:4.2<4.5']);
  assert.deepEqual(filterRecipe(rated(4, 3), c).reasons, ['low-rating:4<4.5', 'few-ratings:3<10']);
  assert.deepEqual(filterRecipe(base, c).reasons, ['no-rating']);
  assert.ok(filterRecipe(rated(5, 2), { ...crit, minRatingCount: undefined }).keep);
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

const searchHtml = readFileSync(join(paths.fixtures('marmiton'), 'search-curry-poulet.html'), 'utf8');
const open = (): Profile => {
  const p = YAML.parse(VALID_PROFILE_YAML) as Profile;
  return { ...p, food: { ...p.food, exclusions: [] }, recipes: { sources: ['marmiton', 'ptitchef'] } };
};
const findOpts = { queries: ['curry'], pages: 1, want: 100, maxMin: 180, rejectIds: [] as string[], today: '2026-10-06', delayMs: 0 };

/** Serves the Marmiton search fixture for search pages and the blanquette fixture for any recipe page. */
function fakeWeb() {
  const calls: string[] = [];
  const fetcher = async (u: string) => {
    calls.push(u);
    if (u.includes('recherche.aspx')) return searchHtml;
    if (u.includes('broken')) throw new Error('HTTP 500');
    return fixtureHtml;
  };
  return { calls, fetcher };
}

test('fetch: --max-prep rejects long preparation, and the profile cap is the default', async () => {
  const web = fakeWeb();
  const profile = open();
  const [byFlag] = await runFetch([BLANQUETTE], { maxMin: 180, maxPrep: 10, rejectIds: [], today: '2026-10-06' }, { profile, fetcher: web.fetcher });
  assert.deepEqual(byFlag.reasons, ['prep-too-long:15>10']);
  const capped = { ...profile, time: { ...profile.time, weekday_prep_max_min: 10 } };
  const [byProfile] = await runFetch([BLANQUETTE], { maxMin: 180, rejectIds: [], today: '2026-10-06' }, { profile: capped, fetcher: web.fetcher });
  assert.deepEqual(byProfile.reasons, ['prep-too-long:15>10']);
  const [overridden] = await runFetch([BLANQUETTE], { maxMin: 180, maxPrep: 20, rejectIds: [], today: '2026-10-06' }, { profile: capped, fetcher: web.fetcher });
  assert.ok(overridden.keep);
  assert.equal(overridden.summary?.prepMin, 15);
  assert.equal(overridden.summary?.cookMin, 120);
});

test('find: searches, fetches, filters and returns only the kept recipes', async () => {
  const web = fakeWeb();
  const r = await runFind(findOpts, { profile: open(), fetcher: web.fetcher });
  assert.equal(r.kept.length, 10);
  assert.ok(r.kept.every((k) => k.keep && k.summary?.prepMin === 15));
  assert.equal(r.stats.examined, 10);
  assert.deepEqual(r.stats.rejected, {});
  assert.ok(existsSync(join(paths.recipes(), `${r.kept[0].id}.md`)));
  assert.equal(r.enough, false); // asked for 100, the search only had 10
});

test('find: counts rejections by reason and says when nothing is left', async () => {
  const web = fakeWeb();
  const r = await runFind({ ...findOpts, maxMin: 60, maxPrep: 10 }, { profile: open(), fetcher: web.fetcher });
  assert.equal(r.kept.length, 0);
  assert.equal(r.stats.rejected['too-long'], 10);
  assert.equal(r.stats.rejected['prep-too-long'], 10);
  assert.equal(r.enough, false);
});

test('find: stops fetching once enough recipes are kept', async () => {
  const web = fakeWeb();
  const r = await runFind({ ...findOpts, want: 3, concurrency: 2 }, { profile: open(), fetcher: web.fetcher });
  assert.ok(r.kept.length >= 3 && r.kept.length <= 4); // batches of 2 may overshoot by one
  assert.ok(web.calls.filter((u) => !u.includes('recherche')).length <= 4);
  assert.equal(r.enough, true);
});

test('find: pages, dedupes urls across queries and pages, honours maxPages', async () => {
  const web = fakeWeb();
  const r = await runFind({ ...findOpts, queries: ['curry', 'poulet'], pages: 2 }, { profile: open(), fetcher: web.fetcher });
  const searches = web.calls.filter((u) => u.includes('recherche.aspx'));
  assert.equal(searches.length, 4);
  assert.ok(searches.some((u) => u.includes('aqt=poulet&page=2')));
  assert.equal(r.stats.examined, 10); // same fixture every time → 10 distinct urls
  const ptit = fakeWeb();
  await runFind({ ...findOpts, source: 'ptitchef', pages: 3 }, { profile: open(), fetcher: async (u) => { ptit.calls.push(u); return ''; } });
  assert.equal(ptit.calls.length, 1); // ptitchef serves one page only
});

test('find: errors are reported, not thrown; disabled and search-less sources are explained', async () => {
  const r = await runFind({ ...findOpts, source: 'cuisineaz' }, { profile: open(), fetcher: fakeWeb().fetcher });
  assert.equal(r.kept.length, 0);
  assert.match(r.stats.errors[0], /cuisineaz.*not enabled/);
  const failing = await runFind(findOpts, { profile: open(), fetcher: async () => { throw new Error('HTTP 503'); } });
  assert.equal(failing.kept.length, 0);
  assert.match(failing.stats.errors[0], /HTTP 503/);
});

test('find: re-evaluates a saved recipe from disk instead of downloading it again', async () => {
  const web = fakeWeb();
  const first = await runFind({ ...findOpts, want: 1, concurrency: 1 }, { profile: open(), fetcher: web.fetcher });
  const url = first.kept[0].url;
  const web2 = fakeWeb();
  const again = await runFind({ ...findOpts, maxMin: 60 }, { profile: open(), fetcher: web2.fetcher });
  assert.ok(web2.calls.every((u) => u !== url)); // known url never re-downloaded
  assert.equal(again.stats.fromStore, 1);
  assert.equal(again.stats.rejected['too-long'], 10);
});
