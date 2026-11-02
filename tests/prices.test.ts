import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { REPO_ROOT } from '../scripts/lib/paths.ts';
import {
  computeReferencePrice, estimateRecipe, favorTerms, loadReferences, matchReference, priceStatus, readProducts,
  type PriceReference, type PricesFile,
} from '../scripts/lib/prices.ts';
import { useTempRoot, writeValidProfile } from './helpers.ts';

/** Same nesting as a real search_products result (see tests/fixtures/carrefour). */
function product(o: {
  title: string; brand?: string | null; perUnit?: number | null; unit?: string; flags?: string[];
  purchasable?: boolean; marketplace?: unknown;
}) {
  const ean = o.title.length.toString();
  return {
    type: 'product', id: `product-${ean}`,
    attributes: {
      ean, title: o.title, brand: o.brand ?? null, flags: o.flags ?? [],
      offers: { [ean]: { store: { type: 'offer', id: 'store', attributes: {
        availability: { purchasable: o.purchasable ?? true },
        price: { price: 1, unitOfMeasure: o.unit ?? 'KG', perUnit: o.perUnit ?? 10 },
        marketplace: o.marketplace ?? null, ean,
      } } } },
    },
  };
}
const products = (...p: Parameters<typeof product>[0][]) => readProducts({ data: p.map(product) });

const poulet: PriceReference = { id: 'blanc-poulet', query: 'blanc de poulet', unit: 'kg', match: ['blanc de poulet'], must: ['blanc de poulet', 'filet de poulet', 'poulet'], exclude: ['pane'] };
const carotte: PriceReference = { id: 'carotte', query: 'carotte', unit: 'kg', match: ['carotte'], must: ['carotte'], exclude: ['rapee'], sizes: { piece: 100 } };
const creme: PriceReference = { id: 'creme', query: 'creme fraiche', unit: 'l', match: ['creme'], must: ['creme'] };
const oeuf: PriceReference = { id: 'oeuf', query: 'oeufs', unit: 'u', match: ['oeuf'], must: ['oeuf'], sizes: { piece: 60 } };
const refs = [poulet, carotte, creme, oeuf];
const prices: PricesFile = {
  updated: '2026-10-01',
  prices: {
    'blanc-poulet': { unitPrice: 20, unit: 'kg', count: 3, date: '2026-10-01' },
    carotte: { unitPrice: 2, unit: 'kg', count: 3, date: '2026-10-01' },
    creme: { unitPrice: 4, unit: 'l', count: 3, date: '2026-10-01' },
    oeuf: { unitPrice: 0.3, unit: 'u', count: 3, date: '2026-10-01' },
  },
};
const staples = ['sel', 'poivre', 'huile'];

test('the retained price is the mean of the relevant products, ignoring noise', () => {
  const r = computeReferencePrice(poulet, products(
    { title: 'Blanc de poulet', perUnit: 10 },
    { title: 'Filet de poulet', perUnit: 20 },
    { title: 'Poulet pané', perUnit: 99 },              // excluded word
    { title: 'Curry Tandoori', perUnit: 99 },           // not relevant
    { title: 'Poulet vendu ailleurs', perUnit: 99, marketplace: { seller: 'x' } },
    { title: 'Poulet épuisé', perUnit: 99, purchasable: false },
    { title: 'Poulet à la pièce', perUnit: 99, unit: 'U' }, // another unit
    { title: 'Poulet premier prix', perUnit: 1, brand: 'SIMPL' },
  ), { favor: [], entryLevelBrands: ['SIMPL'] });
  assert.deepEqual(r, { ok: true, unitPrice: 15, unit: 'kg', count: 2, approximate: false });
});

test('a product only mentioning the ingredient is not that ingredient', () => {
  const beurre: PriceReference = { id: 'beurre', query: 'beurre', unit: 'kg', match: ['beurre'], must: ['beurre'] };
  const r = computeReferencePrice(beurre, products(
    { title: 'Beurre doux', perUnit: 10 },
    { title: 'Haricots verts et beurre', perUnit: 5 },
  ), { favor: [], entryLevelBrands: [] });
  assert.ok(r.ok);
  assert.equal(r.unitPrice, 10);
  assert.equal(r.count, 1);
});

test('prices far from the median do not distort the mean', () => {
  const r = computeReferencePrice(carotte, products(
    { title: 'Carottes A', perUnit: 10 }, { title: 'Carottes B', perUnit: 11 }, { title: 'Carottes C', perUnit: 12 },
    { title: 'Carottes séchées D', perUnit: 300 }, { title: 'Carottes E', perUnit: 1 },
  ), { favor: [], entryLevelBrands: [] });
  assert.ok(r.ok);
  // médiane 11 : 300 et 1 sortent de [5,5 ; 22] ; moyenne de 10, 11, 12
  assert.equal(r.unitPrice, 11);
  assert.equal(r.count, 3);
});

