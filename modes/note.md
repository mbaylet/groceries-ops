# Mode: note — park something for the next cart

The user noticed they are running out of something ("the last dishwasher tablet") and wants it added at
the next cart without choosing a product now. This mode never touches the store.

1. Split the request into items. For each: the plain name in the store's language ("pastilles
   lave-vaisselle", not a brand) and, only when the user said one, a quantity (`--qty "2 boîtes"`).
2. `node scripts/pending.ts add "<item>" [--qty "<qty>"]` for each. `duplicate: true` means it was
   already parked: say so, and mention a changed quantity.
3. Confirm in one line per item ("Noted: pastilles lave-vaisselle — it will join your next cart"). If
   the user says they want a specific product (a brand, "the usual one"), remember it now with
   `node scripts/choices.ts set "<item>" <ean> "<label>"` when they give an EAN, otherwise leave it for
   cart time.
4. No argument → `node scripts/pending.ts list` and show what is waiting (item, quantity, since when).
   To drop something: `node scripts/pending.ts remove "<item>"`.

Parked items are picked up by the next `plan` or `add` (see `_cart.md`, Request).
