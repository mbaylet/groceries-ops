import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import {
  classifySession, listProviderIds, loadProvider, mcpToolName, missingDenies, validateProvider, type McpProvider,
} from '../scripts/lib/provider.ts';
import { paths } from '../scripts/lib/paths.ts';

const carrefour = loadProvider('carrefour') as McpProvider;

test('shipped providers load', () => {
  assert.deepEqual(listProviderIds().sort(), ['carrefour', 'list']);
  assert.equal(carrefour.kind, 'mcp');
  assert.equal(loadProvider('list').kind, 'list');
  assert.throws(() => loadProvider('auchan'), /Unknown provider "auchan"/);
});

test('repo settings deny every forbidden tool (guard)', () => {
  const settings = JSON.parse(readFileSync(paths.settings(), 'utf8'));
  assert.deepEqual(missingDenies(carrefour, settings), []);
});

test('missingDenies reports gaps', () => {
  assert.equal(mcpToolName(carrefour, 'get_cart'), 'mcp__carrefour-drive__get_cart');
  assert.deepEqual(missingDenies(carrefour, {}), carrefour.forbidden.map((t) => mcpToolName(carrefour, t)));
  const partial = { permissions: { deny: [mcpToolName(carrefour, 'submit_checkout_payment')] } };
  assert.equal(missingDenies(carrefour, partial).length, carrefour.forbidden.length - 1);
});

test('classifySession on the server\'s real output shapes', () => {
  const c = carrefour.capabilities.session_check;
  assert.equal(classifySession({ isError: false, text: 'Session present: 4 cookie(s)\nVerification: HTTP 200' }, c), 'ok');
  assert.equal(classifySession({ isError: false, text: 'Session present\nVerification: FAILED (HTTP 401) — the session looks expired.' }, c), 'expired');
  assert.equal(classifySession({ isError: true, text: 'No Carrefour session available.' }, c), 'expired');
  assert.equal(classifySession({ isError: false, text: 'Verification: could not reach carrefour.fr (timeout)' }, c), 'unknown');
});

test('validation rejects a forbidden tool used as a capability, and bad regexes', () => {
  const raw = YAML.parse(readFileSync(paths.provider('carrefour'), 'utf8'));
  raw.capabilities.add_to_cart = 'submit_checkout_payment';
  raw.capabilities.session_check.ok_pattern = '(';
  delete raw.capabilities.read_cart;
  raw.capabilities.remove = 42;
  const v = validateProvider(raw, 'carrefour');
  assert.ok(!v.ok);
  if (!v.ok) {
    const all = v.errors.join('\n');
    assert.match(all, /capabilities\.add_to_cart: "submit_checkout_payment" is forbidden/);
    assert.match(all, /ok_pattern: invalid regex/);
    assert.match(all, /capabilities\.read_cart: must be a tool name/);
    assert.match(all, /capabilities\.remove: must be a tool name/);
  }
});

test('agent_notes and entry_level_brands are optional and typed', () => {
  const raw = YAML.parse(readFileSync(paths.provider('carrefour'), 'utf8'));
  assert.equal(validateProvider(raw, 'carrefour').ok, true);
  const badNotes = validateProvider({ ...raw, agent_notes: 3 }, 'carrefour');
  assert.ok(!badNotes.ok && badNotes.errors.some((e) => e.startsWith('agent_notes')));
  const badBrands = validateProvider({ ...raw, entry_level_brands: 'SIMPL' }, 'carrefour');
  assert.ok(!badBrands.ok && badBrands.errors.some((e) => e.startsWith('entry_level_brands')));
});
