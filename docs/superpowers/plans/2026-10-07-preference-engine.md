# Product Preference Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pick store products with a script-side preference engine (household rules written in their own words) that calls the store's MCP search itself, so Claude only sees decisions and exceptions.

**Architecture:** Rules live in `profile.yml` as a generic list (require/forbid/prefer/budget + scope). A pure engine filters, relaxes, applies capped preferences lexicographically, prunes, scores and decides per item. `products.ts resolve` opens one MCP session, runs each search, maps raw results through a declarative field mapping declared in the provider YAML, and prints compact JSON. Mapping discovery and health checks live in setup/doctor.

**Tech Stack:** Node ≥ 22.18 TypeScript (type stripping), `node:test`, `yaml`, `@modelcontextprotocol/sdk`.

**Spec:** `docs/superpowers/specs/2026-10-06-preference-engine-design.md` (extends `docs/superpowers/specs/2026-10-06-groceries-ops-design.md`)

## Global Constraints

- Erasable TypeScript only (no enum/namespace/parameter properties), `.ts` import extensions, run with `node scripts/x.ts`.
- No new dependencies.
- Scripts print JSON on stdout; errors as `{"error": "..."}` on stderr with exit 1.
- Raw store search results are never printed to stdout; they are written under `data/runs/{date}-search/`.
- Hard rules are never relaxed and never bypassed by remembered choices or habits.
- Word matching always goes through `containsPhrase` (case, accents, plurals, whole words).
- User layer (`profile.yml`, `data/`) is only touched by tests under a temp `GROCERIES_ROOT`.
- Defaults: `scoring = { weights: { price_per_unit: 0.6, preferences: 0.35, rating: 0.05 }, indifference_pct: 3, close_call_pct: 5, on_unknown: reject }`; prefer `weight` default 0.1; constraint `strictness` default `hard`; mapping health threshold 80 % for `ean`, `title`, `price`, `unit_price`, `available`.

## Review Focus

1. A search returning zero products (or a non-array at `products_path`) must yield a `none` exception, not a crash — Task 6.
2. Products with no unit price compared under a capped preference must not count as satisfying it (and must not crash the premium computation) — Task 4.
3. A forbid word that is a substring of another word (`sol` in `solaire`) must not eliminate the product — Task 4.
4. An item name with characters unsafe for a file name (`/`, accents) must still produce a valid raw-result file and be found again by `--from-search` — Task 6.
5. A tool error from the MCP search (`isError: true`) for one item must not stop the other items — Task 6.

---

## File map

| File | Responsibility |
|---|---|
| `scripts/lib/field-parse.ts` | generic conversions: number/price, unit price, pack size, bool |
| `scripts/lib/product-mapper.ts` | `Product` type, path reading, declarative mapping, mapping health |
| `scripts/lib/rules.ts` | rule/scoring types, validation, contradictions, defaults |
| `scripts/lib/profile.ts` (modify) | new `product_rules` list, `tags`, `preferences_text`, `scoring` |
| `scripts/lib/preference-engine.ts` | pure per-item resolution |
| `scripts/lib/mcp-client.ts` | shared MCP session (open/call/close), tool text → JSON |
| `scripts/lib/mcp-probe.ts` (modify) | login probe on top of `mcp-client.ts` |
| `scripts/lib/provider.ts` (modify) | `search` block in provider YAML |
| `scripts/products.ts` | CLI: resolve, map-check, validate, feedback, suggest |
| `scripts/doctor.ts` (modify) | product-mapping check (offline fixtures + live) |
| `config/profile.template.yml`, `providers/carrefour.yml`, `modes/*.md`, `AGENTS.md`, `tests/helpers.ts` (modify) | formats and agent instructions |

---

### Task 1: Field conversions

**Files:**
- Create: `scripts/lib/field-parse.ts`
- Test: `tests/field-parse.test.ts`

**Interfaces:**
- Produces: `type UnitKind = 'kg' | 'l' | 'piece'`; `interface UnitPrice { value: number; unit: UnitKind }`; `interface Pack { qty: number; unit: 'g' | 'ml' | 'piece' }`; `parseNumber(v: unknown): number | undefined`; `parseUnitPrice(v: unknown): UnitPrice | undefined`; `parsePack(v: unknown): Pack | undefined`; `parseBool(v: unknown): boolean | undefined`.

- [ ] **Step 1: Write the failing test** — `tests/field-parse.test.ts`

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/field-parse.test.ts`
Expected: FAIL — cannot find module `field-parse.ts`.

- [ ] **Step 3: Implement** — `scripts/lib/field-parse.ts`

```ts
export type UnitKind = 'kg' | 'l' | 'piece';
export interface UnitPrice { value: number; unit: UnitKind }
export interface Pack { qty: number; unit: 'g' | 'ml' | 'piece' }

const NUM = '(\\d+(?:[.,]\\d+)?)';
const toNum = (s: string) => Number(s.replace(',', '.'));
const round = (x: number) => Math.round(x * 10000) / 10000;

/** Lowercase, accents stripped, thousands separators removed ("1 299,00" → "1299,00"). */
function clean(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/(\d)[\s  ](?=\d{3}\b)/g, '$1');
}

export function parseNumber(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v !== 'string') return undefined;
  const m = new RegExp(NUM).exec(clean(v));
  return m ? toNum(m[1]) : undefined;
}

const MEASURE: Record<string, { base: 'g' | 'ml'; factor: number }> = {
  kg: { base: 'g', factor: 1000 },
  g: { base: 'g', factor: 1 },
  l: { base: 'ml', factor: 1000 },
  cl: { base: 'ml', factor: 10 },
  ml: { base: 'ml', factor: 1 },
};

/** "12,50 €/kg", "1,05 €/100g", "0,35 €/pièce", "2,10 € le kg" → price per kg | l | piece. */
export function parseUnitPrice(v: unknown): UnitPrice | undefined {
  if (typeof v !== 'string') return undefined;
  const s = clean(v);
  const m = new RegExp(`${NUM}\\s*(?:€|eur)?\\s*(?:\\/|le|la|par)\\s*${NUM}?\\s*(kg|g|l|cl|ml|piece|pce|unite|u)\\b`).exec(s);
  if (!m) return undefined;
  const price = toNum(m[1]);
  const per = m[2] ? toNum(m[2]) : 1;
  const unit = m[3];
  if (unit === 'piece' || unit === 'pce' || unit === 'unite' || unit === 'u') return { value: round(price / per), unit: 'piece' };
  const def = MEASURE[unit];
  const perBase = per * def.factor; // amount in g or ml
  return { value: round((price / perBase) * 1000), unit: def.base === 'g' ? 'kg' : 'l' };
}

/** "6 x 125 g" → 750 g; "75 cl" → 750 ml; "x12" / "12 oeufs" / "boite de 6" → pieces. */
export function parsePack(v: unknown): Pack | undefined {
  if (typeof v !== 'string') return undefined;
  const s = clean(v);
  const multi = new RegExp(`(\\d+)\\s*x\\s*${NUM}\\s*(kg|g|l|cl|ml)\\b`).exec(s);
  if (multi) {
    const def = MEASURE[multi[3]];
    return { qty: round(Number(multi[1]) * toNum(multi[2]) * def.factor), unit: def.base };
  }
  const single = new RegExp(`${NUM}\\s*(kg|g|l|cl|ml)\\b`).exec(s);
  if (single) {
    const def = MEASURE[single[2]];
    return { qty: round(toNum(single[1]) * def.factor), unit: def.base };
  }
  const count =
    /(?:^|\s)x\s*(\d+)\b/.exec(s) ??
    /(\d+)\s*(?:oeufs?|pieces?|unites?|pots?|sachets?|tranches?|portions?)\b/.exec(s) ??
    /(?:boite|lot|paquet|pack|barquette)\s+de\s+(\d+)\b/.exec(s);
  return count ? { qty: Number(count[1]), unit: 'piece' } : undefined;
}

export function parseBool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v !== 'string') return undefined;
  const s = clean(v).trim();
  if (['true', 'yes', 'oui', '1', 'disponible', 'available'].includes(s)) return true;
  if (['false', 'no', 'non', '0', 'indisponible', 'unavailable'].includes(s)) return false;
  return undefined;
}
```

- [ ] **Step 4: Run tests**

Run: `npm run check`
Expected: typecheck clean; all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: generic field conversions for store product data"
```

---

### Task 2: Declarative product mapping and mapping health

**Files:**
- Create: `scripts/lib/product-mapper.ts`
- Test: `tests/product-mapper.test.ts`

**Interfaces:**
- Consumes: Task 1 parsers.
- Produces:
  ```ts
  type ParseKind = 'string' | 'number' | 'price' | 'unit_price' | 'pack' | 'bool' | 'not'
  type FieldSpec = string | { path: string; parse?: ParseKind }
  interface FieldMap { ean: FieldSpec; title: FieldSpec; brand?: FieldSpec; price?: FieldSpec; unit_price?: FieldSpec; pack?: FieldSpec; available?: FieldSpec; rating?: FieldSpec; text?: string | string[] }
  interface SearchSpec { tool: string; args: Record<string, unknown>; products_path?: string; fields?: FieldMap }
  interface Product { ean: string; title: string; brand?: string; price?: number; unitPrice?: number; unit?: UnitKind; packQty?: number; packUnit?: 'g'|'ml'|'piece'; available: boolean; text: string; rating?: number }
  const FIELD_NAMES: readonly string[]  // ['ean','title','brand','price','unit_price','pack','available','rating']
  const PARSE_KINDS: readonly ParseKind[]
  const REQUIRED_HEALTH_FIELDS = ['ean','title','price','unit_price','available']
  getPath(obj, path): unknown; stringLeaves(v): string[]; buildArgs(args, query): Record<string, unknown>
  mapProducts(raw, spec): Product[]   // throws if spec.fields missing
  mappingHealth(raws: unknown[], spec): { products: number; filled: Record<string, number>; missing: string[]; healthy: boolean; sample: Product[] }
  ```

- [ ] **Step 1: Write the failing test** — `tests/product-mapper.test.ts`

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/product-mapper.test.ts`
Expected: FAIL — cannot find module `product-mapper.ts`.

- [ ] **Step 3: Implement** — `scripts/lib/product-mapper.ts`

```ts
import { parseBool, parseNumber, parsePack, parseUnitPrice, type Pack, type UnitKind } from './field-parse.ts';

export type ParseKind = 'string' | 'number' | 'price' | 'unit_price' | 'pack' | 'bool' | 'not';
export type FieldSpec = string | { path: string; parse?: ParseKind };
export interface FieldMap {
  ean: FieldSpec;
  title: FieldSpec;
  brand?: FieldSpec;
  price?: FieldSpec;
  unit_price?: FieldSpec;
  pack?: FieldSpec;
  available?: FieldSpec;
  rating?: FieldSpec;
  text?: string | string[];
}
export interface SearchSpec { tool: string; args: Record<string, unknown>; products_path?: string; fields?: FieldMap }
export interface Product {
  ean: string;
  title: string;
  brand?: string;
  price?: number;
  unitPrice?: number;
  unit?: UnitKind;
  packQty?: number;
  packUnit?: Pack['unit'];
  available: boolean;
  text: string;
  rating?: number;
}

export const PARSE_KINDS: readonly ParseKind[] = ['string', 'number', 'price', 'unit_price', 'pack', 'bool', 'not'];
export const FIELD_NAMES = ['ean', 'title', 'brand', 'price', 'unit_price', 'pack', 'available', 'rating'] as const;
export const REQUIRED_HEALTH_FIELDS = ['ean', 'title', 'price', 'unit_price', 'available'] as const;
const HEALTH_THRESHOLD = 0.8;
const DEFAULT_PARSE: Record<(typeof FIELD_NAMES)[number], ParseKind> = {
  ean: 'string', title: 'string', brand: 'string', price: 'price', unit_price: 'unit_price', pack: 'pack', available: 'bool', rating: 'number',
};

export function getPath(obj: unknown, path: string): unknown {
  if (path === '' || path === '.') return obj;
  let cur: unknown = obj;
  for (const seg of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) cur = /^\d+$/.test(seg) ? cur[Number(seg)] : undefined;
    else if (typeof cur === 'object') cur = (cur as Record<string, unknown>)[seg];
    else return undefined;
  }
  return cur;
}

