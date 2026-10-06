import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { paths } from './paths.ts';
import { daysBetween } from './dates.ts';
import { parseIngredientLine, type ParsedIngredient } from './ingredient-line.ts';
import { recipeId, type Recipe } from '../recipe-sources/types.ts';

export interface StoredRecipe extends Recipe {
  id: string;
  fetched_at: string;
  used_on: string[];
  parsed_ingredients: ParsedIngredient[];
}

const recipeFile = (id: string) => join(paths.recipes(), `${id}.md`);

function writeRecipe(r: StoredRecipe): void {
  mkdirSync(paths.recipes(), { recursive: true });
  const body = [`# ${r.name}`, '', `Source: ${r.url}`, '', ...r.steps.map((s, i) => `${i + 1}. ${s}`), ''].join('\n');
  writeFileSync(recipeFile(r.id), `---\n${YAML.stringify(r)}---\n\n${body}`);
}

export function loadRecipe(id: string): StoredRecipe {
  const file = recipeFile(id);
  if (!existsSync(file)) throw new Error(`Unknown recipe "${id}" (no ${file})`);
  const m = /^---\n([\s\S]*?)\n---\n/.exec(readFileSync(file, 'utf8'));
  if (!m) throw new Error(`${file}: missing front matter`);
  return YAML.parse(m[1]) as StoredRecipe;
}

/** Saves a recipe, keeping used_on history if it was saved before. */
export function saveRecipe(recipe: Recipe, fetchedAt: string): StoredRecipe {
  const id = recipeId(recipe);
  const previous = existsSync(recipeFile(id)) ? loadRecipe(id) : undefined;
  const stored: StoredRecipe = {
    ...recipe,
    id,
    fetched_at: fetchedAt,
    used_on: previous?.used_on ?? [],
    parsed_ingredients: recipe.ingredients.map(parseIngredientLine),
  };
  writeRecipe(stored);
  return stored;
}

export function listRecipes(): StoredRecipe[] {
  if (!existsSync(paths.recipes())) return [];
  return readdirSync(paths.recipes())
    .filter((f) => f.endsWith('.md'))
    .map((f) => loadRecipe(f.slice(0, -3)));
}

export function markUsed(id: string, date: string): StoredRecipe {
  const r = loadRecipe(id);
  if (!r.used_on.includes(date)) r.used_on = [...r.used_on, date].sort();
  writeRecipe(r);
  return r;
}

export function recentIds(weeks: number, today: string): string[] {
  return listRecipes()
    .filter((r) => r.used_on.some((d) => {
      const age = daysBetween(d, today);
      return age >= 0 && age < weeks * 7;
    }))
    .map((r) => r.id);
}
