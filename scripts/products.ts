import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { flagString, parseArgs } from './lib/args.ts';
import { getChoice, loadChoices } from './lib/choices.ts';
import { isMain, printJson, readJsonInput, runMain } from './lib/cli.ts';
import { today } from './lib/dates.ts';
import { findHabit, loadHabits } from './lib/habits.ts';
import { openSession, parseToolJson, type McpSession } from './lib/mcp-client.ts';
import { tokens } from './lib/normalize.ts';
import { paths } from './lib/paths.ts';
import { resolveItem, type Decision, type ItemRequest, type Option } from './lib/preference-engine.ts';
import { buildArgs, mapProducts, mappingHealth } from './lib/product-mapper.ts';
import { loadProfile, requireProfile, type Profile } from './lib/profile.ts';
import { listProviderIds, loadProvider, type McpProvider } from './lib/provider.ts';
import { resolveScoring, ruleKind } from './lib/rules.ts';
import { sourceIds } from './recipe-sources/index.ts';

const USAGE = `usage:
  products.ts resolve <items.json|-> [--from-search <dir>] [--today YYYY-MM-DD]
  products.ts map-check <raw.json>... [--provider id]
  products.ts validate
  products.ts feedback <item> <chosen_ean> <overridden_ean> [--rules id,id] [--today YYYY-MM-DD]
  products.ts suggest`;

export interface CompactDecision {
  item: string;
  status: Decision['status'] | 'error';
  ean?: string;
  title?: string;
  packs?: number;
  price?: number;
  unit_price?: number;
  unit?: string;
  options?: Option[];
  why: string[];
  relaxed?: string[];
  flags?: string[];
  eliminated?: Record<string, number>;
}
export interface ResolveOutput { resolved: CompactDecision[]; exceptions: CompactDecision[]; stats: { items: number; chosen: number; exceptions: number } }
export interface Fallback { fallback: 'search-via-claude'; reason: string; dir: string; files: { item: string; query: string; file: string }[] }
export interface ResolveDeps {
  profile: Profile;
  provider: McpProvider;
  open: (p: McpProvider) => Promise<McpSession>;
  preferredEans: (item: string) => string[];
}

export function itemFileName(item: string): string {
  return `${tokens(item).join('-') || 'item'}.json`;
}

function compact(d: Decision): CompactDecision {
  const c: CompactDecision = { item: d.item, status: d.status, why: d.why };
  if (d.choice && d.status === 'chosen') {
    const o = d.choice;
    c.ean = o.ean;
    c.title = o.title;
    c.packs = o.packs;
    if (o.price !== undefined) c.price = o.price;
    if (o.unit_price !== undefined) c.unit_price = o.unit_price;
    if (o.unit !== undefined) c.unit = o.unit;
  }
  if (d.status !== 'chosen' && d.options) c.options = d.options.slice(0, 3);
  if (d.relaxed.length) c.relaxed = d.relaxed;
  if (d.flags.length) c.flags = d.flags;
  if (d.status !== 'chosen' && d.eliminated.length) {
    const counts: Record<string, number> = {};
    for (const e of d.eliminated) for (const r of e.reasons) counts[r] = (counts[r] ?? 0) + 1;
    c.eliminated = counts;
  }
  return c;
}

export async function runResolve(items: ItemRequest[], opts: { today: string; fromSearch?: string }, deps: ResolveDeps): Promise<ResolveOutput | Fallback> {
  const spec = deps.provider.search;
  if (!spec?.fields) throw new Error(`No product mapping for provider "${deps.provider.id}" — run /groceries setup (mapping discovery)`);
  const dir = join(paths.runs(), `${opts.today}-search`);
  let session: McpSession | undefined;
  if (!opts.fromSearch) {
    try {
      session = await deps.open(deps.provider);
    } catch (e) {
      return {
        fallback: 'search-via-claude',
        reason: (e as Error).message,
        dir,
        files: items.map((i) => ({ item: i.item, query: i.item, file: join(dir, itemFileName(i.item)) })),
      };
    }
  }
  const scoring = resolveScoring(deps.profile.scoring);
  const out: ResolveOutput = { resolved: [], exceptions: [], stats: { items: items.length, chosen: 0, exceptions: 0 } };
  try {
    for (const item of items) {
      try {
        let raw: unknown;
        if (opts.fromSearch) raw = JSON.parse(readFileSync(join(opts.fromSearch, itemFileName(item.item)), 'utf8'));
        else {
          raw = parseToolJson(await session!.call(spec.tool, buildArgs(spec.args, item.item)));
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, itemFileName(item.item)), JSON.stringify(raw));
        }
        const d = resolveItem(item, mapProducts(raw, spec), deps.profile.product_rules, scoring, { preferredEans: deps.preferredEans(item.item) });
        (d.status === 'chosen' ? out.resolved : out.exceptions).push(compact(d));
      } catch (e) {
        out.exceptions.push({ item: item.item, status: 'error', why: [(e as Error).message] });
      }
    }
  } finally {
    await session?.close();
  }
  out.stats.chosen = out.resolved.length;
  out.stats.exceptions = out.exceptions.length;
  return out;
}

