import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from './lib/args.ts';
import { briefStatus, extractUserRules, renderBrief } from './lib/brief.ts';
import { isMain, printJson, runMain } from './lib/cli.ts';
import { paths } from './lib/paths.ts';
import { requireProfile } from './lib/profile.ts';
import { loadProvider, listProviderIds } from './lib/provider.ts';
import { sourceIds } from './recipe-sources/index.ts';

const USAGE = `usage:
  brief.ts status                     is data/product-brief.md present and up to date?
  brief.ts build <user-rules.md>      render the template + the user rules (written by the agent at onboarding)
  brief.ts build --keep-rules         re-render with the user rules already in the brief (template/provider changed)`;

async function main(): Promise<void> {
  const { positional, flags } = parseArgs(process.argv.slice(2), ['keep-rules']);
  const [cmd, rulesFile] = positional;
  const profile = requireProfile({ sources: sourceIds(), providers: listProviderIds() });
  const provider = loadProvider(profile.store.provider);
  if (provider.kind !== 'mcp') throw new Error(`Provider "${provider.id}" has no store connection: no product brief needed`);
  if (cmd === 'status') {
    printJson(briefStatus(profile, provider));
    return;
  }
  if (cmd === 'build') {
    let rules: string | undefined;
    if (flags['keep-rules'] === true) rules = extractUserRules(readFileSync(paths.productBrief(), 'utf8'));
    else if (rulesFile) rules = readFileSync(rulesFile, 'utf8');
    if (!rules?.trim()) throw new Error(`No user rules to write. ${USAGE}`);
    const text = renderBrief(readFileSync(paths.briefTemplate(), 'utf8'), provider, profile, rules);
    mkdirSync(dirname(paths.productBrief()), { recursive: true });
    writeFileSync(paths.productBrief(), text);
    printJson({ written: paths.productBrief(), chars: text.length, status: briefStatus(profile, provider) });
    return;
  }
  throw new Error(USAGE);
}

if (isMain(import.meta.url)) runMain(main);
