import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { parseIsoDuration } from '../scripts/lib/duration.ts';
import { daysBetween, addDays, isIsoDate } from '../scripts/lib/dates.ts';
import { parseArgs, flagNumber } from '../scripts/lib/args.ts';
import { readYaml, writeYaml } from '../scripts/lib/yaml-io.ts';
import { paths } from '../scripts/lib/paths.ts';
import { useTempRoot } from './helpers.ts';

test('parseIsoDuration', () => {
  assert.equal(parseIsoDuration('PT15M'), 15);
  assert.equal(parseIsoDuration('PT2H15M'), 135);
  assert.equal(parseIsoDuration('PT1H'), 60);
  assert.equal(parseIsoDuration('P0DT0H30M'), 30);
  assert.equal(parseIsoDuration('PT45S'), 1);
  assert.equal(parseIsoDuration('PT0M'), 0);
  for (const v of ['', 'P', 'PT', '15 min', undefined, null, 42]) assert.equal(parseIsoDuration(v), undefined);
});

test('dates', () => {
  assert.equal(daysBetween('2026-10-01', '2026-10-06'), 5);
  assert.equal(daysBetween('2026-10-20', '2026-10-27'), 7); // crosses DST change
  assert.equal(daysBetween('2026-10-06', '2026-10-01'), -5);
  assert.equal(addDays('2026-09-28', 5), '2026-10-03');
  assert.ok(isIsoDate('2026-10-06'));
  assert.ok(!isIsoDate('06/10/2026'));
});

test('parseArgs', () => {
  const a = parseArgs(['fetch', 'u1', '--max-min', '30', 'u2', '--json'], ['json']);
  assert.deepEqual(a.positional, ['fetch', 'u1', 'u2']);
  assert.equal(a.flags['json'], true);
  assert.equal(flagNumber(a.flags, 'max-min'), 30);
  assert.throws(() => parseArgs(['--limit']), /--limit needs a value/);
  assert.throws(() => flagNumber({ limit: 'x' }, 'limit'), /must be a number/);
});

test('yaml io roundtrip under GROCERIES_ROOT', () => {
  const root = useTempRoot();
  assert.equal(paths.habits(), join(root, 'data', 'habits.yml'));
  assert.deepEqual(readYaml(paths.habits(), { habits: [] }), { habits: [] });
  writeYaml(paths.habits(), { habits: [{ key: 'a' }] });
  assert.ok(existsSync(paths.habits()));
  assert.deepEqual(readYaml(paths.habits(), { habits: [] }), { habits: [{ key: 'a' }] });
});
