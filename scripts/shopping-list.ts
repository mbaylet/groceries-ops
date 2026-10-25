import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { flagNumber, parseArgs } from './lib/args.ts';
import { isMain, printJson, runMain } from './lib/cli.ts';
import { requireProfile } from './lib/profile.ts';
import { loadRecipe } from './lib/recipe-store.ts';
import { buildList, loadStaples, type ShoppingList, type Sides } from './lib/shopping-list.ts';

const USAGE = `usage:
  shopping-list.ts build <out.json> [--servings n] <recipeId>...
  shopping-list.ts drop <list.json> <recipeId>
  shopping-list.ts add <list.json> <recipeId>
  shopping-list.ts side <list.json> <recipeId> ["<line for one serving>"...]   (no line = remove the side)`;

function build(ids: string[], servings: number, sides: Sides = {}): ShoppingList {
  const recipes = ids.map((id) => {
    const r = loadRecipe(id);
    return { id, servings: r.servings, ingredients: r.ingredients };
  });
  return buildList(recipes, servings, loadStaples(), sides);
}

function save(file: string, list: ShoppingList): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(list, null, 2)}\n`);
  printJson(list);
}

async function main(): Promise<void> {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [cmd, file, ...ids] = positional;
  if (!file) throw new Error(USAGE);
  if (cmd === 'build') {
    if (ids.length === 0) throw new Error(USAGE);
    save(file, build(ids, flagNumber(flags, 'servings') ?? requireProfile().household.servings));
    return;
  }
  if (cmd === 'drop' || cmd === 'add' || cmd === 'side') {
    const [id, ...lines] = ids;
    if (!id) throw new Error(USAGE);
    const list = JSON.parse(readFileSync(file, 'utf8')) as ShoppingList;
    const sides = list.sides ?? {};
    if (cmd === 'side') {
      if (!list.recipeIds.includes(id)) throw new Error(`${id} is not in ${file}`);
      save(file, build(list.recipeIds, list.servings, { ...sides, [id]: lines }));
      return;
    }
    const next = cmd === 'drop' ? list.recipeIds.filter((x) => x !== id) : [...new Set([...list.recipeIds, id])];
    save(file, build(next, list.servings, sides));
    return;
  }
  throw new Error(USAGE);
}

if (isMain(import.meta.url)) runMain(main);