export interface FeedbackRow { date: string; item: string; chosen: string; overridden: string; rules: string[] }
const feedbackFile = () => join(paths.data(), 'preference-feedback.tsv');

function readFeedback(): FeedbackRow[] {
  if (!existsSync(feedbackFile())) return [];
  return readFileSync(feedbackFile(), 'utf8').split('\n').slice(1).filter(Boolean).map((line) => {
    const [date, item, chosen, overridden, rules] = line.split('\t');
    return { date, item, chosen, overridden, rules: rules ? rules.split(',').filter(Boolean) : [] };
  });
}

export function suggestions(rows: FeedbackRow[], threshold = 3): { rule: string; overrides: number; hint: string }[] {
  const counts = new Map<string, number>();
  for (const r of rows) for (const id of r.rules) counts.set(id, (counts.get(id) ?? 0) + 1);
  return [...counts.entries()]
    .filter(([, n]) => n >= threshold)
    .map(([rule, overrides]) => ({ rule, overrides, hint: `The user overrode the outcome of "${rule}" ${overrides} times — ask whether to change or relax this rule.` }));
}

function realPreferredEans(): (item: string) => string[] {
  const choices = loadChoices();
  const habits = loadHabits();
  return (item) => [getChoice(choices, item)?.ean, findHabit(habits, { name: item })?.ean].filter((e): e is string => Boolean(e));
}

function activeMcpProvider(profile?: Profile, id?: string): McpProvider {
  const p = loadProvider(id ?? profile?.store.provider ?? 'carrefour');
  if (p.kind !== 'mcp') throw new Error(`Provider "${p.id}" has no store connection`);
  return p;
}

async function main(): Promise<void> {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [cmd, ...rest] = positional;
  const day = flagString(flags, 'today') ?? today();
  switch (cmd) {
    case 'resolve': {
      const profile = requireProfile({ sources: sourceIds(), providers: listProviderIds() });
      const items = (await readJsonInput(rest[0])) as ItemRequest[];
      printJson(await runResolve(items, { today: day, fromSearch: flagString(flags, 'from-search') }, {
        profile, provider: activeMcpProvider(profile), open: (p) => openSession(p), preferredEans: realPreferredEans(),
      }));
      return;
    }
    case 'map-check': {
      if (rest.length === 0) throw new Error(USAGE);
      const loaded = loadProfile();
      const provider = activeMcpProvider(loaded.status === 'ok' ? loaded.profile : undefined, flagString(flags, 'provider'));
      if (!provider.search) throw new Error(`Provider "${provider.id}" has no search block`);
      printJson(mappingHealth(rest.map((f) => JSON.parse(readFileSync(f, 'utf8'))), provider.search));
      return;
    }
    case 'validate': {
      const loaded = loadProfile({ sources: sourceIds(), providers: listProviderIds() });
      if (loaded.status !== 'ok') {
        printJson({ ok: false, status: loaded.status, errors: loaded.status === 'invalid' ? loaded.errors : [] });
        return;
      }
      const { product_rules, scoring } = loaded.profile;
      printJson({
        ok: true,
        rules: product_rules.map((r) => ({
          id: r.id,
          applies_to: r.applies_to,
          kind: ruleKind(r),
          words: r.require ?? r.forbid ?? r.prefer ?? r.budget,
          strictness: ruleKind(r) === 'prefer' ? 'soft' : (r.strictness ?? 'hard'),
          ...(r.max_premium_pct !== undefined && { max_premium_pct: r.max_premium_pct }),
          ...(r.priority !== undefined && { priority: r.priority }),
        })),
        scoring: resolveScoring(scoring),
      });
      return;
    }
    case 'feedback': {
      const [item, chosen, overridden] = rest;
      if (!item || !chosen || !overridden) throw new Error(USAGE);
      mkdirSync(paths.data(), { recursive: true });
      if (!existsSync(feedbackFile())) writeFileSync(feedbackFile(), 'date\titem\tchosen\toverridden\trules\n');
      const rules = flagString(flags, 'rules') ?? '';
      appendFileSync(feedbackFile(), `${day}\t${item}\t${chosen}\t${overridden}\t${rules}\n`);
      printJson({ recorded: true });
      return;
    }
    case 'suggest':
      printJson(suggestions(readFeedback()));
      return;
    default:
      throw new Error(USAGE);
  }
}

if (isMain(import.meta.url)) runMain(main);
