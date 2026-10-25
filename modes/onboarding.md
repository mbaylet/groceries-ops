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
4. **Time** — usual maximum total time (prep + cooking) for a weekday meal and a weekend meal
   (`weekday_max_min`, `weekend_max_min`), then — if preparation effort matters to them — the maximum
   hands-on preparation time alone for each (`weekday_prep_max_min`, `weekend_prep_max_min`; omit them
   if the user does not care). Recipes over a cap are rejected by the script.
5. **Buying preferences** — ask the user to describe them freely, in their own words (brands,
   organic, budget, animal welfare, origin, things never to buy, special rules for some people in
   the household, whether first-price products are acceptable). Store the text verbatim in
   `preferences_text`. If some items are bought for someone in particular (a baby, a diet), declare a
   `tags` label for them (e.g. `bebe`) and use it in the text.
   **Product brief** (MCP provider only; do it right after step 6 if the store is not chosen yet, and again
   whenever `preferences_text` or `tags` change). Haiku subagents pick the products, so reformulate the user's
   text for them into a short block (≤ 25 lines, plain English instructions, French label words) in a temp file:
   - **Hard rules**: "if the item is … the product MUST contain one of … in its title/flags" (organic is
     the flag `flag.common.organic` or "bio" in the title); for tags: "items tagged X: …".
   - **Preferences** in order, every threshold as arithmetic ("bio is acceptable if its price per kg is at most
     20 % above the cheapest equivalent non-bio, or less than 2 € more per pack"; the comparison only
     involves products that already pass the hard rules).
   - **Value for money**: what "quality/price" means for this user (store brands OK or not, brands to avoid).
   - **First-price ranges are excluded by default** for everyone. Write "First-price products: excluded"
     unless the user said they accept them, then "First-price products: allowed".
   - Do not repeat what the template already says (relevance, choosing, quantity, statuses, output format).
   Check the rules for contradictions yourself. Show the user a table — rule · applies to · effect · hard or
   soft — and save only after they confirm: `node scripts/brief.ts build <file>`. To change a preference
   later, re-write only the changed sentence.
6. **Store** — provider (`carrefour`, or `list` for a shopping list with no store connection), drive or
   delivery, usual store (free text in `store_id`). For an MCP provider, run the login part of
   `modes/setup.md` now.
7. **Habit bootstrap** (MCP provider only, ask consent first): run "Order sync" from
   `modes/_cart.md` (also read `capability:frequent`), then `node scripts/habits.ts propose`. Present
   the items with an interval, grouped: proposed `auto` (≈ weekly) vs `ask`. Everything learned from
   history starts as `track` (never asked); promote only what the user confirms: `node scripts/habits.ts set-mode <key> auto|ask`, `node scripts/habits.ts set-interval <key> <days>`.

After each section, write `profile.yml` and run `node scripts/doctor.ts --json --offline`; fix any
`profile` error before moving on. Finish with a 5-line summary of the profile and suggest
`/groceries plan`.
