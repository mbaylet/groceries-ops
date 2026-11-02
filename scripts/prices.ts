import { readFileSync } from 'node:fs';
import { flagNumber, parseArgs } from './lib/args.ts';
import { isMain, printJson, runMain } from './lib/cli.ts';
import { today } from './lib/dates.ts';
import { paths } from './lib/paths.ts';
import {
  computeReferencePrice, estimateRecipe, favorTerms, loadFavorites, loadPrices, loadReferences, priceStatus, readProducts, type PriceEntry,
} from './lib/prices.ts';
import { requireProfile } from './lib/profile.ts';
import { loadProvider } from './lib/provider.ts';
import { loadRecipe } from './lib/recipe-store.ts';
import { loadStaples } from './lib/shopping-list.ts';
import { readYaml, writeYaml } from './lib/yaml-io.ts';

const USAGE = `usage:
  prices.ts status                          are the prices due for a new reading?
  prices.ts references                      what to search: [{ id, query }]
  prices.ts ingest <referenceId> <file>     compute and store a price from a saved search result
  prices.ts done                            mark the reading as finished
  prices.ts estimate [--servings n] <recipeId>...`;

function productRules(): unknown[] {
  const rules = readYaml<{ product_rules?: unknown[] }>(paths.profile(), {}).product_rules;
  return Array.isArray(rules) ? rules : [];
}

function entryLevelBrands(): string[] {
  const provider = loadProvider(requireProfile().store.provider);
  return provider.kind === 'mcp' ? provider.entry_level_brands ?? [] : [];
}

function ingest(id: string, file: string): void {
  const ref = loadReferences().find((r) => r.id === id);
  if (!ref) throw new Error(`Unknown price reference "${id}"`);
  const products = readProducts(JSON.parse(readFileSync(file, 'utf8')));
  const favor = favorTerms(ref, productRules(), loadFavorites());
  const result = computeReferencePrice(ref, products, { favor, entryLevelBrands: entryLevelBrands() });
  if (!result.ok) throw new Error(result.reason);
  const file_ = loadPrices();
  const entry: PriceEntry = { unitPrice: result.unitPrice, unit: result.unit, count: result.count, date: today() };
  if (result.approximate) entry.approximate = true;
  file_.prices[id] = entry;
  writeYaml(paths.prices(), file_);
  printJson({ id, ...entry });
}

async function main(): Promise<void> {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [cmd, ...rest] = positional;
  switch (cmd) {
    case 'status': {
      const provider = loadProvider(requireProfile().store.provider);
      printJson({ enabled: provider.kind === 'mcp', ...priceStatus(loadPrices(), loadReferences(), today()) });
      return;
    }
    case 'references':
      printJson(loadReferences().map(({ id, query }) => ({ id, query })));
      return;
    case 'ingest':
      if (rest.length !== 2) throw new Error(USAGE);
      ingest(rest[0], rest[1]);
      return;
    case 'done': {
      const file = loadPrices();
      file.updated = today();
      writeYaml(paths.prices(), file);
      printJson(priceStatus(file, loadReferences(), today()));
      return;
    }
    case 'estimate': {
      if (rest.length === 0) throw new Error(USAGE);
      const servings = flagNumber(flags, 'servings') ?? requireProfile().household.servings;
      const refs = loadReferences();
      const prices = loadPrices();
      const staples = loadStaples();
      const estimates = rest.map((id) => {
        const r = loadRecipe(id);
        return estimateRecipe({ id, servings: r.servings, ingredients: r.ingredients }, servings, refs, prices, staples);
      });
      printJson({ updated: prices.updated ?? null, estimates });
      return;
    }
    default:
      throw new Error(USAGE);
  }
}

if (isMain(import.meta.url)) runMain(main);
