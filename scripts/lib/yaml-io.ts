import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import YAML from 'yaml';

export function readYaml<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback;
  const value: unknown = YAML.parse(readFileSync(file, 'utf8'));
  return (value ?? fallback) as T;
}

/** Atomic write: temp file then rename. */
export function writeYaml(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, YAML.stringify(value));
  renameSync(tmp, file);
}
