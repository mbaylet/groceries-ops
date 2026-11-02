import { daysBetween } from './dates.ts';
import { containsPhrase, tokens } from './normalize.ts';
import { paths } from './paths.ts';
import { parseIngredientLine } from './ingredient-line.ts';
import { buildList, type ListItem } from './shopping-list.ts';
import { readYaml } from './yaml-io.ts';

export type PriceUnit = 'kg' | 'l' | 'u';

/** One priced ingredient family (config/price-references.yml). */
export interface PriceReference {
  id: string;
  query: string;
  unit: PriceUnit;
  /** recipe ingredient names this price covers; the longest match wins across references */
  match: string[];
  not_match?: string[];
  /** a product title must start with one of these to be relevant... */
  must: string[];
  /** ...and none of these */
  exclude?: string[];
  /** above this price per unit a product is not the plain ingredient (dried, cooked...) */
  max?: number;
  /** grams (or ml) of one recipe unit: piece (a count with no unit), boite, tranche, sachet... */
  sizes?: Record<string, number>;
}

export interface PriceEntry { unitPrice: number; unit: PriceUnit; count: number; date: string; approximate?: true }
export interface PricesFile { updated?: string; prices: Record<string, PriceEntry> }

export interface Product {
  title: string;
  brand: string | null;
  flags: string[];
  purchasable: boolean;
  marketplace: boolean;
  perUnit: number | null;
  unit: PriceUnit | null;
}

export type ReferencePrice =
  | { ok: true; unitPrice: number; unit: PriceUnit; count: number; approximate: boolean }
  | { ok: false; reason: string };

export interface RecipeForEstimate { id: string; servings?: number; ingredients: string[] }
export interface Estimate {
  id: string;
  servings: number;
  total: number | null;
  perServing: number | null;
  /** important ingredients the total leaves out */
  missing: string[];
  /** references behind this total whose price did not come from favoured products */
  approximate: string[];
  reason?: 'no-yield' | 'no-prices';
}

/** Prices older than this trigger a new reading. */
export const MAX_AGE_DAYS = 30;

const SPOON_ML: Record<string, number> = { cas: 15, cac: 5, verre: 200 };
const FLAG_WORDS: Record<string, string> = { 'flag.common.organic': 'bio', 'flag.common.labelrouge': 'label rouge' };
const UNIT_NAMES: Record<string, PriceUnit> = { kg: 'kg', kilogramme: 'kg', l: 'l', litre: 'l', u: 'u', piece: 'u' };

const round2 = (x: number) => Math.round((x + Number.EPSILON) * 100) / 100;
const hasAny = (text: string, words: string[]) => words.some((w) => containsPhrase(text, w));
/** Store titles lead with what the product is: "Carottes râpées", but "Haricots verts et beurre" is not butter. */
function startsWithAny(text: string, words: string[]): boolean {
  const t = tokens(text);
  return words.some((w) => {
    const n = tokens(w);
    return n.length > 0 && n.every((token, i) => t[i] === token);
  });
}
/** Keeps prices within half to twice the median, so a few odd products don't move the estimate. */
function withoutOutliers(values: number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length / 2;
  const median = sorted.length % 2 ? sorted[Math.floor(mid)] : (sorted[mid - 1] + sorted[mid]) / 2;
  return values.filter((v) => v >= median / 2 && v <= median * 2);
}

type Obj = Record<string, unknown>;
const asObj = (v: unknown): Obj => (typeof v === 'object' && v !== null ? (v as Obj) : {});

function toProduct(raw: unknown): Product | undefined {
  const a = asObj(asObj(raw).attributes);
  const byStore = asObj(asObj(a.offers)[String(a.ean)]);
  const first = Object.values(byStore)[0];
  if (typeof a.title !== 'string' || first === undefined) return undefined;
  const offer = asObj(asObj(first).attributes);
  const price = asObj(offer.price);
  return {
    title: a.title,
    brand: typeof a.brand === 'string' ? a.brand : null,
    flags: Array.isArray(a.flags) ? a.flags.filter((f): f is string => typeof f === 'string') : [],
    purchasable: asObj(offer.availability).purchasable === true,
    marketplace: Boolean(offer.marketplace),
    perUnit: typeof price.perUnit === 'number' ? price.perUnit : null,
    unit: UNIT_NAMES[String(price.unitOfMeasure ?? '').toLowerCase()] ?? null,
  };
}

/** Accepts a search_products result, or the same result wrapped as MCP text content. */
export function readProducts(raw: unknown): Product[] {
  const inner = Array.isArray(raw) && typeof asObj(raw[0]).text === 'string' ? JSON.parse(asObj(raw[0]).text as string) : raw;
  const data = asObj(inner).data;
  if (!Array.isArray(data)) throw new Error('not a search result: no "data" list');
  return data.map(toProduct).filter((p): p is Product => p !== undefined);
}

export function computeReferencePrice(
  ref: PriceReference,
  products: Product[],
  opts: { favor: string[]; entryLevelBrands: string[] },
): ReferencePrice {
  const relevant = products.filter((p) =>
    p.purchasable && !p.marketplace && p.unit === ref.unit && p.perUnit !== null && p.perUnit > 0 && p.perUnit <= (ref.max ?? Infinity)
    && startsWithAny(p.title, ref.must) && !hasAny(p.title, ref.exclude ?? [])
    && !hasAny(`${p.brand ?? ''} ${p.title}`, opts.entryLevelBrands));
  if (relevant.length === 0) return { ok: false, reason: `no relevant product for "${ref.id}"` };
  const describe = (p: Product) => [p.title, ...p.flags.map((f) => FLAG_WORDS[f] ?? '')].join(' ');
  const favored = relevant.filter((p) => hasAny(describe(p), opts.favor));
  const kept = withoutOutliers((favored.length > 0 ? favored : relevant).map((p) => p.perUnit as number));
  const mean = kept.reduce((sum, v) => sum + v, 0) / kept.length;
  return { ok: true, unitPrice: round2(mean), unit: ref.unit, count: kept.length, approximate: opts.favor.length > 0 && favored.length === 0 };
}

