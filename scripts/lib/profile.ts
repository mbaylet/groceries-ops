import { existsSync, readFileSync } from 'node:fs';
import YAML from 'yaml';
import { paths } from './paths.ts';

export interface ProductRule {
  store_brand_ok?: boolean;
  organic?: boolean;
  preferred_brand?: string;
  cheapest?: boolean;
  max_price_per_kg?: number;
}

export interface Profile {
  household: { adults: number; children: { age: number }[]; servings: number };
  food: { diet: string; exclusions: string[]; preferences: string };
  tools: string[];
  time: { weekday_max_min: number; weekend_max_min: number };
  product_rules: Record<string, ProductRule>;
  store: { provider: string; mode: 'drive' | 'delivery'; store_id: string };
  recipes: { sources: string[] };
  plan: { avoid_repeat_weeks: number };
}

export interface ValidateOptions { sources?: string[]; providers?: string[] }
export type ValidationResult = { ok: true; profile: Profile } | { ok: false; errors: string[] };
export type ProfileLoad =
  | { status: 'missing' }
  | { status: 'template' }
  | { status: 'invalid'; errors: string[] }
  | { status: 'ok'; profile: Profile };

export const RULE_KEYS: Record<string, 'boolean' | 'string' | 'number'> = {
  store_brand_ok: 'boolean',
  organic: 'boolean',
  preferred_brand: 'string',
  cheapest: 'boolean',
  max_price_per_kg: 'number',
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown, min: number, max: number) => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const isStrArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

export function validateProfile(raw: unknown, opts: ValidateOptions = {}): ValidationResult {
  const errors: string[] = [];
  const err = (path: string, msg: string) => errors.push(`${path}: ${msg}`);
  if (!isObj(raw)) return { ok: false, errors: ['profile: must be a YAML mapping'] };
  const sec = (name: string): Obj => {
    const v = raw[name];
    if (!isObj(v)) {
      err(name, 'missing section');
      return {};
    }
    return v;
  };

  const h = sec('household');
  if (!isInt(h.adults, 1, 20)) err('household.adults', 'must be an integer between 1 and 20');
  if (!Array.isArray(h.children) || !h.children.every((c) => isObj(c) && isInt(c.age, 0, 17)))
    err('household.children', 'must be a list of { age: 0-17 }');
  if (!isInt(h.servings, 1, 30)) err('household.servings', 'must be an integer between 1 and 30');

  const f = sec('food');
  if (typeof f.diet !== 'string' || !f.diet.trim()) err('food.diet', 'must be a non-empty string');
  if (!isStrArray(f.exclusions)) err('food.exclusions', 'must be a list of strings');
  if (typeof f.preferences !== 'string') err('food.preferences', 'must be a string');

  if (!isStrArray(raw.tools)) err('tools', 'must be a list of strings');

  const t = sec('time');
  if (!isInt(t.weekday_max_min, 5, 600)) err('time.weekday_max_min', 'must be an integer between 5 and 600 (minutes)');
  if (!isInt(t.weekend_max_min, 5, 600)) err('time.weekend_max_min', 'must be an integer between 5 and 600 (minutes)');

  const pr = raw.product_rules;
  if (!isObj(pr)) err('product_rules', 'missing section');
  else {
    for (const [cat, rule] of Object.entries(pr)) {
      if (!isObj(rule)) {
        err(`product_rules.${cat}`, 'must be a mapping');
        continue;
      }
      for (const [k, v] of Object.entries(rule)) {
        const type = RULE_KEYS[k];
        if (!type) err(`product_rules.${cat}.${k}`, `unknown rule (known: ${Object.keys(RULE_KEYS).join(', ')})`);
        else if (typeof v !== type) err(`product_rules.${cat}.${k}`, `must be a ${type}`);
      }
    }
  }

  const s = sec('store');
  if (typeof s.provider !== 'string') err('store.provider', 'must be a string');
  else if (opts.providers && !opts.providers.includes(s.provider))
    err('store.provider', `unknown provider "${s.provider}" (known: ${opts.providers.join(', ')})`);
  if (s.mode !== 'drive' && s.mode !== 'delivery') err('store.mode', 'must be "drive" or "delivery"');
  if (typeof s.store_id !== 'string') err('store.store_id', 'must be a string');

  const r = sec('recipes');
  if (!isStrArray(r.sources) || r.sources.length === 0) err('recipes.sources', 'must be a non-empty list');
  else if (opts.sources) {
    for (const id of r.sources)
      if (!opts.sources.includes(id)) err('recipes.sources', `unknown recipe source "${id}" (known: ${opts.sources.join(', ')})`);
  }

  const p = sec('plan');
  if (!isInt(p.avoid_repeat_weeks, 0, 52)) err('plan.avoid_repeat_weeks', 'must be an integer between 0 and 52');

  return errors.length ? { ok: false, errors } : { ok: true, profile: raw as unknown as Profile };
}

export function loadProfile(opts: ValidateOptions = {}): ProfileLoad {
  const file = paths.profile();
  if (!existsSync(file)) return { status: 'missing' };
  const text = readFileSync(file, 'utf8');
  const template = paths.profileTemplate();
  if (existsSync(template) && text.trim() === readFileSync(template, 'utf8').trim()) return { status: 'template' };
  let raw: unknown;
  try {
    raw = YAML.parse(text);
  } catch (e) {
    return { status: 'invalid', errors: [`profile.yml: YAML syntax error — ${(e as Error).message}`] };
  }
  const v = validateProfile(raw, opts);
  return v.ok ? { status: 'ok', profile: v.profile } : { status: 'invalid', errors: v.errors };
}

export function requireProfile(opts: ValidateOptions = {}): Profile {
  const l = loadProfile(opts);
  if (l.status === 'ok') return l.profile;
  if (l.status === 'invalid') throw new Error(`profile.yml is invalid: ${l.errors.join('; ')}`);
  throw new Error('No personalised profile.yml — run /groceries onboarding first');
}
