# Mode: add — everyday items

Uses `modes/_cart.md`.

1. **Pre-flight** (`_cart.md`) — skip when called during a plan run.
2. Parked items waiting? (`_cart.md`, Request) — they are added to this run. Split the request into items with quantities (default: one pack). Vague items ("something for the
   dishwasher") → `capability:search` and offer 2–3 options.
3. Pick and add each item (`_cart.md` Product resolution and fill). Unavailable → say so and offer alternatives.
4. **Review → Fill and verify → Record** (`_cart.md`).