test('a reference can cap the price of a credible product', () => {
  const echalote: PriceReference = { id: 'echalote', query: 'echalotes', unit: 'kg', match: ['echalote'], must: ['echalote'], max: 12 };
  // Sans plafond, les échalotes séchées (38 et 75 €/kg) déplaceraient la médiane à 26 €/kg.
  const r = computeReferencePrice(echalote, products(
    { title: 'Echalote vrac', perUnit: 4 }, { title: 'Echalote bio', perUnit: 8 }, { title: 'Echalote A', perUnit: 26 },
    { title: 'Echalote B', perUnit: 38 }, { title: 'Echalote C', perUnit: 75 },
  ), { favor: [], entryLevelBrands: [] });
  assert.ok(r.ok);
  assert.equal(r.unitPrice, 6);
  assert.equal(r.count, 2);
});

test('store unit spellings are the same unit', () => {
  const r = computeReferencePrice(creme, products(
    { title: 'Crème A', perUnit: 2, unit: 'L' }, { title: 'Crème B', perUnit: 4, unit: 'Litre' }, { title: 'Crème C', perUnit: 6, unit: 'l' },
  ), { favor: [], entryLevelBrands: [] });
  assert.ok(r.ok);
  assert.equal(r.unitPrice, 4);
  assert.equal(r.count, 3);
});

test('favoured products alone set the price when any exists', () => {
  const r = computeReferencePrice(poulet, products(
    { title: 'Poulet standard', perUnit: 10 },
    { title: 'Poulet plein air', perUnit: 20 },
    { title: 'Poulet Fermier', perUnit: 30 },
  ), { favor: ['plein air', 'fermier'], entryLevelBrands: [] });
  assert.deepEqual(r, { ok: true, unitPrice: 25, unit: 'kg', count: 2, approximate: false });
});

test('favoured terms also read the product flags', () => {
  const r = computeReferencePrice(poulet, products(
    { title: 'Poulet standard', perUnit: 10 },
    { title: 'Poulet A', perUnit: 16, flags: ['flag.common.organic'] },
    { title: 'Poulet B', perUnit: 24, flags: ['flag.common.labelrouge'] },
  ), { favor: ['bio', 'label rouge'], entryLevelBrands: [] });
  assert.ok(r.ok);
  assert.equal(r.unitPrice, 20);
});

test('no favoured product falls back to the others and says it is approximate', () => {
  const r = computeReferencePrice(poulet, products({ title: 'Poulet standard', perUnit: 10 }), { favor: ['plein air'], entryLevelBrands: [] });
  assert.deepEqual(r, { ok: true, unitPrice: 10, unit: 'kg', count: 1, approximate: true });
});

test('no relevant product is a failure, not a price', () => {
  const r = computeReferencePrice(poulet, products({ title: 'Curry', perUnit: 10 }), { favor: [], entryLevelBrands: [] });
  assert.equal(r.ok, false);
});

test('favoured terms come from the name rules of the profile and the user list', () => {
  const rules = [
    { id: 'tous', applies_to: 'all', prefer: { any: ['bio'] } },
    { id: 'bebe', applies_to: { tags: ['bebe'] }, require: { any: ['bio'] } },
    { id: 'poulet', applies_to: { match: ['poulet'], not_match: ['bouillon'] }, require: { any: ['plein air', 'fermier'] } },
  ];
  assert.deepEqual(favorTerms(poulet, rules, {}), ['plein air', 'fermier']);
  assert.deepEqual(favorTerms(carotte, rules, {}), []);
  const jambon: PriceReference = { id: 'jambon', query: 'jambon', unit: 'kg', match: ['jambon'], must: ['jambon'] };
  assert.deepEqual(favorTerms(jambon, rules, { jambon: ['sans nitrite'] }), ['sans nitrite']);
});

test('the most specific reference wins', () => {
  const coco: PriceReference = { id: 'coco', query: 'lait de coco', unit: 'l', match: ['lait de coco'], must: ['coco'] };
  const lait: PriceReference = { id: 'lait', query: 'lait', unit: 'l', match: ['lait'], must: ['lait'] };
  assert.equal(matchReference('lait de coco', [lait, coco])?.id, 'coco');
  assert.equal(matchReference('lait', [lait, coco])?.id, 'lait');
  assert.equal(matchReference('rouget', [lait, coco]), undefined);
});

test('a reference can refuse a name that merely contains its word', () => {
  const pate: PriceReference = { id: 'pate', query: 'pates', unit: 'kg', match: ['pate'], not_match: ['feuilletee'], must: ['pate'] };
  assert.equal(matchReference('pate feuilletee', [pate]), undefined);
  assert.equal(matchReference('pates', [pate])?.id, 'pate');
});

