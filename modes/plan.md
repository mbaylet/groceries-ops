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
6. **Products** — pick and add every non-staple item through `_cart.md` Product resolution and fill
   (one request for the whole list).
   **Key item with status none:** tell the user which recipe can't be made, propose a replacement (same
   loop as step 4), then `node scripts/shopping-list.ts drop data/runs/{today}-list.json <oldId>` and
   `node scripts/shopping-list.ts add data/runs/{today}-list.json <newId>`; resolve only the new or
   changed items (shared items such as onions are reduced automatically; fix their cart quantity).
7. **Parked items & habits** — parked items (`_cart.md`, Request) join the request of step 6. **Habits** — `node scripts/habits.ts due`. Add every `auto` item and list them. For each `ask`
   item, one question ("Toilet paper — last bought 19 days ago, usually every ~21 days. Add it?"),
   then `node scripts/habits.ts answer <key> yes|no`.
8. **Staples** — one closing question naming the staple items the recipes use ("Your recipes need
   curry, olive oil and flour — do you have everything?"). Add only what the user says is missing.
9. **Review → Fill and verify → Record** (`_cart.md`). If an add fails for a key item, apply step 6's
   replacement flow, adjust shared lines with `capability:set_quantity`, and verify again.
10. `node scripts/recipes.ts mark-used <id>...` for the final recipes.
