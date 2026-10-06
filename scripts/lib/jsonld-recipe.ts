import { parseIsoDuration } from './duration.ts';
import { RecipeParseError, type Recipe } from '../recipe-sources/types.ts';

type Node = Record<string, unknown>;
const SCRIPT_RE = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    try {
      // Some sites emit raw newlines inside strings; JSON forbids control chars.
      return JSON.parse(text.replace(/[\u0000-\u001f]+/g, ' '));
    } catch {
      return undefined;
    }
  }
}

function collect(v: unknown, out: Node[]): void {
  if (Array.isArray(v)) {
    for (const x of v) collect(x, out);
    return;
  }
  if (v && typeof v === 'object') {
    const n = v as Node;
    out.push(n);
    if (Array.isArray(n['@graph'])) collect(n['@graph'], out);
  }
}

export function extractJsonLdNodes(html: string): Node[] {
  const out: Node[] = [];
  for (const m of html.matchAll(SCRIPT_RE)) collect(safeJsonParse(m[1]), out);
  return out;
}

export function hasType(n: Node, type: string): boolean {
  const t = n['@type'];
  return t === type || (Array.isArray(t) && t.includes(type));
}

export function parseYield(v: unknown): number | undefined {
  if (typeof v === 'number') return v > 0 ? v : undefined;
  if (Array.isArray(v)) {
    for (const x of v) {
      const y = parseYield(x);
      if (y) return y;
    }
    return undefined;
  }
  if (typeof v === 'string') {
    const m = /(\d+)/.exec(v);
    const n = m ? Number(m[1]) : 0;
    return n > 0 ? n : undefined;
  }
  return undefined;
}

export function parseInstructions(v: unknown): string[] {
  if (typeof v === 'string') return v.split(/\r?\n+/).map((s) => s.trim()).filter(Boolean);
  if (Array.isArray(v)) return v.flatMap(parseInstructions);
  if (v && typeof v === 'object') {
    const n = v as Node;
    if (hasType(n, 'HowToSection')) return parseInstructions(n.itemListElement);
    if (typeof n.text === 'string' && n.text.trim()) return [n.text.trim()];
  }
  return [];
}

function parseTags(keywords: unknown, category: unknown): string[] {
  const list = (x: unknown) => (typeof x === 'string' ? x.split(',') : Array.isArray(x) ? x.map(String) : []);
  return [...new Set([...list(category), ...list(keywords)].map((s) => s.trim()).filter(Boolean))];
}

function parseRating(v: unknown): Recipe['rating'] {
  if (!v || typeof v !== 'object') return undefined;
  const n = v as Node;
  const value = Number(n.ratingValue);
  const count = Number(n.reviewCount ?? n.ratingCount ?? 0);
  return Number.isFinite(value) && value > 0 ? { value, count: Number.isFinite(count) ? count : 0 } : undefined;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

export function slugFromUrl(url: string): string {
  const last = new URL(url).pathname.split('/').filter(Boolean).pop() ?? 'recipe';
  return last
    .replace(/\.[a-z]+$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function parseRecipeFromHtml(html: string, url: string, source: string, slug = slugFromUrl(url)): Recipe {
  const node = extractJsonLdNodes(html).find((n) => hasType(n, 'Recipe'));
  if (!node) throw new RecipeParseError('no schema.org Recipe JSON-LD found', url);
  const name = typeof node.name === 'string' ? decodeEntities(node.name.trim()) : '';
  const ingredients = Array.isArray(node.recipeIngredient)
    ? node.recipeIngredient.map((x) => decodeEntities(String(x).trim())).filter(Boolean)
    : [];
  if (!name || ingredients.length === 0) throw new RecipeParseError('Recipe JSON-LD lacks name or recipeIngredient', url);

  const recipe: Recipe = {
    source,
    url,
    slug,
    name,
    ingredients,
    steps: parseInstructions(node.recipeInstructions).map(decodeEntities),
    tags: parseTags(node.keywords, node.recipeCategory),
  };
  const prepMin = parseIsoDuration(node.prepTime);
  const cookMin = parseIsoDuration(node.cookTime);
  const totalMin = parseIsoDuration(node.totalTime);
  const servings = parseYield(node.recipeYield);
  const rating = parseRating(node.aggregateRating);
  if (prepMin !== undefined) recipe.prepMin = prepMin;
  if (cookMin !== undefined) recipe.cookMin = cookMin;
  if (totalMin !== undefined) recipe.totalMin = totalMin;
  if (servings !== undefined) recipe.servings = servings;
  if (typeof node.recipeCategory === 'string') recipe.category = node.recipeCategory;
  if (rating) recipe.rating = rating;
  return recipe;
}
