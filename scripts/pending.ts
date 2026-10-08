import { flagString, parseArgs } from './lib/args.ts';
import { isMain, printJson, runMain } from './lib/cli.ts';
import { today } from './lib/dates.ts';
import { addPending, loadPending, removePending, savePending } from './lib/pending.ts';

const USAGE = `usage:
  pending.ts add "<item>" [--qty "2 packs"] [--today YYYY-MM-DD]   park an item for the next cart
  pending.ts list                                                  parked items
  pending.ts remove "<item>"...                                    drop parked items
  pending.ts done "<item>"...                                      same as remove: they were added to the cart`;

async function main(): Promise<void> {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [cmd, ...rest] = positional;
  const f = loadPending();
  switch (cmd) {
    case 'list':
      printJson(f.items);
      return;
    case 'add': {
      if (!rest[0]) throw new Error(USAGE);
      const r = addPending(f, rest[0], flagString(flags, 'today') ?? today(), flagString(flags, 'qty'));
      savePending(f);
      printJson({ ...r, total: f.items.length });
      return;
    }
    case 'remove':
    case 'done': {
      if (rest.length === 0) throw new Error(USAGE);
      const removed = removePending(f, rest);
      savePending(f);
      printJson({ removed: removed.map((i) => i.item), remaining: f.items.length });
      return;
    }
    default:
      throw new Error(USAGE);
  }
}

if (isMain(import.meta.url)) runMain(main);