export function stringLeaves(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') {
    if (v.trim()) out.push(v.trim());
  } else if (Array.isArray(v)) for (const x of v) stringLeaves(x, out);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) stringLeaves(x, out);
  return out;
}

export function buildArgs(args: Record<string, unknown>, query: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).map(([k, v]) => [k, typeof v === 'string' ? v.replaceAll('{query}', query) : v]));
}

function readField(item: unknown, spec: FieldSpec | undefined, fallback: ParseKind): unknown {
  if (spec === undefined) return undefined;
  const path = typeof spec === 'string' ? spec : spec.path;
  const kind = typeof spec === 'string' ? fallback : (spec.parse ?? fallback);
  const v = getPath(item, path);
  switch (kind) {
    case 'string':
      return typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : undefined;
    case 'number':
    case 'price':
      return parseNumber(v);
    case 'unit_price':
      return parseUnitPrice(v);
    case 'pack':
      return parsePack(v);
    case 'bool':
      return parseBool(v);
    case 'not': {
      const b = parseBool(v);
      return b === undefined ? undefined : !b;
    }
  }
}

function readAll(item: unknown, fields: FieldMap): Record<(typeof FIELD_NAMES)[number], unknown> {
  const out = {} as Record<(typeof FIELD_NAMES)[number], unknown>;
  for (const name of FIELD_NAMES) out[name] = readField(item, fields[name], DEFAULT_PARSE[name]);
  return out;
}

function productList(raw: unknown, spec: SearchSpec): unknown[] {
  const list = spec.products_path ? getPath(raw, spec.products_path) : raw;
  return Array.isArray(list) ? list : [];
}

function toProduct(item: unknown, fields: FieldMap): Product | undefined {
  const v = readAll(item, fields);
  if (typeof v.ean !== 'string' || typeof v.title !== 'string') return undefined;
  const textPaths = fields.text === undefined ? [] : Array.isArray(fields.text) ? fields.text : [fields.text];
  const brand = typeof v.brand === 'string' ? v.brand : undefined;
  const p: Product = {
    ean: v.ean,
    title: v.title,
    available: typeof v.available === 'boolean' ? v.available : true,
    text: [v.title, brand ?? '', ...textPaths.flatMap((tp) => stringLeaves(getPath(item, tp)))].filter(Boolean).join(' '),
  };
  if (brand !== undefined) p.brand = brand;
  if (typeof v.price === 'number') p.price = v.price;
  const up = v.unit_price as { value: number; unit: UnitKind } | undefined;
  if (up) {
    p.unitPrice = up.value;
    p.unit = up.unit;
  }
  const pack = v.pack as Pack | undefined;
  if (pack) {
    p.packQty = pack.qty;
    p.packUnit = pack.unit;
  }
  if (typeof v.rating === 'number') p.rating = v.rating;
  return p;
}

export function mapProducts(raw: unknown, spec: SearchSpec): Product[] {
  if (!spec.fields) throw new Error('Product mapping missing for this provider — run /groceries setup (mapping discovery)');
  const fields = spec.fields;
  return productList(raw, spec).flatMap((item) => toProduct(item, fields) ?? []);
}

export function mappingHealth(raws: unknown[], spec: SearchSpec) {
  const fields = spec.fields;
  if (!fields) return { products: 0, filled: {}, missing: [...REQUIRED_HEALTH_FIELDS], healthy: false, sample: [] as Product[] };
  const items = raws.flatMap((raw) => productList(raw, spec)).filter((item) => toProduct(item, fields));
  const filled: Record<string, number> = {};
  for (const name of FIELD_NAMES) {
    const count = items.filter((item) => readAll(item, fields)[name] !== undefined).length;
    filled[name] = items.length ? Math.round((count / items.length) * 100) / 100 : 0;
  }
  const missing = REQUIRED_HEALTH_FIELDS.filter((f) => (filled[f] ?? 0) < HEALTH_THRESHOLD);
  const sample = raws.flatMap((raw) => mapProducts(raw, spec)).slice(0, 3);
  return { products: items.length, filled, missing: [...missing], healthy: items.length > 0 && missing.length === 0, sample };
}
```

- [ ] **Step 4: Run tests**

Run: `npm run check`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: declarative product mapping with health check"
```

---

### Task 3: Rules, scoring and the new profile format

**Files:**
- Create: `scripts/lib/rules.ts`
- Modify: `scripts/lib/profile.ts` (types, product_rules validation), `config/profile.template.yml`, `tests/helpers.ts`, `tests/profile.test.ts`
- Test: `tests/rules.test.ts`

**Interfaces:**
- Consumes: `tokens` (normalize.ts).
- Produces:
  ```ts
  interface Matcher { any?: string[]; all?: string[]; brand_any?: string[] }
  interface AppliesTo { match?: string[]; not_match?: string[]; tags?: string[] }
  interface Rule { id; applies_to: 'all' | AppliesTo; require?: Matcher; forbid?: Matcher; prefer?: Matcher; budget?: { max_price?: number; max_price_per_kg?: number }; max_premium_pct?: number; strictness?: 'hard'|'soft'; priority?: number; weight?: number }
  interface Scoring { weights: { price_per_unit: number; preferences: number; rating: number }; indifference_pct: number; close_call_pct: number; on_unknown: 'reject'|'ask' }
  type ScoringInput = { weights?: Partial<Scoring['weights']>; indifference_pct?: number; close_call_pct?: number; on_unknown?: 'reject'|'ask' }
  DEFAULT_SCORING; RULE_KINDS; type RuleKind; ruleKind(r); matcherWords(m); scopesOverlap(a, b);
  validateRules(raw: unknown[], tags: string[]): string[]; validateScoring(raw: unknown): string[]; resolveScoring(input?: ScoringInput): Scoring
  ```
  `Profile` gains `tags: string[]`, `preferences_text?: string`, `product_rules: Rule[]`, `scoring?: ScoringInput`; `ProductRule` and `RULE_KEYS` are removed.

- [ ] **Step 1: Write the failing test** — `tests/rules.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SCORING, resolveScoring, ruleKind, scopesOverlap, validateRules, validateScoring, type Rule } from '../scripts/lib/rules.ts';

const ok: unknown[] = [
  { id: 'oeufs', applies_to: { match: ['oeuf'] }, forbid: { any: ['sol', 'cage'] } },
  { id: 'enfant-bio', applies_to: { tags: ['enfant'] }, require: { any: ['bio'] }, priority: 10 },
  { id: 'bio-raisonnable', applies_to: 'all', prefer: { any: ['bio'] }, max_premium_pct: 20 },
  { id: 'cafe', applies_to: { match: ['cafe'] }, budget: { max_price_per_kg: 25 }, strictness: 'soft' },
];

test('valid rules pass', () => {
  assert.deepEqual(validateRules(ok, ['enfant']), []);
  assert.equal(ruleKind(ok[3] as Rule), 'budget');
});

test('errors name the rule and field', () => {
  const errs = validateRules([
    { id: 'a', applies_to: 'all' },
    { id: 'a', applies_to: { match: [] }, require: { any: ['x'] } },
    { id: 'b', applies_to: { tags: ['bebe'] }, prefer: { anything: ['x'] }, strictness: 'hard' },
    { id: 'c', applies_to: 'all', forbid: { any: ['x'] }, max_premium_pct: 10, weight: 2 },
    { id: 'd', applies_to: 'all', budget: { max_price: -1 } },
    { applies_to: 'all', require: { any: ['x'] } },
  ], ['enfant']).join('\n');
  for (const s of [
    'product_rules.a: needs exactly one of',
    'product_rules.a: duplicate id',
    'product_rules.a.applies_to.match: must be a non-empty list',
    'unknown tag "bebe"',
    'product_rules.b.prefer.anything: unknown key',
    'product_rules.b.strictness: not allowed with prefer',
    'product_rules.c.max_premium_pct: only allowed with prefer',
    'product_rules.c.weight: only allowed with prefer',
    'product_rules.d.budget.max_price: must be a positive number',
    'product_rules[5]: id: must be a non-empty string',
  ]) assert.ok(errs.includes(s), `missing "${s}" in:\n${errs}`);
});

test('contradictions between require and forbid on overlapping scopes', () => {
  const errs = validateRules([
    { id: 'need-bio', applies_to: { match: ['lait'] }, require: { all: ['bio'] } },
    { id: 'no-bio', applies_to: 'all', forbid: { any: ['bio'] } },
  ], []);
  assert.ok(errs.some((e) => e.includes('contradiction')), errs.join('\n'));
  // `any` with an allowed alternative is not a contradiction
  assert.deepEqual(validateRules([
    { id: 'poulet', applies_to: { match: ['poulet'] }, require: { any: ['plein air', 'bio'] } },
    { id: 'no-bio', applies_to: 'all', forbid: { any: ['bio'] } },
  ], []), []);
});

test('scopesOverlap', () => {
  const r = (applies_to: Rule['applies_to']): Rule => ({ id: 'x', applies_to, require: { any: ['y'] } });
  assert.ok(scopesOverlap(r('all'), r({ match: ['oeuf'] })));
  assert.ok(scopesOverlap(r({ match: ['oeufs'] }), r({ match: ['oeuf'] })));
  assert.ok(!scopesOverlap(r({ match: ['oeuf'] }), r({ match: ['poulet'] })));
  assert.ok(scopesOverlap(r({ tags: ['enfant'] }), r({ tags: ['enfant'], match: ['compote'] })));
});

test('scoring validation and defaults', () => {
  assert.deepEqual(validateScoring({ weights: { price_per_unit: 1 }, on_unknown: 'ask' }), []);
  const errs = validateScoring({ weights: { price_per_unit: -1, foo: 1 }, indifference_pct: 80, on_unknown: 'maybe' }).join('\n');
  for (const s of ['scoring.weights.price_per_unit', 'scoring.weights.foo', 'scoring.indifference_pct', 'scoring.on_unknown'])
    assert.ok(errs.includes(s), s);
  assert.deepEqual(validateScoring({ weights: { price_per_unit: 0, preferences: 0, rating: 0 } }), ['scoring.weights: at least one weight must be > 0']);
  assert.deepEqual(resolveScoring(), DEFAULT_SCORING);
  assert.deepEqual(resolveScoring({ weights: { rating: 0 }, on_unknown: 'ask' }).weights, { price_per_unit: 0.6, preferences: 0.35, rating: 0 });
});
```

Modify `tests/profile.test.ts`:
- In `errors name the field`, replace `raw.product_rules.default.bio = true;` with `raw.product_rules = [{ id: 'x', applies_to: 'all', require: { any: [] } }];` and replace `'product_rules.default.bio'` in the expected list with `'product_rules.x.require.any'`.
- Append:

```ts
test('old per-category product_rules format is rejected with a pointer to onboarding', () => {
  const raw = YAML.parse(VALID_PROFILE_YAML);
  raw.product_rules = { default: { store_brand_ok: true } };
  const v = validateProfile(raw, opts);
  assert.ok(!v.ok);
  if (!v.ok) assert.match(v.errors.join('\n'), /product_rules: old format/);
});

test('tags, preferences_text and scoring are validated', () => {
  const raw = YAML.parse(VALID_PROFILE_YAML);
  raw.tags = 'enfant';
  raw.preferences_text = 42;
  raw.scoring = { on_unknown: 'maybe' };
  const v = validateProfile(raw, opts);
  assert.ok(!v.ok);
  if (!v.ok) {
    const all = v.errors.join('\n');
    for (const s of ['tags:', 'preferences_text:', 'scoring.on_unknown']) assert.ok(all.includes(s), s);
  }
});
```

Modify `tests/helpers.ts` — in `VALID_PROFILE_YAML`, replace the line
`product_rules: { default: { store_brand_ok: true }, fruits_legumes: { organic: true } }` with:

```
tags: [enfant]
preferences_text: "Jamais d'oeufs de poules élevées au sol."
product_rules:
  - { id: oeufs-bien-etre, applies_to: { match: [oeuf] }, forbid: { any: [sol, cage] } }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test 2>&1 | grep -E "^✖|Cannot find"`
Expected: `rules.test.ts` fails (module not found); profile tests fail (old validation).

- [ ] **Step 3: Implement** — `scripts/lib/rules.ts`

