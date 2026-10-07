# Product preference engine — Design

**Date:** 2026-10-06
**Status:** Design for review
**Extends:** `2026-10-06-groceries-ops-design.md` §5.6 (product resolution) and §4.5 (product rules). Supersedes the `product_rules` mapping format of that spec.

## 1. Goal

Let each household express precise, free-form buying preferences ("Carrefour brand is fine; organic when it costs at most 20 % more per kg; never barn eggs; only free-range chicken; organic only for my child's food") and apply them **in a script, before Claude sees anything**, to cut tokens and latency.

### Success criteria

- In a normal run, most items are resolved by the script alone; Claude only sees **exceptions** (no compliant product, close call, unknown attribute) as compact JSON.
- Raw store search results **never enter Claude's context** (the script calls the store's MCP server itself).
- Hard constraints are never violated, including by remembered choices or purchase history.
- Rules use the household's own words; no fixed label vocabulary in code. The same engine covers vegan, halal, gluten-free, MSC, French origin, "never brand X", budgets, etc.
- Every decision carries a machine-readable explanation (which rules eliminated what, why the winner won).

### Non-goals

- Learning weights automatically (feedback only produces *suggestions*).
- Nutrition-score optimisation (possible later as a scoring criterion).

## 2. Design principles borrowed from classic preference engines

| Principle (origin) | Applied here |
|---|---|
| **Hard constraints vs soft preferences** (constraint satisfaction + multi-attribute utility, MAUT) | `require` / `forbid` / `budget` with `strictness: hard` filter; everything else scores. |
| **Closed-world for hard constraints** | A product whose attributes cannot prove compliance fails a hard rule (`on_unknown: reject`, configurable to `ask`). |
| **Specificity and priority** (default logic, CSS-like specificity) | When rules conflict, the more specific `applies_to` wins; explicit `priority` breaks remaining ties. "Organic required for child food" beats "organic if ≤ +20 %". |
| **Conditional, context-dependent preferences** (CP-nets) | `prefer` with `max_premium_pct` is evaluated *relative to the candidate set* and applied **lexicographically**: if some product satisfying it costs ≤ (best compliant non-satisfying price per unit) × (1 + pct), only those products stay in the running ("I want organic when…" is a priority, not a bonus). Several capped preferences apply in specificity/priority order. |
| **Pareto pruning** | Candidates dominated on every criterion (more expensive per kg **and** satisfying no more preferences) are dropped before scoring. |
| **Normalised weighted scoring** (MAUT / weighted sum) | Uncapped preferences, price and rating are normalised to [0,1] (price: ratio to the cheapest, stable when an outlier appears) and combined with profile weights. |
| **Indifference and preference thresholds** (ELECTRE / PROMETHEE) | Price differences under `indifference_pct` count as equal (avoids flip-flopping between near-identical packs); a top-2 gap under `close_call_pct` is escalated to Claude **only when the two differ on satisfied preferences** (a real trade-off); otherwise the cheaper wins deterministically. |
| **Status-quo bias** | A remembered choice or habit product that passes all hard rules wins if it is within the indifference threshold of the best score. |
| **Ordered constraint relaxation** | If no candidate survives, soft-strict rules are relaxed in ascending `priority`, one at a time, and the relaxation is reported. `hard` rules are never relaxed — the item becomes `ask`. |
| **Static rule validation** | Contradictions (same scope requires and forbids the same word), unreachable rules (scope matches nothing ever seen), bad thresholds are reported by `doctor`. |
| **Explanations** | Each decision lists applied rules, eliminations with reasons, score breakdown. |
| **Feedback loop** | User overrides are recorded (`product-choices.yml`); repeated overrides against the same rule produce a *suggested* rule change, never an automatic one. |

## 3. Rule format (`profile.yml`)

Replaces the previous `product_rules` mapping. The original free text is kept verbatim.

```yaml
preferences_text: >-
  La marque Carrefour me va. Je veux des produits bio quand le rapport prix/kg …

product_rules:
  - id: oeufs-bien-etre
    applies_to: { match: [oeuf] }
    forbid: { any: [sol, cage, "code 2", "code 3"] }
    strictness: hard

  - id: poulet-plein-air
    applies_to: { match: [poulet], not_match: [bouillon, "fond de"] }
    require: { any: [plein air, label rouge, bio] }
    strictness: hard

  - id: enfant-bio
    applies_to: { tags: [enfant] }
    require: { any: [bio] }
    strictness: hard
    priority: 10

  - id: bio-raisonnable
    applies_to: all
    prefer: { any: [bio] }
    max_premium_pct: 20
    weight: 0.3

  - id: marque-carrefour-ok
    applies_to: all
    prefer: { brand_any: [carrefour] }
    weight: 0.05

  - id: budget-cafe
    applies_to: { match: [cafe] }
    budget: { max_price_per_kg: 25 }
    strictness: soft

scoring:
  weights: { price_per_unit: 0.6, preferences: 0.35, rating: 0.05 }
  indifference_pct: 3
  close_call_pct: 5
  on_unknown: reject          # reject | ask
```