test('a recipe costs what it uses, scaled to the servings', () => {
  const e = estimateRecipe(
    { id: 'r', servings: 4, ingredients: ['400 g de blanc de poulet', '2 carottes', '20 cl de crème', 'Sel'] },
    2, refs, prices, staples,
  );
  // 200 g × 20 €/kg = 4 ; 1 carotte = 100 g × 2 €/kg = 0,20 ; 100 ml × 4 €/l = 0,40
  assert.equal(e.total, 4.6);
  assert.equal(e.perServing, 2.3);
  assert.deepEqual(e.missing, []);
});

test('spoons and counted products convert to the reference unit', () => {
  // 2 c. à soupe = 30 ml × 4 €/l = 0,12 ; 3 œufs × 0,30 = 0,90 ; 120 g d'œuf = 2 œufs × 0,30 = 0,60
  const a = estimateRecipe({ id: 'a', servings: 2, ingredients: ['2 c. à soupe de crème'] }, 2, refs, prices, staples);
  const b = estimateRecipe({ id: 'b', servings: 2, ingredients: ['3 œufs'] }, 2, refs, prices, staples);
  const c = estimateRecipe({ id: 'c', servings: 2, ingredients: ['120 g d\'œuf'] }, 2, refs, prices, staples);
  assert.equal(a.total, 0.12);
  assert.equal(b.total, 0.9);
  assert.equal(c.total, 0.6);
});

test('an absurd count from a recipe site is read as grams', () => {
  // Ligne réelle de CuisineAZ : 500 g × 20 €/kg = 10 pour 2 personnes, pas 500 cuillères.
  const a = estimateRecipe({ id: 'a', servings: 2, ingredients: ['500 c. à soupe de blanc de poulet'] }, 2, refs, prices, staples);
  const b = estimateRecipe({ id: 'b', servings: 2, ingredients: ['400 boîtes de crème'] }, 2, refs, prices, staples);
  assert.equal(a.total, 10);
  assert.equal(b.total, 1.6);
  // Une quantité plausible reste une quantité : 12 carottes × 100 g × 2 €/kg.
  const c = estimateRecipe({ id: 'c', servings: 2, ingredients: ['12 carottes'] }, 2, refs, prices, staples);
  assert.equal(c.total, 2.4);
});

test('a weight written in the recipe line beats the default portion', () => {
  const cost = (line: string, servings = 2) => estimateRecipe({ id: 'r', servings, ingredients: [line] }, 2, refs, prices, staples).total;
  // 400 g × 2 €/kg, pas la portion par défaut de 100 g
  assert.equal(cost("1 carotte d'environ 400 g"), 0.8);
  // le poids vaut pour chaque pièce : 2 × 150 g × 2 €/kg
  assert.equal(cost('2 carottes de 150 g'), 0.6);
  // recette pour 4 ramenée à 2 : 200 g × 2 €/kg
  assert.equal(cost("1 carotte d'environ 400 g", 4), 0.4);
  // volume et parenthèses : 200 ml × 4 €/l ; kilo : 1000 g × 2 €/kg
  assert.equal(cost('1 boîte de crème (20 cl)'), 0.8);
  assert.equal(cost('1 carotte de 1 kg'), 2);
  // un pourcentage n'est pas un poids : 1 c. à soupe = 15 ml × 4 €/l
  assert.equal(cost('1 c. à soupe de crème 15%'), 0.06);
});

test('an important ingredient without a price is named, a small one is not', () => {
  const e = estimateRecipe(
    { id: 'r', servings: 2, ingredients: ['500 g de rôti de biche', '1 c. à café de zaatar', '100 g de blanc de poulet'] },
    2, refs, prices, staples,
  );
  assert.equal(e.total, 2);
  assert.deepEqual(e.missing, ['roti de biche']);
});

test('an important ingredient without a usable quantity is named', () => {
  const e = estimateRecipe({ id: 'r', servings: 2, ingredients: ['blanc de poulet'] }, 2, refs, prices, staples);
  assert.equal(e.total, 0);
  assert.deepEqual(e.missing, ['blanc de poulet']);
});

test('a recipe without a yield has no price rather than a wrong one', () => {
  const e = estimateRecipe({ id: 'r', ingredients: ['400 g de blanc de poulet'] }, 2, refs, prices, staples);
  assert.equal(e.total, null);
  assert.equal(e.perServing, null);
  assert.equal(e.reason, 'no-yield');
});

test('freshness: stale from 60 days, or when nothing is priced', () => {
  assert.equal(priceStatus(prices, refs, '2026-11-29').stale, false);
  assert.equal(priceStatus(prices, refs, '2026-11-30').stale, true);
  assert.equal(priceStatus({ updated: '2026-10-30', prices: {} }, refs, '2026-10-31').stale, true);
  assert.deepEqual(priceStatus({ updated: '2026-10-30', prices: {} }, refs, '2026-10-31').hasPrices, false);
});

