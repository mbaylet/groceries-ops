import { parseArgs, flagNumber, flagString } from './lib/args.ts';
import { isMain, printJson, runMain } from './lib/cli.ts';
import { today } from './lib/dates.ts';
import { fetchHtml, type Fetcher } from './lib/http.ts';
import { requireProfile, type Profile } from './lib/profile.ts';
import { effectiveTotalMin, filterRecipe, type FilterCriteria } from './lib/recipe-filter.ts';
import { listRecipes, loadRecipe, markUsed, recentIds, saveRecipe } from './lib/recipe-store.ts';
import { fetchRecipe, getSource, searchRecipes, sourceForUrl, sourceIds } from './recipe-sources/index.ts';
import { recipeId, type Recipe } from './recipe-sources/types.ts';

const USAGE = `usage:
  recipes.ts sources
  recipes.ts search "<query>" [--source id] [--limit n]
  recipes.ts find "<query>"... [--source id] [--pages n] [--want n] [--max-min n] [--max-prep n] [--reject id,id] [--today YYYY-MM-DD]
  recipes.ts fetch <url>... [--max-min n] [--max-prep n] [--reject id,id] [--today YYYY-MM-DD]
  recipes.ts show <id>
  recipes.ts mark-used <id>... [--today YYYY-MM-DD]`;

export interface FetchOptions { maxMin?: number; maxPrep?: number; rejectIds: string[]; today: string }
export interface FetchResult {
  url: string;
  id?: string;
  keep: boolean;
  reasons: string[];
  error?: string;
  summary?: { name: string; prepMin?: number; cookMin?: number; totalMin?: number; servings?: number; rating?: Recipe['rating'] };
}
interface Deps { profile: Profile; fetcher: Fetcher }

function criteriaFor(profile: Profile, opts: FetchOptions): FilterCriteria {
  return {
    maxTotalMin: opts.maxMin ?? profile.time.weekday_max_min,
    maxPrepMin: opts.maxPrep ?? profile.time.weekday_prep_max_min,
    exclusions: profile.food.exclusions,
    tools: profile.tools,
    recentIds: recentIds(profile.plan.avoid_repeat_weeks, opts.today),
    rejectedIds: opts.rejectIds,
    minRating: profile.recipes.min_rating,
    minRatingCount: profile.recipes.min_rating_count,
  };
}

function resultFor(url: string, r: Recipe, f: { keep: boolean; reasons: string[] }): FetchResult {
  return {
    url,
    id: recipeId(r),
    keep: f.keep,
    reasons: f.reasons,
    summary: { name: r.name, prepMin: r.prepMin, cookMin: r.cookMin, totalMin: effectiveTotalMin(r), servings: r.servings, rating: r.rating },
  };
}

/** Download → filter → save when kept. Never throws; errors are reported in the result. */
async function evaluateUrl(url: string, criteria: FilterCriteria, today: string, deps: Deps): Promise<FetchResult> {
  const source = sourceForUrl(url);
  if (source && !deps.profile.recipes.sources.includes(source.id)) return { url, keep: false, reasons: [`source-disabled:${source.id}`] };
  try {
    const r = await fetchRecipe(url, deps.fetcher);
    const f = filterRecipe(r, criteria);
    if (f.keep) saveRecipe(r, today);
    return resultFor(url, r, f);
  } catch (e) {
    return { url, keep: false, reasons: ['error'], error: (e as Error).message };
  }
}

/** Fetch → filter → save kept recipes. Never throws per URL; errors are reported in the result. */
export async function runFetch(urls: string[], opts: FetchOptions, deps: Deps): Promise<FetchResult[]> {
  const criteria = criteriaFor(deps.profile, opts);
  const out: FetchResult[] = [];
  for (const url of urls) out.push(await evaluateUrl(url, criteria, opts.today, deps));
  return out;
}