```ts
import { tokens } from './normalize.ts';

export interface Matcher { any?: string[]; all?: string[]; brand_any?: string[] }
export interface AppliesTo { match?: string[]; not_match?: string[]; tags?: string[] }
export interface Rule {
  id: string;
  applies_to: 'all' | AppliesTo;
  require?: Matcher;
  forbid?: Matcher;
  prefer?: Matcher;
  budget?: { max_price?: number; max_price_per_kg?: number };
  max_premium_pct?: number;
  strictness?: 'hard' | 'soft';
  priority?: number;
  weight?: number;
}
export interface Scoring {
  weights: { price_per_unit: number; preferences: number; rating: number };
  indifference_pct: number;
  close_call_pct: number;
  on_unknown: 'reject' | 'ask';
}
export interface ScoringInput {
  weights?: Partial<Scoring['weights']>;
  indifference_pct?: number;
  close_call_pct?: number;
  on_unknown?: 'reject' | 'ask';
}

export const DEFAULT_SCORING: Scoring = {
  weights: { price_per_unit: 0.6, preferences: 0.35, rating: 0.05 },
  indifference_pct: 3,
  close_call_pct: 5,
  on_unknown: 'reject',
};
export const RULE_KINDS = ['require', 'forbid', 'prefer', 'budget'] as const;
export type RuleKind = (typeof RULE_KINDS)[number];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isWordList = (v: unknown): v is string[] =>
  Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string' && x.trim() !== '');
const norm = (w: string) => tokens(w).join(' ');

export function ruleKind(r: Rule): RuleKind {
  return r.require ? 'require' : r.forbid ? 'forbid' : r.prefer ? 'prefer' : 'budget';
}

export function matcherWords(m?: Matcher): string[] {
  return [...(m?.any ?? []), ...(m?.all ?? []), ...(m?.brand_any ?? [])].map(norm).filter(Boolean);
}

export function scopesOverlap(a: Rule, b: Rule): boolean {
  if (a.applies_to === 'all' || b.applies_to === 'all') return true;
  const words = (x: AppliesTo) => (x.match ?? []).map(norm);
  const sharedMatch = words(a.applies_to).some((w) => words(b.applies_to as AppliesTo).includes(w));
  const sharedTag = (a.applies_to.tags ?? []).some((t) => (b.applies_to as AppliesTo).tags?.includes(t));
  return sharedMatch || sharedTag;
}

function validateMatcher(v: unknown, path: string, err: (p: string, m: string) => void): void {
  if (!isObj(v)) return err(path, 'must be a mapping with any / all / brand_any');
  if (Object.keys(v).length === 0) err(path, 'needs any, all or brand_any');
  for (const [k, val] of Object.entries(v)) {
    if (!['any', 'all', 'brand_any'].includes(k)) err(`${path}.${k}`, 'unknown key (use any, all, brand_any)');
    else if (!isWordList(val)) err(`${path}.${k}`, 'must be a non-empty list of words');
  }
}

export function validateRules(raw: unknown[], tags: string[]): string[] {
  const errors: string[] = [];
  const err = (p: string, m: string) => {
    errors.push(`${p}: ${m}`);
  };
  const ids = new Set<string>();
  raw.forEach((r, i) => {
    const p = `product_rules[${i}]`;
    if (!isObj(r)) return err(p, 'must be a mapping');
    const id = typeof r.id === 'string' && r.id.trim() ? r.id : undefined;
    const at = id ? `product_rules.${id}` : p;
    if (!id) err(p, 'id: must be a non-empty string');
    else if (ids.has(id)) err(at, 'duplicate id');
    else ids.add(id);

    const a = r.applies_to;
    if (a !== 'all') {
      if (!isObj(a)) err(`${at}.applies_to`, 'must be "all" or { match, not_match, tags }');
      else {
        for (const k of Object.keys(a)) if (!['match', 'not_match', 'tags'].includes(k)) err(`${at}.applies_to.${k}`, 'unknown key');
        for (const k of ['match', 'not_match', 'tags']) if (a[k] !== undefined && !isWordList(a[k])) err(`${at}.applies_to.${k}`, 'must be a non-empty list of words');
        if (a.match === undefined && a.tags === undefined) err(`${at}.applies_to`, 'needs match or tags (or use "all")');
        if (isWordList(a.tags)) for (const t of a.tags) if (!tags.includes(t)) err(`${at}.applies_to.tags`, `unknown tag "${t}" (declare it in tags: [...])`);
      }
    }

    const kinds = RULE_KINDS.filter((k) => r[k] !== undefined);
    if (kinds.length !== 1) err(at, `needs exactly one of ${RULE_KINDS.join(', ')}`);
    for (const k of ['require', 'forbid', 'prefer'] as const) if (r[k] !== undefined) validateMatcher(r[k], `${at}.${k}`, err);
    if (r.budget !== undefined) {
      const b = r.budget;
      if (!isObj(b) || (b.max_price === undefined && b.max_price_per_kg === undefined)) err(`${at}.budget`, 'needs max_price or max_price_per_kg');
      else for (const k of ['max_price', 'max_price_per_kg']) {
        const v = b[k];
        if (v !== undefined && !(typeof v === 'number' && v > 0)) err(`${at}.budget.${k}`, 'must be a positive number');
      }
    }
    if (r.max_premium_pct !== undefined) {
      const v = r.max_premium_pct;
      if (r.prefer === undefined) err(`${at}.max_premium_pct`, 'only allowed with prefer');
      else if (!(typeof v === 'number' && v >= 0 && v <= 500)) err(`${at}.max_premium_pct`, 'must be a number between 0 and 500');
    }
    if (r.weight !== undefined) {
      const v = r.weight;
      if (r.prefer === undefined) err(`${at}.weight`, 'only allowed with prefer');
      else if (!(typeof v === 'number' && v > 0 && v <= 1)) err(`${at}.weight`, 'must be a number in (0, 1]');
    }
    if (r.strictness !== undefined) {
      if (r.prefer !== undefined) err(`${at}.strictness`, 'not allowed with prefer (preferences are always soft)');
      else if (r.strictness !== 'hard' && r.strictness !== 'soft') err(`${at}.strictness`, 'must be "hard" or "soft"');
    }
    if (r.priority !== undefined && !Number.isInteger(r.priority)) err(`${at}.priority`, 'must be an integer');
  });
  if (errors.length) return errors;

  const rules = raw as Rule[];
  for (const a of rules) {
    if (!a.require) continue;
    for (const b of rules) {
      if (!b.forbid || !scopesOverlap(a, b)) continue;
      const forbidden = matcherWords(b.forbid);
      const allWords = (a.require.all ?? []).map(norm);
      const anyWords = (a.require.any ?? []).map(norm);
      const blockedAll = allWords.filter((w) => forbidden.includes(w));
      const blockedAny = anyWords.length > 0 && anyWords.every((w) => forbidden.includes(w));
      if (blockedAll.length || blockedAny)
        errors.push(`product_rules.${a.id}: contradiction — requires "${(blockedAll.length ? blockedAll : anyWords).join(', ')}" but ${b.id} forbids it`);
    }
  }
  return errors;
}

export function validateScoring(raw: unknown): string[] {
  const errors: string[] = [];
  const err = (p: string, m: string) => {
    errors.push(`scoring.${p}: ${m}`);
  };
  if (!isObj(raw)) return ['scoring: must be a mapping'];
  for (const k of Object.keys(raw)) if (!['weights', 'indifference_pct', 'close_call_pct', 'on_unknown'].includes(k)) err(k, 'unknown key');
  if (raw.weights !== undefined) {
    if (!isObj(raw.weights)) err('weights', 'must be a mapping');
    else {
      for (const [k, v] of Object.entries(raw.weights)) {
        if (!['price_per_unit', 'preferences', 'rating'].includes(k)) err(`weights.${k}`, 'unknown weight (price_per_unit, preferences, rating)');
        else if (!(typeof v === 'number' && v >= 0)) err(`weights.${k}`, 'must be a number ≥ 0');
      }
      const merged = { ...DEFAULT_SCORING.weights, ...(raw.weights as Obj) };
      if (!errors.length && Object.values(merged).every((v) => v === 0)) errors.push('scoring.weights: at least one weight must be > 0');
    }
  }
  for (const k of ['indifference_pct', 'close_call_pct']) {
    const v = raw[k];
    if (v !== undefined && !(typeof v === 'number' && v >= 0 && v <= 50)) err(k, 'must be a number between 0 and 50');
  }
  if (raw.on_unknown !== undefined && raw.on_unknown !== 'reject' && raw.on_unknown !== 'ask') err('on_unknown', 'must be "reject" or "ask"');
  return errors;
}

export function resolveScoring(input: ScoringInput = {}): Scoring {
  return {
    weights: { ...DEFAULT_SCORING.weights, ...input.weights },
    indifference_pct: input.indifference_pct ?? DEFAULT_SCORING.indifference_pct,
    close_call_pct: input.close_call_pct ?? DEFAULT_SCORING.close_call_pct,
    on_unknown: input.on_unknown ?? DEFAULT_SCORING.on_unknown,
  };
}
```

- [ ] **Step 4: Update `scripts/lib/profile.ts`**

Replace the `ProductRule` interface block (lines 5–11) with:

```ts
import { validateRules, validateScoring, type Rule, type ScoringInput } from './rules.ts';
```
(place this import with the others at the top), and in `Profile` replace `product_rules: Record<string, ProductRule>;` with:

```ts
  tags: string[];
  preferences_text?: string;
  product_rules: Rule[];
  scoring?: ScoringInput;
```

Delete the `RULE_KEYS` constant.

Replace the `const pr = raw.product_rules; … }` block (the per-category loop) with:

```ts
  const tags = raw.tags === undefined ? [] : raw.tags;
  if (!isStrArray(tags)) err('tags', 'must be a list of strings');
  if (raw.preferences_text !== undefined && typeof raw.preferences_text !== 'string') err('preferences_text', 'must be a string');
  if (Array.isArray(raw.product_rules)) errors.push(...validateRules(raw.product_rules, isStrArray(tags) ? tags : []));
  else if (isObj(raw.product_rules))
    err('product_rules', 'old format (per-category mapping) — rerun /groceries onboarding to convert your preferences into rules');
  else err('product_rules', 'must be a list of rules (may be empty: [])');
  if (raw.scoring !== undefined) errors.push(...validateScoring(raw.scoring));
```

At the end of `validateProfile`, before returning `ok: true`, default `tags`: replace
`return errors.length ? { ok: false, errors } : { ok: true, profile: raw as unknown as Profile };` with:

```ts
  if (errors.length) return { ok: false, errors };
  const profile = raw as unknown as Profile;
  profile.tags ??= [];
  return { ok: true, profile };
```

- [ ] **Step 5: Update `config/profile.template.yml`**

Replace the two lines starting at `product_rules:` (the comment line and `default: { store_brand_ok: true }`) with:

```yaml
tags: []                # your own item labels, e.g. [enfant] — usable in rules
preferences_text: ""    # your buying preferences in your own words (kept verbatim)
product_rules: []       # generated from preferences_text by /groceries onboarding
# scoring: { weights: { price_per_unit: 0.6, preferences: 0.35, rating: 0.05 }, indifference_pct: 3, close_call_pct: 5, on_unknown: reject }
```

- [ ] **Step 6: Run tests**

Run: `npm run check`
Expected: all PASS (including the updated profile tests and the template-is-invalid test).

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: generic preference rules and scoring in the profile"
```

---

### Task 4: Preference engine

**Files:**
- Create: `scripts/lib/preference-engine.ts`
- Test: `tests/preference-engine.test.ts`

**Interfaces:**
- Consumes: `Product` (Task 2), `Rule`, `Scoring`, `Matcher`, `ruleKind`, `matcherWords`, `DEFAULT_SCORING` (Task 3), `containsPhrase` (normalize.ts).
- Produces:
  ```ts
  interface ItemRequest { item: string; need?: { qty?: number; unit?: string | null }; tags?: string[]; role?: 'key' | 'minor' }
  interface ResolveContext { preferredEans?: string[] }
  interface Option { ean; title; price?; unit_price?; unit?; packs: number; satisfied: string[]; score: number }
  interface Decision { item; status: 'chosen'|'close_call'|'none'|'ask'; choice?: Option; options?: Option[]; why: string[]; relaxed: string[]; eliminated: { ean; title; reasons: string[] }[]; flags: string[] }
  specificity(r): number; appliesTo(r, req): boolean; activeRules(rules, req): { active: Rule[]; shadowed: string[] };
  computePacks(need, product): { packs: number; flag?: string };
  resolveItem(req, products, rules, scoring, ctx?): Decision
  ```

- [ ] **Step 1: Write the failing test** — `tests/preference-engine.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeRules, computePacks, resolveItem } from '../scripts/lib/preference-engine.ts';
import { DEFAULT_SCORING, type Rule, type Scoring } from '../scripts/lib/rules.ts';
import type { Product } from '../scripts/lib/product-mapper.ts';

