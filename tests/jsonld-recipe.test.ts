import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseRecipeFromHtml, parseYield, slugFromUrl } from '../scripts/lib/jsonld-recipe.ts';
import { RecipeParseError, recipeId } from '../scripts/recipe-sources/types.ts';
import { paths } from '../scripts/lib/paths.ts';

const URL = 'https://www.marmiton.org/recettes/recette_blanquette-de-veau-facile_19219.aspx';
const html = readFileSync(join(paths.fixtures('marmiton'), 'recipe-blanquette.html'), 'utf8');
const ld = (json: string) => `<html><script type="application/ld+json">${json}</script></html>`;

test('parses the Marmiton blanquette fixture', () => {
  const r = parseRecipeFromHtml(html, URL, 'marmiton', 'blanquette-de-veau-facile-19219');
  assert.equal(r.name, 'Blanquette de veau : recette traditionnelle : la meilleure recette');
  assert.equal(r.prepMin, 15);
  assert.equal(r.cookMin, 120);
  assert.equal(r.totalMin, 135);
  assert.equal(r.servings, 4);
  assert.equal(r.ingredients.length, 13);
  assert.equal(r.ingredients[0], '1 kg de blanquette de veau');
  assert.equal(r.steps.length, 7);
  assert.match(r.steps[0], /^Faire revenir la viande/);
  assert.equal(r.category, 'Plat principal');
  assert.deepEqual(r.rating, { value: 4.9, count: 2776 });
  assert.ok(r.tags.includes('blanquette'));
  assert.equal(recipeId(r), 'marmiton-blanquette-de-veau-facile-19219');
});

test('top-level array, HowToSection, yield array (review focus 2)', () => {
  const r = parseRecipeFromHtml(ld(JSON.stringify([
    { '@type': 'WebSite' },
    { '@type': ['Recipe'], name: 'Soupe', recipeIngredient: ['2 poireaux'], recipeYield: ['4', '4 servings'],
      recipeInstructions: [{ '@type': 'HowToSection', itemListElement: [{ '@type': 'HowToStep', text: 'Couper.' }, { '@type': 'HowToStep', text: 'Cuire.' }] }] },
  ])), 'https://ex.org/r/soupe.html', 'ex');
  assert.equal(r.servings, 4);
  assert.deepEqual(r.steps, ['Couper.', 'Cuire.']);
  assert.equal(r.slug, 'soupe');
});

test('raw control characters inside JSON strings', () => {
  const r = parseRecipeFromHtml(ld('{"@type":"Recipe","name":"Soupe\nde poireaux","recipeIngredient":["2 poireaux"],"recipeInstructions":"Couper\nCuire"}'), 'https://ex.org/a', 'ex');
  assert.equal(r.name, 'Soupe de poireaux');
  assert.equal(r.totalMin, undefined);
  assert.equal(r.servings, undefined);
});

test('missing recipe or ingredients throws RecipeParseError', () => {
  assert.throws(() => parseRecipeFromHtml('<html></html>', 'https://ex.org/a', 'ex'), RecipeParseError);
  assert.throws(() => parseRecipeFromHtml(ld('{"@type":"Recipe","name":"X"}'), 'https://ex.org/a', 'ex'), RecipeParseError);
});

test('helpers', () => {
  assert.equal(parseYield('4 personnes'), 4);
  assert.equal(parseYield(6), 6);
  assert.equal(parseYield('quelques'), undefined);
  assert.equal(slugFromUrl('https://ex.org/recettes/Poulet_Curry.aspx'), 'poulet-curry');
});
