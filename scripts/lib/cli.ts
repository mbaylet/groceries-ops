import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function isMain(metaUrl: string): boolean {
  const entry = process.argv[1];
  return entry !== undefined && metaUrl === pathToFileURL(resolve(entry)).href;
}

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function runMain(main: () => Promise<void> | void): void {
  Promise.resolve()
    .then(main)
    .catch((err: unknown) => {
      process.stderr.write(`${JSON.stringify({ error: err instanceof Error ? err.message : String(err) })}\n`);
      process.exitCode = 1;
    });
}

/** Reads JSON from a file path, or stdin when the path is "-" or missing. */
export async function readJsonInput(path?: string): Promise<unknown> {
  if (path && path !== '-') return JSON.parse(readFileSync(path, 'utf8'));
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