test('a price list that was never filled gives no price rather than 0 €', () => {
  const e = estimateRecipe({ id: 'r', servings: 2, ingredients: ['400 g de blanc de poulet'] }, 2, refs, { prices: {} }, staples);
  assert.equal(e.total, null);
  assert.equal(e.reason, 'no-prices');
});

test('shipped references are usable', () => {
  const all = loadReferences();
  assert.ok(all.length >= 35 && all.length <= 45, `${all.length} references`);
  assert.equal(new Set(all.map((r) => r.id)).size, all.length);
  for (const [key, id] of [
    ['blanc de poulet', 'blanc-poulet'], ['steak hache', 'steak-hache'], ['pave de saumon', 'saumon'], ['carotte', 'carotte'],
    ['pomme de terre', 'pomme-de-terre'], ['lait de coco', 'lait-de-coco'], ['riz arborio', 'riz'], ['tomate concassee', 'tomate-conserve'],
    ['creme fraiche liquide', 'creme'], ['jambon', 'jambon'],
  ] as const) assert.equal(matchReference(key, all)?.id, id, key);
  assert.equal(matchReference('pate feuilletee', all), undefined);
});

test('CLI: ingest a real search result, then estimate from it', () => {
  const root = useTempRoot();
  writeValidProfile(root);
  mkdirSync(join(root, 'data'), { recursive: true });
  const env = { ...process.env, GROCERIES_ROOT: root };
  const run = (...args: string[]) => JSON.parse(execFileSync('node', ['--no-warnings', 'scripts/prices.ts', ...args], { cwd: REPO_ROOT, env, encoding: 'utf8' }));

  assert.equal(run('status').stale, true);
  const fixture = join(REPO_ROOT, 'tests/fixtures/carrefour/search-carotte.json');
  // Carottes Bio 2,5 · agroécologie 2,13 · vrac 1,19 · vrac 1,79 : moyenne 1,90 (râpées, rondelles, baby, boîte et botte écartées)
  const ingested = run('ingest', 'carotte', fixture);
  assert.equal(ingested.unitPrice, 1.9);
  assert.equal(ingested.count, 4);
  const stored = YAML.parse(readFileSync(join(root, 'data/prices.yml'), 'utf8'));
  assert.equal(stored.prices.carotte.unitPrice, 1.9);
  // Tant que le relevé n'est pas terminé, il reste à refaire : une coupure ne le fait pas passer pour complet.
  assert.equal(run('status').stale, true);
  run('done');
  assert.equal(run('status').stale, false);

  // Le fichier enveloppé tel que Claude Code l'enregistre parfois donne le même résultat.
  const wrapped = join(root, 'wrapped.json');
  writeFileSync(wrapped, JSON.stringify([{ type: 'text', text: readFileSync(fixture, 'utf8') }]));
  assert.equal(run('ingest', 'carotte', wrapped).unitPrice, 1.9);

  mkdirSync(join(root, 'data/recipes'), { recursive: true });
  writeFileSync(join(root, 'data/recipes/test-carottes.md'), `---\n${YAML.stringify({
    id: 'test-carottes', name: 'Carottes', source: 'x', url: 'x', slug: 'x', servings: 4, ingredients: ['1 kg de carottes'], steps: [], used_on: [], parsed_ingredients: [],
  })}---\n`);
  // Pour 2 : 500 g × 1,90 €/kg = 0,95 ; 0,475 → 0,48 par personne
  const est = run('estimate', '--servings', '2', 'test-carottes');
  assert.equal(est.estimates[0].total, 0.95);
  assert.equal(est.estimates[0].perServing, 0.48);
});

test('CLI: a failed ingest keeps the previous price and exits non-zero', () => {
  const root = useTempRoot();
  writeValidProfile(root);
  mkdirSync(join(root, 'data'), { recursive: true });
  writeFileSync(join(root, 'data/prices.yml'), YAML.stringify({ updated: '2026-10-01', prices: { carotte: { unitPrice: 1.5, unit: 'kg', count: 2, date: '2026-10-01' } } }));
  const empty = join(root, 'empty.json');
  writeFileSync(empty, JSON.stringify({ data: [] }));
  const r = spawnSync('node', ['--no-warnings', 'scripts/prices.ts', 'ingest', 'carotte', empty], { cwd: REPO_ROOT, env: { ...process.env, GROCERIES_ROOT: root }, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /carotte/);
  assert.equal(YAML.parse(readFileSync(join(root, 'data/prices.yml'), 'utf8')).prices.carotte.unitPrice, 1.5);
});
