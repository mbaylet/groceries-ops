import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import YAML from 'yaml';
import { briefStatus, extractUserRules, renderBrief, renderEntryLevel, renderTools } from '../scripts/lib/brief.ts';
import { loadProvider, type McpProvider } from '../scripts/lib/provider.ts';
import { paths } from '../scripts/lib/paths.ts';
import type { Profile } from '../scripts/lib/profile.ts';
import { VALID_PROFILE_YAML, useTempRoot } from './helpers.ts';

const provider = loadProvider('carrefour') as McpProvider;
const profile = YAML.parse(VALID_PROFILE_YAML) as Profile;
const template = () => readFileSync(paths.briefTemplate(), 'utf8');
const save = (text: string) => {
  mkdirSync(dirname(paths.productBrief()), { recursive: true });
  writeFileSync(paths.productBrief(), text);
};

beforeEach(() => useTempRoot());

test('the shipped template has every placeholder and no store or user specifics', () => {
  const t = template();
  for (const k of ['{{TOOLS}}', '{{ENTRY_LEVEL}}', '{{USER_RULES}}']) assert.ok(t.includes(k), k);
  assert.doesNotMatch(t, /carrefour|simpl|bebe|plein air/i);
});

test('rendering fills tools, entry-level brands and the user rules block', () => {
  const text = renderBrief(template(), provider, profile, 'Hard rule: eggs must be plein air.');
  assert.doesNotMatch(text, /\{\{/);
  assert.match(text, /mcp__carrefour-drive__search_products/);
  assert.match(text, /mcp__carrefour-drive__add_item_to_cart/);
  assert.match(text, /SIMPL/);
  assert.equal(extractUserRules(text), 'Hard rule: eggs must be plein air.');
});

test('entry-level text falls back to a generic rule when the store declares no range', () => {
  assert.match(renderEntryLevel({ ...provider, entry_level_brands: undefined }), /premier prix/);
  assert.match(renderTools({ ...provider, agent_notes: undefined }), /Search:/);
});

test('status: missing → stale; fresh after build; stale when rules or template change', () => {
  assert.deepEqual(briefStatus(profile, provider), { exists: false, path: paths.productBrief(), stale: ['rules', 'template'], ok: false });
  save(renderBrief(template(), provider, profile, 'rules'));
  assert.equal(briefStatus(profile, provider).ok, true);
  const changed = { ...profile, preferences_text: 'autre chose' } as Profile;
  assert.deepEqual(briefStatus(changed, provider).stale, ['rules']);
  const moved = { ...provider, entry_level_brands: ['SIMPL', 'AUTRE'] };
  assert.deepEqual(briefStatus(profile, moved).stale, ['template']);
});
