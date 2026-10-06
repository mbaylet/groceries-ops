import { test } from 'node:test';
import assert from 'node:assert/strict';
import { containsPhrase, findExclusions, normalizeText, tokens } from '../scripts/lib/normalize.ts';
import { parseIngredientLine } from '../scripts/lib/ingredient-line.ts';

test('normalizeText strips accents, ligatures, punctuation', () => {
  assert.equal(normalizeText("Crème fraîche d'Isigny"), 'creme fraiche d isigny');
  assert.equal(normalizeText('Œufs'), 'oeufs');
});

test('tokens singularise', () => {
  assert.deepEqual(tokens('Pommes de terre'), ['pomme', 'de', 'terre']);
  assert.deepEqual(tokens('poireaux'), ['poireau']);
  assert.deepEqual(tokens('noix riz ail'), ['noix', 'riz', 'ail']);
});

test('exclusions: plurals, accents, no substring false positives', () => {
  assert.ok(containsPhrase('1 petite boîte de champignon (coupés)', 'champignons'));
  assert.ok(containsPhrase('200 g de champignons de Paris', 'champignon'));
  assert.ok(containsPhrase("1 jaune d'œuf", 'oeufs'));
  assert.ok(!containsPhrase('2 poireaux', 'poire'));
  assert.ok(!containsPhrase('1 porcelaine', 'porc'));
  assert.ok(!containsPhrase('anything', ''));
  assert.deepEqual(findExclusions(['2 poireaux', '1 poire'], ['poire']), [{ exclusion: 'poire', line: '1 poire' }]);
});

test('parseIngredientLine: units and conversions', () => {
  assert.deepEqual(parseIngredientLine('1 kg de blanquette de veau'),
    { raw: '1 kg de blanquette de veau', qty: 1000, unit: 'g', name: 'blanquette de veau', key: 'blanquette de veau' });
  assert.deepEqual(parseIngredientLine('25 cl de vin blanc'),
    { raw: '25 cl de vin blanc', qty: 250, unit: 'ml', name: 'vin blanc', key: 'vin blanc' });
  assert.deepEqual(parseIngredientLine('2 carottes'), { raw: '2 carottes', qty: 2, name: 'carottes', key: 'carotte' });
  assert.deepEqual(parseIngredientLine('1 petite boîte de champignon (coupés)'),
    { raw: '1 petite boîte de champignon (coupés)', qty: 1, unit: 'boite', name: 'champignon', key: 'champignon' });
  assert.equal(parseIngredientLine("2 cuillères à soupe d'huile d'olive").unit, 'cas');
  assert.equal(parseIngredientLine("2 cuillères à soupe d'huile d'olive").name, 'huile d olive');
  assert.equal(parseIngredientLine('200g de farine').qty, 200);
  assert.equal(parseIngredientLine('200g de farine').name, 'farine');
  assert.equal(parseIngredientLine('2 à 3 oignons').qty, 2);
  assert.equal(parseIngredientLine('2 gros oignons').name, 'oignons');
});

test('parseIngredientLine: no quantity, fractions, decimal comma (review focus 1)', () => {
  assert.deepEqual(parseIngredientLine('citron'), { raw: 'citron', name: 'citron', key: 'citron' });
  assert.equal(parseIngredientLine('1/2 citron').qty, 0.5);
  assert.equal(parseIngredientLine('1 1/2 citron').qty, 1.5);
  const p = parseIngredientLine('1,5 kg de pommes de terre');
  assert.equal(p.qty, 1500);
  assert.equal(p.key, 'pomme de terre');
  const b = parseIngredientLine('½ botte de persil');
  assert.equal(b.qty, 0.5);
  assert.equal(b.unit, 'botte');
  assert.equal(b.name, 'persil');
  assert.equal(parseIngredientLine("1 jaune d'oeuf").name, 'jaune d oeuf');
  assert.equal(parseIngredientLine('').key, '');
  assert.equal(parseIngredientLine("l'oignon").unit, undefined);
});
