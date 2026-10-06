import { parseIngredientLine } from './ingredient-line.ts';
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
}
export interface ShoppingList { servings: number; recipeIds: string[]; items: ListItem[]; warnings: string[] }

/** Default "key ingredient" heuristic (protein, starch, main vegetable); Claude may override per item. */
const KEY_WORDS = [
  'viande', 'poulet', 'dinde', 'boeuf', 'veau', 'porc', 'agneau', 'canard', 'jambon', 'lardon', 'saucisse', 'steak',
  'poisson', 'saumon', 'cabillaud', 'colin', 'thon', 'crevette', 'moule', 'oeuf', 'tofu', 'tempeh',
  'pate', 'spaghetti', 'tagliatelle', 'riz', 'pomme de terre', 'lentille', 'pois chiche', 'haricot', 'quinoa',
  'semoule', 'boulgour', 'gnocchi', 'lasagne', 'pate feuilletee', 'pate brisee',
  'courgette', 'aubergine', 'chou', 'poireau', 'potiron', 'butternut', 'epinard', 'brocoli',
];

const round2 = (x: number) => Math.round(x * 100) / 100;

export function loadStaples(): string[] {
  return readYaml<{ staples: string[] }>(paths.staples(), { staples: [] }).staples;
}

export function buildList(recipes: RecipeInput[], servings: number, staples: string[]): ShoppingList {
  const warnings: string[] = [];
  const byKey = new Map<string, ListItem>();
  for (const r of recipes) {
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
  return { servings, recipeIds: recipes.map((r) => r.id), items, warnings };
}
