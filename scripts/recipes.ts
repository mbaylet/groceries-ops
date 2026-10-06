import { parseArgs, flagNumber, flagString } from './lib/args.ts';
import { isMain, printJson, runMain } from './lib/cli.ts';
import { today } from './lib/dates.ts';
import { fetchHtml, type Fetcher } from './lib/http.ts';
import { requireProfile, type Profile } from './lib/profile.ts';
import { effectiveTotalMin, filterRecipe, type FilterCriteria } from './lib/recipe-filter.ts';
import { loadRecipe, markUsed, recentIds, saveRecipe } from './lib/recipe-store.ts';
import { fetchRecipe, getSource, searchRecipes, sourceForUrl, sourceIds } from './recipe-sources/index.ts';
import { recipeId, type Recipe } from './recipe-sources/types.ts';

const USAGE = `usage:
  recipes.ts sources
  recipes.ts search "<query>" [--source id] [--limit n]
  recipes.ts fetch <url>... [--max-min n] [--reject id,id] [--today YYYY-MM-DD]
  recipes.ts show <id>
  recipes.ts mark-used <id>... [--today YYYY-MM-DD]`;

export interface FetchOptions { maxMin?: number; rejectIds: string[]; today: string }
export interface FetchResult {
  url: string;
  id?: string;
  keep: boolean;
  reasons: string[];
  error?: string;
  summary?: { name: string; totalMin?: number; servings?: number; rating?: Recipe['rating'] };
}

/** Fetch → filter → save kept recipes. Never throws per URL; errors are reported in the result. */
export async function runFetch(urls: string[], opts: FetchOptions, deps: { profile: Profile; fetcher: Fetcher }): Promise<FetchResult[]> {
  const { profile } = deps;
  const criteria: FilterCriteria = {
    maxTotalMin: opts.maxMin ?? profile.time.weekday_max_min,
    exclusions: profile.food.exclusions,
    tools: profile.tools,
    recentIds: recentIds(profile.plan.avoid_repeat_weeks, opts.today),
    rejectedIds: opts.rejectIds,
  };
  const out: FetchResult[] = [];
  for (const url of urls) {
    const source = sourceForUrl(url);
    if (source && !profile.recipes.sources.includes(source.id)) {
      out.push({ url, keep: false, reasons: [`source-disabled:${source.id}`] });
      continue;
    }
    try {
      const r = await fetchRecipe(url, deps.fetcher);
      const f = filterRecipe(r, criteria);
      if (f.keep) saveRecipe(r, opts.today);
      out.push({
        url,
        id: recipeId(r),
        keep: f.keep,
        reasons: f.reasons,
        summary: { name: r.name, totalMin: effectiveTotalMin(r), servings: r.servings, rating: r.rating },
      });
    } catch (e) {
      out.push({ url, keep: false, reasons: ['error'], error: (e as Error).message });
    }
  }
  return out;
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
    case 'fetch': {
      if (rest.length === 0) throw new Error(USAGE);
      const rejectIds = (flagString(flags, 'reject') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      printJson(await runFetch(rest, { maxMin: flagNumber(flags, 'max-min'), rejectIds, today: day }, { profile: profile(), fetcher: fetchHtml }));
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
