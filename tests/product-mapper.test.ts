import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildArgs, getPath, mapProducts, mappingHealth, stringLeaves, type SearchSpec } from '../scripts/lib/product-mapper.ts';

const raw = {
  data: [
    { attributes: { ean: '111', title: 'Oeufs plein air x12', brand: 'CARREFOUR', offers: { price: '3,49 €' },
      perUnit: '0,29 €/pièce', packaging: 'Boîte de 12', purchasable: true, labels: ['Plein air', { name: 'Code 1' }] } },
    { attributes: { ean: '222', title: 'Oeufs de poules élevées au sol', brand: 'LOUÉ', offers: { price: 2.9 },
      perUnit: '0,24 €/pièce', packaging: 'x12', purchasable: 'false' } },
    { attributes: { title: 'Sans EAN' } },
  ],
};
const spec: SearchSpec = {
  tool: 'search_products',
  args: { q: '{query}', page: 1 },
  products_path: 'data',
  fields: {
    ean: 'attributes.ean',
    title: 'attributes.title',
    brand: 'attributes.brand',
    price: { path: 'attributes.offers.price', parse: 'price' },
    unit_price: { path: 'attributes.perUnit', parse: 'unit_price' },
    pack: { path: 'attributes.packaging', parse: 'pack' },
    available: { path: 'attributes.purchasable', parse: 'bool' },
    text: ['attributes.labels', 'attributes.packaging'],
  },
};

test('getPath, stringLeaves, buildArgs', () => {
  assert.equal(getPath(raw, 'data.0.attributes.ean'), '111');
  assert.equal(getPath(raw, 'data.9.attributes'), undefined);
  assert.equal(getPath(raw, ''), raw);
  assert.deepEqual(stringLeaves(['a', { b: 'c', d: [1, 'e'] }]), ['a', 'c', 'e']);
  assert.deepEqual(buildArgs(spec.args, 'oeufs bio'), { q: 'oeufs bio', page: 1 });
});

test('mapProducts maps, converts and skips products without ean/title', () => {
  const ps = mapProducts(raw, spec);
  assert.equal(ps.length, 2);
  assert.deepEqual(ps[0], {
    ean: '111', title: 'Oeufs plein air x12', brand: 'CARREFOUR', price: 3.49, unitPrice: 0.29, unit: 'piece',
    packQty: 12, packUnit: 'piece', available: true,
    text: 'Oeufs plein air x12 CARREFOUR Plein air Code 1 Boîte de 12',
  });
  assert.equal(ps[1].available, false);
  assert.equal(ps[1].price, 2.9);
});

test('mapProducts tolerates a missing or non-array products_path', () => {
  assert.deepEqual(mapProducts({ data: null }, spec), []);
  assert.deepEqual(mapProducts('oops', spec), []);
  assert.throws(() => mapProducts(raw, { tool: 't', args: {} }), /mapping missing/);
});

test('available defaults to true when not mapped', () => {
  const { available: _ignored, ...fields } = spec.fields!;
  assert.equal(mapProducts(raw, { ...spec, fields })[1].available, true);
});

test('mappingHealth reports fill ratios and missing required fields', () => {
  const h = mappingHealth([raw], spec);
  assert.equal(h.products, 2);
  assert.equal(h.filled.unit_price, 1);
  assert.equal(h.filled.rating, 0);
  assert.deepEqual(h.missing, []);
  assert.equal(h.healthy, true);
  const broken = mappingHealth([raw], { ...spec, fields: { ...spec.fields!, unit_price: 'attributes.nope' } });
  assert.deepEqual(broken.missing, ['unit_price']);
  assert.equal(broken.healthy, false);
  assert.equal(mappingHealth([{ data: [] }], spec).healthy, false);
});
