# groceries-ops Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A career-ops-style Claude Code skill (`/groceries`) that onboards a household, plans weekly meals from real recipes, adds ad-hoc items, learns purchase habits, and fills a grocery store cart through a swappable MCP provider — never checking out.

**Architecture:** Markdown mode files (agent layer) drive the conversation; deterministic TypeScript scripts (run directly by Node, no build) do parsing, filtering, list building, habit maths and setup checks, printing JSON. Grocery stores are YAML provider files mapping capabilities to MCP tools; recipe sources are TypeScript modules behind a pure `RecipeSource` interface. User data (`profile.yml`, `data/`) is separate from system files.

**Tech Stack:** Node ≥ 22.18 (native TypeScript type stripping), TypeScript (type-check only), `node:test`, `yaml`, `@modelcontextprotocol/sdk` (doctor's login probe).

**Spec:** `docs/superpowers/specs/2026-10-06-groceries-ops-design.md`

## Global Constraints

- Node ≥ 22.18; `.ts` files run directly (`node scripts/x.ts`). TypeScript must be erasable-only: no `enum`, `namespace`, parameter properties; `import type` for types; relative imports end in `.ts`.
- Runtime deps only `yaml`, `@modelcontextprotocol/sdk`; dev deps only `typescript`, `@types/node`.
- User layer = `profile.yml` + `data/` (gitignored). The data root is `$GROCERIES_ROOT` if set, else the repo root. Tests always set `GROCERIES_ROOT` to a temp dir.
- Every CLI prints JSON on stdout; on error prints `{"error": "..."}` on stderr and exits 1. Exception: `doctor.ts` without `--json` prints a human checklist.
- Code, mode files and script messages are in English. User-facing text follows the user's language; recipe/product names keep their original language.
- Checkout is never performed: provider `forbidden` tools must be denied in `.claude/settings.json`; modes reference only capabilities.
- Dates are `YYYY-MM-DD` strings; day differences computed in UTC.

## Review Focus

1. Ingredient lines with no quantity, fractions or decimal commas (`citron`, `1/2 citron`, `1,5 kg`, `½ botte`) must parse without crashing — Task 2.
2. JSON-LD variants: `@graph`, top-level arrays, `HowToSection` instructions, raw control characters inside strings — Task 3.
3. Exclusion near-misses: `poire` must not exclude `poireau`; `oeufs` must exclude `1 jaune d'œuf` — Task 2.
4. A habit with a single purchase or only pending purchases is never due and never proposed `auto` — Task 8.
5. Recipe missing `recipeYield` → unscaled with a `no-yield` warning; missing `totalTime` → prep+cook, else rejected `no-time` — Tasks 6 and 7.

---

## File map

| File | Responsibility |
|---|---|
| `package.json`, `tsconfig.json`, `.gitignore` | tooling |
| `scripts/lib/paths.ts` | repo root, data root, all file paths |
| `scripts/lib/yaml-io.ts` | read/write YAML atomically |
| `scripts/lib/dates.ts` | today, daysBetween, addDays |
| `scripts/lib/duration.ts` | ISO-8601 duration → minutes |
| `scripts/lib/args.ts` | argv parsing |
| `scripts/lib/cli.ts` | isMain, runMain, printJson, readJsonInput |
| `scripts/lib/normalize.ts` | text normalisation, tokens, phrase match, exclusions |
| `scripts/lib/ingredient-line.ts` | "1 kg de veau" → {qty, unit, name, key} |
| `scripts/lib/http.ts` | `fetchHtml` |
| `scripts/lib/jsonld-recipe.ts` | schema.org Recipe parser |
| `scripts/recipe-sources/types.ts` | `Recipe`, `RecipeSource`, `RecipeParseError`, `recipeId` |
| `scripts/recipe-sources/marmiton.ts` | Marmiton source |
| `scripts/recipe-sources/index.ts` | registry, `fetchRecipe`, `searchRecipes` |
| `scripts/lib/profile.ts` | profile types, validation, loading |
| `scripts/lib/recipe-filter.ts` | time/exclusion/tool/repeat filter |
| `scripts/lib/recipe-store.ts` | `data/recipes/*.md` persistence |
| `scripts/recipes.ts` | CLI: sources, search, fetch, show, mark-used |
| `scripts/lib/shopping-list.ts` | scale, merge, staples, roles |
| `scripts/shopping-list.ts` | CLI: build, drop, add |
| `scripts/lib/habits.ts` | habit maths |
| `scripts/habits.ts` | CLI |
| `scripts/lib/choices.ts`, `scripts/choices.ts` | product corrections |
| `scripts/lib/provider.ts` | provider loading/validation, deny check, session classification |
| `scripts/lib/mcp-probe.ts` | spawn MCP server, call session check |
| `scripts/doctor.ts` | setup check |
| `config/profile.template.yml`, `config/staples.default.yml` | system defaults |
| `providers/carrefour.yml`, `providers/list.yml`, `.claude/settings.json` | providers + deny list |
| `AGENTS.md`, `CLAUDE.md`, `.claude/skills/groceries/SKILL.md`, `modes/*.md` | agent layer |
| `tests/*.test.ts`, `tests/helpers.ts`, `tests/fixtures/marmiton/*.html` | tests (fixtures already committed) |

---

### Task 1: Tooling and core helpers

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `scripts/lib/paths.ts`, `scripts/lib/yaml-io.ts`, `scripts/lib/dates.ts`, `scripts/lib/duration.ts`, `scripts/lib/args.ts`, `scripts/lib/cli.ts`, `tests/helpers.ts`
- Test: `tests/core.test.ts`

**Interfaces:**
- Produces: `REPO_ROOT`, `dataRoot()`, `paths.{profile,data,recipes,habits,choices,runs,profileTemplate,staples,provider(id),providersDir,settings,fixtures(id)}`; `readYaml<T>(file, fallback)`, `writeYaml(file, value)`; `today()`, `isIsoDate()`, `daysBetween(from,to)`, `addDays(date,n)`; `parseIsoDuration(v): number|undefined`; `parseArgs(argv, booleanFlags)`, `flagString`, `flagNumber`; `isMain(metaUrl)`, `runMain(fn)`, `printJson(v)`, `readJsonInput(pathOrDash)`; test helper `useTempRoot()`.

- [ ] **Step 1: Create tooling files**

`package.json`:
```json
{
  "name": "groceries-ops",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22.18" },
  "scripts": {
    "test": "node --test \"tests/**/*.test.ts\"",
    "typecheck": "tsc --noEmit",
    "check": "npm run typecheck && npm test",
    "doctor": "node scripts/doctor.ts"
  }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "erasableSyntaxOnly": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["scripts", "tests"]
}
```

`.gitignore`:
```
node_modules/
profile.yml
data/
*.tmp
```

Run: `npm install yaml @modelcontextprotocol/sdk && npm install -D typescript @types/node`
Expected: installs without errors; `package.json` gains `dependencies`/`devDependencies`.

- [ ] **Step 2: Write the failing test** — `tests/core.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { parseIsoDuration } from '../scripts/lib/duration.ts';
import { daysBetween, addDays, isIsoDate } from '../scripts/lib/dates.ts';
import { parseArgs, flagNumber } from '../scripts/lib/args.ts';
import { readYaml, writeYaml } from '../scripts/lib/yaml-io.ts';
import { paths } from '../scripts/lib/paths.ts';
import { useTempRoot } from './helpers.ts';

test('parseIsoDuration', () => {
  assert.equal(parseIsoDuration('PT15M'), 15);
  assert.equal(parseIsoDuration('PT2H15M'), 135);
  assert.equal(parseIsoDuration('PT1H'), 60);
  assert.equal(parseIsoDuration('P0DT0H30M'), 30);
  assert.equal(parseIsoDuration('PT45S'), 1);
  assert.equal(parseIsoDuration('PT0M'), 0);
  for (const v of ['', 'P', 'PT', '15 min', undefined, null, 42]) assert.equal(parseIsoDuration(v), undefined);
});

test('dates', () => {
  assert.equal(daysBetween('2026-10-01', '2026-10-06'), 5);
  assert.equal(daysBetween('2026-10-20', '2026-10-27'), 7); // crosses DST change
  assert.equal(daysBetween('2026-10-06', '2026-10-01'), -5);
  assert.equal(addDays('2026-09-28', 5), '2026-10-03');
  assert.ok(isIsoDate('2026-10-06'));
  assert.ok(!isIsoDate('06/10/2026'));
});

test('parseArgs', () => {
  const a = parseArgs(['fetch', 'u1', '--max-min', '30', 'u2', '--json'], ['json']);
  assert.deepEqual(a.positional, ['fetch', 'u1', 'u2']);
  assert.equal(a.flags['json'], true);
  assert.equal(flagNumber(a.flags, 'max-min'), 30);
  assert.throws(() => parseArgs(['--limit']), /--limit needs a value/);
  assert.throws(() => flagNumber({ limit: 'x' }, 'limit'), /must be a number/);
});

test('yaml io roundtrip under GROCERIES_ROOT', () => {
  const root = useTempRoot();
  assert.equal(paths.habits(), join(root, 'data', 'habits.yml'));
  assert.deepEqual(readYaml(paths.habits(), { habits: [] }), { habits: [] });
  writeYaml(paths.habits(), { habits: [{ key: 'a' }] });
  assert.ok(existsSync(paths.habits()));
  assert.deepEqual(readYaml(paths.habits(), { habits: [] }), { habits: [{ key: 'a' }] });
});
```

`tests/helpers.ts`:
```ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Points the data root at a fresh temp dir and returns it. */
export function useTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'groceries-'));
  process.env.GROCERIES_ROOT = dir;
  return dir;
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '.../scripts/lib/duration.ts'`.

- [ ] **Step 4: Implement**

`scripts/lib/paths.ts`:
```ts
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** User-layer root: $GROCERIES_ROOT if set, else the repo root. */
export function dataRoot(): string {
  const env = process.env.GROCERIES_ROOT;
  return env ? resolve(REPO_ROOT, env) : REPO_ROOT;
}

export const paths = {
  profile: () => join(dataRoot(), 'profile.yml'),
  data: () => join(dataRoot(), 'data'),
  recipes: () => join(dataRoot(), 'data', 'recipes'),
  habits: () => join(dataRoot(), 'data', 'habits.yml'),
  choices: () => join(dataRoot(), 'data', 'product-choices.yml'),
  runs: () => join(dataRoot(), 'data', 'runs'),
  profileTemplate: () => join(REPO_ROOT, 'config', 'profile.template.yml'),
  staples: () => join(REPO_ROOT, 'config', 'staples.default.yml'),
  providersDir: () => join(REPO_ROOT, 'providers'),
  provider: (id: string) => join(REPO_ROOT, 'providers', `${id}.yml`),
  settings: () => join(REPO_ROOT, '.claude', 'settings.json'),
  fixtures: (sourceId: string) => join(REPO_ROOT, 'tests', 'fixtures', sourceId),
};
```

`scripts/lib/yaml-io.ts`:
```ts
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import YAML from 'yaml';

export function readYaml<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback;
  const value: unknown = YAML.parse(readFileSync(file, 'utf8'));
  return (value ?? fallback) as T;
}

/** Atomic write: temp file then rename. */
export function writeYaml(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, YAML.stringify(value));
  renameSync(tmp, file);
}
```

`scripts/lib/dates.ts`:
```ts
const DAY_MS = 86_400_000;
const utc = (d: string) => Date.parse(`${d}T00:00:00Z`);

/** Local calendar date as YYYY-MM-DD. */
export function today(): string {
  return new Date().toLocaleDateString('sv-SE');
}

export function isIsoDate(s: unknown): s is string {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(utc(s));
}

export function daysBetween(from: string, to: string): number {
  return Math.round((utc(to) - utc(from)) / DAY_MS);
}

export function addDays(date: string, n: number): string {
  return new Date(utc(date) + n * DAY_MS).toISOString().slice(0, 10);
}
```

`scripts/lib/duration.ts`:
```ts
const RE = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;

/** ISO-8601 duration ("PT2H15M") → whole minutes (seconds round up). */
export function parseIsoDuration(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const m = RE.exec(value.trim());
  if (!m || m.slice(1).every((g) => g === undefined)) return undefined;
  const [d, h, min, s] = m.slice(1).map((g) => (g === undefined ? 0 : Number(g)));
  return d * 1440 + h * 60 + min + Math.ceil(s / 60);
}
```

`scripts/lib/args.ts`:
```ts
export type Flags = Record<string, string | boolean>;
export interface ParsedArgs { positional: string[]; flags: Flags }

export function parseArgs(argv: string[], booleanFlags: string[] = []): ParsedArgs {
  const positional: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { positional.push(a); continue; }
    const name = a.slice(2);
    if (booleanFlags.includes(name)) { flags[name] = true; continue; }
    const v = argv[i + 1];
    if (v === undefined) throw new Error(`--${name} needs a value`);
    flags[name] = v;
    i++;
  }
  return { positional, flags };
}

export function flagString(flags: Flags, name: string): string | undefined {
  const v = flags[name];
  return typeof v === 'string' ? v : undefined;
}

export function flagNumber(flags: Flags, name: string): number | undefined {
  const v = flagString(flags, name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`--${name} must be a number, got "${v}"`);
  return n;
}
```

`scripts/lib/cli.ts`:
```ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function isMain(metaUrl: string): boolean {
  const entry = process.argv[1];
  return entry !== undefined && metaUrl === pathToFileURL(resolve(entry)).href;
}

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function runMain(main: () => Promise<void> | void): void {
  Promise.resolve()
    .then(main)
    .catch((err: unknown) => {
      process.stderr.write(`${JSON.stringify({ error: err instanceof Error ? err.message : String(err) })}\n`);
      process.exitCode = 1;
    });
}

/** Reads JSON from a file path, or stdin when the path is "-" or missing. */
export async function readJsonInput(path?: string): Promise<unknown> {
  if (path && path !== '-') return JSON.parse(readFileSync(path, 'utf8'));
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npm run check`
Expected: typecheck clean; 4 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: tooling and core helpers"
```

---

### Task 2: Text normalisation and ingredient-line parsing

**Files:**
- Create: `scripts/lib/normalize.ts`, `scripts/lib/ingredient-line.ts`
- Test: `tests/ingredients.test.ts`

**Interfaces:**
- Produces: `normalizeText(s)`, `singularize(w)`, `tokens(s): string[]`, `containsPhrase(haystack, needle): boolean`, `findExclusions(lines, exclusions): {exclusion, line}[]`; `interface ParsedIngredient { raw; qty?; unit?; name; key }`, `parseIngredientLine(raw): ParsedIngredient`. Units are canonical: mass `g`, volume `ml`, else `cas`, `cac`, `pincee`, `gousse`, `tranche`, `boite`, `pot`, `sachet`, `brin`, `botte`, `feuille`, `verre`, `poignee`, `morceau`. `name` is normalised (lowercase, no accents); `key` is singularised tokens joined by spaces.

- [ ] **Step 1: Write the failing test** — `tests/ingredients.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { containsPhrase, findExclusions, normalizeText, tokens } from '../scripts/lib/normalize.ts';
import { parseIngredientLine } from '../scripts/lib/ingredient-line.ts';

test('normalizeText strips accents, ligatures, punctuation', () => {
  assert.equal(normalizeText("Crème fraîche d'Isigny"), 'creme fraiche d isigny');
  assert.equal(normalizeText('Œufs'), 'oeufs');
});

test('tokens singularise', () => {
  assert.deepEqual(tokens('Pommes de terre'), ['pomme', 'de', 'terre']);
  assert.deepEqual(tokens('poireaux'), ['poireau']);
  assert.deepEqual(tokens('noix riz ail'), ['noix', 'riz', 'ail']);
});

test('exclusions: plurals, accents, no substring false positives', () => {
  assert.ok(containsPhrase('1 petite boîte de champignon (coupés)', 'champignons'));
  assert.ok(containsPhrase('200 g de champignons de Paris', 'champignon'));
  assert.ok(containsPhrase("1 jaune d'œuf", 'oeufs'));
  assert.ok(!containsPhrase('2 poireaux', 'poire'));
  assert.ok(!containsPhrase('1 porcelaine', 'porc'));
  assert.ok(!containsPhrase('anything', ''));
  assert.deepEqual(findExclusions(['2 poireaux', '1 poire'], ['poire']), [{ exclusion: 'poire', line: '1 poire' }]);
});

test('parseIngredientLine: units and conversions', () => {
  assert.deepEqual(parseIngredientLine('1 kg de blanquette de veau'),
    { raw: '1 kg de blanquette de veau', qty: 1000, unit: 'g', name: 'blanquette de veau', key: 'blanquette de veau' });
  assert.deepEqual(parseIngredientLine('25 cl de vin blanc'),
    { raw: '25 cl de vin blanc', qty: 250, unit: 'ml', name: 'vin blanc', key: 'vin blanc' });
  assert.deepEqual(parseIngredientLine('2 carottes'), { raw: '2 carottes', qty: 2, name: 'carottes', key: 'carotte' });
  assert.deepEqual(parseIngredientLine('1 petite boîte de champignon (coupés)'),
    { raw: '1 petite boîte de champignon (coupés)', qty: 1, unit: 'boite', name: 'champignon', key: 'champignon' });
  assert.equal(parseIngredientLine("2 cuillères à soupe d'huile d'olive").unit, 'cas');
  assert.equal(parseIngredientLine("2 cuillères à soupe d'huile d'olive").name, 'huile d olive');
  assert.equal(parseIngredientLine('200g de farine').qty, 200);
  assert.equal(parseIngredientLine('200g de farine').name, 'farine');
  assert.equal(parseIngredientLine('2 à 3 oignons').qty, 2);
  assert.equal(parseIngredientLine('2 gros oignons').name, 'oignons');
});

test('parseIngredientLine: no quantity, fractions, decimal comma (review focus 1)', () => {
  assert.deepEqual(parseIngredientLine('citron'), { raw: 'citron', name: 'citron', key: 'citron' });
  assert.equal(parseIngredientLine('1/2 citron').qty, 0.5);
  assert.equal(parseIngredientLine('1 1/2 citron').qty, 1.5);
  const p = parseIngredientLine('1,5 kg de pommes de terre');
  assert.equal(p.qty, 1500);
  assert.equal(p.key, 'pomme de terre');
  const b = parseIngredientLine('½ botte de persil');
  assert.equal(b.qty, 0.5);
  assert.equal(b.unit, 'botte');
  assert.equal(b.name, 'persil');
  assert.equal(parseIngredientLine("1 jaune d'oeuf").name, 'jaune d oeuf');
  assert.equal(parseIngredientLine('').key, '');
  assert.equal(parseIngredientLine("l'oignon").unit, undefined);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/ingredients.test.ts`
Expected: FAIL — cannot find module `normalize.ts`.

- [ ] **Step 3: Implement**

`scripts/lib/normalize.ts`:
```ts
/** Lowercase, ligatures expanded, accents stripped, punctuation → single spaces. */
export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/œ/g, 'oe')
    .replace(/æ/g, 'ae')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Naive French singular: poireaux → poireau, pommes → pomme. Short words untouched. */
export function singularize(w: string): string {
  if (w.length <= 3) return w;
  if (/(eau|eu|ou)x$/.test(w)) return w.slice(0, -1);
  if (w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

export function tokens(s: string): string[] {
  return normalizeText(s).split(' ').filter(Boolean).map(singularize);
}

/** True when needle's tokens appear contiguously in haystack's tokens (whole words only). */
export function containsPhrase(haystack: string, needle: string): boolean {
  const h = tokens(haystack);
  const n = tokens(needle);
  if (n.length === 0) return false;
  for (let i = 0; i <= h.length - n.length; i++) {
    if (n.every((t, j) => h[i + j] === t)) return true;
  }
  return false;
}

export function findExclusions(lines: string[], exclusions: string[]): { exclusion: string; line: string }[] {
  const hits: { exclusion: string; line: string }[] = [];
  for (const line of lines) {
    for (const exclusion of exclusions) {
      if (containsPhrase(line, exclusion)) hits.push({ exclusion, line });
    }
  }
  return hits;
}
```

`scripts/lib/ingredient-line.ts`:
```ts
import { normalizeText, tokens } from './normalize.ts';

export interface ParsedIngredient {
  raw: string;
  qty?: number;
  unit?: string;
  name: string;
  key: string;
}

interface UnitDef { unit: string; factor: number }

const UNITS: [string[], UnitDef][] = [
  [['g', 'gr', 'gramme', 'grammes'], { unit: 'g', factor: 1 }],
  [['kg', 'kilo', 'kilos', 'kilogramme', 'kilogrammes'], { unit: 'g', factor: 1000 }],
  [['mg'], { unit: 'g', factor: 0.001 }],
  [['ml', 'millilitre', 'millilitres'], { unit: 'ml', factor: 1 }],
  [['cl', 'centilitre', 'centilitres'], { unit: 'ml', factor: 10 }],
  [['dl', 'decilitre', 'decilitres'], { unit: 'ml', factor: 100 }],
  [['l', 'litre', 'litres'], { unit: 'ml', factor: 1000 }],
  [['cuillere a soupe', 'cuilleres a soupe', 'c a soupe', 'c a s', 'cas', 'cs'], { unit: 'cas', factor: 1 }],
  [['cuillere a cafe', 'cuilleres a cafe', 'c a cafe', 'c a c', 'cac', 'cc'], { unit: 'cac', factor: 1 }],
  [['pincee', 'pincees'], { unit: 'pincee', factor: 1 }],
  [['gousse', 'gousses'], { unit: 'gousse', factor: 1 }],
  [['tranche', 'tranches'], { unit: 'tranche', factor: 1 }],
  [['boite', 'boites'], { unit: 'boite', factor: 1 }],
  [['pot', 'pots'], { unit: 'pot', factor: 1 }],
  [['sachet', 'sachets'], { unit: 'sachet', factor: 1 }],
  [['brin', 'brins'], { unit: 'brin', factor: 1 }],
  [['botte', 'bottes'], { unit: 'botte', factor: 1 }],
  [['feuille', 'feuilles'], { unit: 'feuille', factor: 1 }],
  [['verre', 'verres'], { unit: 'verre', factor: 1 }],
  [['poignee', 'poignees'], { unit: 'poignee', factor: 1 }],
  [['morceau', 'morceaux'], { unit: 'morceau', factor: 1 }],
];

// Longest alias first so "cuillere a soupe" wins over "c".
const ALIASES = UNITS.flatMap(([names, def]) => names.map((n) => [n, def] as const)).sort(
  (a, b) => b[0].length - a[0].length,
);

const QTY_RE = /^\s*(\d+\s+\d+\/\d+|\d+\/\d+|\d+(?:[.,]\d+)?|[½¼¾⅓⅔])(?:\s*(?:à|-)\s*\d+(?:[.,]\d+)?)?\s*/;
const ADJECTIVES = /^(?:(?:petite?s?|grande?s?|gros|grosses?|belles?|beaux?|bonne?s?)\s+)+/;
const ARTICLES = /^(?:de la|de l|des|du|de|d)\s+/;
const FRACTIONS: Record<string, number> = { '½': 0.5, '¼': 0.25, '¾': 0.75, '⅓': 0.33, '⅔': 0.67 };

const round = (x: number) => Math.round(x * 1000) / 1000;

function parseQty(s: string): number {
  const frac = FRACTIONS[s];
  if (frac !== undefined) return frac;
  const mixed = /^(\d+)\s+(\d+)\/(\d+)$/.exec(s);
  if (mixed) return Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3]);
  const simple = /^(\d+)\/(\d+)$/.exec(s);
  if (simple) return Number(simple[1]) / Number(simple[2]);
  return Number(s.replace(',', '.'));
}

/** "1 kg de blanquette de veau" → { qty: 1000, unit: 'g', name: 'blanquette de veau', key: 'blanquette de veau' } */
export function parseIngredientLine(raw: string): ParsedIngredient {
  const cleaned = raw.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  const m = QTY_RE.exec(cleaned);
  let qty: number | undefined;
  let rest = cleaned;
  if (m && m[0].trim()) {
    qty = parseQty(m[1]);
    rest = cleaned.slice(m[0].length);
  }
  let n = normalizeText(rest).replace(ADJECTIVES, '');
  let unit: string | undefined;
  // Units only count after a number: "l'oignon" must not read as litres.
  if (qty !== undefined) {
    for (const [alias, def] of ALIASES) {
      if (n === alias || n.startsWith(`${alias} `)) {
        unit = def.unit;
        qty = round(qty * def.factor);
        n = n.slice(alias.length).trim();
        break;
      }
    }
  }
  n = n.replace(ARTICLES, '').replace(ADJECTIVES, '').trim();
  const result: ParsedIngredient = { raw, name: n, key: tokens(n).join(' ') };
  if (qty !== undefined) result.qty = qty;
  if (unit !== undefined) result.unit = unit;
  return result;
}
```

Note: `deepEqual` checks key order-insensitively but checks presence, so optional fields must be omitted (not `undefined`) — the implementation assigns them only when defined.

- [ ] **Step 4: Run tests**

Run: `npm run check`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: ingredient normalisation and line parsing"
```

---

### Task 3: Recipe types and schema.org JSON-LD parser

**Files:**
- Create: `scripts/recipe-sources/types.ts`, `scripts/lib/jsonld-recipe.ts`
- Test: `tests/jsonld-recipe.test.ts` (uses committed `tests/fixtures/marmiton/recipe-blanquette.html`)

**Interfaces:**
- Consumes: `parseIsoDuration` (Task 1).
- Produces:
  ```ts
  interface Recipe { source: string; url: string; slug: string; name: string; prepMin?: number; cookMin?: number; totalMin?: number; servings?: number; ingredients: string[]; steps: string[]; tags: string[]; category?: string; rating?: { value: number; count: number } }
  interface RecipeSource { id; label; healthUrl; searchHint?; matches(url): boolean; parse(html, url): Recipe; searchUrl?(query): string; parseSearch?(html): string[] }
  class RecipeParseError extends Error { url: string }
  function recipeId(r: { source: string; slug: string }): string   // `${source}-${slug}`
  extractJsonLdNodes(html): Record<string, unknown>[]; hasType(node, type): boolean;
  parseYield(v): number|undefined; parseInstructions(v): string[]; slugFromUrl(url): string;
  parseRecipeFromHtml(html, url, source, slug?): Recipe
  ```

- [ ] **Step 1: Write the failing test** — `tests/jsonld-recipe.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseRecipeFromHtml, parseYield, slugFromUrl } from '../scripts/lib/jsonld-recipe.ts';
import { RecipeParseError, recipeId } from '../scripts/recipe-sources/types.ts';
import { paths } from '../scripts/lib/paths.ts';

const URL = 'https://www.marmiton.org/recettes/recette_blanquette-de-veau-facile_19219.aspx';
const html = readFileSync(join(paths.fixtures('marmiton'), 'recipe-blanquette.html'), 'utf8');
const ld = (json: string) => `<html><script type="application/ld+json">${json}</script></html>`;

test('parses the Marmiton blanquette fixture', () => {
  const r = parseRecipeFromHtml(html, URL, 'marmiton', 'blanquette-de-veau-facile-19219');
  assert.equal(r.name, 'Blanquette de veau : recette traditionnelle : la meilleure recette');
  assert.equal(r.prepMin, 15);
  assert.equal(r.cookMin, 120);
  assert.equal(r.totalMin, 135);
  assert.equal(r.servings, 4);
  assert.equal(r.ingredients.length, 13);
  assert.equal(r.ingredients[0], '1 kg de blanquette de veau');
  assert.equal(r.steps.length, 7);
  assert.match(r.steps[0], /^Faire revenir la viande/);
  assert.equal(r.category, 'Plat principal');
  assert.deepEqual(r.rating, { value: 4.9, count: 2776 });
  assert.ok(r.tags.includes('blanquette'));
  assert.equal(recipeId(r), 'marmiton-blanquette-de-veau-facile-19219');
});

test('top-level array, HowToSection, yield array (review focus 2)', () => {
  const r = parseRecipeFromHtml(ld(JSON.stringify([
    { '@type': 'WebSite' },
    { '@type': ['Recipe'], name: 'Soupe', recipeIngredient: ['2 poireaux'], recipeYield: ['4', '4 servings'],
      recipeInstructions: [{ '@type': 'HowToSection', itemListElement: [{ '@type': 'HowToStep', text: 'Couper.' }, { '@type': 'HowToStep', text: 'Cuire.' }] }] },
  ])), 'https://ex.org/r/soupe.html', 'ex');
  assert.equal(r.servings, 4);
  assert.deepEqual(r.steps, ['Couper.', 'Cuire.']);
  assert.equal(r.slug, 'soupe');
});

test('raw control characters inside JSON strings', () => {
  const r = parseRecipeFromHtml(ld('{"@type":"Recipe","name":"Soupe\nde poireaux","recipeIngredient":["2 poireaux"],"recipeInstructions":"Couper\nCuire"}'), 'https://ex.org/a', 'ex');
  assert.equal(r.name, 'Soupe de poireaux');
  assert.equal(r.totalMin, undefined);
  assert.equal(r.servings, undefined);
});

test('missing recipe or ingredients throws RecipeParseError', () => {
  assert.throws(() => parseRecipeFromHtml('<html></html>', 'https://ex.org/a', 'ex'), RecipeParseError);
  assert.throws(() => parseRecipeFromHtml(ld('{"@type":"Recipe","name":"X"}'), 'https://ex.org/a', 'ex'), RecipeParseError);
});

test('helpers', () => {
  assert.equal(parseYield('4 personnes'), 4);
  assert.equal(parseYield(6), 6);
  assert.equal(parseYield('quelques'), undefined);
  assert.equal(slugFromUrl('https://ex.org/recettes/Poulet_Curry.aspx'), 'poulet-curry');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/jsonld-recipe.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`scripts/recipe-sources/types.ts`:
```ts
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
```

`scripts/lib/jsonld-recipe.ts`:
```ts
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
```

- [ ] **Step 4: Run tests**

Run: `npm run check`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: Recipe types and schema.org JSON-LD parser"
```

---

### Task 4: Recipe-source registry and Marmiton source

**Files:**
- Create: `scripts/lib/http.ts`, `scripts/recipe-sources/marmiton.ts`, `scripts/recipe-sources/index.ts`
- Test: `tests/recipe-sources.test.ts` (uses `tests/fixtures/marmiton/search-curry-poulet.html`)

**Interfaces:**
- Consumes: Task 3 types and parser.
- Produces: `type Fetcher = (url: string) => Promise<string>`, `fetchHtml: Fetcher`; `marmiton: RecipeSource`, `marmitonSlug(url)`; `SOURCES`, `sourceIds()`, `getSource(id)`, `sourceForUrl(url)`, `fetchRecipe(url, fetcher?)`, `searchRecipes(id, query, limit, fetcher?)`.

- [ ] **Step 1: Write the failing test** — `tests/recipe-sources.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { SOURCES, fetchRecipe, getSource, searchRecipes, sourceForUrl } from '../scripts/recipe-sources/index.ts';
import { marmiton, marmitonSlug } from '../scripts/recipe-sources/marmiton.ts';
import { paths } from '../scripts/lib/paths.ts';

const fixture = (id: string, name: string) => readFileSync(join(paths.fixtures(id), name), 'utf8');
const BLANQUETTE = 'https://www.marmiton.org/recettes/recette_blanquette-de-veau-facile_19219.aspx';

test('contract: every registered source parses its fixture into a valid Recipe', () => {
  for (const s of SOURCES) {
    assert.ok(s.matches(s.healthUrl), `${s.id} must claim its healthUrl`);
    const dir = paths.fixtures(s.id);
    assert.ok(existsSync(dir), `${s.id} needs tests/fixtures/${s.id}/`);
    const files = readdirSync(dir).filter((f) => f.startsWith('recipe-'));
    assert.ok(files.length > 0, `${s.id} needs a recipe-*.html fixture`);
    for (const f of files) {
      const r = s.parse(fixture(s.id, f), s.healthUrl);
      assert.equal(r.source, s.id);
      assert.ok(r.name && r.ingredients.length > 0 && r.slug);
      assert.ok(r.totalMin !== undefined || r.prepMin !== undefined || r.cookMin !== undefined, `${f}: no timing`);
      assert.ok(!r.slug.includes('/'));
    }
    if (s.searchUrl) assert.ok(s.parseSearch, `${s.id}: searchUrl requires parseSearch`);
  }
});

test('marmiton url handling', () => {
  assert.ok(marmiton.matches(BLANQUETTE));
  assert.ok(!marmiton.matches('https://www.marmiton.org/recettes/recherche.aspx?aqt=curry'));
  assert.ok(!marmiton.matches('https://www.750g.com/x.htm'));
  assert.equal(marmitonSlug(BLANQUETTE), 'blanquette-de-veau-facile-19219');
  assert.equal(marmiton.searchUrl?.('poulet curry'), 'https://www.marmiton.org/recettes/recherche.aspx?aqt=poulet%20curry');
});

test('marmiton search results from ItemList JSON-LD', () => {
  const urls = marmiton.parseSearch!(fixture('marmiton', 'search-curry-poulet.html'));
  assert.ok(urls.length >= 5);
  assert.equal(urls[0], 'https://www.marmiton.org/recettes/recette_filet-de-poulet-au-curry_80990.aspx');
  assert.ok(urls.every((u) => marmiton.matches(u)));
  assert.equal(new Set(urls).size, urls.length);
});

test('registry dispatch with injected fetcher', async () => {
  assert.equal(sourceForUrl(BLANQUETTE)?.id, 'marmiton');
  assert.equal(sourceForUrl('https://unknown.org/r'), undefined);
  assert.throws(() => getSource('nope'), /Unknown recipe source "nope"/);
  const r = await fetchRecipe(BLANQUETTE, async () => fixture('marmiton', 'recipe-blanquette.html'));
  assert.equal(r.slug, 'blanquette-de-veau-facile-19219');
  await assert.rejects(fetchRecipe('https://unknown.org/r', async () => ''), /No recipe source handles/);
  const urls = await searchRecipes('marmiton', 'curry', 3, async (u) => {
    assert.match(u, /recherche\.aspx\?aqt=curry/);
    return fixture('marmiton', 'search-curry-poulet.html');
  });
  assert.equal(urls.length, 3);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/recipe-sources.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`scripts/lib/http.ts`:
```ts
export type Fetcher = (url: string) => Promise<string>;

const HEADERS = {
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  'accept-language': 'fr-FR,fr;q=0.9,en;q=0.5',
};

export const fetchHtml: Fetcher = async (url) => {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
};
```

`scripts/recipe-sources/marmiton.ts`:
```ts
import { extractJsonLdNodes, hasType, parseRecipeFromHtml } from '../lib/jsonld-recipe.ts';
import type { RecipeSource } from './types.ts';

const RECIPE_URL = /^https?:\/\/(?:www\.)?marmiton\.org\/recettes\/recette_[^/?#]+\.aspx/i;

export function marmitonSlug(url: string): string {
  const m = /recette_([^/?#]+)\.aspx/i.exec(url);
  return (m ? m[1] : 'recipe').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export const marmiton: RecipeSource = {
  id: 'marmiton',
  label: 'Marmiton',
  healthUrl: 'https://www.marmiton.org/recettes/recette_blanquette-de-veau-facile_19219.aspx',
  searchHint: 'site:marmiton.org/recettes',
  matches: (url) => RECIPE_URL.test(url),
  parse: (html, url) => parseRecipeFromHtml(html, url, 'marmiton', marmitonSlug(url)),
  searchUrl: (query) => `https://www.marmiton.org/recettes/recherche.aspx?aqt=${encodeURIComponent(query)}`,
  parseSearch(html) {
    const urls: string[] = [];
    for (const n of extractJsonLdNodes(html)) {
      if (!hasType(n, 'ItemList') || !Array.isArray(n.itemListElement)) continue;
      for (const item of n.itemListElement) {
        const u = item && typeof item === 'object' ? (item as Record<string, unknown>).url : undefined;
        if (typeof u === 'string' && RECIPE_URL.test(u) && !urls.includes(u)) urls.push(u);
      }
    }
    return urls;
  },
};
```

`scripts/recipe-sources/index.ts`:
```ts
import { fetchHtml, type Fetcher } from '../lib/http.ts';
import { marmiton } from './marmiton.ts';
import type { Recipe, RecipeSource } from './types.ts';

/** The only list of recipe sources. Adding one = module + line here + tests/fixtures/<id>/recipe-*.html. */
export const SOURCES: readonly RecipeSource[] = [marmiton];

export function sourceIds(): string[] {
  return SOURCES.map((s) => s.id);
}

export function getSource(id: string): RecipeSource {
  const s = SOURCES.find((x) => x.id === id);
  if (!s) throw new Error(`Unknown recipe source "${id}". Known: ${sourceIds().join(', ')}`);
  return s;
}

export function sourceForUrl(url: string): RecipeSource | undefined {
  return SOURCES.find((s) => s.matches(url));
}

export async function fetchRecipe(url: string, fetcher: Fetcher = fetchHtml): Promise<Recipe> {
  const s = sourceForUrl(url);
  if (!s) throw new Error(`No recipe source handles ${url}`);
  return s.parse(await fetcher(url), url);
}

export async function searchRecipes(id: string, query: string, limit: number, fetcher: Fetcher = fetchHtml): Promise<string[]> {
  const s = getSource(id);
  if (!s.searchUrl || !s.parseSearch) {
    throw new Error(`Recipe source "${id}" has no search; use WebSearch with "${s.searchHint ?? s.label}"`);
  }
  return s.parseSearch(await fetcher(s.searchUrl(query))).slice(0, limit);
}
```

- [ ] **Step 4: Run tests**

Run: `npm run check`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: recipe-source registry and Marmiton source"
```

---

### Task 5: Profile template, validation and loading

**Files:**
- Create: `config/profile.template.yml`, `scripts/lib/profile.ts`
- Modify: `tests/helpers.ts` (add `VALID_PROFILE_YAML`, `writeValidProfile()`)
- Test: `tests/profile.test.ts`

**Interfaces:**
- Consumes: `paths` (Task 1).
- Produces: `interface Profile`, `interface ProductRule`, `RULE_KEYS`, `validateProfile(raw, opts?: { sources?: string[]; providers?: string[] }): { ok: true; profile } | { ok: false; errors: string[] }`, `type ProfileLoad = {status:'missing'} | {status:'template'} | {status:'invalid'; errors} | {status:'ok'; profile}`, `loadProfile(opts?)`, `requireProfile(opts?)`.

- [ ] **Step 1: Create the template** — `config/profile.template.yml`

```yaml
# groceries-ops profile — filled in by /groceries onboarding. Safe to edit by hand.
household:
  adults: 0
  children: []          # e.g. [{ age: 6 }]
  servings: 0           # servings per meal
food:
  diet: omnivore        # omnivore | vegetarian | vegan | pescatarian | other
  exclusions: []        # hard exclusions, enforced by script, e.g. [champignon, porc]
  preferences: ""       # free text, used by Claude when choosing recipes
tools: [oven, hob]      # special appliances: cookeo, thermomix, monsieur_cuisine, companion, airfryer, slow_cooker, pressure_cooker, barbecue, plancha
time:
  weekday_max_min: 30   # max total time (prep + cooking), minutes
  weekend_max_min: 90
product_rules:          # per category; keys: store_brand_ok, organic, preferred_brand, cheapest, max_price_per_kg
  default: { store_brand_ok: true }
store:
  provider: carrefour   # carrefour | list
  mode: drive           # drive | delivery
  store_id: ""
recipes:
  sources: [marmiton]   # ordered; first is primary
plan:
  avoid_repeat_weeks: 3
```

- [ ] **Step 2: Add test helpers** — append to `tests/helpers.ts`

```ts
import { writeFileSync } from 'node:fs';

export const VALID_PROFILE_YAML = `household: { adults: 2, children: [{ age: 6 }], servings: 4 }
food: { diet: omnivore, exclusions: [champignon], preferences: "likes Asian food" }
tools: [oven, hob]
time: { weekday_max_min: 30, weekend_max_min: 90 }
product_rules: { default: { store_brand_ok: true }, fruits_legumes: { organic: true } }
store: { provider: carrefour, mode: drive, store_id: "123" }
recipes: { sources: [marmiton] }
plan: { avoid_repeat_weeks: 3 }
`;

/** Writes VALID_PROFILE_YAML into the current GROCERIES_ROOT. */
export function writeValidProfile(root: string, yaml = VALID_PROFILE_YAML): void {
  writeFileSync(join(root, 'profile.yml'), yaml);
}
```
(Merge the `writeFileSync` import into the existing `node:fs` import line.)

- [ ] **Step 3: Write the failing test** — `tests/profile.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { loadProfile, requireProfile, validateProfile } from '../scripts/lib/profile.ts';
import { paths } from '../scripts/lib/paths.ts';
import { VALID_PROFILE_YAML, useTempRoot, writeValidProfile } from './helpers.ts';

const opts = { sources: ['marmiton'], providers: ['carrefour', 'list'] };

test('valid profile passes', () => {
  const v = validateProfile(YAML.parse(VALID_PROFILE_YAML), opts);
  assert.ok(v.ok);
  if (v.ok) assert.equal(v.profile.household.servings, 4);
});

test('errors name the field', () => {
  const raw = YAML.parse(VALID_PROFILE_YAML);
  raw.household.adults = 0;
  raw.time.weekday_max_min = 'thirty';
  raw.product_rules.default.bio = true;
  raw.store.provider = 'auchan';
  raw.recipes.sources = ['750g'];
  delete raw.plan;
  const v = validateProfile(raw, opts);
  assert.ok(!v.ok);
  if (!v.ok) {
    const joined = v.errors.join('\n');
    for (const field of ['household.adults', 'time.weekday_max_min', 'product_rules.default.bio', 'store.provider', 'recipes.sources', 'plan:'])
      assert.ok(joined.includes(field), `missing error for ${field}:\n${joined}`);
  }
});

test('provider/source checks are skipped when not supplied', () => {
  const raw = YAML.parse(VALID_PROFILE_YAML);
  raw.store.provider = 'whatever';
  assert.ok(validateProfile(raw).ok);
});

test('template is invalid as-is', () => {
  const v = validateProfile(YAML.parse(readFileSync(paths.profileTemplate(), 'utf8')), opts);
  assert.ok(!v.ok);
});

test('loadProfile statuses', () => {
  const root = useTempRoot();
  assert.equal(loadProfile(opts).status, 'missing');
  assert.throws(() => requireProfile(opts), /onboarding/);
  copyFileSync(paths.profileTemplate(), join(root, 'profile.yml'));
  assert.equal(loadProfile(opts).status, 'template');
  writeValidProfile(root, 'household: [');
  assert.equal(loadProfile(opts).status, 'invalid');
  writeValidProfile(root);
  assert.equal(requireProfile(opts).food.exclusions[0], 'champignon');
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `node --test tests/profile.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 5: Implement** — `scripts/lib/profile.ts`

```ts
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
```

Note: `"plan:"` in the test matches the error string `plan: missing section`.

- [ ] **Step 6: Run tests**

Run: `npm run check`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: profile template and validation"
```

---

### Task 6: Recipe filter, recipe store and `recipes.ts` CLI

**Files:**
- Create: `scripts/lib/recipe-filter.ts`, `scripts/lib/recipe-store.ts`, `scripts/recipes.ts`
- Test: `tests/recipes.test.ts`

**Interfaces:**
- Consumes: `Recipe`, `recipeId` (Task 3); `fetchRecipe`, `searchRecipes`, `sourceForUrl`, `getSource`, `sourceIds` (Task 4); `containsPhrase`, `findExclusions` (Task 2); `parseIngredientLine` (Task 2); `Profile`, `requireProfile` (Task 5); `daysBetween`, `today` (Task 1).
- Produces:
  - `SPECIAL_TOOLS: Record<string, string[]>`; `interface FilterCriteria { maxTotalMin; exclusions; tools; recentIds; rejectedIds }`; `effectiveTotalMin(r)`; `filterRecipe(r, c): { keep: boolean; reasons: string[] }`. Reason codes: `rejected`, `recent`, `no-time`, `too-long:<t>><max>`, `excluded:<word>`, `needs-tool:<tool>`.
  - `interface StoredRecipe extends Recipe { id; fetched_at; used_on: string[]; parsed_ingredients: ParsedIngredient[] }`; `saveRecipe(r, fetchedAt)`, `loadRecipe(id)`, `listRecipes()`, `markUsed(id, date)`, `recentIds(weeks, today)`.
  - `runFetch(urls, opts: { maxMin?: number; rejectIds: string[]; today: string }, deps: { profile: Profile; fetcher: Fetcher }): Promise<FetchResult[]>`; `FetchResult = { url; id?; keep; reasons; error?; summary? }`.
  - CLI: `recipes.ts sources | search "<q>" [--source id] [--limit n] | fetch <url>... [--max-min n] [--reject id,id] [--today d] | show <id> | mark-used <id>... [--today d]`.

- [ ] **Step 1: Write the failing test** — `tests/recipes.test.ts`

```ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { effectiveTotalMin, filterRecipe, type FilterCriteria } from '../scripts/lib/recipe-filter.ts';
import { listRecipes, loadRecipe, markUsed, recentIds, saveRecipe } from '../scripts/lib/recipe-store.ts';
import { runFetch } from '../scripts/recipes.ts';
import type { Recipe } from '../scripts/recipe-sources/types.ts';
import type { Profile } from '../scripts/lib/profile.ts';
import { paths } from '../scripts/lib/paths.ts';
import { VALID_PROFILE_YAML, useTempRoot } from './helpers.ts';

const BLANQUETTE = 'https://www.marmiton.org/recettes/recette_blanquette-de-veau-facile_19219.aspx';
const fixtureHtml = readFileSync(join(paths.fixtures('marmiton'), 'recipe-blanquette.html'), 'utf8');
const base: Recipe = { source: 'x', url: 'https://x/a', slug: 'a', name: 'Poulet curry', ingredients: ['400 g de poulet', '2 oignons'], steps: ['Cuire.'], tags: [], totalMin: 25 };
const crit: FilterCriteria = { maxTotalMin: 30, exclusions: [], tools: ['oven'], recentIds: [], rejectedIds: [] };

beforeEach(() => useTempRoot());

test('filter: time, fallback, no-time (review focus 5)', () => {
  assert.deepEqual(filterRecipe(base, crit), { keep: true, reasons: [] });
  assert.deepEqual(filterRecipe({ ...base, totalMin: 45 }, crit).reasons, ['too-long:45>30']);
  const noTotal = { ...base, totalMin: undefined, prepMin: 10, cookMin: 15 };
  assert.equal(effectiveTotalMin(noTotal), 25);
  assert.ok(filterRecipe(noTotal, crit).keep);
  assert.deepEqual(filterRecipe({ ...base, totalMin: undefined }, crit).reasons, ['no-time']);
  assert.equal(effectiveTotalMin({ ...base, totalMin: 0, prepMin: 5 }), 5);
});

test('filter: exclusions, tools, recent, rejected', () => {
  assert.deepEqual(filterRecipe(base, { ...crit, exclusions: ['oignons'] }).reasons, ['excluded:oignons']);
  assert.deepEqual(filterRecipe({ ...base, name: 'Poulet curry au Cookeo' }, crit).reasons, ['needs-tool:cookeo']);
  assert.ok(filterRecipe({ ...base, name: 'Poulet curry au Cookeo' }, { ...crit, tools: ['cookeo'] }).keep);
  assert.deepEqual(filterRecipe(base, { ...crit, recentIds: ['x-a'] }).reasons, ['recent']);
  assert.deepEqual(filterRecipe(base, { ...crit, rejectedIds: ['x-a'] }).reasons, ['rejected']);
});

test('store: save, load, mark used, recent', () => {
  const s = saveRecipe(base, '2026-10-01');
  assert.equal(s.id, 'x-a');
  assert.equal(s.parsed_ingredients[0].key, 'poulet');
  markUsed('x-a', '2026-09-20');
  saveRecipe({ ...base, name: 'Poulet curry v2' }, '2026-10-02'); // re-save keeps history
  const loaded = loadRecipe('x-a');
  assert.equal(loaded.name, 'Poulet curry v2');
  assert.deepEqual(loaded.used_on, ['2026-09-20']);
  assert.deepEqual(recentIds(3, '2026-10-06'), ['x-a']);
  assert.deepEqual(recentIds(2, '2026-10-06'), []);
  assert.equal(listRecipes().length, 1);
  assert.throws(() => loadRecipe('nope'), /Unknown recipe "nope"/);
});

test('runFetch: keeps, saves, rejects, reports errors', async () => {
  const profile = YAML.parse(VALID_PROFILE_YAML) as Profile; // excludes champignon
  const fetcher = async (u: string) => {
    if (u.includes('broken')) throw new Error('HTTP 500');
    return fixtureHtml;
  };
  const day = '2026-10-06';

  const [excluded] = await runFetch([BLANQUETTE], { maxMin: 180, rejectIds: [], today: day }, { profile, fetcher });
  assert.deepEqual(excluded.reasons, ['excluded:champignon']);
  assert.ok(!existsSync(join(paths.recipes(), 'marmiton-blanquette-de-veau-facile-19219.md')));

  const open = { ...profile, food: { ...profile.food, exclusions: [] } };
  const [tooLong] = await runFetch([BLANQUETTE], { rejectIds: [], today: day }, { profile: open, fetcher });
  assert.deepEqual(tooLong.reasons, ['too-long:135>30']);

  const [kept] = await runFetch([BLANQUETTE], { maxMin: 180, rejectIds: [], today: day }, { profile: open, fetcher });
  assert.ok(kept.keep);
  assert.equal(kept.id, 'marmiton-blanquette-de-veau-facile-19219');
  assert.equal(kept.summary?.totalMin, 135);
  assert.ok(existsSync(join(paths.recipes(), 'marmiton-blanquette-de-veau-facile-19219.md')));

  const results = await runFetch(
    ['https://www.marmiton.org/recettes/recette_broken_1.aspx', 'https://unknown.org/r'],
    { rejectIds: [], today: day }, { profile: open, fetcher });
  assert.equal(results[0].error, 'HTTP 500');
  assert.match(results[1].error ?? '', /No recipe source handles/);

  const disabled = { ...open, recipes: { sources: ['other'] } };
  const [off] = await runFetch([BLANQUETTE], { rejectIds: [], today: day }, { profile: disabled, fetcher });
  assert.deepEqual(off.reasons, ['source-disabled:marmiton']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/recipes.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`scripts/lib/recipe-filter.ts`:
```ts
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

  const excluded = new Set(findExclusions([r.name, ...r.ingredients], c.exclusions).map((h) => h.exclusion));
  for (const e of excluded) reasons.push(`excluded:${e}`);

  const text = [r.name, ...r.tags, ...r.steps].join(' . ');
  for (const [tool, words] of Object.entries(SPECIAL_TOOLS)) {
    if (c.tools.includes(tool)) continue;
    if (words.some((w) => containsPhrase(text, w))) reasons.push(`needs-tool:${tool}`);
  }
  return { keep: reasons.length === 0, reasons };
}
```

`scripts/lib/recipe-store.ts`:
```ts
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { paths } from './paths.ts';
import { daysBetween } from './dates.ts';
import { parseIngredientLine, type ParsedIngredient } from './ingredient-line.ts';
import { recipeId, type Recipe } from '../recipe-sources/types.ts';

export interface StoredRecipe extends Recipe {
  id: string;
  fetched_at: string;
  used_on: string[];
  parsed_ingredients: ParsedIngredient[];
}

const recipeFile = (id: string) => join(paths.recipes(), `${id}.md`);

function writeRecipe(r: StoredRecipe): void {
  mkdirSync(paths.recipes(), { recursive: true });
  const body = [`# ${r.name}`, '', `Source: ${r.url}`, '', ...r.steps.map((s, i) => `${i + 1}. ${s}`), ''].join('\n');
  writeFileSync(recipeFile(r.id), `---\n${YAML.stringify(r)}---\n\n${body}`);
}

export function loadRecipe(id: string): StoredRecipe {
  const file = recipeFile(id);
  if (!existsSync(file)) throw new Error(`Unknown recipe "${id}" (no ${file})`);
  const m = /^---\n([\s\S]*?)\n---\n/.exec(readFileSync(file, 'utf8'));
  if (!m) throw new Error(`${file}: missing front matter`);
  return YAML.parse(m[1]) as StoredRecipe;
}

/** Saves a recipe, keeping used_on history if it was saved before. */
export function saveRecipe(recipe: Recipe, fetchedAt: string): StoredRecipe {
  const id = recipeId(recipe);
  const previous = existsSync(recipeFile(id)) ? loadRecipe(id) : undefined;
  const stored: StoredRecipe = {
    ...recipe,
    id,
    fetched_at: fetchedAt,
    used_on: previous?.used_on ?? [],
    parsed_ingredients: recipe.ingredients.map(parseIngredientLine),
  };
  writeRecipe(stored);
  return stored;
}

export function listRecipes(): StoredRecipe[] {
  if (!existsSync(paths.recipes())) return [];
  return readdirSync(paths.recipes())
    .filter((f) => f.endsWith('.md'))
    .map((f) => loadRecipe(f.slice(0, -3)));
}

export function markUsed(id: string, date: string): StoredRecipe {
  const r = loadRecipe(id);
  if (!r.used_on.includes(date)) r.used_on = [...r.used_on, date].sort();
  writeRecipe(r);
  return r;
}

export function recentIds(weeks: number, today: string): string[] {
  return listRecipes()
    .filter((r) => r.used_on.some((d) => {
      const age = daysBetween(d, today);
      return age >= 0 && age < weeks * 7;
    }))
    .map((r) => r.id);
}
```

`scripts/recipes.ts`:
```ts
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
```

- [ ] **Step 4: Run tests**

Run: `npm run check`
Expected: all PASS.

- [ ] **Step 5: Smoke-test the CLI against live Marmiton**

```bash
export GROCERIES_ROOT=$(mktemp -d)
cat > "$GROCERIES_ROOT/profile.yml" <<'EOF'
household: { adults: 2, children: [], servings: 4 }
food: { diet: omnivore, exclusions: [], preferences: "" }
tools: [oven, hob]
time: { weekday_max_min: 30, weekend_max_min: 90 }
product_rules: { default: { store_brand_ok: true } }
store: { provider: carrefour, mode: drive, store_id: "" }
recipes: { sources: [marmiton] }
plan: { avoid_repeat_weeks: 3 }
EOF
node scripts/recipes.ts search "poulet curry" --limit 3
node scripts/recipes.ts fetch https://www.marmiton.org/recettes/recette_filet-de-poulet-au-curry_80990.aspx --max-min 120
unset GROCERIES_ROOT
```
Expected: 3 Marmiton URLs; then one result with `keep: true` or a filter reason (never `error`). If Marmiton blocks the request, note it — the fixtures still cover parsing.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: recipe filter, recipe store and recipes CLI"
```

---

### Task 7: Shopping list (scale, merge, staples, roles) and CLI

**Files:**
- Create: `config/staples.default.yml`, `scripts/lib/shopping-list.ts`, `scripts/shopping-list.ts`
- Test: `tests/shopping-list.test.ts`

**Interfaces:**
- Consumes: `parseIngredientLine` (Task 2), `containsPhrase` (Task 2), `loadRecipe` (Task 6), `requireProfile` (Task 5), `readYaml` (Task 1).
- Produces: `interface RecipeInput { id; servings?; ingredients: string[] }`; `interface ListItem { key; name; unit?; total?; contributions: Record<string, number|null>; lines: string[]; staple: boolean; role: 'key'|'minor' }`; `interface ShoppingList { servings; recipeIds; items; warnings }`; `buildList(recipes, servings, staples): ShoppingList`; `loadStaples(): string[]`. Warnings: `no-yield:<recipeId>`, `unparsed:<line>`.
- CLI: `shopping-list.ts build <out.json> [--servings n] <recipeId>... | drop <list.json> <recipeId> | add <list.json> <recipeId>` — each writes the file and prints the list.

- [ ] **Step 1: Create staples** — `config/staples.default.yml`

```yaml
# Pantry staples (system default). Recipe ingredients matching these are never added
# automatically; the user is asked once at the end of a run whether anything is missing.
staples:
  - sel
  - poivre
  - huile
  - vinaigre
  - farine
  - sucre
  - moutarde
  - curry
  - cumin
  - paprika
  - curcuma
  - cannelle
  - muscade
  - gingembre moulu
  - piment d espelette
  - herbes de provence
  - thym
  - laurier
  - origan
  - bouillon
  - fond de veau
  - levure
  - bicarbonate
  - maizena
  - fecule
  - eau
  - sauce soja
  - miel
```

- [ ] **Step 2: Write the failing test** — `tests/shopping-list.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildList, loadStaples, type RecipeInput } from '../scripts/lib/shopping-list.ts';

const staples = loadStaples();
const curry: RecipeInput = { id: 'm-curry', servings: 4, ingredients: ['3 oignons', '400 g de blanc de poulet', '20 cl de lait de coco', '1 cuillère à soupe de curry', 'sel'] };
const gratin: RecipeInput = { id: 'm-gratin', servings: 4, ingredients: ['2 oignons', '3 courgettes', '20 cl de crème fraîche', '100 g de gruyère râpé'] };
const item = (l: ReturnType<typeof buildList>, key: string, unit?: string) => l.items.find((i) => i.key === key && i.unit === unit);

test('merges across recipes keeping per-recipe contributions', () => {
  const l = buildList([curry, gratin], 4, staples);
  const onion = item(l, 'oignon');
  assert.equal(onion?.total, 5);
  assert.deepEqual(onion?.contributions, { 'm-curry': 3, 'm-gratin': 2 });
  assert.deepEqual(l.recipeIds, ['m-curry', 'm-gratin']);
});

test('dropping a recipe reduces shared items and removes exclusive ones', () => {
  const l = buildList([curry], 4, staples);
  assert.equal(item(l, 'oignon')?.total, 3);
  assert.equal(item(l, 'courgette'), undefined);
});

test('scales to servings', () => {
  const l = buildList([curry], 2, staples);
  assert.equal(item(l, 'blanc de poulet', 'g')?.total, 200);
  assert.equal(item(l, 'oignon')?.total, 1.5);
});

test('staples are flagged and sorted last', () => {
  const l = buildList([curry], 4, staples);
  assert.equal(item(l, 'curry', 'cas')?.staple, true);
  assert.equal(item(l, 'sel')?.staple, true);
  assert.equal(item(l, 'sel')?.total, undefined);
  assert.equal(item(l, 'oignon')?.staple, false);
  const firstStaple = l.items.findIndex((i) => i.staple);
  assert.ok(l.items.slice(firstStaple).every((i) => i.staple));
});

test('units are not merged across different units', () => {
  const l = buildList([{ id: 'a', servings: 2, ingredients: ['1 oignon', "100 g d'oignon"] }], 2, staples);
  assert.equal(l.items.filter((i) => i.key === 'oignon').length, 2);
});

test('missing yield → unscaled with warning (review focus 5); roles', () => {
  const l = buildList([{ id: 'nyield', ingredients: ['2 courgettes', '(facultatif)', '500 g de pâtes'] }], 8, staples);
  assert.equal(item(l, 'courgette')?.total, 2);
  assert.ok(l.warnings.includes('no-yield:nyield'));
  assert.ok(l.warnings.includes('unparsed:(facultatif)'));
  assert.equal(item(l, 'pate', 'g')?.role, 'key');
  assert.equal(item(l, 'courgette')?.role, 'key');
  assert.equal(buildList([curry], 4, staples).items.find((i) => i.key === 'oignon')?.role, 'minor');
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test tests/shopping-list.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

`scripts/lib/shopping-list.ts`:
```ts
import { parseIngredientLine } from './ingredient-line.ts';
import { containsPhrase } from './normalize.ts';
import { paths } from './paths.ts';
import { readYaml } from './yaml-io.ts';

export interface RecipeInput { id: string; servings?: number; ingredients: string[] }
export interface ListItem {
  key: string;
  name: string;
  unit?: string;
  total?: number;
  contributions: Record<string, number | null>;
  lines: string[];
  staple: boolean;
  role: 'key' | 'minor';
}
export interface ShoppingList { servings: number; recipeIds: string[]; items: ListItem[]; warnings: string[] }

/** Default "key ingredient" heuristic (protein, starch, main vegetable); Claude may override per item. */
const KEY_WORDS = [
  'viande', 'poulet', 'dinde', 'boeuf', 'veau', 'porc', 'agneau', 'canard', 'jambon', 'lardon', 'saucisse', 'steak',
  'poisson', 'saumon', 'cabillaud', 'colin', 'thon', 'crevette', 'moule', 'oeuf', 'tofu', 'tempeh',
  'pate', 'spaghetti', 'tagliatelle', 'riz', 'pomme de terre', 'lentille', 'pois chiche', 'haricot', 'quinoa',
  'semoule', 'boulgour', 'gnocchi', 'lasagne', 'pate feuilletee', 'pate brisee',
  'courgette', 'aubergine', 'chou', 'poireau', 'potiron', 'butternut', 'epinard', 'brocoli',
];

const round2 = (x: number) => Math.round(x * 100) / 100;

export function loadStaples(): string[] {
  return readYaml<{ staples: string[] }>(paths.staples(), { staples: [] }).staples;
}

export function buildList(recipes: RecipeInput[], servings: number, staples: string[]): ShoppingList {
  const warnings: string[] = [];
  const byKey = new Map<string, ListItem>();
  for (const r of recipes) {
    const factor = r.servings ? servings / r.servings : 1;
    if (!r.servings) warnings.push(`no-yield:${r.id}`);
    for (const line of r.ingredients) {
      const p = parseIngredientLine(line);
      if (!p.key) {
        warnings.push(`unparsed:${line}`);
        continue;
      }
      const mapKey = `${p.key}|${p.unit ?? ''}`;
      let it = byKey.get(mapKey);
      if (!it) {
        it = { key: p.key, name: p.name, contributions: {}, lines: [], staple: staples.some((s) => containsPhrase(p.key, s)), role: 'minor' };
        if (p.unit) it.unit = p.unit;
        byKey.set(mapKey, it);
      }
      const qty = p.qty === undefined ? null : round2(p.qty * factor);
      const prev = it.contributions[r.id];
      if (prev === undefined) it.contributions[r.id] = qty;
      else if (prev !== null && qty !== null) it.contributions[r.id] = round2(prev + qty);
      else it.contributions[r.id] = prev ?? qty;
      it.lines.push(line);
    }
  }
  const items = [...byKey.values()].map((it) => {
    const nums = Object.values(it.contributions).filter((v): v is number => v !== null);
    if (nums.length) it.total = round2(nums.reduce((a, b) => a + b, 0));
    const big = (it.unit === 'g' || it.unit === 'ml') && (it.total ?? 0) >= 150;
    it.role = !it.staple && (big || KEY_WORDS.some((w) => containsPhrase(it.key, w))) ? 'key' : 'minor';
    return it;
  });
  items.sort((a, b) => Number(a.staple) - Number(b.staple) || a.key.localeCompare(b.key));
  return { servings, recipeIds: recipes.map((r) => r.id), items, warnings };
}
```

`scripts/shopping-list.ts`:
```ts
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { flagNumber, parseArgs } from './lib/args.ts';
import { isMain, printJson, runMain } from './lib/cli.ts';
import { requireProfile } from './lib/profile.ts';
import { loadRecipe } from './lib/recipe-store.ts';
import { buildList, loadStaples, type ShoppingList } from './lib/shopping-list.ts';

const USAGE = `usage:
  shopping-list.ts build <out.json> [--servings n] <recipeId>...
  shopping-list.ts drop <list.json> <recipeId>
  shopping-list.ts add <list.json> <recipeId>`;

function build(ids: string[], servings: number): ShoppingList {
  const recipes = ids.map((id) => {
    const r = loadRecipe(id);
    return { id, servings: r.servings, ingredients: r.ingredients };
  });
  return buildList(recipes, servings, loadStaples());
}

function save(file: string, list: ShoppingList): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(list, null, 2)}\n`);
  printJson(list);
}

async function main(): Promise<void> {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [cmd, file, ...ids] = positional;
  if (!file) throw new Error(USAGE);
  if (cmd === 'build') {
    if (ids.length === 0) throw new Error(USAGE);
    save(file, build(ids, flagNumber(flags, 'servings') ?? requireProfile().household.servings));
    return;
  }
  if (cmd === 'drop' || cmd === 'add') {
    const id = ids[0];
    if (!id) throw new Error(USAGE);
    const list = JSON.parse(readFileSync(file, 'utf8')) as ShoppingList;
    const next = cmd === 'drop' ? list.recipeIds.filter((x) => x !== id) : [...new Set([...list.recipeIds, id])];
    save(file, build(next, list.servings));
    return;
  }
  throw new Error(USAGE);
}

if (isMain(import.meta.url)) runMain(main);
```

- [ ] **Step 5: Run tests**

Run: `npm run check`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: shopping list with per-recipe contributions and staples"
```

---

### Task 8: Habits

**Files:**
- Create: `scripts/lib/habits.ts`, `scripts/habits.ts`
- Test: `tests/habits.test.ts`

**Interfaces:**
- Consumes: `tokens` (Task 2), `daysBetween`, `addDays`, `today` (Task 1), `readYaml`/`writeYaml`, `paths.habits`.
- Produces:
  ```ts
  interface Purchase { date: string; status: 'confirmed' | 'pending' }
  interface Habit { key; name; ean?; purchases: Purchase[]; interval_days?; interval_override?; mode: 'auto'|'ask'; last_asked?; declines_in_row: number }
  interface HabitsFile { habits: Habit[] }
  interface ItemRef { name: string; ean?: string }
  interface Order { date: string; items: ItemRef[] }
  habitKey(item), findHabit(file, item), medianInterval(dates), effectiveInterval(h), lastPurchase(h), nextDue(h),
  recompute(h), isDue(h, today), proposeMode(h, today), dueItems(file, today): { auto: Habit[]; ask: Habit[] },
  recordPurchases(file, items, date, status), recordAnswer(file, key, 'yes'|'no', today),
  reconcile(file, orders, today): { confirmed; dropped; added }, proposals(file, today), loadHabits(), saveHabits(file)
  ```
- CLI: `habits.ts list | due | record <items.json|-> [--confirmed] | answer <key> yes|no | reconcile <orders.json|-> | propose | set-mode <key> auto|ask | set-interval <key> <days> | remove <key>`, all accept `--today`.

- [ ] **Step 1: Write the failing test** — `tests/habits.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dueItems, habitKey, isDue, medianInterval, nextDue, proposals, proposeMode, reconcile, recordAnswer, recordPurchases,
  type Habit, type HabitsFile,
} from '../scripts/lib/habits.ts';

const habit = (name: string, dates: string[], extra: Partial<Habit> = {}): Habit => ({
  key: habitKey({ name }), name, mode: 'ask', declines_in_row: 0,
  purchases: dates.map((date) => ({ date, status: 'confirmed' as const })), ...extra,
});
const file = (...habits: Habit[]): HabitsFile => {
  const f = { habits };
  reconcile(f, [], '2000-01-01'); // recompute intervals only
  return f;
};

test('medianInterval', () => {
  assert.equal(medianInterval(['2026-09-01', '2026-09-08', '2026-09-15']), 7);
  assert.equal(medianInterval(['2026-09-15', '2026-09-01', '2026-09-08', '2026-09-08']), 7);
  assert.equal(medianInterval(['2026-09-01', '2026-09-05', '2026-09-15', '2026-09-30']), 10);
  assert.equal(medianInterval(['2026-09-01', '2026-09-05', '2026-09-15']), 7);
  assert.equal(medianInterval(['2026-09-01']), undefined);
});

test('weekly bananas: due and proposed auto', () => {
  const f = file(habit('bananes', ['2026-09-08', '2026-09-15', '2026-09-22', '2026-09-29']));
  const h = f.habits[0];
  assert.equal(h.interval_days, 7);
  assert.ok(isDue(h, '2026-10-06'));
  assert.equal(proposeMode(h, '2026-10-06'), 'auto');
  assert.equal(nextDue(h), '2026-10-05');
});

test('toilet paper every 21 days: due threshold, proposed ask', () => {
  const f = file(habit('papier toilette', ['2026-08-01', '2026-08-22', '2026-09-12']));
  const h = f.habits[0];
  assert.ok(!isDue(h, '2026-09-28')); // 16 days < 0.85 × 21
  assert.ok(isDue(h, '2026-10-01'));  // 19 days
  assert.equal(proposeMode(h, '2026-10-01'), 'ask');
});

test('single or only-pending purchases: never due, never auto (review focus 4)', () => {
  const f = file(habit('cafe', ['2026-09-01']), habit('the', [], { purchases: [{ date: '2026-09-01', status: 'pending' }] }));
  for (const h of f.habits) {
    assert.equal(h.interval_days, undefined);
    assert.ok(!isDue(h, '2026-12-01'));
    assert.equal(proposeMode(h, '2026-12-01'), 'ask');
  }
  assert.deepEqual(proposals(f, '2026-12-01'), []);
});

test('declines: snooze same day, widen after 3', () => {
  const f = file(habit('cereales', ['2026-08-01', '2026-08-22', '2026-09-12']));
  recordAnswer(f, f.habits[0].key, 'no', '2026-10-01');
  assert.ok(!isDue(f.habits[0], '2026-10-01'));
  assert.ok(isDue(f.habits[0], '2026-10-02'));
  recordAnswer(f, f.habits[0].key, 'no', '2026-10-02');
  recordAnswer(f, f.habits[0].key, 'no', '2026-10-03');
  assert.equal(f.habits[0].interval_override, 32);
  assert.equal(f.habits[0].declines_in_row, 0);
  recordAnswer(f, f.habits[0].key, 'yes', '2026-10-04');
  assert.equal(f.habits[0].declines_in_row, 0);
  assert.throws(() => recordAnswer(f, 'name:nope', 'yes', '2026-10-04'), /Unknown habit/);
});

test('dueItems splits by mode', () => {
  const f = file(
    habit('bananes', ['2026-09-22', '2026-09-29'], { mode: 'auto' }),
    habit('papier toilette', ['2026-08-22', '2026-09-12']),
  );
  const d = dueItems(f, '2026-10-06');
  assert.deepEqual(d.auto.map((h) => h.name), ['bananes']);
  assert.deepEqual(d.ask.map((h) => h.name), ['papier toilette']);
});

test('record + reconcile: confirm, drop stale pending, add external', () => {
  const f: HabitsFile = { habits: [] };
  recordPurchases(f, [{ name: 'Bananes', ean: '111' }, { name: 'Lait' }], '2026-10-06', 'pending');
  recordPurchases(f, [{ name: 'Bananes', ean: '111' }], '2026-10-06', 'pending'); // idempotent
  recordPurchases(f, [{ name: 'Yaourts' }], '2026-09-20', 'pending');
  assert.equal(f.habits.find((h) => h.name === 'Bananes')?.purchases.length, 1);
  const res = reconcile(f, [{ date: '2026-10-07', items: [{ name: 'Bananes', ean: '111' }, { name: 'Lait' }, { name: 'Café', ean: '222' }] }], '2026-10-08');
  assert.deepEqual(res, { confirmed: 2, dropped: 1, added: 1 });
  const bananas = f.habits.find((h) => h.ean === '111');
  assert.deepEqual(bananas?.purchases, [{ date: '2026-10-07', status: 'confirmed' }]);
  assert.deepEqual(f.habits.find((h) => h.name === 'Yaourts')?.purchases, []);
  assert.equal(f.habits.find((h) => h.ean === '222')?.mode, 'ask');
});

test('name matching ignores case, accents and plurals', () => {
  const f: HabitsFile = { habits: [] };
  recordPurchases(f, [{ name: 'Céréales' }], '2026-09-01', 'confirmed');
  recordPurchases(f, [{ name: 'cereale' }], '2026-09-15', 'confirmed');
  assert.equal(f.habits.length, 1);
  assert.equal(f.habits[0].purchases.length, 2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/habits.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`scripts/lib/habits.ts`:
```ts
import { addDays, daysBetween } from './dates.ts';
import { tokens } from './normalize.ts';
import { paths } from './paths.ts';
import { readYaml, writeYaml } from './yaml-io.ts';

export type PurchaseStatus = 'confirmed' | 'pending';
export interface Purchase { date: string; status: PurchaseStatus }
export interface Habit {
  key: string;
  name: string;
  ean?: string;
  purchases: Purchase[];
  interval_days?: number;
  interval_override?: number;
  mode: 'auto' | 'ask';
  last_asked?: string;
  declines_in_row: number;
}
export interface HabitsFile { habits: Habit[] }
export interface ItemRef { name: string; ean?: string }
export interface Order { date: string; items: ItemRef[] }

const DUE_RATIO = 0.85;
const PENDING_TTL_DAYS = 10;
const PENDING_MATCH_DAYS = 7;
const WIDEN_AFTER_DECLINES = 3;
const nameKey = (name: string) => `name:${tokens(name).join(' ')}`;

export const loadHabits = (): HabitsFile => readYaml<HabitsFile>(paths.habits(), { habits: [] });
export const saveHabits = (f: HabitsFile): void => writeYaml(paths.habits(), f);

export function habitKey(item: ItemRef): string {
  return item.ean ? `ean:${item.ean}` : nameKey(item.name);
}

export function findHabit(f: HabitsFile, item: ItemRef): Habit | undefined {
  const key = habitKey(item);
  return (
    f.habits.find((h) => h.key === key) ??
    (item.ean ? f.habits.find((h) => h.ean === item.ean) : undefined) ??
    f.habits.find((h) => nameKey(h.name) === nameKey(item.name))
  );
}

function getOrCreate(f: HabitsFile, item: ItemRef): { habit: Habit; created: boolean } {
  const found = findHabit(f, item);
  if (found) {
    if (item.ean && !found.ean) found.ean = item.ean;
    return { habit: found, created: false };
  }
  const habit: Habit = { key: habitKey(item), name: item.name, purchases: [], mode: 'ask', declines_in_row: 0 };
  if (item.ean) habit.ean = item.ean;
  f.habits.push(habit);
  return { habit, created: true };
}

export function medianInterval(dates: string[]): number | undefined {
  const sorted = [...new Set(dates)].sort();
  if (sorted.length < 2) return undefined;
  const gaps = sorted.slice(1).map((d, i) => daysBetween(sorted[i], d)).sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  return gaps.length % 2 ? gaps[mid] : Math.round((gaps[mid - 1] + gaps[mid]) / 2);
}

export const effectiveInterval = (h: Habit): number | undefined => h.interval_override ?? h.interval_days;

export function lastPurchase(h: Habit): string | undefined {
  return h.purchases.map((p) => p.date).sort().pop();
}

export function nextDue(h: Habit): string | undefined {
  const eff = effectiveInterval(h);
  const last = lastPurchase(h);
  return eff && last ? addDays(last, Math.ceil(DUE_RATIO * eff)) : undefined;
}

export function recompute(h: Habit): void {
  h.purchases.sort((a, b) => a.date.localeCompare(b.date));
  const interval = medianInterval(h.purchases.filter((p) => p.status === 'confirmed').map((p) => p.date));
  if (interval === undefined) delete h.interval_days;
  else h.interval_days = interval;
}

export function isDue(h: Habit, today: string): boolean {
  const eff = effectiveInterval(h);
  const last = lastPurchase(h);
  if (!eff || !last || h.last_asked === today) return false;
  return daysBetween(last, today) >= DUE_RATIO * eff;
}

/** auto only for ~weekly items bought in at least 3 of the last 4 weeks. */
export function proposeMode(h: Habit, today: string): 'auto' | 'ask' {
  const eff = effectiveInterval(h);
  if (!eff || eff < 5 || eff > 9) return 'ask';
  const confirmed = h.purchases.filter((p) => p.status === 'confirmed').map((p) => daysBetween(p.date, today));
  let weeks = 0;
  for (let w = 0; w < 4; w++) if (confirmed.some((age) => age >= 7 * w && age < 7 * (w + 1))) weeks++;
  return weeks >= 3 ? 'auto' : 'ask';
}

export function dueItems(f: HabitsFile, today: string): { auto: Habit[]; ask: Habit[] } {
  const due = f.habits.filter((h) => isDue(h, today));
  return { auto: due.filter((h) => h.mode === 'auto'), ask: due.filter((h) => h.mode === 'ask') };
}

export function recordPurchases(f: HabitsFile, items: ItemRef[], date: string, status: PurchaseStatus): void {
  for (const item of items) {
    const { habit } = getOrCreate(f, item);
    if (!habit.purchases.some((p) => p.date === date)) habit.purchases.push({ date, status });
    recompute(habit);
  }
}

export function recordAnswer(f: HabitsFile, key: string, answer: 'yes' | 'no', today: string): Habit {
  const h = f.habits.find((x) => x.key === key);
  if (!h) throw new Error(`Unknown habit "${key}"`);
  h.last_asked = today;
  if (answer === 'yes') {
    h.declines_in_row = 0;
    return h;
  }
  h.declines_in_row += 1;
  const eff = effectiveInterval(h);
  if (h.declines_in_row >= WIDEN_AFTER_DECLINES && eff) {
    h.interval_override = Math.round(eff * 1.5);
    h.declines_in_row = 0;
  }
  return h;
}

/** Folds real store orders in: confirms matching pending purchases, drops stale ones, learns external purchases. */
export function reconcile(f: HabitsFile, orders: Order[], today: string): { confirmed: number; dropped: number; added: number } {
  let confirmed = 0;
  let dropped = 0;
  let added = 0;
  for (const order of [...orders].sort((a, b) => a.date.localeCompare(b.date))) {
    for (const item of order.items) {
      const { habit, created } = getOrCreate(f, item);
      if (created) added++;
      if (habit.purchases.some((p) => p.status === 'confirmed' && p.date === order.date)) continue;
      const pending = habit.purchases.findIndex((p) => {
        const age = daysBetween(p.date, order.date);
        return p.status === 'pending' && age >= 0 && age <= PENDING_MATCH_DAYS;
      });
      if (pending >= 0) {
        habit.purchases.splice(pending, 1);
        confirmed++;
      }
      habit.purchases.push({ date: order.date, status: 'confirmed' });
    }
  }
  for (const h of f.habits) {
    const before = h.purchases.length;
    h.purchases = h.purchases.filter((p) => p.status === 'confirmed' || daysBetween(p.date, today) <= PENDING_TTL_DAYS);
    dropped += before - h.purchases.length;
    recompute(h);
  }
  return { confirmed, dropped, added };
}

export function proposals(f: HabitsFile, today: string) {
  return f.habits
    .filter((h) => effectiveInterval(h) !== undefined)
    .map((h) => ({ key: h.key, name: h.name, interval_days: effectiveInterval(h), mode: h.mode, proposed_mode: proposeMode(h, today) }))
    .sort((a, b) => (a.interval_days ?? 0) - (b.interval_days ?? 0));
}
```

`scripts/habits.ts`:
```ts
import { flagString, parseArgs } from './lib/args.ts';
import { isMain, printJson, readJsonInput, runMain } from './lib/cli.ts';
import { today } from './lib/dates.ts';
import {
  dueItems, effectiveInterval, isDue, lastPurchase, loadHabits, nextDue, proposals, reconcile, recordAnswer,
  recordPurchases, saveHabits, type Habit, type HabitsFile, type ItemRef, type Order,
} from './lib/habits.ts';

const USAGE = `usage (all accept --today YYYY-MM-DD):
  habits.ts list | due | propose
  habits.ts record <items.json|-> [--confirmed]     items: [{ "name": "...", "ean": "..." }]
  habits.ts answer <key> yes|no
  habits.ts reconcile <orders.json|->              orders: [{ "date": "YYYY-MM-DD", "items": [...] }]
  habits.ts set-mode <key> auto|ask
  habits.ts set-interval <key> <days>
  habits.ts remove <key>`;

function find(f: HabitsFile, key: string): Habit {
  const h = f.habits.find((x) => x.key === key);
  if (!h) throw new Error(`Unknown habit "${key}"`);
  return h;
}

const view = (h: Habit, day: string) => ({
  key: h.key, name: h.name, ean: h.ean, mode: h.mode, interval_days: effectiveInterval(h),
  last_bought: lastPurchase(h), next_due: nextDue(h), due: isDue(h, day),
});

async function main(): Promise<void> {
  const { positional, flags } = parseArgs(process.argv.slice(2), ['confirmed']);
  const [cmd, a, b] = positional;
  const day = flagString(flags, 'today') ?? today();
  const f = loadHabits();
  switch (cmd) {
    case 'list':
      printJson(f.habits.map((h) => view(h, day)));
      return;
    case 'due': {
      const d = dueItems(f, day);
      printJson({ auto: d.auto.map((h) => view(h, day)), ask: d.ask.map((h) => view(h, day)) });
      return;
    }
    case 'propose':
      printJson(proposals(f, day));
      return;
    case 'record': {
      const items = (await readJsonInput(a)) as ItemRef[];
      recordPurchases(f, items, day, flags['confirmed'] ? 'confirmed' : 'pending');
      saveHabits(f);
      printJson({ recorded: items.length });
      return;
    }
    case 'answer':
      if (!a || (b !== 'yes' && b !== 'no')) throw new Error(USAGE);
      printJson(view(recordAnswer(f, a, b, day), day));
      saveHabits(f);
      return;
    case 'reconcile': {
      const res = reconcile(f, (await readJsonInput(a)) as Order[], day);
      saveHabits(f);
      printJson(res);
      return;
    }
    case 'set-mode':
      if (!a || (b !== 'auto' && b !== 'ask')) throw new Error(USAGE);
      find(f, a).mode = b;
      saveHabits(f);
      printJson(view(find(f, a), day));
      return;
    case 'set-interval': {
      const days = Number(b);
      if (!a || !Number.isInteger(days) || days < 1) throw new Error(USAGE);
      find(f, a).interval_override = days;
      saveHabits(f);
      printJson(view(find(f, a), day));
      return;
    }
    case 'remove':
      if (!a) throw new Error(USAGE);
      find(f, a);
      f.habits = f.habits.filter((h) => h.key !== a);
      saveHabits(f);
      printJson({ removed: a });
      return;
    default:
      throw new Error(USAGE);
  }
}

if (isMain(import.meta.url)) runMain(main);
```

- [ ] **Step 4: Run tests**

Run: `npm run check`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: purchase habits with intervals, due list and order reconciliation"
```

---

### Task 9: Product choices (user corrections)

**Files:**
- Create: `scripts/lib/choices.ts`, `scripts/choices.ts`
- Test: `tests/choices.test.ts`

**Interfaces:**
- Consumes: `parseIngredientLine`, `tokens` (Task 2), `readYaml`/`writeYaml`, `paths.choices`.
- Produces: `interface Choice { ean; label; updated }`, `interface ChoicesFile { choices: Record<string, Choice> }`, `choiceKey(ingredient)`, `getChoice(f, ingredient)`, `setChoice(f, ingredient, ean, label, today)`, `removeChoice(f, ingredient): boolean`, `loadChoices()`, `saveChoices(f)`.
- CLI: `choices.ts get "<ingredient>" | set "<ingredient>" <ean> "<label>" [--today] | remove "<ingredient>" | list`.

- [ ] **Step 1: Write the failing test** — `tests/choices.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { choiceKey, getChoice, removeChoice, setChoice, type ChoicesFile } from '../scripts/lib/choices.ts';

test('keys come from the ingredient name, not quantity or accents', () => {
  assert.equal(choiceKey('20 cl de crème fraîche'), 'creme fraiche');
  assert.equal(choiceKey('Crème fraîche'), 'creme fraiche');
  assert.equal(choiceKey('3 oignons'), 'oignon');
});

test('set, get, remove', () => {
  const f: ChoicesFile = { choices: {} };
  setChoice(f, 'crème fraîche', '3560070', 'Crème fraîche épaisse 30% Carrefour', '2026-10-06');
  assert.equal(getChoice(f, '20 cl de crème fraîche')?.ean, '3560070');
  assert.equal(getChoice(f, 'beurre'), undefined);
  assert.ok(removeChoice(f, 'Crème fraîche'));
  assert.ok(!removeChoice(f, 'Crème fraîche'));
  assert.throws(() => setChoice(f, '   ', '1', 'x', '2026-10-06'), /empty ingredient/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/choices.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`scripts/lib/choices.ts`:
```ts
import { parseIngredientLine } from './ingredient-line.ts';
import { tokens } from './normalize.ts';
import { paths } from './paths.ts';
import { readYaml, writeYaml } from './yaml-io.ts';

export interface Choice { ean: string; label: string; updated: string }
export interface ChoicesFile { choices: Record<string, Choice> }

export const loadChoices = (): ChoicesFile => readYaml<ChoicesFile>(paths.choices(), { choices: {} });
export const saveChoices = (f: ChoicesFile): void => writeYaml(paths.choices(), f);

/** "20 cl de crème fraîche" and "Crème fraîche" share the key "creme fraiche". */
export function choiceKey(ingredient: string): string {
  const name = parseIngredientLine(ingredient).name || ingredient;
  return tokens(name).join(' ');
}

export function getChoice(f: ChoicesFile, ingredient: string): Choice | undefined {
  return f.choices[choiceKey(ingredient)];
}

export function setChoice(f: ChoicesFile, ingredient: string, ean: string, label: string, today: string): Choice {
  const key = choiceKey(ingredient);
  if (!key) throw new Error('empty ingredient');
  const choice = { ean, label, updated: today };
  f.choices[key] = choice;
  return choice;
}

export function removeChoice(f: ChoicesFile, ingredient: string): boolean {
  const key = choiceKey(ingredient);
  if (!(key in f.choices)) return false;
  delete f.choices[key];
  return true;
}
```

`scripts/choices.ts`:
```ts
import { flagString, parseArgs } from './lib/args.ts';
import { isMain, printJson, runMain } from './lib/cli.ts';
import { today } from './lib/dates.ts';
import { getChoice, loadChoices, removeChoice, saveChoices, setChoice } from './lib/choices.ts';

const USAGE = `usage:
  choices.ts get "<ingredient>"
  choices.ts set "<ingredient>" <ean> "<label>" [--today YYYY-MM-DD]
  choices.ts remove "<ingredient>"
  choices.ts list`;

async function main(): Promise<void> {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [cmd, ingredient, ean, label] = positional;
  const f = loadChoices();
  switch (cmd) {
    case 'list':
      printJson(f.choices);
      return;
    case 'get':
      if (!ingredient) throw new Error(USAGE);
      printJson(getChoice(f, ingredient) ?? null);
      return;
    case 'set':
      if (!ingredient || !ean || !label) throw new Error(USAGE);
      printJson(setChoice(f, ingredient, ean, label, flagString(flags, 'today') ?? today()));
      saveChoices(f);
      return;
    case 'remove':
      if (!ingredient) throw new Error(USAGE);
      printJson({ removed: removeChoice(f, ingredient) });
      saveChoices(f);
      return;
    default:
      throw new Error(USAGE);
  }
}

if (isMain(import.meta.url)) runMain(main);
```

- [ ] **Step 4: Run tests**

Run: `npm run check`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: remembered product choices"
```

---

### Task 10: Grocery providers, deny list, session classification, MCP probe

**Files:**
- Create: `providers/carrefour.yml`, `providers/list.yml`, `.claude/settings.json`, `scripts/lib/provider.ts`, `scripts/lib/mcp-probe.ts`
- Test: `tests/provider.test.ts`

**Interfaces:**
- Consumes: `paths` (Task 1).
- Produces:
  ```ts
  const CAPABILITY_NAMES = ['session_check','login','search','add_to_cart','set_quantity','read_cart','order_history','frequent'] as const
  interface SessionCheck { tool: string; args: Record<string, unknown>; ok_pattern: string; expired_pattern: string }
  interface McpProvider { id; label; kind: 'mcp'; mcp_server; install; spawn: { command; args: string[] }; notes?: string;
    capabilities: { session_check: SessionCheck; login; search; add_to_cart; set_quantity; read_cart; order_history: string[]; frequent?: string }; forbidden: string[] }
  interface ListProvider { id; label; kind: 'list' }
  type Provider = McpProvider | ListProvider
  listProviderIds(), validateProvider(raw, id), loadProvider(id), mcpToolName(p, tool), missingDenies(p, settings), classifySession(result, check)
  interface ProbeResult { isError: boolean; text: string }; probeSession(p, timeoutMs?): Promise<ProbeResult>
  ```

- [ ] **Step 1: Create provider files and deny list**

`providers/carrefour.yml`:
```yaml
id: carrefour
label: Carrefour Drive
kind: mcp
mcp_server: carrefour-drive
install: "claude mcp add carrefour-drive -- npx -y github:maximeallanic/CarrefourDriveMCP"
spawn:
  command: npx
  args: ["-y", "github:maximeallanic/CarrefourDriveMCP"]
notes: >-
  Products are identified by EAN. add_item_to_cart_by_ean and add_item_to_cart need the
  basket service from get_cart (basketServiceId, subBasketType e.g. drive_clcv) — read the
  cart first and reuse its values.
capabilities:
  session_check:
    tool: carrefour_session_status
    args: { verify: true }
    ok_pattern: "Verification: HTTP 2\\d\\d"
    expired_pattern: "Verification: FAILED|No Carrefour session"
  login: carrefour_browser_login
  search: search_products
  add_to_cart: add_item_to_cart_by_ean
  set_quantity: add_item_to_cart
  read_cart: get_cart
  order_history: [get_last_orders, get_loyalty_order_receipts]
  frequent: get_frequent_purchases
forbidden:
  - submit_checkout_payment
  - validate_checkout_summary
  - validate_checkout_slot
  - select_cart_delivery_slot
  - apply_promo_code_to_cart
```

`providers/list.yml`:
```yaml
id: list
label: Shopping list only (no store connection)
kind: list
```

`.claude/settings.json`:
```json
{
  "permissions": {
    "deny": [
      "mcp__carrefour-drive__submit_checkout_payment",
      "mcp__carrefour-drive__validate_checkout_summary",
      "mcp__carrefour-drive__validate_checkout_slot",
      "mcp__carrefour-drive__select_cart_delivery_slot",
      "mcp__carrefour-drive__apply_promo_code_to_cart"
    ]
  }
}
```

- [ ] **Step 2: Write the failing test** — `tests/provider.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import {
  classifySession, listProviderIds, loadProvider, mcpToolName, missingDenies, validateProvider, type McpProvider,
} from '../scripts/lib/provider.ts';
import { paths } from '../scripts/lib/paths.ts';

const carrefour = loadProvider('carrefour') as McpProvider;

test('shipped providers load', () => {
  assert.deepEqual(listProviderIds().sort(), ['carrefour', 'list']);
  assert.equal(carrefour.kind, 'mcp');
  assert.equal(loadProvider('list').kind, 'list');
  assert.throws(() => loadProvider('auchan'), /Unknown provider "auchan"/);
});

test('repo settings deny every forbidden tool (guard)', () => {
  const settings = JSON.parse(readFileSync(paths.settings(), 'utf8'));
  assert.deepEqual(missingDenies(carrefour, settings), []);
});

test('missingDenies reports gaps', () => {
  assert.equal(mcpToolName(carrefour, 'get_cart'), 'mcp__carrefour-drive__get_cart');
  assert.deepEqual(missingDenies(carrefour, {}), carrefour.forbidden.map((t) => mcpToolName(carrefour, t)));
  const partial = { permissions: { deny: [mcpToolName(carrefour, 'submit_checkout_payment')] } };
  assert.equal(missingDenies(carrefour, partial).length, carrefour.forbidden.length - 1);
});

test('classifySession on the server\'s real output shapes', () => {
  const c = carrefour.capabilities.session_check;
  assert.equal(classifySession({ isError: false, text: 'Session present: 4 cookie(s)\nVerification: HTTP 200' }, c), 'ok');
  assert.equal(classifySession({ isError: false, text: 'Session present\nVerification: FAILED (HTTP 401) — the session looks expired.' }, c), 'expired');
  assert.equal(classifySession({ isError: true, text: 'No Carrefour session available.' }, c), 'expired');
  assert.equal(classifySession({ isError: false, text: 'Verification: could not reach carrefour.fr (timeout)' }, c), 'unknown');
});

test('validation rejects a forbidden tool used as a capability, and bad regexes', () => {
  const raw = YAML.parse(readFileSync(paths.provider('carrefour'), 'utf8'));
  raw.capabilities.add_to_cart = 'submit_checkout_payment';
  raw.capabilities.session_check.ok_pattern = '(';
  delete raw.capabilities.read_cart;
  const v = validateProvider(raw, 'carrefour');
  assert.ok(!v.ok);
  if (!v.ok) {
    const all = v.errors.join('\n');
    assert.match(all, /capabilities\.add_to_cart: "submit_checkout_payment" is forbidden/);
    assert.match(all, /ok_pattern: invalid regex/);
    assert.match(all, /capabilities\.read_cart: must be a tool name/);
  }
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test tests/provider.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

`scripts/lib/provider.ts`:
```ts
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import YAML from 'yaml';
import { paths } from './paths.ts';

export const CAPABILITY_NAMES = [
  'session_check', 'login', 'search', 'add_to_cart', 'set_quantity', 'read_cart', 'order_history', 'frequent',
] as const;

export interface SessionCheck { tool: string; args: Record<string, unknown>; ok_pattern: string; expired_pattern: string }
export interface McpProvider {
  id: string;
  label: string;
  kind: 'mcp';
  mcp_server: string;
  install: string;
  spawn: { command: string; args: string[] };
  notes?: string;
  capabilities: {
    session_check: SessionCheck;
    login: string;
    search: string;
    add_to_cart: string;
    set_quantity: string;
    read_cart: string;
    order_history: string[];
    frequent?: string;
  };
  forbidden: string[];
}
export interface ListProvider { id: string; label: string; kind: 'list' }
export type Provider = McpProvider | ListProvider;
export type SessionState = 'ok' | 'expired' | 'unknown';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

export function listProviderIds(): string[] {
  if (!existsSync(paths.providersDir())) return [];
  return readdirSync(paths.providersDir()).filter((f) => f.endsWith('.yml')).map((f) => f.slice(0, -4));
}

export function validateProvider(raw: unknown, id: string): { ok: true; provider: Provider } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const err = (path: string, msg: string) => errors.push(`${path}: ${msg}`);
  if (!isObj(raw)) return { ok: false, errors: [`${id}: must be a YAML mapping`] };
  if (raw.id !== id) err('id', `must equal the file name "${id}"`);
  if (!isStr(raw.label)) err('label', 'must be a string');
  if (raw.kind === 'list') return errors.length ? { ok: false, errors } : { ok: true, provider: raw as unknown as ListProvider };
  if (raw.kind !== 'mcp') return { ok: false, errors: [...errors, 'kind: must be "mcp" or "list"'] };

  for (const k of ['mcp_server', 'install'] as const) if (!isStr(raw[k])) err(k, 'must be a string');
  const spawn = isObj(raw.spawn) ? raw.spawn : {};
  if (!isStr(spawn.command)) err('spawn.command', 'must be a string');
  if (!Array.isArray(spawn.args) || !spawn.args.every((a) => typeof a === 'string')) err('spawn.args', 'must be a list of strings');
  const forbidden = Array.isArray(raw.forbidden) && raw.forbidden.every(isStr) ? (raw.forbidden as string[]) : [];
  if (!Array.isArray(raw.forbidden)) err('forbidden', 'must be a list of tool names');

  const caps = isObj(raw.capabilities) ? raw.capabilities : {};
  const tool = (path: string, v: unknown, optional = false) => {
    if (v === undefined && optional) return;
    if (!isStr(v)) err(path, 'must be a tool name');
    else if (forbidden.includes(v)) err(path, `"${v}" is forbidden`);
  };
  for (const k of ['login', 'search', 'add_to_cart', 'set_quantity', 'read_cart'] as const) tool(`capabilities.${k}`, caps[k]);
  tool('capabilities.frequent', caps.frequent, true);
  if (!Array.isArray(caps.order_history) || caps.order_history.length === 0) err('capabilities.order_history', 'must be a non-empty list');
  else caps.order_history.forEach((t, i) => tool(`capabilities.order_history[${i}]`, t));

  const sc = isObj(caps.session_check) ? caps.session_check : {};
  tool('capabilities.session_check.tool', sc.tool);
  if (sc.args !== undefined && !isObj(sc.args)) err('capabilities.session_check.args', 'must be a mapping');
  for (const k of ['ok_pattern', 'expired_pattern'] as const) {
    const p = sc[k];
    if (!isStr(p)) err(`capabilities.session_check.${k}`, 'must be a regex string');
    else {
      try {
        new RegExp(p);
      } catch {
        err(`capabilities.session_check.${k}`, 'invalid regex');
      }
    }
  }
  if (errors.length) return { ok: false, errors };
  const provider = raw as unknown as McpProvider;
  provider.capabilities.session_check.args ??= {};
  return { ok: true, provider };
}

export function loadProvider(id: string): Provider {
  const file = paths.provider(id);
  if (!existsSync(file)) throw new Error(`Unknown provider "${id}" (known: ${listProviderIds().join(', ')})`);
  const v = validateProvider(YAML.parse(readFileSync(file, 'utf8')), id);
  if (!v.ok) throw new Error(`providers/${id}.yml is invalid: ${v.errors.join('; ')}`);
  return v.provider;
}

export function mcpToolName(p: McpProvider, tool: string): string {
  return `mcp__${p.mcp_server}__${tool}`;
}

export function missingDenies(p: McpProvider, settings: unknown): string[] {
  const perms = isObj(settings) && isObj(settings.permissions) ? settings.permissions : {};
  const deny = Array.isArray(perms.deny) ? perms.deny : [];
  return p.forbidden.map((t) => mcpToolName(p, t)).filter((name) => !deny.includes(name));
}

export function classifySession(result: { isError?: boolean; text: string }, check: SessionCheck): SessionState {
  if (result.isError) return 'expired';
  if (new RegExp(check.expired_pattern).test(result.text)) return 'expired';
  if (new RegExp(check.ok_pattern).test(result.text)) return 'ok';
  return 'unknown';
}
```

`scripts/lib/mcp-probe.ts`:
```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { McpProvider } from './provider.ts';

export interface ProbeResult { isError: boolean; text: string }

/** Starts the provider's MCP server on stdio and calls its session-check tool. */
export async function probeSession(p: McpProvider, timeoutMs = 60_000): Promise<ProbeResult> {
  const check = p.capabilities.session_check;
  const transport = new StdioClientTransport({ command: p.spawn.command, args: p.spawn.args, stderr: 'ignore' });
  const client = new Client({ name: 'groceries-ops-doctor', version: '0.1.0' });
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs / 1000}s`)), timeoutMs);
  });
  const call = (async (): Promise<ProbeResult> => {
    await client.connect(transport);
    const res = (await client.callTool({ name: check.tool, arguments: check.args }, undefined, { timeout: timeoutMs })) as {
      content?: unknown;
      isError?: unknown;
    };
    const content = Array.isArray(res.content) ? res.content : [];
    const text = content
      .map((c) => (c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string' ? (c as { text: string }).text : ''))
      .join('\n');
    return { isError: res.isError === true, text };
  })();
  try {
    return await Promise.race([call, timeout]);
  } finally {
    clearTimeout(timer);
    await client.close().catch(() => {});
  }
}
```

- [ ] **Step 5: Run tests**

Run: `npm run check`
Expected: all PASS (typecheck confirms the SDK import paths).

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: grocery provider layer, checkout deny list, MCP session probe"
```

---

### Task 11: Doctor

**Files:**
- Create: `scripts/doctor.ts`
- Test: `tests/doctor.test.ts`

**Interfaces:**
- Consumes: `paths`, `loadProfile` (Task 5), `sourceIds`, `getSource` (Task 4), `listProviderIds`, `loadProvider`, `missingDenies`, `classifySession`, `McpProvider` (Task 10), `probeSession`, `ProbeResult` (Task 10), `fetchHtml`, `Fetcher` (Task 4).
- Produces: `type Status = 'pass'|'fail'|'warn'|'unknown'`; `interface Check { id; status; message; fix?; blocking }`; `interface DoctorReport { onboardingNeeded; planEnabled; blocking; checks }`; `interface DoctorDeps { nodeVersion; listMcpServers(): Promise<string>; fetcher: Fetcher; probe(p): Promise<ProbeResult>; readSettings(): unknown; readFixture(sourceId): string | undefined }`; `nodeVersionOk(v)`; `runDoctor(deps, { offline }): Promise<DoctorReport>`. CLI: `doctor.ts [--json] [--offline]`, exit 1 when `blocking`.
- Check ids: `node`, `profile`, `data-dir`, `provider`, `checkout-deny`, `mcp-registered`, `recipe-source:<id>`, `plan-mode`, `login`.

- [ ] **Step 1: Write the failing test** — `tests/doctor.test.ts`

```ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { nodeVersionOk, runDoctor, type DoctorDeps } from '../scripts/doctor.ts';
import { paths } from '../scripts/lib/paths.ts';
import { useTempRoot, writeValidProfile } from './helpers.ts';

let root = '';
beforeEach(() => { root = useTempRoot(); });

const recipeHtml = readFileSync(join(paths.fixtures('marmiton'), 'recipe-blanquette.html'), 'utf8');
const settings = JSON.parse(readFileSync(paths.settings(), 'utf8'));
const deps = (over: Partial<DoctorDeps> = {}): DoctorDeps => ({
  nodeVersion: 'v24.2.0',
  listMcpServers: async () => 'carrefour-drive: npx -y github:maximeallanic/CarrefourDriveMCP - ✓ Connected',
  fetcher: async () => recipeHtml,
  probe: async () => ({ isError: false, text: 'Session present\nVerification: HTTP 200' }),
  readSettings: () => settings,
  readFixture: () => recipeHtml,
  ...over,
});
const check = (r: Awaited<ReturnType<typeof runDoctor>>, id: string) => r.checks.find((c) => c.id === id);

test('nodeVersionOk', () => {
  assert.ok(nodeVersionOk('v24.2.0'));
  assert.ok(nodeVersionOk('v22.18.0'));
  assert.ok(nodeVersionOk('v23.6.1'));
  assert.ok(!nodeVersionOk('v22.6.0'));
  assert.ok(!nodeVersionOk('v23.5.0'));
  assert.ok(!nodeVersionOk('v20.11.0'));
});

test('fresh install: template copied, onboarding needed, no login probe', async () => {
  let probed = false;
  const r = await runDoctor(deps({ probe: async () => { probed = true; return { isError: false, text: '' }; } }), { offline: false });
  assert.ok(existsSync(join(root, 'profile.yml')));
  assert.equal(r.onboardingNeeded, true);
  assert.equal(r.blocking, false);
  assert.equal(check(r, 'login'), undefined);
  assert.ok(!probed);
});

test('healthy setup', async () => {
  writeValidProfile(root);
  const r = await runDoctor(deps(), { offline: false });
  assert.equal(r.onboardingNeeded, false);
  assert.equal(r.blocking, false);
  assert.equal(r.planEnabled, true);
  for (const c of r.checks) assert.equal(c.status, 'pass', `${c.id}: ${c.message}`);
});

test('invalid profile names the field', async () => {
  writeValidProfile(root, 'household: { adults: 0 }\n');
  const r = await runDoctor(deps(), { offline: true });
  assert.equal(r.onboardingNeeded, true);
  assert.match(check(r, 'profile')?.message ?? '', /household\.adults/);
});

test('missing deny entry blocks', async () => {
  writeValidProfile(root);
  const r = await runDoctor(deps({ readSettings: () => ({}) }), { offline: true });
  assert.equal(check(r, 'checkout-deny')?.status, 'fail');
  assert.equal(r.blocking, true);
});

test('expired login blocks; probe crash is unknown and non-blocking', async () => {
  writeValidProfile(root);
  const expired = await runDoctor(deps({ probe: async () => ({ isError: false, text: 'Verification: FAILED (HTTP 401)' }) }), { offline: false });
  assert.equal(check(expired, 'login')?.status, 'fail');
  assert.equal(expired.blocking, true);
  const busy = await runDoctor(deps({ probe: async () => { throw new Error('profile locked'); } }), { offline: false });
  assert.equal(check(busy, 'login')?.status, 'unknown');
  assert.equal(busy.blocking, false);
});

test('claude CLI unavailable → unknown, not blocking; server not registered → blocking', async () => {
  writeValidProfile(root);
  const noCli = await runDoctor(deps({ listMcpServers: async () => { throw new Error('ENOENT'); } }), { offline: false });
  assert.equal(check(noCli, 'mcp-registered')?.status, 'unknown');
  assert.equal(noCli.blocking, false);
  const missing = await runDoctor(deps({ listMcpServers: async () => 'other: x' }), { offline: false });
  assert.equal(check(missing, 'mcp-registered')?.status, 'fail');
  assert.match(check(missing, 'mcp-registered')?.fix ?? '', /claude mcp add carrefour-drive/);
});

test('recipe source down → plan disabled, not blocking', async () => {
  writeValidProfile(root);
  const r = await runDoctor(deps({ fetcher: async () => { throw new Error('HTTP 403'); } }), { offline: false });
  assert.equal(check(r, 'recipe-source:marmiton')?.status, 'warn');
  assert.equal(r.planEnabled, false);
  assert.equal(check(r, 'plan-mode')?.status, 'fail');
  assert.equal(r.blocking, false);
});

test('old node blocks; offline skips live checks', async () => {
  writeValidProfile(root);
  const r = await runDoctor(deps({ nodeVersion: 'v20.0.0' }), { offline: true });
  assert.equal(r.blocking, true);
  assert.equal(check(r, 'login'), undefined);
  assert.equal(check(r, 'mcp-registered')?.status, 'unknown');
  assert.equal(check(r, 'recipe-source:marmiton')?.status, 'pass');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/doctor.test.ts`
Expected: FAIL — cannot find module `doctor.ts`.

- [ ] **Step 3: Implement** — `scripts/doctor.ts`

```ts
import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { parseArgs } from './lib/args.ts';
import { isMain, printJson, runMain } from './lib/cli.ts';
import { fetchHtml, type Fetcher } from './lib/http.ts';
import { probeSession, type ProbeResult } from './lib/mcp-probe.ts';
import { paths } from './lib/paths.ts';
import { loadProfile } from './lib/profile.ts';
import { classifySession, listProviderIds, loadProvider, missingDenies, type McpProvider, type Provider } from './lib/provider.ts';
import { getSource, sourceIds } from './recipe-sources/index.ts';

export type Status = 'pass' | 'fail' | 'warn' | 'unknown';
export interface Check { id: string; status: Status; message: string; fix?: string; blocking: boolean }
export interface DoctorReport { onboardingNeeded: boolean; planEnabled: boolean; blocking: boolean; checks: Check[] }
export interface DoctorDeps {
  nodeVersion: string;
  listMcpServers: () => Promise<string>;
  fetcher: Fetcher;
  probe: (p: McpProvider) => Promise<ProbeResult>;
  readSettings: () => unknown;
  readFixture: (sourceId: string) => string | undefined;
}

export function nodeVersionOk(v: string): boolean {
  const [major, minor] = v.replace(/^v/, '').split('.').map(Number);
  if (major > 23) return true;
  if (major === 23) return minor >= 6;
  if (major === 22) return minor >= 18;
  return false;
}

export async function runDoctor(deps: DoctorDeps, opts: { offline: boolean }): Promise<DoctorReport> {
  const checks: Check[] = [];
  const add = (id: string, status: Status, message: string, blocking: boolean, fix?: string) =>
    checks.push(fix ? { id, status, message, fix, blocking } : { id, status, message, blocking });

  add('node', nodeVersionOk(deps.nodeVersion) ? 'pass' : 'fail', `Node ${deps.nodeVersion}`, true, 'Install Node 22.18+ (or 23.6+)');

  if (!existsSync(paths.profile())) copyFileSync(paths.profileTemplate(), paths.profile());
  const profile = loadProfile({ sources: sourceIds(), providers: listProviderIds() });
  let onboardingNeeded = false;
  if (profile.status === 'ok') add('profile', 'pass', 'profile.yml is valid', false);
  else {
    onboardingNeeded = true;
    if (profile.status === 'invalid') add('profile', 'fail', profile.errors.join('; '), false, 'Fix profile.yml or run /groceries onboarding');
    else add('profile', 'warn', 'profile.yml is still the template', false, 'Run /groceries onboarding');
  }

  try {
    mkdirSync(paths.data(), { recursive: true });
    const probe = join(paths.data(), '.write-test');
    writeFileSync(probe, 'ok');
    unlinkSync(probe);
    add('data-dir', 'pass', `${paths.data()} is writable`, true);
  } catch (e) {
    add('data-dir', 'fail', `${paths.data()} is not writable: ${(e as Error).message}`, true);
  }

  const providerId = profile.status === 'ok' ? profile.profile.store.provider : 'carrefour';
  let provider: Provider | undefined;
  try {
    provider = loadProvider(providerId);
    add('provider', 'pass', `${provider.label} (${provider.kind})`, true);
  } catch (e) {
    add('provider', 'fail', (e as Error).message, true);
  }

  if (provider?.kind === 'mcp') {
    const missing = missingDenies(provider, deps.readSettings());
    if (missing.length === 0) add('checkout-deny', 'pass', 'All checkout tools are denied', true);
    else add('checkout-deny', 'fail', `Checkout tools not denied: ${missing.join(', ')}`, true, 'Add them to permissions.deny in .claude/settings.json');

    if (opts.offline) add('mcp-registered', 'unknown', 'skipped (--offline)', false);
    else {
      try {
        const out = await deps.listMcpServers();
        if (out.includes(`${provider.mcp_server}:`)) add('mcp-registered', 'pass', `MCP server "${provider.mcp_server}" is configured`, true);
        else add('mcp-registered', 'fail', `MCP server "${provider.mcp_server}" is not configured`, true, provider.install);
      } catch (e) {
        add('mcp-registered', 'unknown', `could not run \`claude mcp list\`: ${(e as Error).message}`, false);
      }
    }
  }

  const sourceList = profile.status === 'ok' ? profile.profile.recipes.sources : sourceIds();
  let planEnabled = false;
  for (const id of sourceList) {
    const s = getSource(id);
    const problems: string[] = [];
    const fixture = deps.readFixture(id);
    if (fixture === undefined) problems.push('no fixture');
    else {
      try {
        s.parse(fixture, s.healthUrl);
      } catch (e) {
        problems.push(`fixture: ${(e as Error).message}`);
      }
    }
    if (!opts.offline) {
      try {
        s.parse(await deps.fetcher(s.healthUrl), s.healthUrl);
      } catch (e) {
        problems.push(`live: ${(e as Error).message}`);
      }
    }
    if (problems.length === 0) {
      planEnabled = true;
      add(`recipe-source:${id}`, 'pass', `${s.label} recipes parse${opts.offline ? ' (fixture only)' : ''}`, false);
    } else add(`recipe-source:${id}`, 'warn', `${s.label}: ${problems.join('; ')}`, false);
  }
  if (!planEnabled) add('plan-mode', 'fail', 'All recipe sources failing — plan mode disabled (add mode still works)', false);

  if (profile.status === 'ok' && provider?.kind === 'mcp' && !opts.offline) {
    try {
      const state = classifySession(await deps.probe(provider), provider.capabilities.session_check);
      if (state === 'ok') add('login', 'pass', `Logged in to ${provider.label}`, true);
      else if (state === 'expired')
        add('login', 'fail', `Not logged in to ${provider.label}`, true, `Ask Claude to log you in (runs ${provider.capabilities.login})`);
      else add('login', 'unknown', 'Session state could not be confirmed', false, 'Run /groceries setup');
    } catch (e) {
      add('login', 'unknown', `server busy or unreachable: ${(e as Error).message}`, false, 'Run /groceries setup');
    }
  }

  const blocking = checks.some((c) => c.blocking && c.status === 'fail');
  return { onboardingNeeded, planEnabled, blocking, checks };
}

const run = promisify(execFile);
const realDeps: DoctorDeps = {
  nodeVersion: process.version,
  listMcpServers: async () => (await run('claude', ['mcp', 'list'], { timeout: 60_000 })).stdout,
  fetcher: fetchHtml,
  probe: (p) => probeSession(p),
  readSettings: () => (existsSync(paths.settings()) ? JSON.parse(readFileSync(paths.settings(), 'utf8')) : {}),
  readFixture: (id) => {
    const dir = paths.fixtures(id);
    if (!existsSync(dir)) return undefined;
    const f = readdirSync(dir).find((n) => n.startsWith('recipe-'));
    return f ? readFileSync(join(dir, f), 'utf8') : undefined;
  },
};

const ICON: Record<Status, string> = { pass: '✅', fail: '❌', warn: '⚠️ ', unknown: '❔' };

async function main(): Promise<void> {
  const { flags } = parseArgs(process.argv.slice(2), ['json', 'offline']);
  const report = await runDoctor(realDeps, { offline: Boolean(flags['offline']) });
  if (flags['json']) printJson(report);
  else {
    for (const c of report.checks) {
      console.log(`${ICON[c.status]} ${c.id} — ${c.message}`);
      if (c.fix && c.status !== 'pass') console.log(`   fix: ${c.fix}`);
    }
    console.log(report.blocking ? '\nBlocked: fix the ❌ items above.' : report.onboardingNeeded ? '\nRun /groceries onboarding.' : '\nReady.');
  }
  if (report.blocking) process.exitCode = 1;
}

if (isMain(import.meta.url)) runMain(main);
```

- [ ] **Step 4: Run tests**

Run: `npm run check`
Expected: all PASS.

- [ ] **Step 5: Run the real doctor offline**

Run: `GROCERIES_ROOT=$(mktemp -d) node scripts/doctor.ts --offline`
Expected: ✅ node, ⚠️ profile template, ✅ data-dir, ✅ provider, ✅ checkout-deny, ❔ mcp-registered skipped, ✅ recipe-source:marmiton; "Run /groceries onboarding."

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: doctor setup check with login probe"
```

---

### Task 12: Agent layer — AGENTS.md, router skill, modes

**Files:**
- Create: `AGENTS.md`, `CLAUDE.md`, `.claude/skills/groceries/SKILL.md`, `modes/_cart.md`, `modes/onboarding.md`, `modes/plan.md`, `modes/add.md`, `modes/habits.md`, `modes/setup.md`
- Test: `tests/agent-layer.test.ts`

**Interfaces:**
- Consumes: every CLI from Tasks 6–11; `CAPABILITY_NAMES`, `listProviderIds`, `loadProvider` (Task 10). Modes refer to store actions only as `capability:<name>`.

- [ ] **Step 1: Write the failing test** — `tests/agent-layer.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../scripts/lib/paths.ts';
import { CAPABILITY_NAMES, listProviderIds, loadProvider } from '../scripts/lib/provider.ts';

const read = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');
const modeFiles = readdirSync(join(REPO_ROOT, 'modes')).map((f) => `modes/${f}`);
const agentFiles = ['AGENTS.md', '.claude/skills/groceries/SKILL.md', ...modeFiles];

test('router references existing mode files', () => {
  const refs = [...read('.claude/skills/groceries/SKILL.md').matchAll(/`(modes\/[a-z_-]+\.md)`/g)].map((m) => m[1]);
  for (const m of ['onboarding', 'plan', 'add', 'habits', 'setup', '_cart']) assert.ok(refs.includes(`modes/${m}.md`), m);
  for (const r of refs) assert.ok(existsSync(join(REPO_ROOT, r)), r);
});

test('every referenced script exists', () => {
  for (const f of agentFiles)
    for (const m of read(f).matchAll(/node (scripts\/[a-z-]+\.ts)/g)) assert.ok(existsSync(join(REPO_ROOT, m[1])), `${f}: ${m[1]}`);
});

test('agent instructions never name a forbidden tool', () => {
  for (const id of listProviderIds()) {
    const p = loadProvider(id);
    if (p.kind !== 'mcp') continue;
    for (const f of agentFiles) for (const tool of p.forbidden) assert.ok(!read(f).includes(tool), `${f} mentions ${tool}`);
  }
});

test('capability references are known', () => {
  const known = new Set<string>(CAPABILITY_NAMES);
  for (const f of agentFiles)
    for (const m of read(f).matchAll(/capability:([a-z_]+)/g)) assert.ok(known.has(m[1]), `${f}: capability:${m[1]}`);
});

test('CLAUDE.md imports AGENTS.md', () => {
  assert.match(read('CLAUDE.md'), /@AGENTS\.md/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/agent-layer.test.ts`
Expected: FAIL — `modes` directory missing.

- [ ] **Step 3: Write `CLAUDE.md`**

```markdown
@AGENTS.md
```

- [ ] **Step 4: Write `AGENTS.md`**

````markdown
# groceries-ops — weekly groceries with Claude

Plans meals from real recipes, adds everyday items, learns purchase habits and fills the
grocery store cart. **It never checks out.** Entry point: the `/groceries` skill.

## Session start (first message of every session)

Run silently: `node scripts/doctor.ts --json`

- `onboardingNeeded: true` → run `modes/onboarding.md` before anything else.
- `blocking: true` → show each failing check (message + fix) in the user's language; do not run
  plan or add until fixed. Onboarding, habits and setup still work.
- `planEnabled: false` → plan mode is unavailable; say so if the user asks for it. Add mode works.
- Otherwise say nothing about the doctor.

## Language

Reply in the language the user writes in — every question, shortlist, summary and run log in
`data/runs/`. These instructions, the mode files and script output are English and are never shown
verbatim: scripts print JSON for you to render. Example phrasings in mode files are illustrations,
not fixed strings. Recipe names, ingredient lines and product labels stay in their original language.

## Hard rules

1. **Never check out.** Never pay, validate an order, book a slot or apply a promo code. Use only
   the capabilities listed in the active provider file; the provider's `forbidden` tools are also
   denied in `.claude/settings.json`. Every cart run ends by telling the user the cart is ready and
   checkout is theirs.
2. **Nothing enters the cart without consent.** Only (a) lines the user approved in a review step,
   or (b) due habits with `mode: auto`. `ask` habits and staples need an explicit yes first.
3. **Filtering is the script's job.** Time, exclusions, appliances and repeats are decided by
   `node scripts/recipes.ts fetch`. Never show a recipe it rejected or that you did not fetch through it.
4. **Dates come from scripts.** Habit intervals and due dates come from `node scripts/habits.ts`.
5. Never edit `profile.yml` or `data/` beyond what the current mode says; never put personal facts
   into `modes/`, `AGENTS.md` or other system files.

## Layers

- **System** (may be rewritten by updates): `AGENTS.md`, `CLAUDE.md`, `.claude/`, `modes/`,
  `scripts/`, `providers/`, `config/`, `tests/`.
- **User** (personal, gitignored): `profile.yml`, `data/` (`recipes/`, `habits.yml`,
  `product-choices.yml`, `runs/`).

## Providers

- **Grocery store:** `providers/{profile.store.provider}.yml`. Modes say `capability:<name>`; resolve
  it with the provider file to the MCP tool `mcp__{mcp_server}__{tool}` and read its `notes`.
  `kind: list` means no store connection: produce a shopping list instead of filling a cart.
- **Recipe sources:** chosen by `profile.recipes.sources`, reached only through `node scripts/recipes.ts`.

## Scripts (JSON on stdout; `{"error"}` on stderr + exit 1)

| Command | Purpose |
|---|---|
| `node scripts/doctor.ts [--json] [--offline]` | setup check |
| `node scripts/recipes.ts sources \| search \| fetch \| show \| mark-used` | recipe search, fetch+filter+save |
| `node scripts/shopping-list.ts build \| drop \| add` | scaled, merged list with per-recipe contributions |
| `node scripts/habits.ts list \| due \| record \| answer \| reconcile \| propose \| set-mode \| set-interval \| remove` | purchase habits |
| `node scripts/choices.ts get \| set \| remove \| list` | remembered product choices |

## Development

`npm run check` (typecheck + tests) must pass before committing.
````

- [ ] **Step 5: Write `.claude/skills/groceries/SKILL.md`**

````markdown
---
name: groceries
description: >-
  Weekly groceries — household onboarding, meal planning from real recipes, ad-hoc items,
  purchase habits, filling the grocery store cart (never checkout). Use when the user wants to
  plan meals, add groceries, review buying habits, or check the grocery setup.
argument-hint: "[onboarding | plan | add <items> | habits | setup]"
user-invocable: true
---

# groceries — router

Project root: walk up from this file to the directory containing `AGENTS.md` and `modes/`.
Resolve every path below against it. Follow `AGENTS.md` (hard rules, language rule) in every mode.

| Input | Read |
|---|---|
| (empty) | show the menu below |
| `onboarding` | `modes/onboarding.md` |
| `plan` | `modes/_cart.md` + `modes/plan.md` |
| `add` or a free-text list of items | `modes/_cart.md` + `modes/add.md` |
| `habits` | `modes/habits.md` |
| `setup` | `modes/setup.md` |

Before any mode: read `profile.yml` (if valid) and the active provider file
`providers/{store.provider}.yml`.

Menu (render in the user's language):

```
/groceries onboarding   build or update your household profile
/groceries plan         plan this week's meals and fill the cart
/groceries add <items>  add everyday items (toilet paper, bread…)
/groceries habits       see and edit what you buy regularly
/groceries setup        check the setup and store login
```
````

- [ ] **Step 6: Write `modes/_cart.md`**

````markdown
# Shared cart procedures (used by plan and add)

Store actions are written `capability:<name>`; resolve them through the provider file and read its
`notes`. If the provider has `kind: list`, skip every capability step and use "List provider" below.

## Pre-flight

1. `capability:session_check` (pass its `args`). Classify the text with the provider's
   `ok_pattern` / `expired_pattern` (an error result means expired). Expired → stop, offer to run
   `capability:login` (the user signs in in the browser window), then resume.
2. `capability:read_cart`. If it has items: list them (name × quantity) and ask whether to empty the
   cart before starting. Yes → `capability:set_quantity` with quantity 0 for each line, then
   `capability:read_cart` to confirm it is empty. No → stop the run; nothing gets mixed.
3. Order sync (below).

## Order sync

1. Call each `capability:order_history` tool for recent orders (the last ~8 weeks is enough).
2. Convert to `[{ "date": "YYYY-MM-DD", "items": [{ "name": "...", "ean": "..." }] }]` and write it to
   `data/runs/{today}-orders.json`.
3. `node scripts/habits.ts reconcile data/runs/{today}-orders.json`.
If order history fails, continue and mention it in one line.

## Product resolution

For each thing to buy, first hit wins:
1. **Remembered choice:** `node scripts/choices.ts get "<ingredient>"` → use that EAN.
2. **History:** a habit with an EAN for the same item (`node scripts/habits.ts list`), or a match
   in `capability:frequent`.
3. **Search + rules:** `capability:search` with a short French product query. Category = the closest
   key in `profile.product_rules` (else `default`). Apply, in order: `preferred_brand`, `organic`,
   `store_brand_ok`, `max_price_per_kg`, `cheapest`. Skip unavailable products.

Quantity: the fewest packs covering the needed amount (round up). Counts without a unit (3 oignons)
→ loose items, or the smallest pack covering the count.

Unavailable product: a `minor` item gets a substitute, flagged in the review. A `key` item is
handled by the calling mode (plan: replace the recipe; add: tell the user and offer alternatives).

## Review

One table: item · product · quantity · price · why (`choice`, `history`, `rule:<category>`,
`habit:auto`, `habit:yes`, `staple:yes`, `substitute`) + estimated total. The user may change any
line; re-resolve it. When the user picks a specific product for an ingredient, remember it:
`node scripts/choices.ts set "<ingredient>" <ean> "<label>"`. Continue only on an explicit OK.

## Fill and verify

1. Add each approved line with `capability:add_to_cart`. Collect failures; keep going.
2. `capability:read_cart`; compare with the approved lines and report any difference.
3. To lower or remove a line later in the run, use `capability:set_quantity` (0 removes).
4. End with: the cart is ready — checkout is the user's.

## Record

1. Write the added lines as `[{ "name": "...", "ean": "..." }]` to `data/runs/{today}-items.json` and run
   `node scripts/habits.ts record data/runs/{today}-items.json`.
2. Write `data/runs/{today}.md` (add `-2`, `-3`… if it exists), in the user's language: the request,
   recipes (plan), the final table, substitutions, failures, cart differences.

## List provider (`kind: list`)

No pre-flight and no cart. After the review, write `data/runs/{today}-list.md` grouped by aisle
(fruits & légumes, crèmerie, boucherie/poissonnerie, épicerie, surgelés, boissons, hygiène, entretien)
with quantities, then record with `node scripts/habits.ts record data/runs/{today}-items.json --confirmed`.
````

- [ ] **Step 7: Write `modes/onboarding.md`**

````markdown
# Mode: onboarding — build or update profile.yml

Goal: a valid, personalised `profile.yml` (format: `config/profile.template.yml`). Ask **one
question per message**, in the user's language. If `profile.yml` already has real values, show the
current value and ask what to change instead of starting over.

1. **Household** — adults; children and their ages; servings per meal (suggest adults + children).
2. **Food** — diet; **hard exclusions** (allergies and dislikes). Explain they are enforced strictly.
   Store each as the French ingredient word recipes use, singular (`champignon`, `porc`, `arachide`).
   When an exclusion has common derived ingredients (porc → lardon, jambon, chorizo, saucisse), propose
   adding them and let the user confirm. Then soft preferences as free text.
3. **Kitchen tools** — record `oven`, `hob` and others they have. Special appliances matter for
   filtering: `cookeo`, `thermomix`, `monsieur_cuisine`, `companion`, `airfryer`, `slow_cooker`,
   `pressure_cooker`, `barbecue`, `plancha` — recipes needing one not listed are rejected.
4. **Time** — usual maximum total time (prep + cooking) for a weekday meal and a weekend meal.
5. **Product rules** — per category: `default` plus any of `fruits_legumes`, `viande`, `poisson`,
   `cremerie`, `epicerie`, `boissons`, `hygiene`, `entretien` (the user may add others). Rule keys:
   `store_brand_ok`, `organic`, `preferred_brand`, `cheapest`, `max_price_per_kg`.
6. **Store** — provider (`carrefour`, or `list` for a shopping list with no store connection), drive or
   delivery, usual store (free text in `store_id`). For an MCP provider, run the login part of
   `modes/setup.md` now.
7. **Habit bootstrap** (MCP provider only, ask consent first): run "Order sync" from
   `modes/_cart.md` (also read `capability:frequent`), then `node scripts/habits.ts propose`. Present
   the items with an interval, grouped: proposed `auto` (≈ weekly) vs `ask`. Apply only what the user
   confirms: `node scripts/habits.ts set-mode <key> auto|ask`, `node scripts/habits.ts set-interval <key> <days>`.

After each section, write `profile.yml` and run `node scripts/doctor.ts --json --offline`; fix any
`profile` error before moving on. Finish with a 5-line summary of the profile and suggest
`/groceries plan`.
````

- [ ] **Step 8: Write `modes/plan.md`**

````markdown
# Mode: plan — this week's meals → cart

Uses `modes/_cart.md`. If the doctor reported `planEnabled: false`, say plan mode is unavailable
and offer add mode.

1. **Pre-flight** (`_cart.md`).
2. **Brief** — one message: how many meals, time per meal (defaults: `time.weekday_max_min`,
   `time.weekend_max_min`), any wishes ("something with salmon"). Servings default to
   `household.servings`.
3. **Candidates**
   - `node scripts/recipes.ts sources` → enabled sources.
   - Write 3–5 varied French queries from the wishes, `food.preferences` and the season
     (e.g. "poulet curry", "gratin légumes", "poisson four"). For each:
     `node scripts/recipes.ts search "<query>" --limit 8`. A source with `search: false` → use
     WebSearch with its `searchHint`.
   - `node scripts/recipes.ts fetch <url>... --max-min <limit>` (separate calls for weekday and
     weekend limits). Only `keep: true` results may be shown. Aim for about 3× the meal count.
   - Three `error` results in a row → stop and suggest `/groceries setup`.
4. **Choose and swap** — show a numbered shortlist with as many proposals as meals: name · total
   minutes · servings · rating · one line on why it fits. Keep the other kept recipes in reserve.
   The user can keep, replace ("replace 2"), constrain ("something without cream instead of 4"), or
   steer ("more like 1"). Replacements come from the reserve or new searches, always through
   `fetch`; pass rejected ids with `--reject id,id`. Repeat until the user says done.
5. **Shopping list** — `node scripts/shopping-list.ts build data/runs/{today}-list.json <id>...`.
   Mention any `no-yield:<id>` warning (that recipe's quantities are not scaled). Each item has a
   default `role`; you may reclassify obvious cases (a garnish is `minor`).
6. **Products** — resolve every non-staple item (`_cart.md` Product resolution).
   **Key item unavailable:** tell the user which recipe can't be made, propose a replacement (same
   loop as step 4), then `node scripts/shopping-list.ts drop data/runs/{today}-list.json <oldId>` and
   `node scripts/shopping-list.ts add data/runs/{today}-list.json <newId>`; resolve only the new or
   changed items (shared items such as onions are reduced automatically).
7. **Habits** — `node scripts/habits.ts due`. Add every `auto` item and list them. For each `ask`
   item, one question ("Toilet paper — last bought 19 days ago, usually every ~21 days. Add it?"),
   then `node scripts/habits.ts answer <key> yes|no`.
8. **Staples** — one closing question naming the staple items the recipes use ("Your recipes need
   curry, olive oil and flour — do you have everything?"). Add only what the user says is missing.
9. **Review → Fill and verify → Record** (`_cart.md`). If an add fails for a key item, apply step 6's
   replacement flow, adjust shared lines with `capability:set_quantity`, and verify again.
10. `node scripts/recipes.ts mark-used <id>...` for the final recipes.
````

- [ ] **Step 9: Write `modes/add.md`**

````markdown
# Mode: add — everyday items

Uses `modes/_cart.md`.

1. **Pre-flight** (`_cart.md`) — skip when called during a plan run.
2. Split the request into items with quantities (default: one pack). Vague items ("something for the
   dishwasher") → `capability:search` and offer 2–3 options.
3. Resolve each item (`_cart.md` Product resolution). Unavailable → say so and offer alternatives.
4. **Review → Fill and verify → Record** (`_cart.md`).
````

- [ ] **Step 10: Write `modes/habits.md`**

````markdown
# Mode: habits — what the household buys regularly

1. `node scripts/habits.ts list` → table: item · mode (auto/ask) · every N days · last bought ·
   next due. Sort by next due.
2. The user can:
   - switch mode → `node scripts/habits.ts set-mode <key> auto|ask` (only on the user's explicit words);
   - change an interval → `node scripts/habits.ts set-interval <key> <days>`;
   - remove an item → `node scripts/habits.ts remove <key>`;
   - see suggestions → `node scripts/habits.ts propose` (items whose history suggests `auto`).
3. Show the updated row after each change.
````

- [ ] **Step 11: Write `modes/setup.md`**

````markdown
# Mode: setup — check everything works

1. `node scripts/doctor.ts --json`. Present each check that is not `pass`, with its fix, in the user's
   language. Offer to apply fixes that only touch system files (e.g. a missing deny entry).
2. **Login** (MCP provider): `capability:session_check` through your own MCP connection — this also
   settles a doctor `unknown`. Expired or no session → `capability:login`; the user completes the
   sign-in in the browser window; check again.
3. **Search test:** `capability:search` for "lait" → expect at least one product with an EAN and a
   price. Report what came back.
4. Summary: ready, or the list of what to fix.
````

- [ ] **Step 12: Run tests**

Run: `npm run check`
Expected: all PASS, including agent-layer.

- [ ] **Step 13: Commit**

```bash
git add -A && git commit -m "feat: agent layer — AGENTS.md, groceries router, modes"
```

---

### Task 13: Live verification with the real MCP server (needs the user)

**Files:**
- Modify (as findings require): `providers/carrefour.yml`, `modes/_cart.md`, `docs/superpowers/specs/2026-10-06-groceries-ops-design.md` §12

- [ ] **Step 1: Register the MCP server**

Run: `claude mcp add carrefour-drive -- npx -y github:maximeallanic/CarrefourDriveMCP`
Expected: "Added stdio MCP server carrefour-drive". Restart the Claude Code session in the repo so the tools load.

- [ ] **Step 2: Login (user)** — ask Claude to run `capability:login`; the user signs in (captcha + OTP) in the opened window.

- [ ] **Step 3: Doctor**

Run: `node scripts/doctor.ts`
Expected: all ✅ except possibly `login` ❔ "server busy" (Chromium profile shared with the session's instance). Record which.

- [ ] **Step 4: Inspect real shapes** — in the session: `capability:search` "lait", `capability:read_cart`, `capability:order_history`. Note the fields for EAN, price, availability, and where `basketServiceId` / `subBasketType` come from. Put what Claude needs into `notes` in `providers/carrefour.yml`.

- [ ] **Step 5: Verify cart semantics** — add one cheap item with `capability:add_to_cart`; call it again: does quantity increment or stay? Call `capability:set_quantity` with 2, then 0; read the cart after each. If `add_to_cart` increments, note it in `notes` and in `_cart.md` Fill step ("add once with the final quantity").

- [ ] **Step 6: Record findings** — mark spec §12 items 1–3 resolved with what was observed; `npm run check`; commit:

```bash
git add -A && git commit -m "docs: record live Carrefour MCP verification"
```

- [ ] **Step 7: End-to-end dry run** — `/groceries plan` with 2 meals; go through review and fill; check the cart on carrefour.fr; then empty it.