### 3.1 Rule fields

| Field | Meaning |
|---|---|
| `id` | stable identifier used in explanations and suggestions |
| `applies_to` | `all`, or `{ match: [...], not_match: [...], tags: [...] }` — words are matched (normalised: case, accents, plurals, whole words) against the **item request** (ingredient or item name) and its tags; `match` is any-of |
| `require` / `forbid` | `{ any: [...] }` or `{ all: [...] }` of words/phrases matched against the **product text** (title + brand + labels + description fields exposed by the provider mapping); `brand_any` matches the brand only |
| `prefer` | same matchers; soft, contributes `weight` to the preference score when satisfied |
| `max_premium_pct` | only on `prefer`: the preference counts only if the satisfying product's price per unit ≤ best non-satisfying compliant price per unit × (1 + pct/100) |
| `budget` | `max_price`, `max_price_per_kg` (per unit: kg, l or piece as the provider mapping reports) |
| `strictness` | `hard` (never relaxed) or `soft` (relaxable when nothing survives); default `hard` for require/forbid/budget |
| `priority` | integer, default 0; higher wins conflicts and is relaxed last |
| `weight` | for `prefer`, default 0.1 |

### 3.2 Specificity

Specificity of `applies_to`: `tags` > `match` with `not_match` > `match` > `all`. Conflicts are only possible between `prefer`/`require` on the same words with different conditions (e.g. `enfant-bio` requires `bio` unconditionally; `bio-raisonnable` prefers it under a premium cap): the more specific rule governs that item; the other is marked `shadowed` in the explanation.

### 3.3 Tags

Items carry tags from the request: the user saying "pour mon fils" → `enfant`; plan-mode recipes may carry tags from the profile (e.g. a recipe planned for the children). Tags are free words declared by the household; the onboarding conversion lists which tags exist.

## 4. Product resolution pipeline (`scripts/products.ts resolve`)

Input (written by Claude, small):
```json
[{ "item": "blanc de poulet", "need": { "qty": 400, "unit": "g" }, "tags": [], "role": "key" },
 { "item": "compote", "need": { "qty": 6, "unit": null }, "tags": ["enfant"] }]
```

Per item, all in the script:

1. **Search** — the provider's `search.tool` (§5): one MCP client session for the whole run, query = item name, first page. Raw responses are written to `data/runs/{date}-search/{item}.json` for debugging and never printed.
2. **Normalise** — the declarative mapping (§5) turns raw products into `Product { ean, title, brand, store_brand, price, unit_price, unit (kg|l|piece), pack_qty, pack_unit, available, text, rating? }`.
3. **Scope** — select the rules whose `applies_to` matches the item; resolve specificity.
4. **Hard filter** — unavailable, failing hard `require`/`forbid`/`budget`; unknown attribute under `on_unknown: reject` (e.g. no unit price for a `max_price_per_kg` rule).
5. **Relaxation** — if empty: relax `soft` rules by ascending priority until something survives; if still empty → decision `none` with the eliminations summary.
6. **Pareto prune.**
7. **Conditional preferences** — for each `prefer` with `max_premium_pct` (most specific first): if any survivor satisfies it within the premium cap, keep only those survivors.
8. **Score** — price score = cheapest / own price per unit (1 within `indifference_pct` of the cheapest), preference score = satisfied uncapped weights / applicable uncapped weights, rating / 5 (0.5 if absent); weighted by `scoring.weights`.
9. **Status quo** — remembered choice (`product-choices.yml`) or habit EAN that survived step 4: chosen if within `indifference_pct` of the top score.
10. **Quantity** — packs needed = ceil(need / pack size) when units are compatible; otherwise 1 pack and flag `qty-unknown`.
11. **Decide** — `chosen` (clear winner), `close_call` (top-2 within `close_call_pct` and differing on satisfied preferences → include top 3), `none` (nothing compliant), `ask` (hard rule could not be evaluated and `on_unknown: ask`).

Output (all Claude reads):
```json
{ "resolved": [{ "item": "blanc de poulet", "status": "chosen", "ean": "…", "title": "…", "packs": 1,
                 "price": 6.49, "unit_price": 16.2, "why": ["poulet-plein-air", "bio-raisonnable:+14%"] }],
  "exceptions": [{ "item": "compote", "status": "close_call", "options": [ {…}, {…}, {…} ],
                   "why": ["enfant-bio"] }],
  "stats": { "items": 18, "chosen": 16, "exceptions": 2 } }
```
Options in exceptions are compact (ean, title, price, unit_price, satisfied rule ids) — at most 3.

Claude then only: resolves exceptions with the user, renders the review table from `resolved`, and calls `add_to_cart` for approved lines.

### 4.1 Fallback (mode A)

