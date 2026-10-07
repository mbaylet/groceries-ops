# Mode: setup — check everything works

0. **Profile first:** if `node scripts/doctor.ts --json --offline` reports `onboardingNeeded: true`, stop
   here and run `modes/onboarding.md`; come back to setup only once the profile is valid.
1. `node scripts/doctor.ts --json`. Present each check that is not `pass`, with its fix, in the user's
   language. Offer to apply fixes that only touch system files (e.g. a missing deny entry).
2. **Login** (MCP provider): `capability:session_check` through your own MCP connection — this also
   settles a doctor `unknown`. Expired or no session → `capability:login`; the user completes the
   sign-in in the browser window; check again.
3. **Product mapping** (MCP provider):
   - If the provider YAML has no `search.fields`, or the doctor reported `product-mapping` failing →
     **mapping discovery**: call `capability:search` for 4–5 typed queries (`oeufs`, a `bio` product,
     `bananes`, a store-brand staple such as `lait`, one likely unavailable item) and save each raw
     result to `tests/fixtures/{provider}/search-<query>.json`. Read one response, find where the
     product list is (`products_path`) and the fields for `ean`, `title`, `brand`, `price`,
     `unit_price` (`parse: unit_price`), `pack` (`parse: pack`), `available` (`parse: bool`, or `not`
     for an out-of-stock flag), `rating`, and `text` (label/badge/description paths). Write them in the
     provider YAML `search` block, then run
     `node scripts/products.ts map-check tests/fixtures/{provider}/search-*.json` until `healthy` is
     true. Show the user 3 mapped sample products and keep the mapping on their OK.
   - Otherwise run `node scripts/products.ts map-check` on the saved fixtures and report the result.
4. **Search test:** `capability:search` for "lait" → expect at least one product with an EAN and a
   price. Report what came back.
5. Summary: ready, or the list of what to fix.
