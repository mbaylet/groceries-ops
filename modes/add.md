# Mode: add — everyday items

Uses `modes/_cart.md`.

1. **Pre-flight** (`_cart.md`) — skip when called during a plan run.
2. Split the request into items with quantities (default: one pack). Vague items ("something for the
   dishwasher") → `capability:search` and offer 2–3 options.
3. Resolve each item (`_cart.md` Product resolution). Unavailable → say so and offer alternatives.
4. **Review → Fill and verify → Record** (`_cart.md`).
