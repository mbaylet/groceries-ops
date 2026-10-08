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

test('cart products are picked by Haiku subagents following a rules brief', () => {
  const cart = read('modes/_cart.md');
  assert.match(cart, /Haiku/);
  assert.match(cart, /node scripts\/brief\.ts status/);
  assert.match(cart, /data\/product-brief\.md/);
  assert.match(cart, /at most \*\*8 at a time\*\*/);
  assert.doesNotMatch(cart, /products\.ts resolve/);
  assert.doesNotMatch(cart, /preferred_brand|store_brand_ok/);
});

test('onboarding turns free-text preferences into the product brief', () => {
  const o = read('modes/onboarding.md');
  assert.match(o, /preferences_text/);
  assert.match(o, /node scripts\/brief\.ts build/);
  assert.match(o, /First-price products: excluded/);
});
