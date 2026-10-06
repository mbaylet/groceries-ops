# Mode: habits — what the household buys regularly

1. `node scripts/habits.ts list` → table: item · mode · every N days · last bought · next due. Sort by
   next due. Modes: `auto` (added when due), `ask` (asked when due), `track` (learned from store
   history, never asked — show these last, collapsed unless the user asks).
2. The user can:
   - switch mode → `node scripts/habits.ts set-mode <key> auto|ask|track` (only on the user's explicit words);
   - change an interval → `node scripts/habits.ts set-interval <key> <days>`;
   - remove an item → `node scripts/habits.ts remove <key>`;
   - see suggestions → `node scripts/habits.ts propose` (tracked items with a regular rhythm worth promoting).
3. Show the updated row after each change.