const P = (ean: string, title: string, unitPrice: number | undefined, extra: Partial<Product> = {}): Product => ({
  ean, title, unitPrice, unit: 'kg', price: unitPrice, available: true, text: title, ...extra,
});
const rules: Rule[] = [
  { id: 'oeufs', applies_to: { match: ['oeuf'] }, forbid: { any: ['sol', 'cage'] } },
  { id: 'poulet', applies_to: { match: ['poulet'], not_match: ['bouillon'] }, require: { any: ['plein air', 'label rouge', 'bio'] } },
  { id: 'enfant-bio', applies_to: { tags: ['enfant'] }, require: { any: ['bio'] }, priority: 10 },
  { id: 'bio-raisonnable', applies_to: 'all', prefer: { any: ['bio'] }, max_premium_pct: 20 },
];
const S = DEFAULT_SCORING;

test('hard forbid removes barn eggs; whole words only (review focus 3)', () => {
  const d = resolveItem({ item: 'oeufs' }, [
    P('1', 'Oeufs de poules élevées au sol x12', 2.5),
    P('2', 'Oeufs plein air x12', 3.5),
    P('3', 'Oeufs frais extra solaire x12', 3.6),
  ], rules, S);
  assert.equal(d.status, 'chosen');
  assert.equal(d.choice?.ean, '2');
  assert.deepEqual(d.eliminated, [{ ean: '1', title: 'Oeufs de poules élevées au sol x12', reasons: ['oeufs'] }]);
});

test('require with scope exclusions', () => {
  const ps = [P('a', 'Filet de poulet', 9), P('b', 'Filet de poulet fermier Label Rouge', 14)];
  assert.equal(resolveItem({ item: 'blanc de poulet' }, ps, rules, S).choice?.ean, 'b');
  assert.equal(resolveItem({ item: 'bouillon de poulet' }, ps, rules, S).choice?.ean, 'a');
});

test('capped preference wins within the cap, not beyond (lexicographic)', () => {
  const inCap = resolveItem({ item: 'lentilles' }, [P('n', 'Lentilles vertes', 10), P('b', 'Lentilles vertes bio', 11.9)], rules, S);
  assert.equal(inCap.choice?.ean, 'b');
  assert.ok(inCap.why.includes('bio-raisonnable:+19%'), inCap.why.join(','));
  const beyond = resolveItem({ item: 'lentilles' }, [P('n', 'Lentilles vertes', 10), P('b', 'Lentilles vertes bio', 12.1)], rules, S);
  assert.equal(beyond.choice?.ean, 'n');
});

test('capped preference ignores products without unit price (review focus 2)', () => {
  const d = resolveItem({ item: 'lentilles' }, [P('n', 'Lentilles vertes', 10), P('b', 'Lentilles vertes bio', undefined, { price: 2 })], rules, S);
  assert.equal(d.choice?.ean, 'n');
});

test('more specific rule shadows the general one (child food)', () => {
  const req = { item: 'compote', tags: ['enfant'] };
  assert.deepEqual(activeRules(rules, req).shadowed, ['bio-raisonnable']);
  const d = resolveItem(req, [P('n', 'Compote pomme', 3), P('b', 'Compote pomme bio', 6)], rules, S);
  assert.equal(d.choice?.ean, 'b');
  assert.ok(d.flags.includes('shadowed:bio-raisonnable'));
});

test('closed world: unknown attribute rejects, or asks', () => {
  const budget: Rule[] = [{ id: 'cafe', applies_to: { match: ['cafe'] }, budget: { max_price_per_kg: 25 } }];
  const ps = [P('x', 'Café moulu', undefined, { price: 4 })];
  const rejected = resolveItem({ item: 'café' }, ps, budget, S);
  assert.equal(rejected.status, 'none');
  assert.deepEqual(rejected.eliminated[0].reasons, ['unknown:cafe']);
  const asked = resolveItem({ item: 'café' }, ps, budget, { ...S, on_unknown: 'ask' });
  assert.equal(asked.status, 'ask');
  assert.equal(asked.options?.[0].ean, 'x');
});

test('soft rules are relaxed when nothing survives; hard rules never', () => {
  const soft: Rule[] = [{ id: 'cafe', applies_to: { match: ['cafe'] }, budget: { max_price_per_kg: 10 }, strictness: 'soft' }];
  const ps = [P('x', 'Café moulu', 18), P('y', 'Café grains', 22)];
  const relaxed = resolveItem({ item: 'café' }, ps, soft, S);
  assert.equal(relaxed.status, 'chosen');
  assert.deepEqual(relaxed.relaxed, ['cafe']);
  assert.equal(relaxed.choice?.ean, 'x');
  const hard = resolveItem({ item: 'café' }, ps, [{ ...soft[0], strictness: 'hard' }], S);
  assert.equal(hard.status, 'none');
  assert.deepEqual(hard.relaxed, []);
});

test('unavailable products are eliminated; empty search → none', () => {
  const d = resolveItem({ item: 'riz' }, [P('x', 'Riz', 2, { available: false })], [], S);
  assert.equal(d.status, 'none');
  assert.deepEqual(d.eliminated[0].reasons, ['unavailable']);
  assert.equal(resolveItem({ item: 'riz' }, [], [], S).status, 'none');
});

test('indifference: near-equal prices tie and the cheaper wins without a close call', () => {
  const d = resolveItem({ item: 'riz' }, [P('a', 'Riz long', 2.0), P('b', 'Riz long grain', 2.04)], [], S);
  assert.equal(d.status, 'chosen');
  assert.equal(d.choice?.ean, 'a');
});

test('close call only for a real trade-off between preferences', () => {
  const pref: Rule[] = [{ id: 'label-rouge', applies_to: 'all', prefer: { any: ['label rouge'] }, weight: 1 }];
  const sc: Scoring = { ...S, weights: { price_per_unit: 0.9, preferences: 0.1, rating: 0 } };
  const close = resolveItem({ item: 'poulet entier' }, [P('a', 'Poulet entier', 10), P('b', 'Poulet entier Label Rouge', 10.8)], pref, sc);
  assert.equal(close.status, 'close_call');
  assert.deepEqual(close.options?.map((o) => o.ean), ['b', 'a']);
  const clear = resolveItem({ item: 'poulet entier' }, [P('a', 'Poulet entier', 10), P('b', 'Poulet entier Label Rouge', 10.5)], pref, sc);
  assert.equal(clear.status, 'chosen');
  assert.equal(clear.choice?.ean, 'b');
});

test('status quo: remembered product kept within indifference only', () => {
  const ps = [P('a', 'Lait demi-écrémé', 1.0), P('b', 'Lait demi-écrémé UHT', 1.02), P('c', 'Lait demi-écrémé bouteille', 1.2)];
  const kept = resolveItem({ item: 'lait' }, ps, [], S, { preferredEans: ['b'] });
  assert.equal(kept.choice?.ean, 'b');
  assert.ok(kept.why.includes('status-quo'));
  const replaced = resolveItem({ item: 'lait' }, ps, [], S, { preferredEans: ['c'] });
  assert.equal(replaced.choice?.ean, 'a');
});

test('remembered product never bypasses a hard rule', () => {
  const d = resolveItem({ item: 'oeufs' }, [P('1', 'Oeufs élevés au sol', 2.5), P('2', 'Oeufs plein air', 3.5)], rules, S, { preferredEans: ['1'] });
  assert.equal(d.choice?.ean, '2');
});

test('pareto pruning keeps dominated products out of options', () => {
  const pref: Rule[] = [{ id: 'label-rouge', applies_to: 'all', prefer: { any: ['label rouge'] }, weight: 1 }];
  const sc: Scoring = { ...S, weights: { price_per_unit: 0.9, preferences: 0.1, rating: 0 } };
  const d = resolveItem({ item: 'poulet entier' }, [
    P('a', 'Poulet entier', 10), P('b', 'Poulet entier Label Rouge', 10.8), P('z', 'Poulet entier premium', 13),
  ], pref, sc);
  assert.ok(!(d.options ?? []).some((o) => o.ean === 'z'));
});

