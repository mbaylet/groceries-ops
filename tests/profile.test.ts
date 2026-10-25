import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { loadProfile, requireProfile, validateProfile } from '../scripts/lib/profile.ts';
import { paths } from '../scripts/lib/paths.ts';
import { VALID_PROFILE_YAML, useTempRoot, writeValidProfile } from './helpers.ts';

const opts = { sources: ['marmiton'], providers: ['carrefour', 'list'] };

test('valid profile passes', () => {
  const v = validateProfile(YAML.parse(VALID_PROFILE_YAML), opts);
  assert.ok(v.ok);
  if (v.ok) assert.equal(v.profile.household.servings, 4);
});

test('errors name the field', () => {
  const raw = YAML.parse(VALID_PROFILE_YAML);
  raw.household.adults = 0;
  raw.time.weekday_max_min = 'thirty';
  raw.store.provider = 'auchan';
  raw.recipes.sources = ['750g'];
  raw.recipes.min_rating = 6;
  delete raw.plan;
  const v = validateProfile(raw, opts);
  assert.ok(!v.ok);
  if (!v.ok) {
    const joined = v.errors.join('\n');
    for (const field of ['household.adults', 'time.weekday_max_min', 'store.provider', 'recipes.sources', 'recipes.min_rating', 'plan:'])
      assert.ok(joined.includes(field), `missing error for ${field}:\n${joined}`);
  }
});

test('provider/source checks are skipped when not supplied', () => {
  const raw = YAML.parse(VALID_PROFILE_YAML);
  raw.store.provider = 'whatever';
  assert.ok(validateProfile(raw).ok);
});

test('template is invalid as-is', () => {
  const v = validateProfile(YAML.parse(readFileSync(paths.profileTemplate(), 'utf8')), opts);
  assert.ok(!v.ok);
});

test('loadProfile statuses', () => {
  const root = useTempRoot();
  assert.equal(loadProfile(opts).status, 'missing');
  assert.throws(() => requireProfile(opts), /onboarding/);
  copyFileSync(paths.profileTemplate(), join(root, 'profile.yml'));
  assert.equal(loadProfile(opts).status, 'template');
  writeValidProfile(root, 'household: [');
  assert.equal(loadProfile(opts).status, 'invalid');
  writeValidProfile(root);
  assert.equal(requireProfile(opts).food.exclusions[0], 'champignon');
});

test('tags and preferences_text are validated', () => {
  const raw = YAML.parse(VALID_PROFILE_YAML);
  raw.tags = 'enfant';
  raw.preferences_text = 42;
  const v = validateProfile(raw, opts);
  assert.ok(!v.ok);
  if (!v.ok) {
    const all = v.errors.join('\n');
    for (const s of ['tags:', 'preferences_text:']) assert.ok(all.includes(s), s);
  }
});

test('optional prep caps and rating count are validated', () => {
  const raw = YAML.parse(VALID_PROFILE_YAML);
  raw.time.weekday_prep_max_min = 10;
  raw.time.weekend_prep_max_min = 20;
  raw.recipes.min_rating = 4.5;
  raw.recipes.min_rating_count = 10;
  assert.ok(validateProfile(raw, opts).ok);

  raw.time.weekday_prep_max_min = 'ten';
  raw.time.weekend_prep_max_min = 2;
  raw.recipes.min_rating_count = -1;
  const v = validateProfile(raw, opts);
  assert.ok(!v.ok);
  if (!v.ok) {
    const joined = v.errors.join('\n');
    for (const field of ['time.weekday_prep_max_min', 'time.weekend_prep_max_min', 'recipes.min_rating_count'])
      assert.ok(joined.includes(field), `missing error for ${field}:\n${joined}`);
  }
});
