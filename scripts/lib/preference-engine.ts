import { containsPhrase } from './normalize.ts';
import type { Product } from './product-mapper.ts';
import { matcherWords, ruleKind, type Matcher, type Rule, type Scoring } from './rules.ts';

export interface ItemRequest { item: string; need?: { qty?: number; unit?: string | null }; tags?: string[]; role?: 'key' | 'minor' }
export interface ResolveContext { preferredEans?: string[] }
export interface Option {
  ean: string;
  title: string;
  price?: number;
  unit_price?: number;
  unit?: string;
  packs: number;
  satisfied: string[];
  score: number;
}
export interface Decision {
  item: string;
  status: 'chosen' | 'close_call' | 'none' | 'ask';
  choice?: Option;
  options?: Option[];
  why: string[];
  relaxed: string[];
  eliminated: { ean: string; title: string; reasons: string[] }[];
  flags: string[];
}

interface Cand { p: Product; softFails: string[]; unknowns: string[]; satisfied: string[]; pref: number; score: number }

const prio = (r: Rule) => r.priority ?? 0;
const weightOf = (r: Rule) => r.weight ?? 0.1;

export function specificity(r: Rule): number {
  if (r.applies_to === 'all') return 0;
  if (r.applies_to.tags?.length) return 3;
  if (r.applies_to.not_match?.length) return 2;
  return 1;
}

export function appliesTo(r: Rule, req: ItemRequest): boolean {
  if (r.applies_to === 'all') return true;
  const a = r.applies_to;
  if (a.tags?.length && !a.tags.some((t) => (req.tags ?? []).includes(t))) return false;
  if (a.match?.length && !a.match.some((w) => containsPhrase(req.item, w))) return false;
  if (a.not_match?.some((w) => containsPhrase(req.item, w))) return false;
  return true;
}

const matcherOf = (r: Rule): Matcher | undefined => r.require ?? r.prefer ?? r.forbid;
const outranks = (o: Rule, r: Rule) => specificity(o) > specificity(r) || (specificity(o) === specificity(r) && prio(o) > prio(r));
function sameFamily(o: Rule, r: Rule): boolean {
  const ko = ruleKind(o);
  const kr = ruleKind(r);
  if (kr === 'prefer') return ko === 'prefer' || ko === 'require';
  if (kr === 'require') return ko === 'require';
  if (kr === 'budget') return ko === 'budget';
  return false; // forbids are additive and never shadowed
}
function overlap(o: Rule, r: Rule): boolean {
  if (ruleKind(r) === 'budget') return true;
  const wo = matcherWords(matcherOf(o));
  return matcherWords(matcherOf(r)).some((w) => wo.includes(w));
}

/** Rules applying to this item; a less specific rule on the same words is shadowed by a more specific one. */
export function activeRules(rules: Rule[], req: ItemRequest): { active: Rule[]; shadowed: string[] } {
  const applicable = rules.filter((r) => appliesTo(r, req));
  const shadowed = applicable.filter((r) => applicable.some((o) => o !== r && sameFamily(o, r) && outranks(o, r) && overlap(o, r)));
  return { active: applicable.filter((r) => !shadowed.includes(r)), shadowed: shadowed.map((r) => r.id) };
}

function matches(m: Matcher, p: Product): boolean {
  if (m.any && !m.any.some((w) => containsPhrase(p.text, w))) return false;
  if (m.all && !m.all.every((w) => containsPhrase(p.text, w))) return false;
  if (m.brand_any && !m.brand_any.some((w) => containsPhrase(p.brand ?? '', w))) return false;
  return true;
}

function checkConstraint(r: Rule, p: Product): 'pass' | 'fail' | 'unknown' {
  if (r.require) return p.text.trim() ? (matches(r.require, p) ? 'pass' : 'fail') : 'unknown';
  if (r.forbid) return p.text.trim() ? (matches(r.forbid, p) ? 'fail' : 'pass') : 'unknown';
  const b = r.budget ?? {};
  if (b.max_price !== undefined) {
    if (p.price === undefined) return 'unknown';
    if (p.price > b.max_price) return 'fail';
  }
  if (b.max_price_per_kg !== undefined) {
    if (p.unitPrice === undefined) return 'unknown';
    if (p.unitPrice > b.max_price_per_kg) return 'fail';
  }
  return 'pass';
}

