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
