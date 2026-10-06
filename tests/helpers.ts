import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Points the data root at a fresh temp dir and returns it. */
export function useTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'groceries-'));
  process.env.GROCERIES_ROOT = dir;
  return dir;
}
