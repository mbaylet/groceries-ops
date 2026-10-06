# Mode: habits — what the household buys regularly

1. `node scripts/habits.ts list` → table: item · mode (auto/ask) · every N days · last bought ·
   next due. Sort by next due.
2. The user can:
   - switch mode → `node scripts/habits.ts set-mode <key> auto|ask` (only on the user's explicit words);
   - change an interval → `node scripts/habits.ts set-interval <key> <days>`;
   - remove an item → `node scripts/habits.ts remove <key>`;
   - see suggestions → `node scripts/habits.ts propose` (items whose history suggests `auto`).
3. Show the updated row after each change.
