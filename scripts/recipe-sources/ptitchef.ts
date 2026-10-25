import { extractJsonLdNodes, hasType, parseRecipeFromHtml } from '../lib/jsonld-recipe.ts';
import type { RecipeSource } from './types.ts';

const RECIPE_URL = /^https?:\/\/(?:www\.)?ptitchef\.com\/recettes\/[a-z-]+\/[a-z0-9-]+-fid-\d+(?:[?#].*)?$/i;

export const ptitchef: RecipeSource = {
  id: 'ptitchef',
  label: 'Ptitchef',
  healthUrl: 'https://www.ptitchef.com/recettes/entree/gratin-courgette-et-filet-de-julienne-fid-980940',
  searchHint: 'site:ptitchef.com/recettes',
  matches: (url) => RECIPE_URL.test(url),
  parse: (html, url) => parseRecipeFromHtml(html, url, 'ptitchef'),
  searchUrl: (query) => `https://www.ptitchef.com/index.php?obj=feed&action=list&q=${encodeURIComponent(query)}`,
  // Further result pages are loaded by script, not by a URL: only the first page (24 recipes) is reachable.
  maxPages: 1,
  parseSearch(html) {
    const urls: string[] = [];
    for (const n of extractJsonLdNodes(html)) {
      if (!hasType(n, 'ItemList') || !Array.isArray(n.itemListElement)) continue;
      for (const entry of n.itemListElement) {
        const item = entry && typeof entry === 'object' ? ((entry as Record<string, unknown>).item ?? entry) : undefined;
        const u = item && typeof item === 'object' ? (item as Record<string, unknown>).url : undefined;
        if (typeof u === 'string' && RECIPE_URL.test(u) && !urls.includes(u)) urls.push(u);
      }
    }
    return urls;
  },
};
