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
  searchUrl?(query: string): string;
  parseSearch?(html: string): string[];
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
