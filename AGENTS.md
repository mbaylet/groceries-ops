# groceries-ops — weekly groceries with Claude

Plans meals from real recipes, adds everyday items, learns purchase habits and fills the
grocery store cart. **It never checks out.** Entry point: the `/groceries` skill.

## Session start (first message of every session)

Run silently: `node scripts/doctor.ts --json`

- `onboardingNeeded: true` → run `modes/onboarding.md` before anything else — including an explicitly
  requested mode such as setup. Profile creation is always the very first step; nothing touches the
  store (login, search, cart) until the profile is valid.
- `blocking: true` → show each failing check (message + fix) in the user's language; do not run
  plan or add until fixed. Onboarding, habits and setup still work (once the profile exists).
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
   `node scripts/recipes.ts fetch`. Never show a recipe it rejected or that you did not fetch through it. Product picking is likewise the script's job: never re-rank or second-guess a `resolved` line.
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
| `node scripts/products.ts resolve \| map-check \| validate \| feedback \| suggest` | product picking from preference rules (calls the store search itself) |

## Development

`npm run check` (typecheck + tests) must pass before committing.
