import { tokens } from './normalize.ts';

export interface Matcher { any?: string[]; all?: string[]; brand_any?: string[] }
export interface AppliesTo { match?: string[]; not_match?: string[]; tags?: string[] }
export interface Rule {
  id: string;
  applies_to: 'all' | AppliesTo;
  require?: Matcher;
  forbid?: Matcher;
  prefer?: Matcher;
  budget?: { max_price?: number; max_price_per_kg?: number };
  max_premium_pct?: number;
  strictness?: 'hard' | 'soft';
  priority?: number;
  weight?: number;
}
export interface Scoring {
  weights: { price_per_unit: number; preferences: number; rating: number };
  indifference_pct: number;
  close_call_pct: number;
  on_unknown: 'reject' | 'ask';
}
export interface ScoringInput {
  weights?: Partial<Scoring['weights']>;
  indifference_pct?: number;
  close_call_pct?: number;
  on_unknown?: 'reject' | 'ask';
}

export const DEFAULT_SCORING: Scoring = {
  weights: { price_per_unit: 0.6, preferences: 0.35, rating: 0.05 },
  indifference_pct: 3,
  close_call_pct: 5,
  on_unknown: 'reject',
};
export const RULE_KINDS = ['require', 'forbid', 'prefer', 'budget'] as const;
export type RuleKind = (typeof RULE_KINDS)[number];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isWordList = (v: unknown): v is string[] =>
  Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string' && x.trim() !== '');
const norm = (w: string) => tokens(w).join(' ');

export function ruleKind(r: Rule): RuleKind {
  return r.require ? 'require' : r.forbid ? 'forbid' : r.prefer ? 'prefer' : 'budget';
}

export function matcherWords(m?: Matcher): string[] {
  return [...(m?.any ?? []), ...(m?.all ?? []), ...(m?.brand_any ?? [])].map(norm).filter(Boolean);
}

export function scopesOverlap(a: Rule, b: Rule): boolean {
  if (a.applies_to === 'all' || b.applies_to === 'all') return true;
  const words = (x: AppliesTo) => (x.match ?? []).map(norm);
  const sharedMatch = words(a.applies_to).some((w) => words(b.applies_to as AppliesTo).includes(w));
  const sharedTag = (a.applies_to.tags ?? []).some((t) => (b.applies_to as AppliesTo).tags?.includes(t));
  return sharedMatch || sharedTag;
}

function validateMatcher(v: unknown, path: string, err: (p: string, m: string) => void): void {
  if (!isObj(v)) return err(path, 'must be a mapping with any / all / brand_any');
  if (Object.keys(v).length === 0) err(path, 'needs any, all or brand_any');
  for (const [k, val] of Object.entries(v)) {
    if (!['any', 'all', 'brand_any'].includes(k)) err(`${path}.${k}`, 'unknown key (use any, all, brand_any)');
    else if (!isWordList(val)) err(`${path}.${k}`, 'must be a non-empty list of words');
  }
}

