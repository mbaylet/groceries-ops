import { extractJsonLdNodes, hasType, parseRecipeFromHtml } from '../lib/jsonld-recipe.ts';
import type { RecipeSource } from './types.ts';

const RECIPE_URL = /^https?:\/\/(?:www\.)?marmiton\.org\/recettes\/recette_[^/?#]+\.aspx/i;

export function marmitonSlug(url: string): string {
  const m = /recette_([^/?#]+)\.aspx/i.exec(url);
  return (m ? m[1] : 'recipe').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export const marmiton: RecipeSource = {
  id: 'marmiton',
  label: 'Marmiton',
  healthUrl: 'https://www.marmiton.org/recettes/recette_blanquette-de-veau-facile_19219.aspx',
  searchHint: 'site:marmiton.org/recettes',
  matches: (url) => RECIPE_URL.test(url),
  parse: (html, url) => parseRecipeFromHtml(html, url, 'marmiton', marmitonSlug(url)),
  searchUrl: (query, page = 1) =>
    `https://www.marmiton.org/recettes/recherche.aspx?aqt=${encodeURIComponent(query)}${page > 1 ? `&page=${page}` : ''}`,
  parseSearch(html) {
    const urls: string[] = [];
    for (const n of extractJsonLdNodes(html)) {
      if (!hasType(n, 'ItemList') || !Array.isArray(n.itemListElement)) continue;
      for (const item of n.itemListElement) {
        const u = item && typeof item === 'object' ? (item as Record<string, unknown>).url : undefined;
        if (typeof u === 'string' && RECIPE_URL.test(u) && !urls.includes(u)) urls.push(u);
      }
    }
    return urls;
  },
};
