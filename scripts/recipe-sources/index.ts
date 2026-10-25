import { fetchHtml, type Fetcher } from '../lib/http.ts';
import { cuisineaz } from './cuisineaz.ts';
import { marmiton } from './marmiton.ts';
import { ptitchef } from './ptitchef.ts';
import type { Recipe, RecipeSource } from './types.ts';

/** The only list of recipe sources. Adding one = module + line here + tests/fixtures/<id>/recipe-*.html. */
export const SOURCES: readonly RecipeSource[] = [marmiton, cuisineaz, ptitchef];

export function sourceIds(): string[] {
  return SOURCES.map((s) => s.id);
}

export function getSource(id: string): RecipeSource {
  const s = SOURCES.find((x) => x.id === id);
  if (!s) throw new Error(`Unknown recipe source "${id}". Known: ${sourceIds().join(', ')}`);
  return s;
}

export function sourceForUrl(url: string): RecipeSource | undefined {
  return SOURCES.find((s) => s.matches(url));
}

export async function fetchRecipe(url: string, fetcher: Fetcher = fetchHtml): Promise<Recipe> {
  const s = sourceForUrl(url);
  if (!s) throw new Error(`No recipe source handles ${url}`);
  return s.parse(await fetcher(url), url);
}

export async function searchRecipes(id: string, query: string, limit: number, fetcher: Fetcher = fetchHtml, page = 1): Promise<string[]> {
  const s = getSource(id);
  if (!s.searchUrl || !s.parseSearch) {
    throw new Error(`Recipe source "${id}" has no search; use WebSearch with "${s.searchHint ?? s.label}"`);
  }
  return s.parseSearch(await fetcher(s.searchUrl(query, page))).slice(0, limit);
}