export function validateRules(raw: unknown[], tags: string[]): string[] {
  const errors: string[] = [];
  const err = (p: string, m: string) => {
    errors.push(`${p}: ${m}`);
  };
  const ids = new Set<string>();
  raw.forEach((r, i) => {
    const p = `product_rules[${i}]`;
    if (!isObj(r)) return err(p, 'must be a mapping');
    const id = typeof r.id === 'string' && r.id.trim() ? r.id : undefined;
    const at = id ? `product_rules.${id}` : p;
    if (!id) err(p, 'id: must be a non-empty string');
    else if (ids.has(id)) err(at, 'duplicate id');
    else ids.add(id);

    const a = r.applies_to;
    if (a !== 'all') {
      if (!isObj(a)) err(`${at}.applies_to`, 'must be "all" or { match, not_match, tags }');
      else {
        for (const k of Object.keys(a)) if (!['match', 'not_match', 'tags'].includes(k)) err(`${at}.applies_to.${k}`, 'unknown key');
        for (const k of ['match', 'not_match', 'tags']) if (a[k] !== undefined && !isWordList(a[k])) err(`${at}.applies_to.${k}`, 'must be a non-empty list of words');
        if (a.match === undefined && a.tags === undefined) err(`${at}.applies_to`, 'needs match or tags (or use "all")');
        if (isWordList(a.tags)) for (const t of a.tags) if (!tags.includes(t)) err(`${at}.applies_to.tags`, `unknown tag "${t}" (declare it in tags: [...])`);
      }
    }

    const kinds = RULE_KINDS.filter((k) => r[k] !== undefined);
    if (kinds.length !== 1) err(at, `needs exactly one of ${RULE_KINDS.join(', ')}`);
    for (const k of ['require', 'forbid', 'prefer'] as const) if (r[k] !== undefined) validateMatcher(r[k], `${at}.${k}`, err);
    if (r.budget !== undefined) {
      const b = r.budget;
      if (!isObj(b) || (b.max_price === undefined && b.max_price_per_kg === undefined)) err(`${at}.budget`, 'needs max_price or max_price_per_kg');
      else for (const k of ['max_price', 'max_price_per_kg']) {
        const v = b[k];
        if (v !== undefined && !(typeof v === 'number' && v > 0)) err(`${at}.budget.${k}`, 'must be a positive number');
      }
    }
    if (r.max_premium_pct !== undefined) {
      const v = r.max_premium_pct;
      if (r.prefer === undefined) err(`${at}.max_premium_pct`, 'only allowed with prefer');
      else if (!(typeof v === 'number' && v >= 0 && v <= 500)) err(`${at}.max_premium_pct`, 'must be a number between 0 and 500');
    }
    if (r.weight !== undefined) {
      const v = r.weight;
      if (r.prefer === undefined) err(`${at}.weight`, 'only allowed with prefer');
      else if (!(typeof v === 'number' && v > 0 && v <= 1)) err(`${at}.weight`, 'must be a number in (0, 1]');
    }
    if (r.strictness !== undefined) {
      if (r.prefer !== undefined) err(`${at}.strictness`, 'not allowed with prefer (preferences are always soft)');
      else if (r.strictness !== 'hard' && r.strictness !== 'soft') err(`${at}.strictness`, 'must be "hard" or "soft"');
    }
    if (r.priority !== undefined && !Number.isInteger(r.priority)) err(`${at}.priority`, 'must be an integer');
  });
  if (errors.length) return errors;

  const rules = raw as Rule[];
  for (const a of rules) {
    if (!a.require) continue;
    for (const b of rules) {
      if (!b.forbid || !scopesOverlap(a, b)) continue;
      const forbidden = matcherWords(b.forbid);
      const allWords = (a.require.all ?? []).map(norm);
      const anyWords = (a.require.any ?? []).map(norm);
      const blockedAll = allWords.filter((w) => forbidden.includes(w));
      const blockedAny = anyWords.length > 0 && anyWords.every((w) => forbidden.includes(w));
      if (blockedAll.length || blockedAny)
        errors.push(`product_rules.${a.id}: contradiction — requires "${(blockedAll.length ? blockedAll : anyWords).join(', ')}" but ${b.id} forbids it`);
    }
  }
  return errors;
}

export function validateScoring(raw: unknown): string[] {
  const errors: string[] = [];
  const err = (p: string, m: string) => {
    errors.push(`scoring.${p}: ${m}`);
  };
  if (!isObj(raw)) return ['scoring: must be a mapping'];
  for (const k of Object.keys(raw)) if (!['weights', 'indifference_pct', 'close_call_pct', 'on_unknown'].includes(k)) err(k, 'unknown key');
  if (raw.weights !== undefined) {
    if (!isObj(raw.weights)) err('weights', 'must be a mapping');
    else {
      for (const [k, v] of Object.entries(raw.weights)) {
        if (!['price_per_unit', 'preferences', 'rating'].includes(k)) err(`weights.${k}`, 'unknown weight (price_per_unit, preferences, rating)');
        else if (!(typeof v === 'number' && v >= 0)) err(`weights.${k}`, 'must be a number ≥ 0');
      }
      const merged = { ...DEFAULT_SCORING.weights, ...(raw.weights as Obj) };
      if (!errors.length && Object.values(merged).every((v) => v === 0)) errors.push('scoring.weights: at least one weight must be > 0');
    }
  }
  for (const k of ['indifference_pct', 'close_call_pct']) {
    const v = raw[k];
    if (v !== undefined && !(typeof v === 'number' && v >= 0 && v <= 50)) err(k, 'must be a number between 0 and 50');
  }
  if (raw.on_unknown !== undefined && raw.on_unknown !== 'reject' && raw.on_unknown !== 'ask') err('on_unknown', 'must be "reject" or "ask"');
  return errors;
}

export function resolveScoring(input: ScoringInput = {}): Scoring {
  return {
    weights: { ...DEFAULT_SCORING.weights, ...input.weights },
    indifference_pct: input.indifference_pct ?? DEFAULT_SCORING.indifference_pct,
    close_call_pct: input.close_call_pct ?? DEFAULT_SCORING.close_call_pct,
    on_unknown: input.on_unknown ?? DEFAULT_SCORING.on_unknown,
  };
}
