import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { SOURCES, fetchRecipe, getSource, searchRecipes, sourceForUrl } from '../scripts/recipe-sources/index.ts';
import { marmiton, marmitonSlug } from '../scripts/recipe-sources/marmiton.ts';
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
});