test('computePacks', () => {
  assert.deepEqual(computePacks({ qty: 400, unit: 'g' }, P('x', 'x', 1, { packQty: 250, packUnit: 'g' })), { packs: 2 });
  assert.deepEqual(computePacks({ qty: 6 }, P('x', 'x', 1, { packQty: 4, packUnit: 'piece' })), { packs: 2 });
  assert.deepEqual(computePacks({ qty: 1, unit: 'kg' }, P('x', 'x', 1, { packQty: 1000, packUnit: 'g' })), { packs: 1 });
  assert.deepEqual(computePacks({ qty: 2, unit: 'cas' }, P('x', 'x', 1, { packQty: 500, packUnit: 'g' })), { packs: 1, flag: 'qty-unknown' });
  assert.deepEqual(computePacks(undefined, P('x', 'x', 1)), { packs: 1 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/preference-engine.test.ts`
Expected: FAIL — cannot find module `preference-engine.ts`.

- [ ] **Step 3: Implement** — `scripts/lib/preference-engine.ts`

```ts
import { containsPhrase } from './normalize.ts';
import type { Product } from './product-mapper.ts';
import { matcherWords, ruleKind, type Matcher, type Rule, type Scoring } from './rules.ts';

export interface ItemRequest { item: string; need?: { qty?: number; unit?: string | null }; tags?: string[]; role?: 'key' | 'minor' }
export interface ResolveContext { preferredEans?: string[] }
export interface Option {
  ean: string;
  title: string;
  price?: number;
  unit_price?: number;
  unit?: string;
  packs: number;
  satisfied: string[];
  score: number;
}
export interface Decision {
  item: string;
  status: 'chosen' | 'close_call' | 'none' | 'ask';
  choice?: Option;
  options?: Option[];
  why: string[];
  relaxed: string[];
  eliminated: { ean: string; title: string; reasons: string[] }[];
  flags: string[];
}

interface Cand { p: Product; softFails: string[]; unknowns: string[]; satisfied: string[]; pref: number; score: number }

const prio = (r: Rule) => r.priority ?? 0;
const weightOf = (r: Rule) => r.weight ?? 0.1;

export function specificity(r: Rule): number {
  if (r.applies_to === 'all') return 0;
  if (r.applies_to.tags?.length) return 3;
  if (r.applies_to.not_match?.length) return 2;
  return 1;
}

export function appliesTo(r: Rule, req: ItemRequest): boolean {
  if (r.applies_to === 'all') return true;
  const a = r.applies_to;
  if (a.tags?.length && !a.tags.some((t) => (req.tags ?? []).includes(t))) return false;
  if (a.match?.length && !a.match.some((w) => containsPhrase(req.item, w))) return false;
  if (a.not_match?.some((w) => containsPhrase(req.item, w))) return false;
  return true;
}

const matcherOf = (r: Rule): Matcher | undefined => r.require ?? r.prefer ?? r.forbid;
const outranks = (o: Rule, r: Rule) => specificity(o) > specificity(r) || (specificity(o) === specificity(r) && prio(o) > prio(r));
function sameFamily(o: Rule, r: Rule): boolean {
  const ko = ruleKind(o);
  const kr = ruleKind(r);
  if (kr === 'prefer') return ko === 'prefer' || ko === 'require';
  if (kr === 'require') return ko === 'require';
  if (kr === 'budget') return ko === 'budget';
  return false; // forbids are additive and never shadowed
}
function overlap(o: Rule, r: Rule): boolean {
  if (ruleKind(r) === 'budget') return true;
  const wo = matcherWords(matcherOf(o));
  return matcherWords(matcherOf(r)).some((w) => wo.includes(w));
}

/** Rules applying to this item; a less specific rule on the same words is shadowed by a more specific one. */
export function activeRules(rules: Rule[], req: ItemRequest): { active: Rule[]; shadowed: string[] } {
  const applicable = rules.filter((r) => appliesTo(r, req));
  const shadowed = applicable.filter((r) => applicable.some((o) => o !== r && sameFamily(o, r) && outranks(o, r) && overlap(o, r)));
  return { active: applicable.filter((r) => !shadowed.includes(r)), shadowed: shadowed.map((r) => r.id) };
}

function matches(m: Matcher, p: Product): boolean {
  if (m.any && !m.any.some((w) => containsPhrase(p.text, w))) return false;
  if (m.all && !m.all.every((w) => containsPhrase(p.text, w))) return false;
  if (m.brand_any && !m.brand_any.some((w) => containsPhrase(p.brand ?? '', w))) return false;
  return true;
}

function checkConstraint(r: Rule, p: Product): 'pass' | 'fail' | 'unknown' {
  if (r.require) return p.text.trim() ? (matches(r.require, p) ? 'pass' : 'fail') : 'unknown';
  if (r.forbid) return p.text.trim() ? (matches(r.forbid, p) ? 'fail' : 'pass') : 'unknown';
  const b = r.budget ?? {};
  if (b.max_price !== undefined) {
    if (p.price === undefined) return 'unknown';
    if (p.price > b.max_price) return 'fail';
  }
  if (b.max_price_per_kg !== undefined) {
    if (p.unitPrice === undefined) return 'unknown';
    if (p.unitPrice > b.max_price_per_kg) return 'fail';
  }
  return 'pass';
}

const NEED_UNITS: Record<string, { unit: 'g' | 'ml' | 'piece'; factor: number }> = {
  g: { unit: 'g', factor: 1 }, kg: { unit: 'g', factor: 1000 },
  ml: { unit: 'ml', factor: 1 }, cl: { unit: 'ml', factor: 10 }, l: { unit: 'ml', factor: 1000 },
  piece: { unit: 'piece', factor: 1 },
};

export function computePacks(need: ItemRequest['need'], p: Product): { packs: number; flag?: string } {
  if (!need?.qty) return { packs: 1 };
  const nu = NEED_UNITS[need.unit ?? 'piece'];
  if (!nu || p.packQty === undefined || p.packUnit !== nu.unit) return { packs: 1, flag: 'qty-unknown' };
  return { packs: Math.max(1, Math.ceil((need.qty * nu.factor) / p.packQty - 1e-9)) };
}

const pct = (x: number) => (x >= 0 ? `+${x}%` : `${x}%`);

export function resolveItem(req: ItemRequest, products: Product[], rules: Rule[], scoring: Scoring, ctx: ResolveContext = {}): Decision {
  const { active, shadowed } = activeRules(rules, req);
  const constraints = active.filter((r) => ruleKind(r) !== 'prefer');
  const prefers = active.filter((r) => ruleKind(r) === 'prefer');
  const preferred = ctx.preferredEans ?? [];
  const eliminated: Decision['eliminated'] = [];
  const flags = shadowed.map((id) => `shadowed:${id}`);

  // 1. hard filter, collecting soft failures and unknowns
  const pool: Cand[] = [];
  for (const p of products) {
    if (!p.available) {
      eliminated.push({ ean: p.ean, title: p.title, reasons: ['unavailable'] });
      continue;
    }
    const reasons: string[] = [];
    const c: Cand = { p, softFails: [], unknowns: [], satisfied: [], pref: 0, score: 0 };
    for (const r of constraints) {
      const res = checkConstraint(r, p);
      if (res === 'pass') continue;
      if (res === 'unknown') {
        if (scoring.on_unknown === 'reject') reasons.push(`unknown:${r.id}`);
        else c.unknowns.push(r.id);
      } else if ((r.strictness ?? 'hard') === 'hard') reasons.push(r.id);
      else c.softFails.push(r.id);
    }
    if (reasons.length) eliminated.push({ ean: p.ean, title: p.title, reasons });
    else pool.push(c);
  }

  // 2. ordered relaxation of soft rules (lowest priority first)
  const relaxed: string[] = [];
  let survivors = pool.filter((c) => c.softFails.length === 0);
  const soft = constraints.filter((r) => r.strictness === 'soft').sort((a, b) => prio(a) - prio(b));
  for (const r of soft) {
    if (survivors.length) break;
    relaxed.push(r.id);
    survivors = pool.filter((c) => c.softFails.every((id) => relaxed.includes(id)));
  }
  for (const c of pool) if (!survivors.includes(c)) eliminated.push({ ean: c.p.ean, title: c.p.title, reasons: c.softFails });
  const base = { item: req.item, relaxed, eliminated, flags };
  if (!survivors.length) {
    return { ...base, status: 'none', why: [...new Set(eliminated.flatMap((e) => e.reasons))] };
  }

  // Compare on price per unit when any candidate has one (a missing unit price then scores 0);
  // fall back to the pack price only when no candidate has a unit price.
  const useUnit = survivors.some((c) => c.p.unitPrice !== undefined);
  const priceOf = (p: Product) => (useUnit ? p.unitPrice : p.price);

  // 3. capped preferences, lexicographic, most specific first
  const capped = prefers.filter((r) => r.max_premium_pct !== undefined).sort((a, b) => (outranks(a, b) ? -1 : outranks(b, a) ? 1 : 0));
  for (const r of capped) {
    const sat = survivors.filter((c) => matches(r.prefer!, c.p));
    const rest = survivors.filter((c) => !sat.includes(c));
    if (!sat.length) continue;
    if (!rest.length) {
      sat.forEach((c) => c.satisfied.push(r.id));
      continue;
    }
    const bestRest = Math.min(...rest.map((c) => c.p.unitPrice).filter((v): v is number => v !== undefined));
    if (!Number.isFinite(bestRest)) continue;
    const within = sat.filter((c) => c.p.unitPrice !== undefined && c.p.unitPrice <= bestRest * (1 + r.max_premium_pct! / 100));
    if (!within.length) continue;
    within.forEach((c) => c.satisfied.push(`${r.id}:${pct(Math.round((c.p.unitPrice! / bestRest - 1) * 100))}`));
    survivors = within;
  }

  // 4. uncapped preferences → preference score
  const uncapped = prefers.filter((r) => r.max_premium_pct === undefined);
  const totalW = uncapped.reduce((s, r) => s + weightOf(r), 0);
  for (const c of survivors) {
    let w = 0;
    for (const r of uncapped) if (matches(r.prefer!, c.p)) {
      w += weightOf(r);
      c.satisfied.push(r.id);
    }
    c.pref = totalW ? w / totalW : 0;
  }

  // 5. pareto pruning (remembered products are exempt so status quo can apply)
  const dominates = (d: Cand, c: Cand) => {
    const pd = priceOf(d.p);
    const pc = priceOf(c.p);
    if (pd === undefined || pc === undefined) return false;
    const rd = d.p.rating ?? 0;
    const rc = c.p.rating ?? 0;
    return pd <= pc && d.pref >= c.pref && rd >= rc && (pd < pc || d.pref > c.pref || rd > rc);
  };
  const cands = survivors.filter((c) => preferred.includes(c.p.ean) || !survivors.some((d) => d !== c && dominates(d, c)));

  // 6. score
  const prices = cands.map((c) => priceOf(c.p)).filter((v): v is number => v !== undefined);
  const minPrice = prices.length ? Math.min(...prices) : undefined;
  const w = scoring.weights;
  const wSum = w.price_per_unit + w.preferences + w.rating || 1;
  for (const c of cands) {
    const v = priceOf(c.p);
    const ps = v === undefined || minPrice === undefined ? 0 : (v - minPrice) / minPrice * 100 <= scoring.indifference_pct ? 1 : minPrice / v;
    const rs = c.p.rating === undefined ? 0.5 : c.p.rating / 5;
    c.score = (w.price_per_unit * ps + w.preferences * c.pref + w.rating * rs) / wSum;
  }
  cands.sort((a, b) => b.score - a.score || (priceOf(a.p) ?? Infinity) - (priceOf(b.p) ?? Infinity) || a.p.ean.localeCompare(b.p.ean));

  const toOption = (c: Cand): Option => {
    const o: Option = { ean: c.p.ean, title: c.p.title, packs: computePacks(req.need, c.p).packs, satisfied: c.satisfied, score: Math.round(c.score * 1000) / 1000 };
    if (c.p.price !== undefined) o.price = c.p.price;
    if (c.p.unitPrice !== undefined) o.unit_price = c.p.unitPrice;
    if (c.p.unit !== undefined) o.unit = c.p.unit;
    return o;
  };

  // 7. decide
  const top = cands[0];
  let winner = top;
  const why: string[] = [];
  for (const ean of preferred) {
    const c = cands.find((x) => x.p.ean === ean);
    if (c && c.score >= top.score * (1 - scoring.indifference_pct / 100)) {
      winner = c;
      why.push('status-quo');
      break;
    }
  }
  const packs = computePacks(req.need, winner.p);
  if (packs.flag) flags.push(packs.flag);
  why.unshift(...winner.satisfied, ...constraints.map((r) => r.id));
  if (relaxed.length) why.push(...relaxed.map((id) => `relaxed:${id}`));

  if (winner.unknowns.length) {
    return { ...base, status: 'ask', choice: toOption(winner), options: cands.slice(0, 3).map(toOption), why: [...why, ...winner.unknowns.map((id) => `unknown:${id}`)] };
  }
  const second = cands.find((c) => c !== winner);
  const sameSatisfied = (a: Cand, b: Cand) => a.satisfied.length === b.satisfied.length && a.satisfied.every((s) => b.satisfied.includes(s));
  if (!why.includes('status-quo') && second && (winner.score - second.score) / winner.score * 100 < scoring.close_call_pct && !sameSatisfied(winner, second)) {
    return { ...base, status: 'close_call', options: cands.slice(0, 3).map(toOption), why };
  }
  return { ...base, status: 'chosen', choice: toOption(winner), why };
}
```

- [ ] **Step 4: Run tests**

Run: `npm run check`
Expected: all PASS. If a scoring expectation fails, debug the engine (systematic-debugging) — the test values are hand-computed: close-call case `a = 0.9`, `b = 0.9 × 10/10.8 + 0.1 = 0.933` (gap 3.5 % < 5 %); clear case `b = 0.9 × 10/10.5 + 0.1 = 0.957` (gap 6 %).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: preference engine (constraints, relaxation, capped preferences, scoring, decisions)"
```

---

### Task 5: Shared MCP session and provider search block

**Files:**
- Create: `scripts/lib/mcp-client.ts`
- Modify: `scripts/lib/mcp-probe.ts`, `scripts/lib/provider.ts`, `providers/carrefour.yml`
- Test: `tests/mcp-client.test.ts`, extend `tests/provider.test.ts`

**Interfaces:**
- Consumes: `SearchSpec`, `PARSE_KINDS`, `FIELD_NAMES` (Task 2).
- Produces: `interface ToolResult { isError: boolean; text: string }`; `interface McpSession { call(tool, args): Promise<ToolResult>; close(): Promise<void> }`; `openSession(p: McpProvider, timeoutMs?): Promise<McpSession>`; `contentText(content: unknown): string`; `parseToolJson(r: ToolResult): unknown`; `McpProvider.search?: SearchSpec`; `mappingReady(p: McpProvider): boolean`. `probeSession(p, timeoutMs?)` keeps its signature (returns `ToolResult`).

- [ ] **Step 1: Write the failing tests**

`tests/mcp-client.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contentText, parseToolJson } from '../scripts/lib/mcp-client.ts';

test('contentText joins text parts and ignores others', () => {
  assert.equal(contentText([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }]), 'a\nb');
  assert.equal(contentText(undefined), '');
});

test('parseToolJson parses JSON text and surfaces tool errors', () => {
  assert.deepEqual(parseToolJson({ isError: false, text: '{"data":[1]}' }), { data: [1] });
  assert.throws(() => parseToolJson({ isError: true, text: 'No Carrefour session available.' }), /No Carrefour session/);
  assert.throws(() => parseToolJson({ isError: false, text: 'not json' }), /not JSON/);
});
```

Append to `tests/provider.test.ts`:

```ts
import { mappingReady } from '../scripts/lib/provider.ts';

test('search block: carrefour declares the tool; mapping not discovered yet', () => {
  assert.equal(carrefour.search?.tool, 'search_products');
  assert.deepEqual(carrefour.search?.args, { q: '{query}' });
  assert.equal(mappingReady(carrefour), false);
  assert.equal(mappingReady({ ...carrefour, search: { ...carrefour.search!, fields: { ean: 'a', title: 'b' } } }), true);
});

test('search block validation', () => {
  const raw = YAML.parse(readFileSync(paths.provider('carrefour'), 'utf8'));
  raw.search = { tool: 'submit_checkout_payment', args: [], fields: { title: 'x', price: { path: 'p', parse: 'euros' } } };
  const v = validateProvider(raw, 'carrefour');
  assert.ok(!v.ok);
  if (!v.ok) {
    const all = v.errors.join('\n');
    for (const s of ['search.tool: "submit_checkout_payment" is forbidden', 'search.args: must be a mapping', 'search.fields.ean: required', 'search.fields.price.parse: must be one of'])
      assert.ok(all.includes(s), `missing "${s}" in:\n${all}`);
  }
});
```
(Merge the new import into the existing `provider.ts` import line.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test 2>&1 | grep -E "^✖|Cannot find"`
Expected: `mcp-client.test.ts` fails (module not found); the two new provider tests fail.

- [ ] **Step 3: Implement**

`scripts/lib/mcp-client.ts`:

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { McpProvider } from './provider.ts';

export interface ToolResult { isError: boolean; text: string }
export interface McpSession {
  call(tool: string, args: Record<string, unknown>): Promise<ToolResult>;
  close(): Promise<void>;
}

export function contentText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => (c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string' ? (c as { text: string }).text : ''))
    .filter(Boolean)
    .join('\n');
}

export function parseToolJson(r: ToolResult): unknown {
  if (r.isError) throw new Error(`tool error: ${r.text.slice(0, 300)}`);
  try {
    return JSON.parse(r.text);
  } catch {
    throw new Error(`tool output is not JSON: ${r.text.slice(0, 120)}`);
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

/** One stdio MCP session to the provider's server, reused for many calls. */
export async function openSession(p: McpProvider, timeoutMs = 60_000): Promise<McpSession> {
  const transport = new StdioClientTransport({ command: p.spawn.command, args: p.spawn.args, stderr: 'ignore' });
  const client = new Client({ name: 'groceries-ops', version: '0.1.0' });
  try {
    await withTimeout(client.connect(transport), timeoutMs, 'MCP connect');
  } catch (e) {
    await client.close().catch(() => {});
    throw e;
  }
  return {
    async call(tool, args) {
      const res = (await withTimeout(client.callTool({ name: tool, arguments: args }, undefined, { timeout: timeoutMs }), timeoutMs, tool)) as {
        content?: unknown;
        isError?: unknown;
      };
      return { isError: res.isError === true, text: contentText(res.content) };
    },
    close: () => client.close().catch(() => {}),
  };
}
```

Replace the whole body of `scripts/lib/mcp-probe.ts` with:

```ts
import { openSession, type ToolResult } from './mcp-client.ts';
import type { McpProvider } from './provider.ts';

export type ProbeResult = ToolResult;

/** Starts the provider's MCP server on stdio and calls its session-check tool. */
export async function probeSession(p: McpProvider, timeoutMs = 60_000): Promise<ProbeResult> {
  const session = await openSession(p, timeoutMs);
  try {
    const check = p.capabilities.session_check;
    return await session.call(check.tool, check.args);
  } finally {
    await session.close();
  }
}
```

In `scripts/lib/provider.ts`:
- add `import { FIELD_NAMES, PARSE_KINDS, type SearchSpec } from './product-mapper.ts';`
- add `search?: SearchSpec;` to `McpProvider` (after `notes?: string;`)
- in `validateProvider`, just before `if (errors.length) return { ok: false, errors };` (the one before `const provider = raw as unknown as McpProvider;`), insert:

```ts
  if (raw.search !== undefined) {
    const s = raw.search;
    if (!isObj(s)) err('search', 'must be a mapping');
    else {
      tool('search.tool', s.tool);
      if (s.args !== undefined && !isObj(s.args)) err('search.args', 'must be a mapping');
      if (s.products_path !== undefined && typeof s.products_path !== 'string') err('search.products_path', 'must be a string');
      if (s.fields !== undefined) {
        if (!isObj(s.fields)) err('search.fields', 'must be a mapping');
        else {
          const f = s.fields;
          for (const k of ['ean', 'title'] as const) if (f[k] === undefined) err(`search.fields.${k}`, 'required');
          for (const [k, v] of Object.entries(f)) {
            if (k === 'text') {
              if (!(typeof v === 'string' || (Array.isArray(v) && v.every((x) => typeof x === 'string')))) err('search.fields.text', 'must be a path or a list of paths');
              continue;
            }
            if (!(FIELD_NAMES as readonly string[]).includes(k)) err(`search.fields.${k}`, `unknown field (known: ${FIELD_NAMES.join(', ')}, text)`);
            else if (typeof v === 'string') continue;
            else if (!isObj(v) || typeof v.path !== 'string') err(`search.fields.${k}`, 'must be a path or { path, parse }');
            else if (v.parse !== undefined && !PARSE_KINDS.includes(v.parse as never)) err(`search.fields.${k}.parse`, `must be one of ${PARSE_KINDS.join(', ')}`);
          }
        }
      }
    }
  }
```
- after `provider.capabilities.session_check.args ??= {};` add `if (provider.search) provider.search.args ??= {};`
- export:

```ts
export function mappingReady(p: McpProvider): boolean {
  return Boolean(p.search?.fields);
}
```

In `providers/carrefour.yml`, append:

```yaml
search:
  tool: search_products
  args: { q: "{query}" }
  # products_path and fields are written by /groceries setup (mapping discovery) from real responses
```

- [ ] **Step 4: Run tests**

Run: `npm run check`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: shared MCP session and provider search declaration"
```

---

### Task 6: `products.ts` — resolve, map-check, validate, feedback, suggest

**Files:**
- Create: `scripts/products.ts`
- Test: `tests/products.test.ts`

**Interfaces:**
- Consumes: Tasks 2–5; `getChoice`/`loadChoices` (choices.ts); `findHabit`/`loadHabits` (habits.ts); `requireProfile`/`loadProfile` (profile.ts); `loadProvider` (provider.ts); `tokens` (normalize.ts); `paths`, `today`.
- Produces:
  ```ts
  itemFileName(item: string): string
  interface CompactDecision { item; status: Decision['status'] | 'error'; ean?; title?; packs?; price?; unit_price?; unit?; options?: Option[]; why: string[]; relaxed?: string[]; flags?: string[]; eliminated?: Record<string, number> }
  type ResolveOutput = { resolved: CompactDecision[]; exceptions: CompactDecision[]; stats: { items: number; chosen: number; exceptions: number } }
  type Fallback = { fallback: 'search-via-claude'; reason: string; dir: string; files: { item: string; query: string; file: string }[] }
  runResolve(items: ItemRequest[], opts: { today: string; fromSearch?: string }, deps: { profile: Profile; provider: McpProvider; open: (p: McpProvider) => Promise<McpSession>; preferredEans: (item: string) => string[] }): Promise<ResolveOutput | Fallback>
  suggestions(rows: FeedbackRow[], threshold?: number): { rule: string; overrides: number; hint: string }[]
  ```
- CLI: `products.ts resolve <items.json|-> [--from-search <dir>] [--today d]`, `map-check <raw.json>... [--provider id]`, `validate`, `feedback <item> <chosen_ean> <overridden_ean> [--rules a,b] [--today d]`, `suggest`.

- [ ] **Step 1: Write the failing test** — `tests/products.test.ts`

```ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { itemFileName, runResolve, suggestions } from '../scripts/products.ts';
import { loadProvider, type McpProvider } from '../scripts/lib/provider.ts';
import type { McpSession } from '../scripts/lib/mcp-client.ts';
import type { Profile } from '../scripts/lib/profile.ts';
import { paths } from '../scripts/lib/paths.ts';
import { VALID_PROFILE_YAML, useTempRoot } from './helpers.ts';

const provider: McpProvider = {
  ...(loadProvider('carrefour') as McpProvider),
  search: {
    tool: 'search_products',
    args: { q: '{query}' },
    products_path: 'data',
    fields: { ean: 'ean', title: 'title', price: { path: 'price', parse: 'price' }, unit_price: { path: 'per', parse: 'unit_price' } },
  },
};
const catalog: Record<string, unknown> = {
  oeufs: { data: [
    { ean: '1', title: 'Oeufs élevés au sol x12', price: 2.5, per: '0,21 €/pièce' },
    { ean: '2', title: 'Oeufs plein air x12', price: 3.5, per: '0,29 €/pièce' },
  ] },
  riz: { data: [{ ean: '9', title: 'Riz long', price: 2, per: '2,00 €/kg' }] },
  vide: { data: [] },
};
const profile = YAML.parse(VALID_PROFILE_YAML) as Profile;
const day = '2026-10-07';

function fakeOpen(log: string[], errorFor: string[] = []) {
  return async (): Promise<McpSession> => ({
    async call(tool, args) {
      log.push(`${tool}:${String(args.q)}`);
      const q = String(args.q);
      if (errorFor.includes(q)) return { isError: true, text: 'boom' };
      return { isError: false, text: JSON.stringify(catalog[q] ?? { data: [] }) };
    },
    async close() {
      log.push('close');
    },
  });
}

beforeEach(() => useTempRoot());

test('resolves items through one session; raw results go to files, not output', async () => {
  const log: string[] = [];
  const out = await runResolve([{ item: 'oeufs', need: { qty: 6 } }, { item: 'riz' }], { today: day },
    { profile, provider, open: fakeOpen(log), preferredEans: () => [] });
  assert.ok('resolved' in out);
  if (!('resolved' in out)) return;
  assert.deepEqual(log, ['search_products:oeufs', 'search_products:riz', 'close']);
  assert.deepEqual(out.resolved.map((r) => r.ean), ['2', '9']);
  assert.deepEqual(out.stats, { items: 2, chosen: 2, exceptions: 0 });
  assert.ok(existsSync(join(paths.runs(), `${day}-search`, 'oeufs.json')));
  assert.ok(!JSON.stringify(out).includes('élevés au sol'));
});

test('empty search, tool error and unknown item become exceptions without stopping the run (review focus 1, 5)', async () => {
  const log: string[] = [];
  const out = await runResolve([{ item: 'vide' }, { item: 'oeufs' }, { item: 'riz' }], { today: day },
    { profile, provider, open: fakeOpen(log, ['oeufs']), preferredEans: () => [] });
  if (!('resolved' in out)) return assert.fail('expected a resolve output');
  assert.deepEqual(out.exceptions.map((e) => [e.item, e.status]), [['vide', 'none'], ['oeufs', 'error']]);
  assert.match(out.exceptions[1].why[0], /tool error: boom/);
  assert.deepEqual(out.resolved.map((r) => r.item), ['riz']);
});

test('connect failure returns the search-via-claude fallback; --from-search reuses those files (review focus 4)', async () => {
  const items = [{ item: 'crème fraîche / épaisse' }];
  const fb = await runResolve(items, { today: day }, {
    profile, provider, open: async () => { throw new Error('profile locked'); }, preferredEans: () => [],
  });
  if (!('fallback' in fb)) return assert.fail('expected fallback');
  assert.equal(fb.files[0].query, 'crème fraîche / épaisse');
  assert.equal(itemFileName('crème fraîche / épaisse'), 'creme-fraiche-epaisse.json');
  mkdirSync(fb.dir, { recursive: true });
  writeFileSync(fb.files[0].file, JSON.stringify({ data: [{ ean: '5', title: 'Crème fraîche épaisse', price: 1.5, per: '7,50 €/kg' }] }));
  const out = await runResolve(items, { today: day, fromSearch: fb.dir }, {
    profile, provider, open: async () => { throw new Error('must not connect'); }, preferredEans: () => [],
  });
  if (!('resolved' in out)) return assert.fail('expected a resolve output');
  assert.equal(out.resolved[0].ean, '5');
});

test('remembered EANs feed the status quo', async () => {
  const out = await runResolve([{ item: 'riz' }], { today: day },
    { profile, provider, open: fakeOpen([]), preferredEans: (i) => (i === 'riz' ? ['9'] : []) });
  if (!('resolved' in out)) return assert.fail();
  assert.ok(out.resolved[0].why.includes('status-quo'));
});

test('missing mapping is an error that points to setup', async () => {
  const bare = { ...provider, search: { tool: 'search_products', args: {} } };
  await assert.rejects(runResolve([{ item: 'riz' }], { today: day }, { profile, provider: bare, open: fakeOpen([]), preferredEans: () => [] }), /mapping discovery/);
});

test('suggestions after repeated overrides of the same rule', () => {
  const rows = [1, 2, 3].map((i) => ({ date: day, item: 'lentilles', chosen: 'n', overridden: `b${i}`, rules: ['bio-raisonnable'] }));
  assert.deepEqual(suggestions(rows).map((s) => [s.rule, s.overrides]), [['bio-raisonnable', 3]]);
  assert.deepEqual(suggestions(rows.slice(0, 2)), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/products.test.ts`
Expected: FAIL — cannot find module `products.ts`.

- [ ] **Step 3: Implement** — `scripts/products.ts`

```ts
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { flagString, parseArgs } from './lib/args.ts';
import { getChoice, loadChoices } from './lib/choices.ts';
import { isMain, printJson, readJsonInput, runMain } from './lib/cli.ts';
import { today } from './lib/dates.ts';
import { findHabit, loadHabits } from './lib/habits.ts';
import { openSession, parseToolJson, type McpSession } from './lib/mcp-client.ts';
import { tokens } from './lib/normalize.ts';
import { paths } from './lib/paths.ts';
import { resolveItem, type Decision, type ItemRequest, type Option } from './lib/preference-engine.ts';
import { buildArgs, mapProducts, mappingHealth } from './lib/product-mapper.ts';
import { loadProfile, requireProfile, type Profile } from './lib/profile.ts';
import { listProviderIds, loadProvider, type McpProvider } from './lib/provider.ts';
import { resolveScoring, ruleKind } from './lib/rules.ts';
import { sourceIds } from './recipe-sources/index.ts';

const USAGE = `usage:
  products.ts resolve <items.json|-> [--from-search <dir>] [--today YYYY-MM-DD]
  products.ts map-check <raw.json>... [--provider id]
  products.ts validate
  products.ts feedback <item> <chosen_ean> <overridden_ean> [--rules id,id] [--today YYYY-MM-DD]
  products.ts suggest`;

export interface CompactDecision {
  item: string;
  status: Decision['status'] | 'error';
  ean?: string;
  title?: string;
  packs?: number;
  price?: number;
  unit_price?: number;
  unit?: string;
  options?: Option[];
  why: string[];
  relaxed?: string[];
  flags?: string[];
  eliminated?: Record<string, number>;
}
export interface ResolveOutput { resolved: CompactDecision[]; exceptions: CompactDecision[]; stats: { items: number; chosen: number; exceptions: number } }
export interface Fallback { fallback: 'search-via-claude'; reason: string; dir: string; files: { item: string; query: string; file: string }[] }
export interface ResolveDeps {
  profile: Profile;
  provider: McpProvider;
  open: (p: McpProvider) => Promise<McpSession>;
  preferredEans: (item: string) => string[];
}

export function itemFileName(item: string): string {
  return `${tokens(item).join('-') || 'item'}.json`;
}

function compact(d: Decision): CompactDecision {
  const c: CompactDecision = { item: d.item, status: d.status, why: d.why };
  if (d.choice && d.status === 'chosen') {
    const o = d.choice;
    c.ean = o.ean;
    c.title = o.title;
    c.packs = o.packs;
    if (o.price !== undefined) c.price = o.price;
    if (o.unit_price !== undefined) c.unit_price = o.unit_price;
    if (o.unit !== undefined) c.unit = o.unit;
  }
  if (d.status !== 'chosen' && d.options) c.options = d.options.slice(0, 3);
  if (d.relaxed.length) c.relaxed = d.relaxed;
  if (d.flags.length) c.flags = d.flags;
  if (d.status !== 'chosen' && d.eliminated.length) {
    const counts: Record<string, number> = {};
    for (const e of d.eliminated) for (const r of e.reasons) counts[r] = (counts[r] ?? 0) + 1;
    c.eliminated = counts;
  }
  return c;
}

export async function runResolve(items: ItemRequest[], opts: { today: string; fromSearch?: string }, deps: ResolveDeps): Promise<ResolveOutput | Fallback> {
  const spec = deps.provider.search;
  if (!spec?.fields) throw new Error(`No product mapping for provider "${deps.provider.id}" — run /groceries setup (mapping discovery)`);
  const dir = join(paths.runs(), `${opts.today}-search`);
  let session: McpSession | undefined;
  if (!opts.fromSearch) {
    try {
      session = await deps.open(deps.provider);
    } catch (e) {
      return {
        fallback: 'search-via-claude',
        reason: (e as Error).message,
        dir,
        files: items.map((i) => ({ item: i.item, query: i.item, file: join(dir, itemFileName(i.item)) })),
      };
    }
  }
  const scoring = resolveScoring(deps.profile.scoring);
  const out: ResolveOutput = { resolved: [], exceptions: [], stats: { items: items.length, chosen: 0, exceptions: 0 } };
  try {
    for (const item of items) {
      try {
        let raw: unknown;
        if (opts.fromSearch) raw = JSON.parse(readFileSync(join(opts.fromSearch, itemFileName(item.item)), 'utf8'));
        else {
          raw = parseToolJson(await session!.call(spec.tool, buildArgs(spec.args, item.item)));
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, itemFileName(item.item)), JSON.stringify(raw));
        }
        const d = resolveItem(item, mapProducts(raw, spec), deps.profile.product_rules, scoring, { preferredEans: deps.preferredEans(item.item) });
        (d.status === 'chosen' ? out.resolved : out.exceptions).push(compact(d));
      } catch (e) {
        out.exceptions.push({ item: item.item, status: 'error', why: [(e as Error).message] });
      }
    }
  } finally {
    await session?.close();
  }
  out.stats.chosen = out.resolved.length;
  out.stats.exceptions = out.exceptions.length;
  return out;
}

export interface FeedbackRow { date: string; item: string; chosen: string; overridden: string; rules: string[] }
const feedbackFile = () => join(paths.data(), 'preference-feedback.tsv');

function readFeedback(): FeedbackRow[] {
  if (!existsSync(feedbackFile())) return [];
  return readFileSync(feedbackFile(), 'utf8').split('\n').slice(1).filter(Boolean).map((line) => {
    const [date, item, chosen, overridden, rules] = line.split('\t');
    return { date, item, chosen, overridden, rules: rules ? rules.split(',').filter(Boolean) : [] };
  });
}

export function suggestions(rows: FeedbackRow[], threshold = 3): { rule: string; overrides: number; hint: string }[] {
  const counts = new Map<string, number>();
  for (const r of rows) for (const id of r.rules) counts.set(id, (counts.get(id) ?? 0) + 1);
  return [...counts.entries()]
    .filter(([, n]) => n >= threshold)
    .map(([rule, overrides]) => ({ rule, overrides, hint: `The user overrode the outcome of "${rule}" ${overrides} times — ask whether to change or relax this rule.` }));
}

function realPreferredEans(): (item: string) => string[] {
  const choices = loadChoices();
  const habits = loadHabits();
  return (item) => [getChoice(choices, item)?.ean, findHabit(habits, { name: item })?.ean].filter((e): e is string => Boolean(e));
}

function activeMcpProvider(profile?: Profile, id?: string): McpProvider {
  const p = loadProvider(id ?? profile?.store.provider ?? 'carrefour');
  if (p.kind !== 'mcp') throw new Error(`Provider "${p.id}" has no store connection`);
  return p;
}

async function main(): Promise<void> {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [cmd, ...rest] = positional;
  const day = flagString(flags, 'today') ?? today();
  switch (cmd) {
    case 'resolve': {
      const profile = requireProfile({ sources: sourceIds(), providers: listProviderIds() });
      const items = (await readJsonInput(rest[0])) as ItemRequest[];
      printJson(await runResolve(items, { today: day, fromSearch: flagString(flags, 'from-search') }, {
        profile, provider: activeMcpProvider(profile), open: (p) => openSession(p), preferredEans: realPreferredEans(),
      }));
      return;
    }
    case 'map-check': {
      if (rest.length === 0) throw new Error(USAGE);
      const loaded = loadProfile();
      const provider = activeMcpProvider(loaded.status === 'ok' ? loaded.profile : undefined, flagString(flags, 'provider'));
      if (!provider.search) throw new Error(`Provider "${provider.id}" has no search block`);
      printJson(mappingHealth(rest.map((f) => JSON.parse(readFileSync(f, 'utf8'))), provider.search));
      return;
    }
    case 'validate': {
      const loaded = loadProfile({ sources: sourceIds(), providers: listProviderIds() });
      if (loaded.status !== 'ok') {
        printJson({ ok: false, status: loaded.status, errors: loaded.status === 'invalid' ? loaded.errors : [] });
        return;
      }
      const { product_rules, scoring } = loaded.profile;
      printJson({
        ok: true,
        rules: product_rules.map((r) => ({
          id: r.id,
          applies_to: r.applies_to,
          kind: ruleKind(r),
          words: r.require ?? r.forbid ?? r.prefer ?? r.budget,
          strictness: ruleKind(r) === 'prefer' ? 'soft' : (r.strictness ?? 'hard'),
          ...(r.max_premium_pct !== undefined && { max_premium_pct: r.max_premium_pct }),
          ...(r.priority !== undefined && { priority: r.priority }),
        })),
        scoring: resolveScoring(scoring),
      });
      return;
    }
    case 'feedback': {
      const [item, chosen, overridden] = rest;
      if (!item || !chosen || !overridden) throw new Error(USAGE);
      mkdirSync(paths.data(), { recursive: true });
      if (!existsSync(feedbackFile())) writeFileSync(feedbackFile(), 'date\titem\tchosen\toverridden\trules\n');
      const rules = flagString(flags, 'rules') ?? '';
      appendFileSync(feedbackFile(), `${day}\t${item}\t${chosen}\t${overridden}\t${rules}\n`);
      printJson({ recorded: true });
      return;
    }
    case 'suggest':
      printJson(suggestions(readFeedback()));
      return;
    default:
      throw new Error(USAGE);
  }
}

if (isMain(import.meta.url)) runMain(main);
```

Note: `feedback` stores the user's pick as `chosen` and the engine's pick as `overridden`.

- [ ] **Step 4: Run tests**

Run: `npm run check`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: products CLI — script-side search, resolution, mapping check, feedback"
```

---

### Task 7: Doctor — product mapping health

**Files:**
- Modify: `scripts/doctor.ts`, `tests/doctor.test.ts`

**Interfaces:**
- Consumes: `mappingReady` (Task 5), `mappingHealth`, `REQUIRED_HEALTH_FIELDS` (Task 2), `openSession`, `parseToolJson` (Task 5).
- Produces: `DoctorDeps` gains `loadProvider: (id: string) => Provider`, `liveSearch: (p: McpProvider, query: string) => Promise<unknown>`, `readMappingFixtures: (providerId: string) => unknown[]`. New check id `product-mapping` (blocking when failing), only when the profile is valid and the provider is MCP.

- [ ] **Step 1: Write the failing tests** — edit `tests/doctor.test.ts`

Add imports `import { loadProvider, type McpProvider } from '../scripts/lib/provider.ts';`. Above `const deps = …`, add:

```ts
const mapped: McpProvider = {
  ...(loadProvider('carrefour') as McpProvider),
  search: { tool: 'search_products', args: { q: '{query}' }, products_path: 'data',
    fields: { ean: 'ean', title: 'title', price: 'price', unit_price: { path: 'per', parse: 'unit_price' }, available: 'ok' } },
};
const liveRaw = { data: [{ ean: '1', title: 'Lait', price: 1, per: '1,00 €/l', ok: true }] };
```

and extend the `deps()` defaults with:

```ts
  loadProvider: () => mapped,
  liveSearch: async () => liveRaw,
  readMappingFixtures: () => [],
```

Append tests:

```ts
test('no product mapping yet → blocking product-mapping check', async () => {
  writeValidProfile(root);
  const r = await runDoctor(deps({ loadProvider: (id) => loadProvider(id) }), { offline: true });
  assert.equal(check(r, 'product-mapping')?.status, 'fail');
  assert.match(check(r, 'product-mapping')?.fix ?? '', /mapping discovery/);
  assert.equal(r.blocking, true);
});

test('mapping health: offline fixtures and live search', async () => {
  writeValidProfile(root);
  const offline = await runDoctor(deps({ readMappingFixtures: () => [{ data: [{ ean: '1', title: 'x' }] }] }), { offline: true });
  assert.equal(check(offline, 'product-mapping')?.status, 'fail');
  assert.match(check(offline, 'product-mapping')?.message ?? '', /price, unit_price/);
  const live = await runDoctor(deps(), { offline: false });
  assert.equal(check(live, 'product-mapping')?.status, 'pass');
  const liveBroken = await runDoctor(deps({ liveSearch: async () => ({ data: [] }) }), { offline: false });
  assert.equal(check(liveBroken, 'product-mapping')?.status, 'fail');
  const liveDown = await runDoctor(deps({ liveSearch: async () => { throw new Error('busy'); } }), { offline: false });
  assert.equal(check(liveDown, 'product-mapping')?.status, 'unknown');
});
```

The existing `fresh install` test must also assert `assert.equal(check(r, 'product-mapping'), undefined);`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/doctor.test.ts 2>&1 | grep -E "^✖|ℹ (pass|fail)"`
Expected: the new mapping tests FAIL.

- [ ] **Step 3: Implement in `scripts/doctor.ts`**

- imports: add `mappingReady` to the `./lib/provider.ts` import; add `import { buildArgs, mappingHealth } from './lib/product-mapper.ts';` and `import { openSession, parseToolJson } from './lib/mcp-client.ts';`.
- `DoctorDeps`: add

```ts
  loadProvider: (id: string) => Provider;
  liveSearch: (p: McpProvider, query: string) => Promise<unknown>;
  readMappingFixtures: (providerId: string) => unknown[];
```
- replace `provider = loadProvider(providerId);` with `provider = deps.loadProvider(providerId);`.
- after the login block (before `const blocking = …`), insert:

```ts
  if (profile.status === 'ok' && provider?.kind === 'mcp') {
    const fix = 'Run /groceries setup (mapping discovery)';
    if (!mappingReady(provider) || !provider.search) add('product-mapping', 'fail', `No product mapping for ${provider.label} yet — products cannot be picked`, true, fix);
    else {
      const spec = provider.search;
      const fixtures = deps.readMappingFixtures(provider.id);
      const offlineHealth = fixtures.length ? mappingHealth(fixtures, spec) : undefined;
      const loginOk = checks.find((c) => c.id === 'login')?.status === 'pass';
      if (offlineHealth && !offlineHealth.healthy)
        add('product-mapping', 'fail', `Saved responses no longer map: missing ${offlineHealth.missing.join(', ')}`, true, fix);
      else if (!opts.offline && loginOk) {
        try {
          const live = mappingHealth([await deps.liveSearch(provider, 'lait')], spec);
          if (live.healthy) add('product-mapping', 'pass', `${live.products} products mapped from a live search`, true);
          else add('product-mapping', 'fail', `Live search no longer maps: missing ${live.missing.join(', ') || 'products'}`, true, fix);
        } catch (e) {
          add('product-mapping', 'unknown', `live search failed: ${(e as Error).message}`, false, 'Run /groceries setup');
        }
      } else add('product-mapping', offlineHealth ? 'pass' : 'unknown', offlineHealth ? 'Saved responses map correctly' : 'Not checked live', false);
    }
  }
```
- `realDeps`: add

```ts
  loadProvider: (id) => loadProvider(id),
  liveSearch: async (p, query) => {
    const session = await openSession(p);
    try {
      return parseToolJson(await session.call(p.search!.tool, buildArgs(p.search!.args, query)));
    } finally {
      await session.close();
    }
  },
  readMappingFixtures: (id) => {
    const dir = paths.fixtures(id);
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((n) => n.startsWith('search-') && n.endsWith('.json')).map((n) => JSON.parse(readFileSync(join(dir, n), 'utf8')));
  },
```


- [ ] **Step 4: Run tests**

Run: `npm run check`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: doctor checks product mapping health"
```

---

### Task 8: Agent layer — onboarding conversion, cart resolution, mapping discovery

**Files:**
- Modify: `modes/onboarding.md`, `modes/_cart.md`, `modes/plan.md`, `modes/setup.md`, `modes/habits.md`, `AGENTS.md`, `tests/agent-layer.test.ts`

**Interfaces:**
- Consumes: `products.ts resolve | map-check | validate | feedback | suggest` (Task 6).

- [ ] **Step 1: Write the failing test** — append to `tests/agent-layer.test.ts`

```ts
test('cart resolution goes through the script, with the fallback', () => {
  const cart = read('modes/_cart.md');
  assert.match(cart, /node scripts\/products\.ts resolve/);
  assert.match(cart, /--from-search/);
  assert.doesNotMatch(cart, /preferred_brand|store_brand_ok/);
});

test('onboarding converts free-text preferences and validates them', () => {
  const o = read('modes/onboarding.md');
  assert.match(o, /preferences_text/);
  assert.match(o, /node scripts\/products\.ts validate/);
});

test('setup runs mapping discovery and map-check', () => {
  const s = read('modes/setup.md');
  assert.match(s, /node scripts\/products\.ts map-check/);
  assert.match(s, /tests\/fixtures\/\{provider\}\/search-/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/agent-layer.test.ts 2>&1 | grep -E "^✖"`
Expected: 3 failures.

- [ ] **Step 3: Rewrite onboarding step 5** — in `modes/onboarding.md` replace the three lines of item 5 (`5. **Product rules** — per category: …`) with:

````markdown
5. **Buying preferences** — ask the user to describe them freely, in their own words (brands,
   organic, budget, animal welfare, origin, things never to buy, special rules for some people in
   the household). Store the text verbatim in `preferences_text`. Then convert it into
   `product_rules` (and `tags` / `scoring` if needed):
   - one rule per idea; `id` short and readable;
   - "never X" → `forbid`; "only X" / "always X" → `require`; "X if not too expensive" → `prefer`
     with `max_premium_pct`; "I like X" → `prefer` with a `weight`; price limits → `budget`;
   - scope with `applies_to`: `all`, `{ match: [...], not_match: [...] }` on the item name, or
     `{ tags: [...] }` for items the user labels (declare each tag in `tags`, e.g. `enfant`);
   - use the words that appear on product labels in the store's language (`plein air`, `label rouge`,
     `bio`, `sol`, `cage`), several synonyms in `any`;
   - "best balance of price/quality/…" → adjust `scoring.weights` (price_per_unit, preferences, rating).
   Run `node scripts/products.ts validate`; fix every error (contradictions included). Show the user a
   table — rule · applies to · effect · strict? — and save only after they confirm. To change a
   preference later, re-convert only the changed sentence.
````

- [ ] **Step 4: Rewrite `## Product resolution` in `modes/_cart.md`** — replace the whole section (from `## Product resolution` up to, not including, `## Review`) with:

````markdown
## Product resolution

The script picks products; you only handle exceptions.

1. Write the items to buy to `data/runs/{today}-request.json`:
   `[{ "item": "<plain ingredient, in the store's language>", "need": { "qty": 400, "unit": "g" }, "tags": ["enfant"], "role": "key" }]`.
   Query the plain ingredient ("riz", not "riz sachets cuisson 8 min"): a convenience format named in
   a recipe line is not a requirement. `need` comes from the shopping list (`total` + `unit`); omit it
   when unknown. Add a tag when the user says who an item is for ("pour mon fils" → `enfant`).
2. `node scripts/products.ts resolve data/runs/{today}-request.json`.
   - Output `{"fallback": "search-via-claude", ...}` → for each `files[]` entry call
     `capability:search` with its `query`, write the raw JSON result to its `file`, then run
     `node scripts/products.ts resolve data/runs/{today}-request.json --from-search <dir>`.
   - An error mentioning mapping discovery → run the mapping discovery in `modes/setup.md` first.
3. `resolved[]` lines go straight to the review table (their `why` explains the choice).
4. `exceptions[]`:
   - `close_call` → show the ≤ 3 `options` in one line each and let the user pick (or pick the one that
     best matches `preferences_text` when the user asked not to be bothered);
   - `none` → say why (`eliminated` counts, `relaxed` rules) and offer: another search term, relaxing a
     rule for this time, or skipping. For a `key` item the calling mode decides (plan: replace the recipe);
   - `ask` → a hard rule could not be checked on that product (missing information): ask the user;
   - `error` → retry once, then report.

Do not search products yourself outside the fallback above.
````

In `## Review`, replace the sentence about remembering a pick with:

```markdown
line; re-resolve it. When the user picks another product than the script's, remember it:
`node scripts/choices.ts set "<ingredient>" <ean> "<label>"` and
`node scripts/products.ts feedback "<item>" <user_ean> <script_ean> --rules <ids from why>`.
Continue only on an explicit OK.
```
(Match the existing sentence starting `line; re-resolve it. When the user picks a specific product` and ending `Continue only on an explicit OK.`.)

Also in the `## Review` "why" list, replace `` (`choice`, `history`, `rule:<category>`, `` with `` (the `why` ids from the script, `status-quo`, ``.

- [ ] **Step 5: `modes/plan.md`** — in step 6 replace the first line `6. **Products** — resolve every non-staple item (`_cart.md` Product resolution).` with:

```markdown
6. **Products** — resolve every non-staple item through `_cart.md` Product resolution (one
   `resolve` call for the whole list).
```
and replace `**Key item unavailable:**` with `**Key item with status none:**`.

- [ ] **Step 6: `modes/setup.md`** — insert after step 2 (Login) and renumber the following steps:

````markdown
3. **Product mapping** (MCP provider):
   - If the provider YAML has no `search.fields`, or the doctor reported `product-mapping` failing →
     **mapping discovery**: call `capability:search` for 4–5 typed queries (`oeufs`, a `bio` product,
     `bananes`, a store-brand staple such as `lait`, one likely unavailable item) and save each raw
     result to `tests/fixtures/{provider}/search-<query>.json`. Read one response, find where the
     product list is (`products_path`) and the fields for `ean`, `title`, `brand`, `price`,
     `unit_price` (`parse: unit_price`), `pack` (`parse: pack`), `available` (`parse: bool`, or `not`
     for an out-of-stock flag), `rating`, and `text` (label/badge/description paths). Write them in the
     provider YAML `search` block, then run
     `node scripts/products.ts map-check tests/fixtures/{provider}/search-*.json` until `healthy` is
     true. Show the user 3 mapped sample products and keep the mapping on their OK.
   - Otherwise run `node scripts/products.ts map-check` on the saved fixtures and report the result.
````

- [ ] **Step 7: `modes/habits.md`** — append:

```markdown
4. `node scripts/products.ts suggest` → if a preference rule was overridden repeatedly, propose the
   change to the user; edit `product_rules` only on their OK, then `node scripts/products.ts validate`.
```

- [ ] **Step 8: `AGENTS.md`** — in the scripts table add after the `choices.ts` row:

```markdown
| `node scripts/products.ts resolve \| map-check \| validate \| feedback \| suggest` | product picking from preference rules (calls the store search itself) |
```
and in Hard rules item 3 append: `Product picking is likewise the script's job: never re-rank or second-guess a `resolved` line.`

- [ ] **Step 9: Run tests**

Run: `npm run check`
Expected: all PASS.

- [ ] **Step 10: Commit**

```bash
git add -A && git commit -m "feat: agent layer uses the preference engine (onboarding, cart, setup discovery)"
```

---

### Task 9: Live verification (needs the user, logged in)

**Files:**
- Modify (from findings): `providers/carrefour.yml`, `tests/fixtures/carrefour/search-*.json`

- [ ] **Step 1:** In a Claude Code session in the repo with `carrefour-drive` registered and logged in, run `/groceries setup` → mapping discovery writes the fixtures and the `search` fields.
- [ ] **Step 2:** `node scripts/products.ts map-check tests/fixtures/carrefour/search-*.json` → `healthy: true`.
- [ ] **Step 3:** `node scripts/doctor.ts` → `product-mapping` ✅ (or ❔ if the second MCP instance cannot start — then the resolve fallback is the normal path; record which).
- [ ] **Step 4:** Write a 3-item request (`oeufs`, `blanc de poulet`, `compote` tagged `enfant`) and run `node scripts/products.ts resolve` → choices respect the rules; note any exception.
- [ ] **Step 5:** `npm run check`; commit `test: real Carrefour search fixtures and mapping`.
