import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contentText, parseToolJson } from '../scripts/lib/mcp-client.ts';

test('contentText joins text parts and ignores others', () => {
  assert.equal(contentText([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }]), 'a\nb');
  assert.equal(contentText(undefined), '');
});

test('parseToolJson parses JSON text and surfaces tool errors', () => {
  assert.deepEqual(parseToolJson({ isError: false, text: '{"data":[1]}' }), { data: [1] });
  assert.throws(() => parseToolJson({ isError: true, text: 'No Carrefour session available.' }), /No Carrefour session/);
  assert.throws(() => parseToolJson({ isError: false, text: 'not json' }), /not JSON/);
});
