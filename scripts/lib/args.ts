export type Flags = Record<string, string | boolean>;
export interface ParsedArgs { positional: string[]; flags: Flags }

export function parseArgs(argv: string[], booleanFlags: string[] = []): ParsedArgs {
  const positional: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { positional.push(a); continue; }
    const name = a.slice(2);
    if (booleanFlags.includes(name)) { flags[name] = true; continue; }
    const v = argv[i + 1];
    if (v === undefined) throw new Error(`--${name} needs a value`);
    flags[name] = v;
    i++;
  }
  return { positional, flags };
}

export function flagString(flags: Flags, name: string): string | undefined {
  const v = flags[name];
  return typeof v === 'string' ? v : undefined;
}

export function flagNumber(flags: Flags, name: string): number | undefined {
  const v = flagString(flags, name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`--${name} must be a number, got "${v}"`);
  return n;
}