const NEED_UNITS: Record<string, { unit: 'g' | 'ml' | 'piece'; factor: number }> = {
  g: { unit: 'g', factor: 1 }, kg: { unit: 'g', factor: 1000 },
  ml: { unit: 'ml', factor: 1 }, cl: { unit: 'ml', factor: 10 }, l: { unit: 'ml', factor: 1000 },
  piece: { unit: 'piece', factor: 1 },
};

export function computePacks(need: ItemRequest['need'], p: Product): { packs: number; flag?: string } {
  if (!need?.qty) return { packs: 1 };
  const nu = NEED_UNITS[need.unit ?? 'piece'];
  if (!nu || p.packQty === undefined || p.packUnit !== nu.unit) return { packs: 1, flag: 'qty-unknown' };
  return { packs: Math.max(1, Math.ceil((need.qty * nu.factor) / p.packQty - 1e-9)) };
}

const pct = (x: number) => (x >= 0 ? `+${x}%` : `${x}%`);

export function resolveItem(req: ItemRequest, products: Product[], rules: Rule[], scoring: Scoring, ctx: ResolveContext = {}): Decision {
  const { active, shadowed } = activeRules(rules, req);
  const constraints = active.filter((r) => ruleKind(r) !== 'prefer');
  const prefers = active.filter((r) => ruleKind(r) === 'prefer');
  const preferred = ctx.preferredEans ?? [];
  const eliminated: Decision['eliminated'] = [];
  const flags = shadowed.map((id) => `shadowed:${id}`);

  // 1. hard filter, collecting soft failures and unknowns
  const pool: Cand[] = [];
  for (const p of products) {
    if (!p.available) {
      eliminated.push({ ean: p.ean, title: p.title, reasons: ['unavailable'] });
      continue;
    }
    const reasons: string[] = [];
    const c: Cand = { p, softFails: [], unknowns: [], satisfied: [], pref: 0, score: 0 };
    for (const r of constraints) {
      const res = checkConstraint(r, p);
      if (res === 'pass') continue;
      if (res === 'unknown') {
        if (scoring.on_unknown === 'reject') reasons.push(`unknown:${r.id}`);
        else c.unknowns.push(r.id);
      } else if ((r.strictness ?? 'hard') === 'hard') reasons.push(r.id);
      else c.softFails.push(r.id);
    }
    if (reasons.length) eliminated.push({ ean: p.ean, title: p.title, reasons });
    else pool.push(c);
  }

  // 2. ordered relaxation of soft rules (lowest priority first)
  const relaxed: string[] = [];
  let survivors = pool.filter((c) => c.softFails.length === 0);
  const soft = constraints.filter((r) => r.strictness === 'soft').sort((a, b) => prio(a) - prio(b));
  for (const r of soft) {
    if (survivors.length) break;
    relaxed.push(r.id);
    survivors = pool.filter((c) => c.softFails.every((id) => relaxed.includes(id)));
  }
  for (const c of pool) if (!survivors.includes(c)) eliminated.push({ ean: c.p.ean, title: c.p.title, reasons: c.softFails });
  const base = { item: req.item, relaxed, eliminated, flags };
  if (!survivors.length) {
    return { ...base, status: 'none', why: [...new Set(eliminated.flatMap((e) => e.reasons))] };
  }

  // Compare on price per unit when any candidate has one (a missing unit price then scores 0);
  // fall back to the pack price only when no candidate has a unit price.
  const useUnit = survivors.some((c) => c.p.unitPrice !== undefined);
  const priceOf = (p: Product) => (useUnit ? p.unitPrice : p.price);

  // 3. capped preferences, lexicographic, most specific first
  const capped = prefers.filter((r) => r.max_premium_pct !== undefined).sort((a, b) => (outranks(a, b) ? -1 : outranks(b, a) ? 1 : 0));
  for (const r of capped) {
    const sat = survivors.filter((c) => matches(r.prefer!, c.p));
    const rest = survivors.filter((c) => !sat.includes(c));
    if (!sat.length) continue;
    if (!rest.length) {
      sat.forEach((c) => c.satisfied.push(r.id));
      continue;
    }
    const bestRest = Math.min(...rest.map((c) => c.p.unitPrice).filter((v): v is number => v !== undefined));
    if (!Number.isFinite(bestRest)) continue;
    const within = sat.filter((c) => c.p.unitPrice !== undefined && c.p.unitPrice <= bestRest * (1 + r.max_premium_pct! / 100));
    if (!within.length) continue;
    within.forEach((c) => c.satisfied.push(`${r.id}:${pct(Math.round((c.p.unitPrice! / bestRest - 1) * 100))}`));
    survivors = within;
  }

  // 4. uncapped preferences → preference score
  const uncapped = prefers.filter((r) => r.max_premium_pct === undefined);
  const totalW = uncapped.reduce((s, r) => s + weightOf(r), 0);
  for (const c of survivors) {
    let w = 0;
    for (const r of uncapped) if (matches(r.prefer!, c.p)) {
      w += weightOf(r);
      c.satisfied.push(r.id);
    }
    c.pref = totalW ? w / totalW : 0;
  }

  // 5. pareto pruning (remembered products are exempt so status quo can apply)
  const dominates = (d: Cand, c: Cand) => {
    const pd = priceOf(d.p);
    const pc = priceOf(c.p);
    if (pd === undefined || pc === undefined) return false;
    const rd = d.p.rating ?? 0;
    const rc = c.p.rating ?? 0;
    return pd <= pc && d.pref >= c.pref && rd >= rc && (pd < pc || d.pref > c.pref || rd > rc);
  };
  const cands = survivors.filter((c) => preferred.includes(c.p.ean) || !survivors.some((d) => d !== c && dominates(d, c)));

  // 6. score
  const prices = cands.map((c) => priceOf(c.p)).filter((v): v is number => v !== undefined);
  const minPrice = prices.length ? Math.min(...prices) : undefined;
  const w = scoring.weights;
  const wSum = w.price_per_unit + w.preferences + w.rating || 1;
  for (const c of cands) {
    const v = priceOf(c.p);
    const ps = v === undefined || minPrice === undefined ? 0 : (v - minPrice) / minPrice * 100 <= scoring.indifference_pct ? 1 : minPrice / v;
    const rs = c.p.rating === undefined ? 0.5 : c.p.rating / 5;
    c.score = (w.price_per_unit * ps + w.preferences * c.pref + w.rating * rs) / wSum;
  }
  cands.sort((a, b) => b.score - a.score || (priceOf(a.p) ?? Infinity) - (priceOf(b.p) ?? Infinity) || a.p.ean.localeCompare(b.p.ean));

  const toOption = (c: Cand): Option => {
    const o: Option = { ean: c.p.ean, title: c.p.title, packs: computePacks(req.need, c.p).packs, satisfied: c.satisfied, score: Math.round(c.score * 1000) / 1000 };
    if (c.p.price !== undefined) o.price = c.p.price;
    if (c.p.unitPrice !== undefined) o.unit_price = c.p.unitPrice;
    if (c.p.unit !== undefined) o.unit = c.p.unit;
    return o;
  };

  // 7. decide
  const top = cands[0];
  let winner = top;
  const why: string[] = [];
  for (const ean of preferred) {
    const c = cands.find((x) => x.p.ean === ean);
    if (c && c.score >= top.score * (1 - scoring.indifference_pct / 100)) {
      winner = c;
      why.push('status-quo');
      break;
    }
  }
  const packs = computePacks(req.need, winner.p);
  if (packs.flag) flags.push(packs.flag);
  why.unshift(...winner.satisfied, ...constraints.map((r) => r.id));
  if (relaxed.length) why.push(...relaxed.map((id) => `relaxed:${id}`));

  if (winner.unknowns.length) {
    return { ...base, status: 'ask', choice: toOption(winner), options: cands.slice(0, 3).map(toOption), why: [...why, ...winner.unknowns.map((id) => `unknown:${id}`)] };
  }
  const second = cands.find((c) => c !== winner);
  const sameSatisfied = (a: Cand, b: Cand) => a.satisfied.length === b.satisfied.length && a.satisfied.every((s) => b.satisfied.includes(s));
  if (!why.includes('status-quo') && second && (winner.score - second.score) / winner.score * 100 < scoring.close_call_pct && !sameSatisfied(winner, second)) {
    return { ...base, status: 'close_call', options: cands.slice(0, 3).map(toOption), why };
  }
  return { ...base, status: 'chosen', choice: toOption(winner), why };
}
