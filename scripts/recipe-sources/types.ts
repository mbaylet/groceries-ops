export interface Recipe {
  source: string;
  url: string;
  slug: string;
  name: string;
  prepMin?: number;
  cookMin?: number;
  totalMin?: number;
  servings?: number;
  ingredients: string[];
  steps: string[];
  tags: string[];
  category?: string;
  rating?: { value: number; count: number };
}

/** A recipe website. Pure functions only; network I/O lives in recipe-sources/index.ts. */
export interface RecipeSource {
  id: string;
  label: string;
  healthUrl: string;
  searchHint?: string;
  matches(url: string): boolean;
  parse(html: string, url: string): Recipe;
  /** `page` is 1-based; page 1 is the plain search URL */
  searchUrl?(query: string, page?: number): string;
  parseSearch?(html: string): string[];
  /** how many result pages the site really serves (default: unlimited); 1 = only the first page is reachable */
  maxPages?: number;
}

export class RecipeParseError extends Error {
  url: string;
  constructor(message: string, url: string) {
    super(`${message} (${url})`);
    this.name = 'RecipeParseError';
    this.url = url;
  }
}

export function recipeId(r: { source: string; slug: string }): string {
  return `${r.source}-${r.slug}`;
}
