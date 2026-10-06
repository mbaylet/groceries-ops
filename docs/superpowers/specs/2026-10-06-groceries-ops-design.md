# groceries-ops — Design

**Date:** 2026-10-06
**Status:** Approved design, pending implementation plan
**Inspiration:** [career-ops](https://github.com/santifer/career-ops) — router skill + mode files + deterministic scripts + strict user/system data layers.

## 1. Goal

A personal Claude Code skill that runs weekly grocery shopping end to end — up to, but never including, checkout:

- Onboarding conversation that builds a household profile (people, food preferences, kitchen tools, product rules, store).
- A **plan** mode: propose real Marmiton recipes that fit the requested meal count, time budget, preferences and tools; let the user pick and swap; turn the chosen recipes into a cart.
- An **add** mode for ad-hoc items (toilet paper, bread, bananas…).
- A **habits** memory that learns purchase frequency and either auto-adds (weekly items) or asks (less frequent items).
- A **provider** layer so the grocery store (Carrefour now, Leclerc later) is swappable, driven through MCP servers.
- A **doctor** script that validates the setup, including the store login.

### Success criteria

- Time and ingredient-exclusion filtering is enforced by code, never by LLM judgement.
- No item that is not a confirmed `auto` habit or part of a user-approved plan/add request ever reaches the cart.
- Checkout cannot happen: the forbidden MCP tools are denied in Claude Code settings, and `doctor` blocks if they are not.
- A weekly plan run (brief → choose → review → cart) completes in one conversation with a cart that matches the reviewed summary.

### Assumptions (confirmed with user)

- Single user, local Claude Code; not a product for others.
- New standalone repo at `~/Documents/groceries-ops`.
- Conversation in English; recipes and product names stay French.
- Scripts in TypeScript, executed directly by Node ≥ 22.6 (type stripping; user has Node 24). No build step. `tsc --noEmit` for type checking.

### Non-goals (v1)

- Recipe book / favourites / ratings workflow (recipe files are stored so this can be added later without migration).
- Leclerc provider (the layer is designed for it; only Carrefour ships).
- Booking pickup/delivery slots, promo codes, checkout.
- Recipe sources other than Marmiton.

## 2. Repository layout and layers

```
groceries-ops/
├── AGENTS.md                      # always-loaded rules: first-message doctor run, onboarding gate, never-checkout rule
├── CLAUDE.md                      # @AGENTS.md
├── package.json / tsconfig.json   # "type": "module"; devDeps: typescript, @types/node; deps: yaml, @modelcontextprotocol/sdk
├── .claude/
│   ├── skills/groceries/SKILL.md  # router: /groceries [onboarding|plan|add|habits|setup]
│   └── settings.json              # permissions.deny for forbidden MCP tools
├── modes/
│   ├── onboarding.md  plan.md  add.md  habits.md  setup.md
├── providers/
│   └── carrefour.yml              # MCP server name, capability→tool map, forbidden tools
├── config/
│   ├── profile.template.yml       # copied to profile.yml by doctor if missing
│   └── staples.default.yml        # built-in pantry staple classifier (system layer)
├── scripts/
│   ├── doctor.ts                  # setup check (human + --json)
│   ├── marmiton.ts                # fetch → parse JSON-LD → filter → save recipe file
│   ├── habits.ts                  # intervals, due list, record purchases, reconcile orders
│   ├── shopping-list.ts           # scale, merge, staple split, per-recipe contributions, drop/replace recipe
│   └── lib/                       # paths, yaml io, profile schema, ISO-8601 duration, ingredient normalizer
├── tests/                         # node:test; fixtures/ holds saved Marmiton HTML
└── (user layer — gitignored)
    ├── profile.yml
    └── data/
        ├── recipes/<slug>.md
        ├── habits.yml
        ├── product-choices.yml
        └── runs/YYYY-MM-DD[-n].md
```

**System layer** (`AGENTS.md`, `modes/`, `scripts/`, `providers/`, `config/*.template.yml`, `config/staples.default.yml`): may be rewritten by future improvements. Contains no user data.

**User layer** (`profile.yml`, `data/`): never overwritten by system changes; gitignored.

**Division of labour:**
- **Scripts:** parsing, filtering, date maths, quantity merging, setup validation — everything that must be exact.
- **Claude:** recipe selection for variety, quantity-to-pack judgement, ingredient→product matching, conversation.
- **MCP server:** the only component that talks to the store, exclusively through tools mapped in the provider file.

## 3. Router and session start

`AGENTS.md` instructs: on the first message of every session run `node scripts/doctor.ts --json`.
- `onboardingNeeded: true` (no `profile.yml`, or still equal to the template) → run `modes/onboarding.md` before anything else.
- Any blocking failure (e.g. missing deny entry) → report it and refuse plan/add until fixed.

`SKILL.md` routes `$mode`:

| Input | Mode |
|---|---|
| empty | menu |
| `onboarding` | `modes/onboarding.md` |
| `plan` | `modes/plan.md` |
| `add` (or free-text item list) | `modes/add.md` |
| `habits` | `modes/habits.md` |
| `setup` | `modes/setup.md` |

Every mode loads `profile.yml` and the active provider file (`providers/{profile.store.provider}.yml`).

## 4. Onboarding and `profile.yml`

Conversational, one question at a time. Re-runnable: updates existing values instead of starting over.

1. **Household** — adults, children with ages, default servings per meal.
2. **Food** — diet; **hard exclusions** (allergies + dislikes; enforced by script); soft preferences (free text, used by Claude when choosing recipes); kids' constraints.
3. **Kitchen tools** — oven, hob, microwave, Cookeo, Thermomix, air fryer, blender, etc.
4. **Time defaults** — max total time for weekday meals and weekend meals.
5. **Product rules per category** — e.g. `store_brand_ok`, `organic`, `preferred_brand`, `cheapest`, `max_price_per_kg`.
6. **Store** — provider (`carrefour`), mode (drive/delivery), usual store; login tested.
7. **Habit bootstrap** — with consent, read store order history, compute proposed intervals and auto/ask modes, user confirms/edits before `habits.yml` is written.

(No staples step — staples are handled at the end of each cart run, see §5.7.)

Sketch:

```yaml
household: { adults: 2, children: [{ age: 6 }], servings: 4 }
food:
  diet: omnivore
  exclusions: [champignon, porc]          # hard, script-enforced
  preferences: "likes Asian food, less red meat"
tools: [oven, hob, microwave]
time: { weekday_max_min: 30, weekend_max_min: 90 }
product_rules:
  default: { store_brand_ok: true }
  fruits_legumes: { organic: true }
  cafe: { preferred_brand: "..." }
  entretien: { cheapest: true }
store: { provider: carrefour, mode: drive, store_id: "..." }
plan: { avoid_repeat_weeks: 3 }
```

`doctor.ts` validates against a schema in `scripts/lib/` and names any invalid field.

## 5. Plan mode (`/groceries plan`)

### 5.1 Pre-flight
- Read the cart via `read_cart`. If not empty: show contents, ask "Empty it before we start?" → yes: `clear_line` each line; no: stop.
- Reconcile habits with real orders (`habits.ts reconcile`, §7).

### 5.2 Brief
One message: number of meals and time per meal (defaults from profile, overridable), optional wishes ("something with salmon").

### 5.3 Candidates
- Claude searches Marmiton for ~3× the needed count, diversified.
- `marmiton.ts fetch <url>` parses the `application/ld+json` `Recipe` node: `name`, `prepTime`, `cookTime`, `totalTime` (ISO-8601 durations, e.g. `PT2H15M`), `recipeYield` (e.g. `"4 personnes"`), `recipeIngredient[]`, `recipeInstructions`, `recipeCategory`, `keywords`, `aggregateRating`.
- `marmiton.ts filter` rejects: `totalTime` > limit (missing `totalTime` → `prepTime + cookTime`; if neither, reject), any ingredient matching a hard exclusion (normalized: lowercase, accent-stripped, singularized, word-boundary match), recipes requiring a tool not in the profile (name/keywords/instructions mention e.g. Cookeo, Thermomix, airfryer, barbecue), recipes used within `avoid_repeat_weeks`.
- Every fetched-and-kept recipe is saved to `data/recipes/<slug>.md` (YAML front matter: source URL, times, yield, raw ingredients, parsed ingredients, tags, rating, fetched_at, used_on[]; body: steps).

### 5.4 Choose and swap loop
Numbered shortlist (name, total time, servings, rating). User commands like "keep 1,3,4", "replace 2", "something without cream instead of 4", "more like 1". Replacements pass the same filter. Rejections are remembered for the session. Loop ends on "done".

### 5.5 Shopping list (`shopping-list.ts`)
- Parse ingredient lines into `{ qty, unit, name }`; scale by `servings / recipeYield`.
- Merge identical ingredients across recipes, **keeping per-recipe contributions** (`onion: { curry: 3, gratin: 2 }`).
- Split out staples using `config/staples.default.yml`.
- Each ingredient line is tagged `key` (protein, base vegetable, starch — set by Claude with a script-supplied default heuristic) or `minor`.

### 5.6 Product resolution
Precedence per ingredient:
1. `data/product-choices.yml` (user corrections: ingredient → EAN).
2. A matching product from store purchase history.
3. Profile product rules applied to `search` results.

Packs round up to cover the needed quantity.

**Out of stock / unavailable:**
- `minor` ingredient → substitute product, flagged in the summary.
- `key` ingredient with no available product → drop the recipe: tell the user, propose a filtered replacement (same loop as §5.4), `shopping-list.ts drop <recipe>` removes exclusive ingredients and decrements shared ones (onions 5 → 3), then resolve the replacement's ingredients.

### 5.7 Habits and staples
- Due `auto` habits → added and listed.
- Due `ask` habits → one question each ("Toilet paper — 19 days, usually ~21. Add?"); answer recorded.
- Staples needed by the recipes → one closing question: "Your recipes need curry, olive oil and flour — do you have everything?" Only missing ones are added.

### 5.8 Review and fill
- Summary table: item · product · qty · price · reason (correction / history / rule / habit / substitute). User may correct any line; corrections persist to `product-choices.yml`.
- On approval: `add_to_cart` each line. If an add fails for a `key` ingredient, run the §5.6 drop/replace flow and reduce/remove already-added lines via `clear_line`/`add_to_cart` with the new quantity.
- Verify via `read_cart`; report any diff.
- Write `data/runs/YYYY-MM-DD.md`; mark recipes `used_on`; record intended purchases (`habits.ts record --pending`).
- **Stop. Checkout is the user's.**

## 6. Add mode (`/groceries add`)

- Free-text list ("toilet paper, 2 baguettes, bananas, something for dishwasher").
- Same pre-flight cart check as §5.1 (when invoked standalone; skipped when invoked inside a plan run).
- Same product resolution precedence (§5.6). Vague items → 2–3 options to choose from.
- Short review → `add_to_cart` → `read_cart` verify → record in habits (`--pending`).

## 7. Habits (`habits.ts`, `data/habits.yml`)

Per item: `key`, `name`, `ean?`, `purchases[]` (dates, `confirmed` flag), `interval_days`, `mode` (`auto|ask`), `last_asked`, `declines_in_row`.

Rules (all in code):
- **Interval** = median gap between confirmed purchases (needs ≥ 2).
- **Due** when `days_since_last >= 0.85 × interval_days`.
- **Proposed auto** when interval ≈ 7 days (5–9) and present in ≥ 3 of the last 4 weeks; otherwise `ask`. Mode changes to `auto` only with explicit user confirmation.
- **Decline** → not asked again until the next run; 3 consecutive declines → `interval_days × 1.5`, counter reset.
- **Reconcile** (start of each run): fetch `order_history`; confirm pending purchases that appear in a real order, drop pending ones that don't (removed at checkout), add items bought outside the skill.
- **Bootstrap** (onboarding): build from `order_history` + `frequent`.

`/groceries habits` lists items with interval/mode/next due and lets the user switch modes, edit intervals, or delete entries.

## 8. Provider layer

```yaml
# providers/carrefour.yml
mcp_server: carrefour-drive
install: "claude mcp add carrefour-drive -- npx -y github:maximeallanic/CarrefourDriveMCP"
spawn: { command: npx, args: ["-y", "github:maximeallanic/CarrefourDriveMCP"] }
capabilities:
  session_check: carrefour_session_status     # called with { verify: true }
  login: carrefour_browser_login
  search: search_products
  add_to_cart: add_item_to_cart_by_ean
  clear_line: add_item_to_cart                # counter: 0 — to verify live
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

- Modes reference capabilities only; Claude resolves them to MCP tool names via this file.
- `.claude/settings.json` denies `mcp__carrefour-drive__<tool>` for every `forbidden` entry; `doctor` blocks if any is missing.
- Fallback provider `list` (no MCP): writes an aisle-grouped shopping list to `data/runs/` instead of filling a cart.
- MCP server used: [maximeallanic/CarrefourDriveMCP](https://github.com/maximeallanic/CarrefourDriveMCP) (MIT, private carrefour.fr API via a real Chromium session). Considered fragile; isolated behind this file.

## 9. Doctor (`scripts/doctor.ts`)

Output: human checklist by default, `--json` → `{ onboardingNeeded, checks: [{ id, status: pass|fail|warn|unknown, message, fix? }], blocking: bool }`.

| Check | Blocking? |
|---|---|
| Node ≥ 22.6 | yes |
| `profile.yml` exists, not template, valid schema (names bad field) | → onboarding |
| `data/` writable | yes |
| Provider file exists and parses | yes |
| Every `forbidden` tool denied in `.claude/settings.json` | **yes** |
| MCP server registered (`claude mcp list` contains `mcp_server`) | yes, prints `install` command |
| Marmiton fixture parses + live recipe fetch parses | warn → plan mode disabled |
| **Store login** (only if profile is valid): spawn MCP server from `spawn` via `@modelcontextprotocol/sdk` stdio client, call `session_check` with `{ verify: true }` | fail → "run `carrefour_browser_login`" |

Login check caveat: if the server's Chromium profile is locked by the instance Claude Code already runs, report `unknown` ("server busy") rather than fail; `/groceries setup` then checks via Claude's own MCP connection. Timeout: 60 s (first run downloads Chromium).

`/groceries setup` = run doctor, then (via Claude's MCP connection) `session_check` and a test `search("lait")`.

## 10. Error handling

| Situation | Behaviour |
|---|---|
| Session expired | Stop before any cart change; ask user to run `login` |
| Cart not empty at start | Show, ask to empty; decline → stop |
| `minor` item unavailable | Substitute, flag in summary |
| `key` item unavailable | Replace recipe, drop/decrement its items (§5.6) |
| Add fails mid-fill | Continue; same key/minor logic; report at end |
| Cart ≠ plan after fill | Report diff |
| Marmiton page unparseable | Skip, fetch replacement; 3 consecutive failures → stop, point to doctor |
| Forbidden tool requested | Denied by settings; mode instructions never call them |

## 11. Testing

`node --test` + `tsc --noEmit`, both via `npm test`.

- **marmiton.ts** — saved HTML fixtures: ISO durations (`PT15M`, `PT2H15M`, missing totalTime), yield parsing (`"4 personnes"`, `"6 parts"`), exclusion normalization (`champignons` ↔ `champignon de Paris`, accents, plurals, no false positive on substrings), tool filter (Cookeo/Thermomix variants), repeat avoidance.
- **shopping-list.ts** — scaling, unit-aware merge, per-recipe contributions, `drop` decrement (5 → 3) and removal, staple split.
- **habits.ts** — synthetic dates: median interval, due threshold, auto proposal, decline snooze and ×1.5 widening, reconcile (confirm/drop pending, add external).
- **doctor.ts** — temp dirs: valid profile, template profile, invalid field, missing deny entry; MCP spawn mocked.
- **Not automated:** live Carrefour calls. Covered manually by `/groceries setup`.

## 12. Items to verify during implementation

1. `add_item_to_cart` with `counter: 0` removes a cart line (`clear_line`).
2. Doctor spawning a second MCP server instance while Claude Code's instance runs (Chromium profile lock).
3. Exact argument shapes of `search_products`, `get_cart`, `get_last_orders` responses (EAN, price, availability fields).
4. Marmiton search: whether a search results page is fetchable/parseable, or candidates come from WebSearch `site:marmiton.org`.
