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

## Product resolution and fill (Haiku subagents)

Products are picked **and added to the cart** by Haiku subagents, one per item. The instructions they follow
live in one file written once (`data/product-brief.md`); your per-item prompt stays tiny to save tokens.

### 1. Brief (once, not per run)
`node scripts/brief.ts status`. If `ok` is false:
- `rules` stale or no file → write the user-rules block (see `modes/onboarding.md` step 5b) and
  `node scripts/brief.ts build <file>`;
- only `template` stale → `node scripts/brief.ts build --keep-rules`.

### 2. Request
Write the items to buy to `data/runs/{today}-request.json`:
`[{ "item": "<plain ingredient, in the store's language>", "need": { "qty": 400, "unit": "g" }, "tags": ["bebe"], "slug": "<file-safe name>" }]`.
Query the plain ingredient ("riz", not "riz sachets cuisson 8 min"). `need` comes from the shopping list
(`total` + `unit`; omit when unknown). Tag items the user labels. Give a distinct `slug` per line, even for
the same ingredient with different tags. `ask` habits and staples join the request only after the user said yes.
The subagents' choices go to temporary files in `data/runs/{today}-picks/`: empty that folder before dispatching.

### 3. Subagents
Read the cart once (`capability:read_cart`) for `basketServiceId` (its `facilityServiceId`) and `subBasketType`.
Launch **Haiku** subagents (`model: haiku`), at most **8 at a time**, one per request line, each with exactly:
```
Read {brief path from brief.ts status} and follow it.
ITEM: {the request line as JSON}
CART: basketServiceId={…}, subBasketType={…}
PICK: {absolute path}/data/runs/{today}-picks/{slug}.json
```
Add nothing else to the prompt: the brief holds the rules, the steps and the output format.

### 4. Reconcile and check
When all are done, read the pick files (small JSON) and `capability:read_cart` (large output, saved to a
file: extract lines with a small node script, never paste it). Then check, yourself:
- **cart**: every `added` pick is in the cart with the right EAN and quantity; nothing else is there. Re-add a
  missing line once; report any other difference.
- **validity of each choice**, from the pick's `title` / `flags` / `packaging` and the brief: relevant raw
  ingredient, hard rules respected (including tags), no first-price range, quantity covers the need without
  waste (e.g. one bunch of spring onions, not two). Fix a wrong line yourself: `capability:remove`, then add the
  right product from the pick's `options` or ask the user.
Then, with the user: `doubtful` → show the ≤ 3 `options` one line each, add their pick yourself; `none` → say
why, offer another search term or skipping (plan: for a key item replace the recipe); `error` → report.
Delete `data/runs/{today}-picks/` once the Record step is done.

## Review

Show one table after the fact: item · product · quantity · price · why + the cart total. The user may
change any line: remove it with `capability:remove` (else `capability:set_quantity` with 0) and add the
replacement. When the user picks another product than the subagent's, remember it:
`node scripts/choices.ts set "<ingredient>" <ean> "<label>"`.
`ask` habits and staples are added only after an explicit yes (see the calling mode).

## Fill and verify

1. Lines added by subagents are already in the cart; add the lines decided during Reconcile and Review
   with `capability:add_to_cart`. Collect failures; keep going.
2. `capability:read_cart`; compare with the final table and report any difference.
3. To lower a quantity, follow the provider `notes`.
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