export interface FindOptions extends FetchOptions {
  queries: string[];
  /** restrict to one source; default: every enabled source that has a search */
  source?: string;
  /** result pages read per query and source */
  pages: number;
  /** stop as soon as this many recipes are kept */
  want: number;
  /** recipes downloaded at the same time (default 3) */
  concurrency?: number;
  /** pause between two batches of downloads, in ms (default 400) */
  delayMs?: number;
}
export interface FindResult {
  kept: FetchResult[];
  enough: boolean;
  stats: { examined: number; fromStore: number; rejected: Record<string, number>; errors: string[] };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Search every query on every selected source (page by page), then download and filter the distinct
 * results a few at a time, until `want` recipes are kept. Recipes already saved are re-checked from
 * disk. Only kept recipes are returned; rejections are counted by reason.
 */
export async function runFind(opts: FindOptions, deps: Deps): Promise<FindResult> {
  const { profile, fetcher } = deps;
  const criteria = criteriaFor(profile, opts);
  const stats: FindResult['stats'] = { examined: 0, fromStore: 0, rejected: {}, errors: [] };
  const kept: FetchResult[] = [];
  const seen = new Set<string>();
  const saved = new Map(listRecipes().map((r) => [r.url, r]));
  const concurrency = Math.max(1, opts.concurrency ?? 3);
  const delayMs = opts.delayMs ?? 400;

  const enabled = opts.source ? [opts.source] : profile.recipes.sources;
  const sources = enabled.filter((id) => {
    if (!profile.recipes.sources.includes(id)) {
      stats.errors.push(`${id}: not enabled in profile.recipes.sources`);
      return false;
    }
    if (!getSource(id).searchUrl) {
      if (opts.source) stats.errors.push(`${id}: has no search (use WebSearch with "${getSource(id).searchHint}")`);
      return false;
    }
    return true;
  });
  const pageLimit = (id: string) => Math.min(opts.pages, getSource(id).maxPages ?? opts.pages);

  const count = (reasons: string[]) => {
    for (const reason of reasons) {
      const key = reason.split(':')[0];
      stats.rejected[key] = (stats.rejected[key] ?? 0) + 1;
    }
  };
  const examine = async (url: string): Promise<FetchResult> => {
    const local = saved.get(url);
    if (local) {
      stats.fromStore++;
      return resultFor(url, local, filterRecipe(local, criteria));
    }
    return evaluateUrl(url, criteria, opts.today, deps);
  };

  const maxPage = Math.max(0, ...sources.map(pageLimit));
  for (let page = 1; page <= maxPage && kept.length < opts.want; page++) {
    for (const query of opts.queries) {
      for (const id of sources) {
        if (page > pageLimit(id) || kept.length >= opts.want) continue;
        let urls: string[];
        try {
          urls = (await searchRecipes(id, query, Number.MAX_SAFE_INTEGER, fetcher, page)).filter((u) => !seen.has(u));
        } catch (e) {
          stats.errors.push(`${id} "${query}" page ${page}: ${(e as Error).message}`);
          continue;
        }
        for (const u of urls) seen.add(u);
        for (let i = 0; i < urls.length && kept.length < opts.want; i += concurrency) {
          if (i > 0 && delayMs > 0) await sleep(delayMs);
          const batch = await Promise.all(urls.slice(i, i + concurrency).map(examine));
          for (const r of batch) {
            stats.examined++;
            if (r.keep) kept.push(r);
            else if (r.error) stats.errors.push(`${r.url}: ${r.error}`);
            else count(r.reasons);
          }
        }
      }
    }
  }
  return { kept, enough: kept.length >= opts.want, stats };
}

async function main(): Promise<void> {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [cmd, ...rest] = positional;
  const day = flagString(flags, 'today') ?? today();
  const profile = () => requireProfile({ sources: sourceIds() });

  switch (cmd) {
    case 'sources':
      printJson(profile().recipes.sources.map((id) => {
        const s = getSource(id);
        return { id, label: s.label, search: Boolean(s.searchUrl), searchHint: s.searchHint };
      }));
      return;
    case 'search': {
      const query = rest.join(' ').trim();
      if (!query) throw new Error(USAGE);
      const id = flagString(flags, 'source') ?? profile().recipes.sources[0];
      const s = getSource(id);
      if (!s.searchUrl) {
        printJson({ source: id, search: false, searchHint: s.searchHint });
        return;
      }
      printJson({ source: id, urls: await searchRecipes(id, query, flagNumber(flags, 'limit') ?? 10) });
      return;
    }
    case 'find': {
      if (rest.length === 0) throw new Error(USAGE);
      const rejectIds = (flagString(flags, 'reject') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      printJson(await runFind({
        queries: rest,
        source: flagString(flags, 'source'),
        pages: flagNumber(flags, 'pages') ?? 3,
        want: flagNumber(flags, 'want') ?? 12,
        maxMin: flagNumber(flags, 'max-min'),
        maxPrep: flagNumber(flags, 'max-prep'),
        rejectIds,
        today: day,
      }, { profile: profile(), fetcher: fetchHtml }));
      return;
    }
    case 'fetch': {
      if (rest.length === 0) throw new Error(USAGE);
      const rejectIds = (flagString(flags, 'reject') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      printJson(await runFetch(rest, { maxMin: flagNumber(flags, 'max-min'), maxPrep: flagNumber(flags, 'max-prep'), rejectIds, today: day }, { profile: profile(), fetcher: fetchHtml }));
      return;
    }
    case 'show':
      if (!rest[0]) throw new Error(USAGE);
      printJson(loadRecipe(rest[0]));
      return;
    case 'mark-used':
      if (rest.length === 0) throw new Error(USAGE);
      printJson(rest.map((id) => ({ id, used_on: markUsed(id, day).used_on })));
      return;
    default:
      throw new Error(USAGE);
  }
}

if (isMain(import.meta.url)) runMain(main);
