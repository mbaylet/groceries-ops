import { parseRecipeFromHtml } from '../lib/jsonld-recipe.ts';
import type { RecipeSource } from './types.ts';

const ORIGIN = 'https://www.cuisineaz.com';
const RECIPE_URL = /^https?:\/\/(?:www\.)?cuisineaz\.com\/recettes\/[a-z0-9-]+-\d+\.aspx(?:[?#].*)?$/i;
// The page also links menu entries and sponsored recipes; only the result tiles are search hits.
const TILE_LINK = /search_tile_title[^>]*>\s*<a[^>]*href="([^"]+)"/gi;

export const cuisineaz: RecipeSource = {
  id: 'cuisineaz',
  label: 'CuisineAZ',
  healthUrl: `${ORIGIN}/recettes/blanquette-de-veau-a-l-ancienne-1548.aspx`,
  searchHint: 'site:cuisineaz.com/recettes',
  matches: (url) => RECIPE_URL.test(url),
  parse: (html, url) => parseRecipeFromHtml(html, url, 'cuisineaz'),
  searchUrl: (query, page = 1) =>
    `${ORIGIN}/recettes/recherche_terme.aspx?recherche=${encodeURIComponent(query)}${page > 1 ? `&page=${page}` : ''}`,
  parseSearch(html) {
    const urls: string[] = [];
    for (const m of html.matchAll(TILE_LINK)) {
      const u = new URL(m[1], ORIGIN).href;
      if (RECIPE_URL.test(u) && !urls.includes(u)) urls.push(u);
    }
    return urls;
  },
};
