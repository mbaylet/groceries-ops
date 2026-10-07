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
