# Price reading, every two months (used by the session start in `AGENTS.md`)

Reads the store's prices for the ingredients in `config/price-references.yml`, so plan mode can show what each
recipe costs. Search only: nothing here touches the cart. Prices are estimates; a price a few weeks old is fine.

Reached when `node scripts/prices.ts status` says `enabled: true` and `stale: true`.

1. `capability:session_check` (pass its `args`). Anything but `ok_pattern` (an unclear answer such as HTTP 404 also
   makes every search fail) → open `capability:login` directly (the user signs in in the browser window), then resume. Login refused or failed → skip the reading, say so in one line and keep the
   existing prices.
2. Launch **one Haiku subagent** (`model: haiku`) with exactly this prompt, `{search}` being the tool that
   `capability:search` resolves to and `{root}` the project root. The store's server only allows one browser, so
   never run a reading from a script or a second server.
   ```
   Load the tool {search} with ToolSearch. Run `node {root}/scripts/prices.ts references`. For each entry, one
   after the other: call {search} with q = its query; the result is saved to a file (if it comes back inline,
   write it unchanged to {root}/data/runs/prices/{id}.json); then run
   `node {root}/scripts/prices.ts ingest {id} <that file>`. If a search or an ingest fails, note the id and go on;
   do not read the search results. Do not call any other store tool. Reply with one line: the number of prices
   stored and the failed ids.
   ```
3. When it reports:
   - at least half of the references stored → `node scripts/prices.ts done`; list failed ids in one line only if
     there are more than five (their previous price stays).
   - otherwise → do not run `done` (the reading starts over next session) and say in one line that prices could
     not be refreshed.

Do not wait for the subagent if `status` says `hasPrices: true`: the existing prices keep working. If it says
`hasPrices: false` and the user is in plan mode, wait for the subagent before showing the shortlist.
