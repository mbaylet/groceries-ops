import { containsPhrase, findExclusions } from './normalize.ts';
import { recipeId, type Recipe } from '../recipe-sources/types.ts';

/** Appliances a recipe may require. Common tools (oven, hob…) are assumed present and never filtered. */
export const SPECIAL_TOOLS: Record<string, string[]> = {
  cookeo: ['cookeo'],
  thermomix: ['thermomix'],
  monsieur_cuisine: ['monsieur cuisine'],
  companion: ['companion'],
  airfryer: ['airfryer', 'air fryer', 'friteuse sans huile'],
  slow_cooker: ['mijoteuse', 'slow cooker'],
  pressure_cooker: ['cocotte minute', 'autocuiseur'],
  barbecue: ['barbecue'],
  plancha: ['plancha'],
};

export interface FilterCriteria {
  maxTotalMin: number;
  exclusions: string[];
  tools: string[];
  recentIds: string[];
  rejectedIds: string[];
  /** minimum average rating (out of 5); unrated recipes fail it */
  minRating?: number;
}

export function effectiveTotalMin(r: Recipe): number | undefined {
  if (r.totalMin !== undefined && r.totalMin > 0) return r.totalMin;
  if (r.prepMin === undefined && r.cookMin === undefined) return undefined;
  const t = (r.prepMin ?? 0) + (r.cookMin ?? 0);
  return t > 0 ? t : undefined;
}

export function filterRecipe(r: Recipe, c: FilterCriteria): { keep: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const id = recipeId(r);
  if (c.rejectedIds.includes(id)) reasons.push('rejected');
  if (c.recentIds.includes(id)) reasons.push('recent');

  const t = effectiveTotalMin(r);
  if (t === undefined) reasons.push('no-time');
  else if (t > c.maxTotalMin) reasons.push(`too-long:${t}>${c.maxTotalMin}`);

  if (c.minRating !== undefined) {
    if (!r.rating) reasons.push('no-rating');
    else if (r.rating.value < c.minRating) reasons.push(`low-rating:${r.rating.value}<${c.minRating}`);
  }

  const excluded = new Set(findExclusions([r.name, ...r.ingredients], c.exclusions).map((h) => h.exclusion));
  for (const e of excluded) reasons.push(`excluded:${e}`);

  const text = [r.name, ...r.tags, ...r.steps].join(' . ');
  for (const [tool, words] of Object.entries(SPECIAL_TOOLS)) {
    if (c.tools.includes(tool)) continue;
    if (words.some((w) => containsPhrase(text, w))) reasons.push(`needs-tool:${tool}`);
  }
  return { keep: reasons.length === 0, reasons };
}
