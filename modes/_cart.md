# Shared cart procedures (used by plan and add)

Store actions are written `capability:<name>`; resolve them through the provider file and read its
`notes`. If the provider has `kind: list`, skip every capability step and use "List provider" below.

## Pre-flight

1. `capability:session_check` (pass its `args`). Classify the text with the provider's
   `ok_pattern` / `expired_pattern` (an error result means expired). Expired → stop, offer to run
   `capability:login` (the user signs in in the browser window), then resume.
2. `capability:read_cart`. If it has items: list them (name × quantity) and ask whether to empty the
   cart before starting. Yes → `capability:remove` for each line (no `remove` in the provider →
   `capability:set_quantity` with quantity 0), then
   `capability:read_cart` to confirm it is empty. No → stop the run; nothing gets mixed.
3. Order sync (below).

## Order sync

1. Call each `capability:order_history` tool for recent orders (the last ~8 weeks is enough).
2. Convert to `[{ "date": "YYYY-MM-DD", "items": [{ "name": "...", "ean": "..." }] }]` and write it to
   `data/runs/{today}-orders.json`.
3. `node scripts/habits.ts reconcile data/runs/{today}-orders.json`.
If order history fails, continue and mention it in one line.

## Product resolution

The script picks products; you only handle exceptions.

1. Write the items to buy to `data/runs/{today}-request.json`:
   `[{ "item": "<plain ingredient, in the store's language>", "need": { "qty": 400, "unit": "g" }, "tags": ["enfant"], "role": "key" }]`.
   Query the plain ingredient ("riz", not "riz sachets cuisson 8 min"): a convenience format named in
   a recipe line is not a requirement. `need` comes from the shopping list (`total` + `unit`); omit it
   when unknown. Add a tag when the user says who an item is for ("pour mon fils" → `enfant`).
2. `node scripts/products.ts resolve data/runs/{today}-request.json`.
   - Output `{"fallback": "search-via-claude", ...}` → for each `files[]` entry call
     `capability:search` with its `query`, write the raw JSON result to its `file`, then run
     `node scripts/products.ts resolve data/runs/{today}-request.json --from-search <dir>`.
   - An error mentioning mapping discovery → run the mapping discovery in `modes/setup.md` first.
3. `resolved[]` lines go straight to the review table (their `why` explains the choice).
4. `exceptions[]`:
   - `close_call` → show the ≤ 3 `options` in one line each and let the user pick (or pick the one that
     best matches `preferences_text` when the user asked not to be bothered);
   - `none` → say why (`eliminated` counts, `relaxed` rules) and offer: another search term, relaxing a
     rule for this time, or skipping. For a `key` item the calling mode decides (plan: replace the recipe);
   - `ask` → a hard rule could not be checked on that product (missing information): ask the user;
   - `error` → retry once, then report.

Do not search products yourself outside the fallback above.

## Review

One table: item · product · quantity · price · why (the `why` ids from the script, `status-quo`,
`habit:auto`, `habit:yes`, `staple:yes`, `substitute`) + estimated total. The user may change any
line; re-resolve it. When the user picks another product than the script's, remember it:
`node scripts/choices.ts set "<ingredient>" <ean> "<label>"` and
`node scripts/products.ts feedback "<item>" <user_ean> <script_ean> --rules <ids from why>`.
Continue only on an explicit OK.

## Fill and verify

1. Add each approved line with `capability:add_to_cart`. Collect failures; keep going.
2. `capability:read_cart`; compare with the approved lines and report any difference.
3. To remove a line later in the run, use `capability:remove` (else `capability:set_quantity` with 0).
   To lower a quantity, follow the provider `notes`.
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
