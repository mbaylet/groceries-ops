import { flagString, parseArgs } from './lib/args.ts';
import { isMain, printJson, readJsonInput, runMain } from './lib/cli.ts';
import { today } from './lib/dates.ts';
import {
  dueItems, effectiveInterval, isDue, lastPurchase, loadHabits, nextDue, proposals, reconcile, recordAnswer,
  recordPurchases, saveHabits, type Habit, type HabitsFile, type ItemRef, type Order,
} from './lib/habits.ts';

const USAGE = `usage (all accept --today YYYY-MM-DD):
  habits.ts list | due | propose
  habits.ts record <items.json|-> [--confirmed]     items: [{ "name": "...", "ean": "..." }]
  habits.ts answer <key> yes|no
  habits.ts reconcile <orders.json|->              orders: [{ "date": "YYYY-MM-DD", "items": [...] }]
  habits.ts set-mode <key> auto|ask|track
  habits.ts set-interval <key> <days>
  habits.ts remove <key>`;

function find(f: HabitsFile, key: string): Habit {
  const h = f.habits.find((x) => x.key === key);
  if (!h) throw new Error(`Unknown habit "${key}"`);
  return h;
}

const view = (h: Habit, day: string) => ({
  key: h.key, name: h.name, ean: h.ean, mode: h.mode, interval_days: effectiveInterval(h),
  last_bought: lastPurchase(h), next_due: nextDue(h), due: isDue(h, day),
});

async function main(): Promise<void> {
  const { positional, flags } = parseArgs(process.argv.slice(2), ['confirmed']);
  const [cmd, a, b] = positional;
  const day = flagString(flags, 'today') ?? today();
  const f = loadHabits();
  switch (cmd) {
    case 'list':
      printJson(f.habits.map((h) => view(h, day)));
      return;
    case 'due': {
      const d = dueItems(f, day);
      printJson({ auto: d.auto.map((h) => view(h, day)), ask: d.ask.map((h) => view(h, day)) });
      return;
    }
    case 'propose':
      printJson(proposals(f, day));
      return;
    case 'record': {
      const items = (await readJsonInput(a)) as ItemRef[];
      recordPurchases(f, items, day, flags['confirmed'] ? 'confirmed' : 'pending');
      saveHabits(f);
      printJson({ recorded: items.length });
      return;
    }
    case 'answer':
      if (!a || (b !== 'yes' && b !== 'no')) throw new Error(USAGE);
      printJson(view(recordAnswer(f, a, b, day), day));
      saveHabits(f);
      return;
    case 'reconcile': {
      const res = reconcile(f, (await readJsonInput(a)) as Order[], day);
      saveHabits(f);
      printJson(res);
      return;
    }
    case 'set-mode':
      if (!a || (b !== 'auto' && b !== 'ask' && b !== 'track')) throw new Error(USAGE);
      find(f, a).mode = b;
      saveHabits(f);
      printJson(view(find(f, a), day));
      return;
    case 'set-interval': {
      const days = Number(b);
      if (!a || !Number.isInteger(days) || days < 1) throw new Error(USAGE);
      find(f, a).interval_override = days;
      saveHabits(f);
      printJson(view(find(f, a), day));
      return;
    }
    case 'remove':
      if (!a) throw new Error(USAGE);
      find(f, a);
      f.habits = f.habits.filter((h) => h.key !== a);
      saveHabits(f);
      printJson({ removed: a });
      return;
    default:
      throw new Error(USAGE);
  }
}

if (isMain(import.meta.url)) runMain(main);
