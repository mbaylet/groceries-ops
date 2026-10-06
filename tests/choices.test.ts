import { test } from 'node:test';
import assert from 'node:assert/strict';
import { choiceKey, getChoice, removeChoice, setChoice, type ChoicesFile } from '../scripts/lib/choices.ts';

test('keys come from the ingredient name, not quantity or accents', () => {
  assert.equal(choiceKey('20 cl de crème fraîche'), 'creme fraiche');
  assert.equal(choiceKey('Crème fraîche'), 'creme fraiche');
  assert.equal(choiceKey('3 oignons'), 'oignon');
});

test('set, get, remove', () => {
  const f: ChoicesFile = { choices: {} };
  setChoice(f, 'crème fraîche', '3560070', 'Crème fraîche épaisse 30% Carrefour', '2026-10-06');
  assert.equal(getChoice(f, '20 cl de crème fraîche')?.ean, '3560070');
  assert.equal(getChoice(f, 'beurre'), undefined);
  assert.ok(removeChoice(f, 'Crème fraîche'));
  assert.ok(!removeChoice(f, 'Crème fraîche'));
  assert.throws(() => setChoice(f, '   ', '1', 'x', '2026-10-06'), /empty ingredient/);
});
