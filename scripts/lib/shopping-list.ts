import { parseIngredientLine, type ParsedIngredient } from './ingredient-line.ts';
import { containsPhrase } from './normalize.ts';
import { paths } from './paths.ts';
import { readYaml } from './yaml-io.ts';

export interface RecipeInput { id: string; servings?: number; ingredients: string[] }
export interface ListItem {
  key: string;
  name: string;
  unit?: string;
  total?: number;
  contributions: Record<string, number | null>;
  lines: string[];
  staple: boolean;
  role: 'key' | 'minor';
  /** Bought for a side dish added with `shopping-list.ts side`, not for the recipe itself. */
  side?: true;
}
/** What a recipe already brings to the plate; `needsSide` when it has no starch and no side was added. */
export interface MealCheck { recipeId: string; starch: string[]; vegetable: string[]; side: string[]; needsSide: boolean }
/** Side-dish lines per recipe id, each written for ONE serving ("75 g de riz"). */
export type Sides = Record<string, string[]>;
export interface ShoppingList {
  servings: number;
  recipeIds: string[];
  items: ListItem[];
  meals: MealCheck[];
  sides: Sides;
  warnings: string[];
}

/** Default "key ingredient" heuristic (protein, starch, main vegetable); Claude may override per item. */
const KEY_WORDS = [
  'viande', 'poulet', 'dinde', 'boeuf', 'veau', 'porc', 'agneau', 'canard', 'jambon', 'lardon', 'saucisse', 'steak',
  'poisson', 'saumon', 'cabillaud', 'colin', 'thon', 'crevette', 'moule', 'oeuf', 'tofu', 'tempeh',
  'pate', 'spaghetti', 'tagliatelle', 'riz', 'pomme de terre', 'lentille', 'pois chiche', 'haricot', 'quinoa',
  'semoule', 'boulgour', 'gnocchi', 'lasagne', 'pate feuilletee', 'pate brisee',
  'courgette', 'aubergine', 'chou', 'poireau', 'potiron', 'butternut', 'epinard', 'brocoli',
];

/** Starches that make a dish a full meal. "haricot" alone would also catch green beans. */
const STARCH_WORDS = [
  'pate', 'spaghetti', 'tagliatelle', 'penne', 'fusilli', 'macaroni', 'coquillette', 'linguine', 'nouille', 'vermicelle',
  'lasagne', 'ravioli', 'gnocchi', 'riz', 'pomme de terre', 'patate douce', 'frite', 'puree', 'quinoa', 'semoule',
  'boulgour', 'ble', 'polenta', 'lentille', 'pois chiche', 'pois casse', 'haricot rouge', 'haricot blanc', 'flageolet',
  'pain', 'baguette', 'tortilla', 'wrap', 'galette', 'crepe',
];
const VEGETABLE_WORDS = [
  'courgette', 'aubergine', 'carotte', 'poivron', 'tomate', 'haricot vert', 'brocoli', 'chou', 'epinard', 'poireau',
  'champignon', 'petit pois', 'salade', 'laitue', 'mache', 'roquette', 'fenouil', 'potiron', 'butternut', 'courge',
  'navet', 'panais', 'celeri', 'asperge', 'artichaut', 'endive', 'betterave', 'concombre', 'radis', 'blette',
];
/** Spoons and pinches are seasoning ("2 c. à soupe de pâte de curry"), never a side. */
const SEASONING_UNITS = new Set(['cas', 'cac', 'pincee']);
/** Below this per serving, a weighed ingredient is an ingredient of the sauce, not a side (25 g of bread crumbs). */
const MIN_PORTION = 30;

const round2 = (x: number) => Math.round(x * 100) / 100;

export function loadStaples(): string[] {
  return readYaml<{ staples: string[] }>(paths.staples(), { staples: [] }).staples;
}

function isPortion(p: ParsedIngredient, perServing: number): boolean {
  if (p.unit && SEASONING_UNITS.has(p.unit)) return false;
  if ((p.unit === 'g' || p.unit === 'ml') && p.qty !== undefined) return p.qty * perServing >= MIN_PORTION;
  return true;
}

function checkMeal(r: RecipeInput, staples: string[], side: string[]): MealCheck {
  const perServing = r.servings ? 1 / r.servings : 1;
  const starch = new Set<string>();
  const vegetable = new Set<string>();
  for (const line of r.ingredients) {
    const p = parseIngredientLine(line);
    if (!p.key || staples.some((s) => containsPhrase(p.key, s)) || !isPortion(p, perServing)) continue;
    if (STARCH_WORDS.some((w) => containsPhrase(p.key, w))) starch.add(p.key);
    else if (VEGETABLE_WORDS.some((w) => containsPhrase(p.key, w))) vegetable.add(p.key);
  }
  return { recipeId: r.id, starch: [...starch], vegetable: [...vegetable], side, needsSide: starch.size === 0 && side.length === 0 };
}

export function buildList(recipes: RecipeInput[], servings: number, staples: string[], sides: Sides = {}): ShoppingList {
  const warnings: string[] = [];
  const byKey = new Map<string, ListItem>();
  const ids = new Set(recipes.map((r) => r.id));
  const kept: Sides = Object.fromEntries(Object.entries(sides).filter(([id, lines]) => ids.has(id) && lines.length > 0));
  // Side lines are written for one serving, so they scale by the list's servings.
  const sideInputs = Object.entries(kept).map(([id, lines]) => ({ id, servings: 1, ingredients: lines, side: true }));
  for (const r of [...recipes.map((x) => ({ ...x, side: false })), ...sideInputs]) {
    const factor = r.servings ? servings / r.servings : 1;
    if (!r.servings) warnings.push(`no-yield:${r.id}`);
    for (const line of r.ingredients) {
      const p = parseIngredientLine(line);
      if (!p.key) {
        warnings.push(`unparsed:${line}`);
        continue;
      }
      const mapKey = `${p.key}|${p.unit ?? ''}`;
      let it = byKey.get(mapKey);
      if (!it) {
        it = { key: p.key, name: p.name, contributions: {}, lines: [], staple: staples.some((s) => containsPhrase(p.key, s)), role: 'minor' };
        if (p.unit) it.unit = p.unit;
        byKey.set(mapKey, it);
      }
      if (r.side) it.side = true;
      const qty = p.qty === undefined ? null : round2(p.qty * factor);
      const prev = it.contributions[r.id];
      if (prev === undefined) it.contributions[r.id] = qty;
      else if (prev !== null && qty !== null) it.contributions[r.id] = round2(prev + qty);
      else it.contributions[r.id] = prev ?? qty;
      it.lines.push(line);
    }
  }
  const items = [...byKey.values()].map((it) => {
    const nums = Object.values(it.contributions).filter((v): v is number => v !== null);
    if (nums.length) it.total = round2(nums.reduce((a, b) => a + b, 0));
    const big = (it.unit === 'g' || it.unit === 'ml') && (it.total ?? 0) >= 150;
    it.role = !it.staple && (big || KEY_WORDS.some((w) => containsPhrase(it.key, w))) ? 'key' : 'minor';
    return it;
  });
  items.sort((a, b) => Number(a.staple) - Number(b.staple) || a.key.localeCompare(b.key));
  const meals = recipes.map((r) => checkMeal(r, staples, kept[r.id] ?? []));
  return { servings, recipeIds: recipes.map((r) => r.id), items, meals, sides: kept, warnings };
}
