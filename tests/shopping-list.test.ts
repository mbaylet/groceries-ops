import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildList, loadStaples, type RecipeInput } from '../scripts/lib/shopping-list.ts';

const staples = loadStaples();
const curry: RecipeInput = { id: 'm-curry', servings: 4, ingredients: ['3 oignons', '400 g de blanc de poulet', '20 cl de lait de coco', '1 cuillère à soupe de curry', 'sel'] };
const gratin: RecipeInput = { id: 'm-gratin', servings: 4, ingredients: ['2 oignons', '3 courgettes', '20 cl de crème fraîche', '100 g de gruyère râpé'] };
const item = (l: ReturnType<typeof buildList>, key: string, unit?: string) => l.items.find((i) => i.key === key && i.unit === unit);

test('merges across recipes keeping per-recipe contributions', () => {
  const l = buildList([curry, gratin], 4, staples);
  const onion = item(l, 'oignon');
  assert.equal(onion?.total, 5);
  assert.deepEqual(onion?.contributions, { 'm-curry': 3, 'm-gratin': 2 });
  assert.deepEqual(l.recipeIds, ['m-curry', 'm-gratin']);
});

test('dropping a recipe reduces shared items and removes exclusive ones', () => {
  const l = buildList([curry], 4, staples);
  assert.equal(item(l, 'oignon')?.total, 3);
  assert.equal(item(l, 'courgette'), undefined);
});

test('scales to servings', () => {
  const l = buildList([curry], 2, staples);
  assert.equal(item(l, 'blanc de poulet', 'g')?.total, 200);
  assert.equal(item(l, 'oignon')?.total, 1.5);
});

test('staples are flagged and sorted last', () => {
  const l = buildList([curry], 4, staples);
  assert.equal(item(l, 'curry', 'cas')?.staple, true);
  assert.equal(item(l, 'sel')?.staple, true);
  assert.equal(item(l, 'sel')?.total, undefined);
  assert.equal(item(l, 'oignon')?.staple, false);
  const firstStaple = l.items.findIndex((i) => i.staple);
  assert.ok(l.items.slice(firstStaple).every((i) => i.staple));
});

test('the shipped staples cover kitchen consumables such as baking paper', () => {
  const l = buildList([{ id: 'p', servings: 2, ingredients: ['4 feuilles de papier sulfurisé', 'papier cuisson', '1 oignon'] }], 2, staples);
  assert.equal(l.items.filter((i) => i.staple).length, 2);
  assert.equal(item(l, 'oignon')?.staple, false);
});

test('units are not merged across different units', () => {
  const l = buildList([{ id: 'a', servings: 2, ingredients: ['1 oignon', "100 g d'oignon"] }], 2, staples);
  assert.equal(l.items.filter((i) => i.key === 'oignon').length, 2);
});

test('missing yield → unscaled with warning (review focus 5); roles', () => {
  const l = buildList([{ id: 'nyield', ingredients: ['2 courgettes', '(facultatif)', '500 g de pâtes'] }], 8, staples);
  assert.equal(item(l, 'courgette')?.total, 2);
  assert.ok(l.warnings.includes('no-yield:nyield'));
  assert.ok(l.warnings.includes('unparsed:(facultatif)'));
  assert.equal(item(l, 'pate', 'g')?.role, 'key');
  assert.equal(item(l, 'courgette')?.role, 'key');
  assert.equal(buildList([curry], 4, staples).items.find((i) => i.key === 'oignon')?.role, 'minor');
});
