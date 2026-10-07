import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBool, parseNumber, parsePack, parseUnitPrice } from '../scripts/lib/field-parse.ts';

test('parseNumber handles numbers, French decimals and currency', () => {
  assert.equal(parseNumber(1.99), 1.99);
  assert.equal(parseNumber('1,99 €'), 1.99);
  assert.equal(parseNumber('€2.50'), 2.5);
  assert.equal(parseNumber('1 299,00 €'), 1299);
  assert.equal(parseNumber('gratuit'), undefined);
  assert.equal(parseNumber(null), undefined);
  assert.equal(parseNumber(Number.NaN), undefined);
});

test('parseUnitPrice normalises to per kg / per l / per piece', () => {
  assert.deepEqual(parseUnitPrice('12,50 €/kg'), { value: 12.5, unit: 'kg' });
  assert.deepEqual(parseUnitPrice('1,20 € / L'), { value: 1.2, unit: 'l' });
  assert.deepEqual(parseUnitPrice('0,35 €/pièce'), { value: 0.35, unit: 'piece' });
  assert.deepEqual(parseUnitPrice('2,10 € le kg'), { value: 2.1, unit: 'kg' });
  assert.deepEqual(parseUnitPrice('1,05 €/100g'), { value: 10.5, unit: 'kg' });
  assert.deepEqual(parseUnitPrice('0,99 € / 100 ml'), { value: 9.9, unit: 'l' });
  assert.deepEqual(parseUnitPrice('3,00 €/75cl'), { value: 4, unit: 'l' });
  assert.equal(parseUnitPrice('12,50 €'), undefined);
  assert.equal(parseUnitPrice(12.5), undefined);
});

test('parsePack reads weights, volumes, multipacks and counts', () => {
  assert.deepEqual(parsePack('6 x 125 g'), { qty: 750, unit: 'g' });
  assert.deepEqual(parsePack('1,5 kg'), { qty: 1500, unit: 'g' });
  assert.deepEqual(parsePack('75 cl'), { qty: 750, unit: 'ml' });
  assert.deepEqual(parsePack('Bouteille 1 L'), { qty: 1000, unit: 'ml' });
  assert.deepEqual(parsePack('x12'), { qty: 12, unit: 'piece' });
  assert.deepEqual(parsePack('12 oeufs'), { qty: 12, unit: 'piece' });
  assert.deepEqual(parsePack('Boîte de 6'), { qty: 6, unit: 'piece' });
  assert.equal(parsePack('vrac'), undefined);
});

test('parseBool', () => {
  assert.equal(parseBool(true), true);
  assert.equal(parseBool('false'), false);
  assert.equal(parseBool('oui'), true);
  assert.equal(parseBool(0), false);
  assert.equal(parseBool('peut-être'), undefined);
});