interface NameRule { applies_to?: unknown; require?: { any?: string[] }; prefer?: { any?: string[] } }

/** Words of the products this household favours for a reference: name-based profile rules + the user's list. */
export function favorTerms(ref: PriceReference, rules: unknown[], favorites: Record<string, string[]>): string[] {
  const terms: string[] = [];
  for (const rule of rules as NameRule[]) {
    const scope = asObj(rule.applies_to);
    const names = Array.isArray(scope.match) ? (scope.match as string[]) : [];
    const not = Array.isArray(scope.not_match) ? (scope.not_match as string[]) : [];
    if (hasAny(ref.query, names) && !hasAny(ref.query, not)) terms.push(...(rule.require?.any ?? rule.prefer?.any ?? []));
  }
  terms.push(...(favorites[ref.id] ?? []));
  return [...new Set(terms)];
}

export function matchReference(key: string, refs: PriceReference[]): PriceReference | undefined {
  let best: PriceReference | undefined;
  let bestLength = 0;
  for (const ref of refs) {
    if (hasAny(key, ref.not_match ?? [])) continue;
    for (const phrase of ref.match) {
      if (phrase.length > bestLength && containsPhrase(key, phrase)) {
        best = ref;
        bestLength = phrase.length;
      }
    }
  }
  return best;
}

/** Some recipe sites write the weight as the count ("500 c. à soupe de blanc de poulet", "400 boîtes"). */
const ABSURD_COUNT = 50;
function withPlausibleUnit(item: ListItem): ListItem {
  const raw = parseIngredientLine(item.lines[0] ?? '');
  const weighed = raw.unit === 'g' || raw.unit === 'ml';
  return !weighed && (raw.qty ?? 0) >= ABSURD_COUNT ? { ...item, unit: 'g' } : item;
}

/** Grams or ml for an item's quantity, when its recipe unit converts. */
function toGrams(item: ListItem, ref: PriceReference): number | undefined {
  if (item.total === undefined) return undefined;
  if (item.unit === 'g' || item.unit === 'ml') return item.total;
  const size = SPOON_ML[item.unit ?? ''] ?? ref.sizes?.[item.unit ?? 'piece'];
  return size === undefined ? undefined : item.total * size;
}

function itemCost(item: ListItem, ref: PriceReference, entry: PriceEntry): number | undefined {
  if (item.total === undefined) return undefined;
  if (ref.unit === 'u') {
    if (item.unit === undefined) return item.total * entry.unitPrice;
    const grams = toGrams(item, ref);
    const piece = ref.sizes?.piece;
    return grams === undefined || !piece ? undefined : (grams / piece) * entry.unitPrice;
  }
  const grams = toGrams(item, ref);
  return grams === undefined ? undefined : (grams / 1000) * entry.unitPrice;
}

/** Cost of what the recipe uses, scaled to `servings`. Staples and small unpriced items count for nothing. */
export function estimateRecipe(
  recipe: RecipeForEstimate,
  servings: number,
  refs: PriceReference[],
  prices: PricesFile,
  staples: string[],
): Estimate {
  const empty = { id: recipe.id, servings, total: null, perServing: null, missing: [], approximate: [] };
  if (Object.keys(prices.prices).length === 0) return { ...empty, reason: 'no-prices' };
  if (!recipe.servings) return { ...empty, reason: 'no-yield' };
  const { items } = buildList([recipe], servings, staples);
  let total = 0;
  const missing = new Set<string>();
  const approximate = new Set<string>();
  for (const item of items) {
    if (item.staple) continue;
    const ref = matchReference(item.key, refs);
    const entry = ref && prices.prices[ref.id];
    const cost = ref && entry ? itemCost(withPlausibleUnit(item), ref, entry) : undefined;
    if (cost === undefined) {
      if (item.role === 'key') missing.add(item.key);
      continue;
    }
    total += cost;
    if (entry?.approximate) approximate.add((ref as PriceReference).id);
  }
  return { id: recipe.id, servings, total: round2(total), perServing: round2(total / servings), missing: [...missing], approximate: [...approximate] };
}

export function priceStatus(file: PricesFile, refs: PriceReference[], today: string) {
  const known = refs.filter((r) => file.prices[r.id]).length;
  const hasPrices = known > 0;
  const ageDays = file.updated ? daysBetween(file.updated, today) : null;
  const stale = !hasPrices || ageDays === null || ageDays >= MAX_AGE_DAYS;
  return { stale, hasPrices, updated: file.updated ?? null, ageDays, known, total: refs.length };
}

export const loadReferences = (): PriceReference[] =>
  readYaml<{ references: PriceReference[] }>(paths.priceReferences(), { references: [] }).references;
export const loadPrices = (): PricesFile => readYaml<PricesFile>(paths.prices(), { prices: {} });
export const loadFavorites = (): Record<string, string[]> =>
  readYaml<{ favorites: Record<string, string[]> }>(paths.priceFavorites(), { favorites: {} }).favorites;
