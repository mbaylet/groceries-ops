import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Points the data root at a fresh temp dir and returns it. */
export function useTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'groceries-'));
  process.env.GROCERIES_ROOT = dir;
  return dir;
}

export const VALID_PROFILE_YAML = `household: { adults: 2, children: [{ age: 6 }], servings: 4 }
food: { diet: omnivore, exclusions: [champignon], preferences: "likes Asian food" }
tools: [oven, hob]
time: { weekday_max_min: 30, weekend_max_min: 90 }
tags: [enfant]
preferences_text: "Jamais d'oeufs de poules élevées au sol."
product_rules:
  - { id: oeufs-bien-etre, applies_to: { match: [oeuf] }, forbid: { any: [sol, cage] } }
store: { provider: carrefour, mode: drive, store_id: "123" }
recipes: { sources: [marmiton] }
plan: { avoid_repeat_weeks: 3 }
`;

/** Writes VALID_PROFILE_YAML into the current GROCERIES_ROOT. */
export function writeValidProfile(root: string, yaml = VALID_PROFILE_YAML): void {
  writeFileSync(join(root, 'profile.yml'), yaml);
}
