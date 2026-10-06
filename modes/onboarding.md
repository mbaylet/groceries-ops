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
