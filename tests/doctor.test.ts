import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { nodeVersionOk, runDoctor, type DoctorDeps } from '../scripts/doctor.ts';
import { paths } from '../scripts/lib/paths.ts';
import { loadProvider, type McpProvider } from '../scripts/lib/provider.ts';
import { useTempRoot, writeValidProfile } from './helpers.ts';

let root = '';
beforeEach(() => { root = useTempRoot(); });

const recipeHtml = readFileSync(join(paths.fixtures('marmiton'), 'recipe-blanquette.html'), 'utf8');
const settings = JSON.parse(readFileSync(paths.settings(), 'utf8'));
const mapped: McpProvider = {
  ...(loadProvider('carrefour') as McpProvider),
  search: { tool: 'search_products', args: { q: '{query}' }, products_path: 'data',
    fields: { ean: 'ean', title: 'title', price: 'price', unit_price: { path: 'per', parse: 'unit_price' }, available: 'ok' } },
};
const liveRaw = { data: [{ ean: '1', title: 'Lait', price: 1, per: '1,00 €/l', ok: true }] };
const deps = (over: Partial<DoctorDeps> = {}): DoctorDeps => ({
  nodeVersion: 'v24.2.0',
  listMcpServers: async () => 'carrefour-drive: npx -y github:maximeallanic/CarrefourDriveMCP - ✓ Connected',
  fetcher: async () => recipeHtml,
  probe: async () => ({ isError: false, text: 'Session present\nVerification: HTTP 200' }),
  readSettings: () => settings,
  readFixture: () => recipeHtml,
  loadProvider: () => mapped,
  liveSearch: async () => liveRaw,
  readMappingFixtures: () => [],
  ...over,
});
const check = (r: Awaited<ReturnType<typeof runDoctor>>, id: string) => r.checks.find((c) => c.id === id);

test('nodeVersionOk', () => {
  assert.ok(nodeVersionOk('v24.2.0'));
  assert.ok(nodeVersionOk('v22.18.0'));
  assert.ok(nodeVersionOk('v23.6.1'));
  assert.ok(!nodeVersionOk('v22.6.0'));
  assert.ok(!nodeVersionOk('v23.5.0'));
  assert.ok(!nodeVersionOk('v20.11.0'));
});

test('fresh install: profile comes first — no store checks at all', async () => {
  let probed = false;
  let listed = false;
  const r = await runDoctor(deps({
    probe: async () => { probed = true; return { isError: false, text: '' }; },
    listMcpServers: async () => { listed = true; return ''; },
  }), { offline: false });
  assert.ok(existsSync(join(root, 'profile.yml')));
  assert.equal(r.onboardingNeeded, true);
  assert.equal(r.blocking, false);
  assert.equal(check(r, 'login'), undefined);
  assert.equal(check(r, 'mcp-registered'), undefined);
  assert.equal(check(r, 'product-mapping'), undefined);
  assert.ok(!probed && !listed);
});

test('healthy setup', async () => {
  writeValidProfile(root);
  const r = await runDoctor(deps(), { offline: false });
  assert.equal(r.onboardingNeeded, false);
  assert.equal(r.blocking, false);
  assert.equal(r.planEnabled, true);
  for (const c of r.checks) assert.equal(c.status, 'pass', `${c.id}: ${c.message}`);
});

test('invalid profile names the field', async () => {
  writeValidProfile(root, 'household: { adults: 0 }\n');
  const r = await runDoctor(deps(), { offline: true });
  assert.equal(r.onboardingNeeded, true);
  assert.match(check(r, 'profile')?.message ?? '', /household\.adults/);
});

test('missing deny entry blocks', async () => {
  writeValidProfile(root);
  const r = await runDoctor(deps({ readSettings: () => ({}) }), { offline: true });
  assert.equal(check(r, 'checkout-deny')?.status, 'fail');
  assert.equal(r.blocking, true);
});

test('expired login blocks; probe crash is unknown and non-blocking', async () => {
  writeValidProfile(root);
  const expired = await runDoctor(deps({ probe: async () => ({ isError: false, text: 'Verification: FAILED (HTTP 401)' }) }), { offline: false });
  assert.equal(check(expired, 'login')?.status, 'fail');
  assert.equal(expired.blocking, true);
  const busy = await runDoctor(deps({ probe: async () => { throw new Error('profile locked'); } }), { offline: false });
  assert.equal(check(busy, 'login')?.status, 'unknown');
  assert.equal(busy.blocking, false);
});

test('claude CLI unavailable → unknown, not blocking; server not registered → blocking', async () => {
  writeValidProfile(root);
  const noCli = await runDoctor(deps({ listMcpServers: async () => { throw new Error('ENOENT'); } }), { offline: false });
  assert.equal(check(noCli, 'mcp-registered')?.status, 'unknown');
  assert.equal(noCli.blocking, false);
  const missing = await runDoctor(deps({ listMcpServers: async () => 'other: x' }), { offline: false });
  assert.equal(check(missing, 'mcp-registered')?.status, 'fail');
  assert.match(check(missing, 'mcp-registered')?.fix ?? '', /claude mcp add carrefour-drive/);
});

test('recipe source down → plan disabled, not blocking', async () => {
  writeValidProfile(root);
  const r = await runDoctor(deps({ fetcher: async () => { throw new Error('HTTP 403'); } }), { offline: false });
  assert.equal(check(r, 'recipe-source:marmiton')?.status, 'warn');
  assert.equal(r.planEnabled, false);
  assert.equal(check(r, 'plan-mode')?.status, 'fail');
  assert.equal(r.blocking, false);
});

test('old node blocks; offline skips live checks', async () => {
  writeValidProfile(root);
  const r = await runDoctor(deps({ nodeVersion: 'v20.0.0' }), { offline: true });
  assert.equal(r.blocking, true);
  assert.equal(check(r, 'login'), undefined);
  assert.equal(check(r, 'mcp-registered')?.status, 'unknown');
  assert.equal(check(r, 'recipe-source:marmiton')?.status, 'pass');
});

test('no product mapping yet → blocking product-mapping check', async () => {
  writeValidProfile(root);
  const r = await runDoctor(deps({ loadProvider: (id) => loadProvider(id) }), { offline: true });
  assert.equal(check(r, 'product-mapping')?.status, 'fail');
  assert.match(check(r, 'product-mapping')?.fix ?? '', /mapping discovery/);
  assert.equal(r.blocking, true);
});

test('mapping health: offline fixtures and live search', async () => {
  writeValidProfile(root);
  const offline = await runDoctor(deps({ readMappingFixtures: () => [{ data: [{ ean: '1', title: 'x' }] }] }), { offline: true });
  assert.equal(check(offline, 'product-mapping')?.status, 'fail');
  assert.match(check(offline, 'product-mapping')?.message ?? '', /price, unit_price/);
  const live = await runDoctor(deps(), { offline: false });
  assert.equal(check(live, 'product-mapping')?.status, 'pass');
  const liveBroken = await runDoctor(deps({ liveSearch: async () => ({ data: [] }) }), { offline: false });
  assert.equal(check(liveBroken, 'product-mapping')?.status, 'fail');
  const liveDown = await runDoctor(deps({ liveSearch: async () => { throw new Error('busy'); } }), { offline: false });
  assert.equal(check(liveDown, 'product-mapping')?.status, 'unknown');
});
