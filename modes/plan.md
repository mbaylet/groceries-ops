# Mode: plan — this week's meals → cart

Uses `modes/_cart.md`. If the doctor reported `planEnabled: false`, say plan mode is unavailable
and offer add mode.

1. **Pre-flight** (`_cart.md`).
2. **Brief** — one message: how many meals, time per meal (defaults: `time.weekday_max_min` and
   `time.weekday_prep_max_min`, or the weekend pair), any wishes ("something with salmon"). The
   preparation cap is the hands-on time alone; ask for it too if the profile has none and the user
   cares. Servings default to `household.servings`.
3. **Candidates**
   - Write 3–5 varied French queries from the wishes, `food.preferences` and the season
     (e.g. "poulet curry", "gratin légumes", "poisson four").
   - One call does the search, the download and the filtering, on every enabled source:
     `node scripts/recipes.ts find "<query>" "<query>"... --want <3 × meals> --max-min <limit> --max-prep <limit>`
     (separate calls for weekday and weekend limits; `--pages n` reads more result pages, default 3).
     Only `kept` recipes come back, already saved; `stats.rejected` counts the others by reason
     (`too-long`, `prep-too-long`, `low-rating`, `few-ratings`, `excluded`, `recent`, …).
   - `enough: false` → run `find` again with other or broader queries. If nothing is kept, tell the
     user which reason dominates and which setting it comes from (prep cap, rating, time, exclusions).
   - A source without search (`recipes.ts sources` → `search: false`) → WebSearch with its
     `searchHint`, then `node scripts/recipes.ts fetch <url>... --max-min <limit> --max-prep <limit>`.
     Only `keep: true` results may be shown. Same for a recipe link the user gives you.
   - `stats.errors` full of failures (three in a row) → stop and suggest `/groceries setup`.
4. **Choose and swap** — show a numbered shortlist with as many proposals as meals: name · prep + cook
   minutes · servings · rating · one line on why it fits. Keep the other kept recipes in reserve.
   The user can keep, replace ("replace 2"), constrain ("something without cream instead of 4"), or
   steer ("more like 1"). Replacements come from the reserve or new searches, always through
   `find` or `fetch`; pass rejected ids with `--reject id,id`. Repeat until the user says done.
5. **Shopping list** — `node scripts/shopping-list.ts build data/runs/{today}-list.json <id>...`.
   Mention any `no-yield:<id>` warning (that recipe's quantities are not scaled). Each item has a
   default `role`; you may reclassify obvious cases (a garnish is `minor`).
   **Sides** — `meals` says what each recipe already brings (`starch`, `vegetable`). For every
   `needsSide: true` recipe, add one side so the meal is complete:
   `node scripts/shopping-list.ts side data/runs/{today}-list.json <id> "<line for ONE serving>"`
   (the script scales it to the list's servings; the side's items get `side: true`).
   - Usually a starch matching the dish: riz basmati for a curry, colombo or korma; riz for a
     blanquette; pâtes, pommes de terre or semoule for meat in sauce; pain for a soup. A vegetable
     instead when it suits better (fish, a dish already rich in cream) or when the recipe has no
     `vegetable` and already feels heavy; never more than one side unless the user asks.
   - Raw portions per serving: riz, semoule, quinoa, boulgour 75 g · pâtes 90 g · pommes de terre
     250 g · légume 200 g · baguette ¼ (write "0.25 baguette").
   - Skip it only when a side makes no sense (dessert, sauce, drink) or the user said no.
   - Tell the user in one line which side goes with which recipe ("Curry de poulet → riz basmati,
     blanquette → riz"); they may change or remove one (`side … <id>` with another line, or with no
     line to remove it). Sides then follow the normal product flow (step 6) and show as
     "accompagnement" in the review. `drop` / `add` keep the sides of the recipes still in the list.
6. **Products** — pick and add every non-staple item through `_cart.md` Product resolution and fill
   (one request for the whole list).
   **Key item with status none:** tell the user which recipe can't be made, propose a replacement (same
   loop as step 4), then `node scripts/shopping-list.ts drop data/runs/{today}-list.json <oldId>` and
   `node scripts/shopping-list.ts add data/runs/{today}-list.json <newId>`; resolve only the new or
   changed items (shared items such as onions are reduced automatically; fix their cart quantity).
   The dropped recipe's side goes with it; give the new recipe a side if its `needsSide` is true (step 5).
7. **Parked items & habits** — parked items (`_cart.md`, Request) join the request of step 6. **Habits** — `node scripts/habits.ts due`. Add every `auto` item and list them. For each `ask`
   item, one question ("Toilet paper — last bought 19 days ago, usually every ~21 days. Add it?"),
   then `node scripts/habits.ts answer <key> yes|no`.
8. **Staples** — one closing question naming the staple items the recipes use ("Your recipes need
   curry, olive oil and flour — do you have everything?"). Add only what the user says is missing.
9. **Review → Fill and verify → Record** (`_cart.md`). If an add fails for a key item, apply step 6's
   replacement flow, adjust shared lines with `capability:set_quantity`, and verify again.
10. `node scripts/recipes.ts mark-used <id>...` for the final recipes.
