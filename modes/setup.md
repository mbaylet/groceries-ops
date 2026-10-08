# Mode: setup — check everything works

0. **Profile first:** if `node scripts/doctor.ts --json --offline` reports `onboardingNeeded: true`, stop
   here and run `modes/onboarding.md`; come back to setup only once the profile is valid.
1. `node scripts/doctor.ts --json`. Present each check that is not `pass`, with its fix, in the user's
   language. Offer to apply fixes that only touch system files (e.g. a missing deny entry).
2. **Login** (MCP provider): `capability:session_check` through your own MCP connection — this also
   settles a doctor `unknown`. Expired or no session → `capability:login`; the user completes the
   sign-in in the browser window; check again.
3. **Search test:** `capability:search` for "lait" → expect at least one product with an EAN and a
   price (read the saved output with a small script; it is large). Report what came back.
4. Summary: ready, or the list of what to fix.
