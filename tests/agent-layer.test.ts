import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../scripts/lib/paths.ts';
import { CAPABILITY_NAMES, listProviderIds, loadProvider } from '../scripts/lib/provider.ts';

const read = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');
const modeFiles = readdirSync(join(REPO_ROOT, 'modes')).map((f) => `modes/${f}`);
const agentFiles = ['AGENTS.md', '.claude/skills/groceries/SKILL.md', ...modeFiles];

test('router references existing mode files', () => {
  const refs = [...read('.claude/skills/groceries/SKILL.md').matchAll(/`(modes\/[a-z_-]+\.md)`/g)].map((m) => m[1]);
  for (const m of ['onboarding', 'plan', 'add', 'habits', 'setup', '_cart']) assert.ok(refs.includes(`modes/${m}.md`), m);
  for (const r of refs) assert.ok(existsSync(join(REPO_ROOT, r)), r);
});

test('every referenced script exists', () => {
  for (const f of agentFiles)
    for (const m of read(f).matchAll(/node (scripts\/[a-z-]+\.ts)/g)) assert.ok(existsSync(join(REPO_ROOT, m[1])), `${f}: ${m[1]}`);
});

test('agent instructions never name a forbidden tool', () => {
  for (const id of listProviderIds()) {
    const p = loadProvider(id);
    if (p.kind !== 'mcp') continue;
    for (const f of agentFiles) for (const tool of p.forbidden) assert.ok(!read(f).includes(tool), `${f} mentions ${tool}`);
  }
});

test('capability references are known', () => {
  const known = new Set<string>(CAPABILITY_NAMES);
  for (const f of agentFiles)
    for (const m of read(f).matchAll(/capability:([a-z_]+)/g)) assert.ok(known.has(m[1]), `${f}: capability:${m[1]}`);
});

test('CLAUDE.md imports AGENTS.md', () => {
  assert.match(read('CLAUDE.md'), /@AGENTS\.md/);
});

test('profile comes first: router and setup gate on onboarding', () => {
  assert.match(read('.claude/skills/groceries/SKILL.md'), /onboardingNeeded[\s\S]*modes\/onboarding\.md/);
  const setup = read('modes/setup.md');
  const gate = setup.indexOf('onboardingNeeded');
  assert.ok(gate >= 0, 'setup.md must check onboardingNeeded');
  assert.ok(gate < setup.indexOf('capability:session_check'), 'setup.md must gate before the login check');
});

test('cart resolution goes through the script, with the fallback', () => {
  const cart = read('modes/_cart.md');
  assert.match(cart, /node scripts\/products\.ts resolve/);
  assert.match(cart, /--from-search/);
  assert.doesNotMatch(cart, /preferred_brand|store_brand_ok/);
});

test('onboarding converts free-text preferences and validates them', () => {
  const o = read('modes/onboarding.md');
  assert.match(o, /preferences_text/);
  assert.match(o, /node scripts\/products\.ts validate/);
});

test('setup runs mapping discovery and map-check', () => {
  const s = read('modes/setup.md');
  assert.match(s, /node scripts\/products\.ts map-check/);
  assert.match(s, /tests\/fixtures\/\{provider\}\/search-/);
});
