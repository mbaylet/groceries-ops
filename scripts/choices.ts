import { flagString, parseArgs } from './lib/args.ts';
import { isMain, printJson, runMain } from './lib/cli.ts';
import { today } from './lib/dates.ts';
import { getChoice, loadChoices, removeChoice, saveChoices, setChoice } from './lib/choices.ts';

const USAGE = `usage:
  choices.ts get "<ingredient>"
  choices.ts set "<ingredient>" <ean> "<label>" [--today YYYY-MM-DD]
  choices.ts remove "<ingredient>"
  choices.ts list`;

async function main(): Promise<void> {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [cmd, ingredient, ean, label] = positional;
  const f = loadChoices();
  switch (cmd) {
    case 'list':
      printJson(f.choices);
      return;
    case 'get':
      if (!ingredient) throw new Error(USAGE);
      printJson(getChoice(f, ingredient) ?? null);
      return;
    case 'set':
      if (!ingredient || !ean || !label) throw new Error(USAGE);
      printJson(setChoice(f, ingredient, ean, label, flagString(flags, 'today') ?? today()));
      saveChoices(f);
      return;
    case 'remove':
      if (!ingredient) throw new Error(USAGE);
      printJson({ removed: removeChoice(f, ingredient) });
      saveChoices(f);
      return;
    default:
      throw new Error(USAGE);
  }
}

if (isMain(import.meta.url)) runMain(main);
