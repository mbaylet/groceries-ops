# groceries-ops

Weekly groceries with Claude. It plans meals from real recipes, adds everyday items, learns what you buy
regularly and fills your grocery store cart. **It never checks out**: paying, booking a slot and promo codes
are always yours.

It runs as a [Claude Code](https://claude.com/claude-code) skill (`/groceries`). Claude does the talking and
the judgment; small TypeScript scripts do everything that must be exact (recipe filtering, shopping-list
maths, purchase habits, bookkeeping).

Currently supported: **Carrefour Drive** (France) through an MCP server, and **Marmiton** as the recipe
source. A `list` provider produces a shopping list instead of filling a cart, for any other store.

## What it does

| Command | What happens |
|---|---|
| `/groceries onboarding` | Builds your household profile (people, diet, exclusions, appliances, time, buying preferences) and the instructions used to pick products. |
| `/groceries plan` | Plans the week's meals from real, filtered recipes, builds the scaled shopping list and fills the cart. |
| `/groceries add <items>` | Adds everyday items (toilet paper, bread…) to the cart. |
| `/groceries note <items>` | Parks something for the next cart ("last dishwasher tablet") without choosing a product now. |
| `/groceries habits` | Shows and edits what you buy regularly (auto-add, ask, or just track). |
| `/groceries setup` | Checks the setup and the store login. |

Claude replies in the language you write in. Recipe names and product labels stay in their original language.

## How a cart run works

```
profile ─► recipes ─► shopping list ─► product brief ─► Haiku subagents ─► reconcile ─► record
 (once)   search +      scaled, merged    (written once    one per item:    main model    habits,
          filter by     per recipe,       at onboarding)   search, filter,  checks the    used recipes,
          script        staples apart                      add if sure      cart and     run log
                                                                            each choice
```

1. **Pre-flight**: session check, read the cart (offer to empty it), sync order history into habits.
2. **Recipes**: Claude searches, but `scripts/recipes.ts fetch` is the only gate: it applies time limits,
   exclusions, appliances, minimum rating and "not cooked recently". A recipe it rejects is never shown.
3. **Shopping list**: quantities scaled to the household, merged across recipes, pantry staples set aside.
4. **Product picking**: one Haiku subagent per item reads `data/product-brief.md` (your rules, rewritten for
   a small model), searches the store, filters, and adds the product only when the choice is clearly right.
   Doubtful or missing items are reported, not guessed.
5. **Reconcile**: the main model reads the real cart, compares it with every choice, fixes mistakes, and asks
   you about the doubtful items.
6. **Record**: habits, remembered product choices, recipes marked as used, a run log in `data/runs/`.

## Hard rules

1. **Never check out.** Only the capabilities declared in the provider file are used; the provider's
   `forbidden` tools are also denied in `.claude/settings.json`.
2. **Nothing enters the cart without consent**: lines you approved, due habits set to `auto`, items you parked
   with `/groceries note`, or products a subagent picked with every hard rule verified.
3. **Filtering is the script's job** (recipes), and products are picked by subagents following your brief.
4. **Dates come from scripts**, never from the model.
5. Personal facts live only in the user layer, never in system files.

## Requirements and install

- Node.js **22.18+** (TypeScript runs natively; no build step).
- Claude Code.
- For Carrefour: the MCP server, registered once (also printed by `/groceries setup`):

  ```
  claude mcp add -e CARREFOUR_MAX_RESPONSE_CHARS=2000000 -s local carrefour-drive -- \
    npx -y github:maximeallanic/CarrefourDriveMCP
  ```

Then:

```
npm install
claude            # open Claude Code in this folder
/groceries onboarding
/groceries plan
```

The first message of every session runs `node scripts/doctor.ts --json` silently; it only speaks up when
something is wrong (profile missing, MCP not registered, checkout tools not denied, …).

## Structure

Two layers: the **system** (replaced by updates) and the **user** layer (personal, gitignored).

```
AGENTS.md                      project instructions for Claude (hard rules, layers, scripts); CLAUDE.md imports it
.claude/
  settings.json                denies the store's checkout tools
  skills/groceries/SKILL.md    the /groceries router: input → mode files
modes/                         step-by-step procedures Claude follows
  onboarding.md  plan.md  add.md  note.md  habits.md  setup.md
  _cart.md                     shared cart procedure (pre-flight, subagents, reconcile, review, record)
providers/                     one file per store
  carrefour.yml                MCP server, capability → tool map, forbidden tools, notes for subagents
  list.yml                     no store connection: produce a shopping list
config/
  profile.template.yml         profile format
  staples.default.yml          pantry staples and consumables never added automatically
  product-brief.template.md    generic instructions for the product-picking subagents
scripts/                       JSON in, JSON out (errors on stderr, exit 1)
  doctor.ts  recipes.ts  shopping-list.ts  habits.ts  choices.ts  pending.ts  brief.ts
  lib/                         profile, provider, MCP session, recipe filter, ingredient parsing, …
  recipe-sources/              recipe sources behind one interface (marmiton.ts)
tests/                         node:test suite with saved fixtures

profile.yml                    (user) your household profile
data/                          (user)
  recipes/                     every recipe fetched, one Markdown file each
  habits.yml                   learned purchase habits (auto / ask / track)
  product-choices.yml          products you picked before, remembered per ingredient
  pending.yml                  items parked for the next cart
  product-brief.md             your rules rewritten for the subagents (generated)
  runs/                        per-run files and logs
```

### Providers and capabilities

Modes never name a store tool. They say `capability:search`, `capability:add_to_cart`, `capability:read_cart`…
and the active provider file maps each capability to a concrete MCP tool (`mcp__{server}__{tool}`). Supporting
another store means writing another provider file, not touching the modes.

### Scripts

| Command | Purpose |
|---|---|
| `node scripts/doctor.ts [--json] [--offline]` | setup check |
| `node scripts/recipes.ts sources \| search \| fetch \| show \| mark-used` | recipe search; fetch + filter + save |
| `node scripts/shopping-list.ts build \| drop \| add` | scaled, merged list with per-recipe contributions |
| `node scripts/habits.ts list \| due \| record \| answer \| reconcile \| propose \| set-mode \| set-interval \| remove` | purchase habits |
| `node scripts/choices.ts get \| set \| remove \| list` | remembered product choices |
| `node scripts/pending.ts add \| list \| remove \| done` | items parked for the next cart |
| `node scripts/brief.ts status \| build` | the product-picker brief |

## Development

```
npm run check     # typecheck + tests; must pass before committing
```

Tests use saved fixtures and a temporary data root (`GROCERIES_ROOT`), so they never touch your real data
or the network.
