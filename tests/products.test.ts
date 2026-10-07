import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { itemFileName, runResolve, suggestions } from '../scripts/products.ts';
import { loadProvider, type McpProvider } from '../scripts/lib/provider.ts';
import type { McpSession } from '../scripts/lib/mcp-client.ts';
import type { Profile } from '../scripts/lib/profile.ts';
import { paths } from '../scripts/lib/paths.ts';
import { VALID_PROFILE_YAML, useTempRoot } from './helpers.ts';

const provider: McpProvider = {
  ...(loadProvider('carrefour') as McpProvider),
  search: {
    tool: 'search_products',
    args: { q: '{query}' },
    products_path: 'data',
    fields: { ean: 'ean', title: 'title', price: { path: 'price', parse: 'price' }, unit_price: { path: 'per', parse: 'unit_price' } },
  },
};
const catalog: Record<string, unknown> = {
  oeufs: { data: [
    { ean: '1', title: 'Oeufs élevés au sol x12', price: 2.5, per: '0,21 €/pièce' },
    { ean: '2', title: 'Oeufs plein air x12', price: 3.5, per: '0,29 €/pièce' },
  ] },
  riz: { data: [{ ean: '9', title: 'Riz long', price: 2, per: '2,00 €/kg' }] },
  vide: { data: [] },
};
const profile = YAML.parse(VALID_PROFILE_YAML) as Profile;
const day = '2026-10-07';

function fakeOpen(log: string[], errorFor: string[] = []) {
  return async (): Promise<McpSession> => ({
    async call(tool, args) {
      log.push(`${tool}:${String(args.q)}`);
      const q = String(args.q);
      if (errorFor.includes(q)) return { isError: true, text: 'boom' };
      return { isError: false, text: JSON.stringify(catalog[q] ?? { data: [] }) };
    },
    async close() {
      log.push('close');
    },
  });
}

beforeEach(() => useTempRoot());

test('resolves items through one session; raw results go to files, not output', async () => {
  const log: string[] = [];
  const out = await runResolve([{ item: 'oeufs', need: { qty: 6 } }, { item: 'riz' }], { today: day },
    { profile, provider, open: fakeOpen(log), preferredEans: () => [] });
  assert.ok('resolved' in out);
  if (!('resolved' in out)) return;
  assert.deepEqual(log, ['search_products:oeufs', 'search_products:riz', 'close']);
  assert.deepEqual(out.resolved.map((r) => r.ean), ['2', '9']);
  assert.deepEqual(out.stats, { items: 2, chosen: 2, exceptions: 0 });
  assert.ok(existsSync(join(paths.runs(), `${day}-search`, 'oeuf.json')));
  assert.ok(!JSON.stringify(out).includes('élevés au sol'));
});

test('empty search, tool error and unknown item become exceptions without stopping the run (review focus 1, 5)', async () => {
  const log: string[] = [];
  const out = await runResolve([{ item: 'vide' }, { item: 'oeufs' }, { item: 'riz' }], { today: day },
    { profile, provider, open: fakeOpen(log, ['oeufs']), preferredEans: () => [] });
  if (!('resolved' in out)) return assert.fail('expected a resolve output');
  assert.deepEqual(out.exceptions.map((e) => [e.item, e.status]), [['vide', 'none'], ['oeufs', 'error']]);
  assert.match(out.exceptions[1].why[0], /tool error: boom/);
  assert.deepEqual(out.resolved.map((r) => r.item), ['riz']);
});

test('connect failure returns the search-via-claude fallback; --from-search reuses those files (review focus 4)', async () => {
  const items = [{ item: 'crème fraîche / épaisse' }];
  const fb = await runResolve(items, { today: day }, {
    profile, provider, open: async () => { throw new Error('profile locked'); }, preferredEans: () => [],
  });
  if (!('fallback' in fb)) return assert.fail('expected fallback');
  assert.equal(fb.files[0].query, 'crème fraîche / épaisse');
  assert.equal(itemFileName('crème fraîche / épaisse'), 'creme-fraiche-epaisse.json');
  mkdirSync(fb.dir, { recursive: true });
  writeFileSync(fb.files[0].file, JSON.stringify({ data: [{ ean: '5', title: 'Crème fraîche épaisse', price: 1.5, per: '7,50 €/kg' }] }));
  const out = await runResolve(items, { today: day, fromSearch: fb.dir }, {
    profile, provider, open: async () => { throw new Error('must not connect'); }, preferredEans: () => [],
  });
  if (!('resolved' in out)) return assert.fail('expected a resolve output');
  assert.equal(out.resolved[0].ean, '5');
});

test('remembered EANs feed the status quo', async () => {
  const out = await runResolve([{ item: 'riz' }], { today: day },
    { profile, provider, open: fakeOpen([]), preferredEans: (i) => (i === 'riz' ? ['9'] : []) });
  if (!('resolved' in out)) return assert.fail();
  assert.ok(out.resolved[0].why.includes('status-quo'));
});

test('missing mapping is an error that points to setup', async () => {
  const bare = { ...provider, search: { tool: 'search_products', args: {} } };
  await assert.rejects(runResolve([{ item: 'riz' }], { today: day }, { profile, provider: bare, open: fakeOpen([]), preferredEans: () => [] }), /mapping discovery/);
});

test('suggestions after repeated overrides of the same rule', () => {
  const rows = [1, 2, 3].map((i) => ({ date: day, item: 'lentilles', chosen: 'n', overridden: `b${i}`, rules: ['bio-raisonnable'] }));
  assert.deepEqual(suggestions(rows).map((s) => [s.rule, s.overrides]), [['bio-raisonnable', 3]]);
  assert.deepEqual(suggestions(rows.slice(0, 2)), []);
});
