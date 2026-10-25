import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { SOURCES, fetchRecipe, getSource, searchRecipes, sourceForUrl } from '../scripts/recipe-sources/index.ts';
import { marmiton, marmitonSlug } from '../scripts/recipe-sources/marmiton.ts';
import { cuisineaz } from '../scripts/recipe-sources/cuisineaz.ts';
import { ptitchef } from '../scripts/recipe-sources/ptitchef.ts';
import { paths } from '../scripts/lib/paths.ts';

const fixture = (id: string, name: string) => readFileSync(join(paths.fixtures(id), name), 'utf8');
const BLANQUETTE = 'https://www.marmiton.org/recettes/recette_blanquette-de-veau-facile_19219.aspx';

test('contract: every registered source parses its fixture into a valid Recipe', () => {
  for (const s of SOURCES) {
    assert.ok(s.matches(s.healthUrl), `${s.id} must claim its healthUrl`);
    const dir = paths.fixtures(s.id);
    assert.ok(existsSync(dir), `${s.id} needs tests/fixtures/${s.id}/`);
    const files = readdirSync(dir).filter((f) => f.startsWith('recipe-'));
    assert.ok(files.length > 0, `${s.id} needs a recipe-*.html fixture`);
    for (const f of files) {
      const r = s.parse(fixture(s.id, f), s.healthUrl);
      assert.equal(r.source, s.id);
      assert.ok(r.name && r.ingredients.length > 0 && r.slug);
      assert.ok(r.totalMin !== undefined || r.prepMin !== undefined || r.cookMin !== undefined, `${f}: no timing`);
      assert.ok(!r.slug.includes('/'));
    }
    if (s.searchUrl) assert.ok(s.parseSearch, `${s.id}: searchUrl requires parseSearch`);
  }
});

test('marmiton url handling', () => {
  assert.ok(marmiton.matches(BLANQUETTE));
  assert.ok(!marmiton.matches('https://www.marmiton.org/recettes/recherche.aspx?aqt=curry'));
  assert.ok(!marmiton.matches('https://www.750g.com/x.htm'));
  assert.equal(marmitonSlug(BLANQUETTE), 'blanquette-de-veau-facile-19219');
  assert.equal(marmiton.searchUrl?.('poulet curry'), 'https://www.marmiton.org/recettes/recherche.aspx?aqt=poulet%20curry');
  assert.equal(marmiton.searchUrl?.('poulet curry', 1), 'https://www.marmiton.org/recettes/recherche.aspx?aqt=poulet%20curry');
  assert.equal(marmiton.searchUrl?.('poulet curry', 2), 'https://www.marmiton.org/recettes/recherche.aspx?aqt=poulet%20curry&page=2');
});

test('cuisineaz: urls, search tiles only (no menu or sidebar links)', () => {
  const url = 'https://www.cuisineaz.com/recettes/blanquette-de-veau-a-l-ancienne-1548.aspx';
  assert.ok(cuisineaz.matches(url));
  assert.ok(cuisineaz.matches('https://cuisineaz.com/recettes/crepe-facile-78347.aspx'));
  assert.ok(!cuisineaz.matches('https://www.cuisineaz.com/recettes/recherche_terme.aspx?recherche=curry'));
  assert.ok(!cuisineaz.matches('https://www.cuisineaz.com/articles/gateau-au-yaourt-21646.aspx'));
  assert.ok(!cuisineaz.matches(BLANQUETTE));
  const r = cuisineaz.parse(fixture('cuisineaz', 'recipe-blanquette.html'), url);
  assert.equal(r.slug, 'blanquette-de-veau-a-l-ancienne-1548');
  assert.equal(r.prepMin, 30);
  assert.equal(r.cookMin, 105);
  assert.equal(cuisineaz.searchUrl?.('gratin courgette'), 'https://www.cuisineaz.com/recettes/recherche_terme.aspx?recherche=gratin%20courgette');
  assert.equal(cuisineaz.searchUrl?.('gratin courgette', 3), 'https://www.cuisineaz.com/recettes/recherche_terme.aspx?recherche=gratin%20courgette&page=3');
  const urls = cuisineaz.parseSearch!(fixture('cuisineaz', 'search-gratin-courgette.html'));
  assert.equal(urls.length, 20);
  assert.equal(urls[0], 'https://www.cuisineaz.com/recettes/gratin-de-courgettes-simple-122741.aspx');
  assert.ok(urls.every((u) => cuisineaz.matches(u)));
  assert.ok(!urls.some((u) => u.includes('crepe-facile')));
  assert.equal(new Set(urls).size, urls.length);
});

test('ptitchef: urls, search list, single page', () => {
  const url = 'https://www.ptitchef.com/recettes/entree/gratin-courgette-et-filet-de-julienne-fid-980940';
  assert.ok(ptitchef.matches(url));
  assert.ok(!ptitchef.matches('https://www.ptitchef.com/recettes/gratin-de-courgettes'));
  assert.ok(!ptitchef.matches('https://www.ptitchef.com/dossiers/air-fryer-des-idees-aid-43734'));
  const r = ptitchef.parse(fixture('ptitchef', 'recipe-gratin-courgette.html'), url);
  assert.equal(r.slug, 'gratin-courgette-et-filet-de-julienne-fid-980940');
  assert.equal(r.prepMin, 10);
  assert.equal(r.cookMin, 25);
  assert.equal(ptitchef.searchUrl?.('gratin courgette'), 'https://www.ptitchef.com/index.php?obj=feed&action=list&q=gratin%20courgette');
  assert.equal(ptitchef.maxPages, 1);
  const urls = ptitchef.parseSearch!(fixture('ptitchef', 'search-gratin-courgette.html'));
  assert.equal(urls.length, 24);
  assert.ok(urls.every((u) => ptitchef.matches(u)));
  assert.equal(new Set(urls).size, urls.length);
});

test('marmiton search results from ItemList JSON-LD', () => {
  const urls = marmiton.parseSearch!(fixture('marmiton', 'search-curry-poulet.html'));
  assert.ok(urls.length >= 5);
  assert.equal(urls[0], 'https://www.marmiton.org/recettes/recette_filet-de-poulet-au-curry_80990.aspx');
  assert.ok(urls.every((u) => marmiton.matches(u)));
  assert.equal(new Set(urls).size, urls.length);
});

test('registry dispatch with injected fetcher', async () => {
  assert.equal(sourceForUrl(BLANQUETTE)?.id, 'marmiton');
  assert.equal(sourceForUrl('https://unknown.org/r'), undefined);
  assert.throws(() => getSource('nope'), /Unknown recipe source "nope"/);
  const r = await fetchRecipe(BLANQUETTE, async () => fixture('marmiton', 'recipe-blanquette.html'));
  assert.equal(r.slug, 'blanquette-de-veau-facile-19219');
  await assert.rejects(fetchRecipe('https://unknown.org/r', async () => ''), /No recipe source handles/);
  const urls = await searchRecipes('marmiton', 'curry', 3, async (u) => {
    assert.match(u, /recherche\.aspx\?aqt=curry/);
    return fixture('marmiton', 'search-curry-poulet.html');
  });
  assert.equal(urls.length, 3);
  const page2 = await searchRecipes('marmiton', 'curry', 3, async (u) => {
    assert.match(u, /aqt=curry&page=2$/);
    return fixture('marmiton', 'search-curry-poulet.html');
  }, 2);
  assert.equal(page2.length, 3);
});