`products.ts resolve --from-search <dir>` runs the same pipeline on raw search results Claude saved itself (when the script cannot start its own MCP client, e.g. Chromium profile locked by Claude Code's instance). Detected automatically: if the MCP connect fails, the output says `{"fallback": "search-via-claude"}` and the mode files tell Claude to call `capability:search` per item, write raw results to the directory, and re-run with `--from-search`.

## 5. Declarative product mapping (no per-provider code)

The script calls the provider's MCP search tool itself; the provider YAML declares how to read the raw response. A generic reader follows the paths and applies a few generic conversions.

```yaml
# providers/carrefour.yml (paths below are illustrative — the real ones come from discovery)
search:
  tool: search_products
  args: { q: "{query}" }
  products_path: data                       # where the product list sits in the raw response
  fields:
    ean: attributes.ean
    title: attributes.title
    brand: attributes.brand
    price: { path: attributes.offers.price, parse: price }
    unit_price: { path: attributes.perUnitLabel, parse: unit_price }   # "12,50 €/kg" → 12.5 per kg
    pack: { path: attributes.packaging, parse: pack }                  # "6 x 125 g" → 750 g
    available: { path: attributes.availability.purchasable, parse: bool }
    rating: { path: attributes.rating.value, parse: number }
    text: [attributes.labels, attributes.packaging, attributes.description]  # every string leaf, for rule matching
```

- **Generic conversions:** `number`, `price`, `unit_price` (€/kg, €/l, €/pièce, €/100 g), `pack` (g/kg/ml/cl/l, "6 x 125 g", "x12"), `bool`, `not` (for "out of stock" style flags). `text` collects every string leaf under the listed paths.
- `ean` and `title` are required; a raw product missing either is skipped. Missing optional fields stay unknown (and fall under `on_unknown` for rules that need them).
- **Mapping discovery** (a `/groceries setup` step, run when the provider has no `fields` or the health check fails): Claude runs 4–5 typed searches through its own MCP connection (eggs, an organic product, a loose/per-kg product, a store-brand product, something likely unavailable), saves the raw responses to `tests/fixtures/{provider}/search-*.json`, proposes `products_path` + `fields`, validates them with `node scripts/products.ts map-check tests/fixtures/{provider}/search-*.json`, shows the user a few mapped products, and writes the mapping on confirmation. One-time token cost; reusable for any new provider and for repairing a broken mapping.
- **Mapping health check:** `map-check` reports, per field, the share of products where it was filled; required for health: `ean`, `title`, `price`, `unit_price`, `available` ≥ 80 %. Run offline by the doctor on saved fixtures, and live (search "lait") by the doctor and `/groceries setup` after the login check. A failing check marks plan/add as needing repair (setup offers discovery).
- A provider with an unusual format may still ship a TypeScript reader as an escape hatch; not needed for Carrefour.

## 6. Onboarding conversion (one-time token cost)

Onboarding step 5 becomes: the user writes preferences freely → Claude converts them to `product_rules` + `scoring` → `node scripts/products.ts validate` checks syntax, contradictions, unknown tags → Claude shows a table (rule · applies to · effect · strict?) in the user's language → user confirms or edits → saved with `preferences_text` verbatim. Re-runnable; edits are made by re-converting the changed sentence only.

Default when the user states nothing: `scoring` defaults, no rules (cheapest unit price, store brand allowed).

## 7. Feedback loop

- An override in the review (user picks another product) → `choices.ts set` as today, plus `data/preference-feedback.tsv` row: date, item, chosen ean, overridden ean, rule ids involved.
- `products.ts suggest` reads the feedback: ≥ 3 overrides against the same rule → suggests a change (e.g. raise `max_premium_pct` to 30). Shown in `/groceries habits`-like review; applied only on confirmation.

## 8. Changes to existing parts

- `profile.ts`: new `product_rules` list schema + `preferences_text` + `scoring`; old mapping format rejected with a message pointing to onboarding.
- `modes/_cart.md` Product resolution: replaced by "write items JSON → `products.ts resolve` → handle exceptions".
- `doctor.ts`: runs rule validation (§2 static validation).
- `providers/carrefour.yml`: add the `search` block (tool + args now; `products_path`/`fields` filled by mapping discovery).
- `modes/setup.md`: mapping discovery + live mapping health check; `doctor.ts`: offline + live mapping health.

## 9. Testing

- Engine (pure, offline): hard filter, closed-world unknowns, specificity (`enfant-bio` vs `bio-raisonnable`), premium rule at 19 % / 21 %, Pareto pruning, indifference vs close call, status quo within/outside threshold, relaxation order and hard-never-relaxed, quantity rounding, explanation contents.
- Validator: contradiction, unknown tag, bad threshold.
- Mapper: path reading, every conversion, health ratios — on synthetic raw JSON; real Carrefour fixtures added by discovery.
- Resolve with a fake MCP client: one session for N items, raw results never on stdout, fallback signal on connect failure.

## 10. Open items

1. Raw `search_products` response shape — filled in by mapping discovery in a logged-in session.
2. Whether two MCP server instances can share the Chromium profile (decides how often fallback A is used).
