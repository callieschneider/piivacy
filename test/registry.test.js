import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  registerPattern,
  unregisterPattern,
  listPatterns,
  resolvePatterns,
  _resetRegistry
} from '../src/registry.js';

test('listPatterns returns default catalog with hasRealistic flag', () => {
  _resetRegistry();
  const patterns = listPatterns();
  assert.ok(patterns.length >= 25, `expected >=25 default patterns, got ${patterns.length}`);
  const email = patterns.find((p) => p.label === 'EMAIL');
  assert.ok(email);
  assert.equal(email.hasRealistic, true);
  const openai = patterns.find((p) => p.label === 'OPENAI_KEY');
  assert.equal(openai.hasRealistic, false);
});

test('registerPattern adds a custom pattern', () => {
  _resetRegistry();
  registerPattern({
    label: 'TEST_PATTERN',
    regex: /\bTEST-\d+\b/g,
    category: 'custom',
    priority: 100,
    description: 'a test'
  });
  const all = listPatterns().map((p) => p.label);
  assert.ok(all.includes('TEST_PATTERN'));
  unregisterPattern('TEST_PATTERN');
  assert.ok(!listPatterns().map((p) => p.label).includes('TEST_PATTERN'));
});

test('registerPattern validates fields', () => {
  _resetRegistry();
  assert.throws(() => registerPattern({ label: 'lowercase', regex: /x/g, category: 'contact' }), /label/);
  assert.throws(() => registerPattern({ label: 'NO_REGEX', regex: 'x', category: 'contact' }), /RegExp/);
  assert.throws(() => registerPattern({ label: 'NO_GLOBAL', regex: /x/, category: 'contact' }), /\/g/);
  assert.throws(() => registerPattern({ label: 'BAD_CAT', regex: /x/g, category: 'nope' }), /category/);
  assert.throws(
    () => registerPattern({ label: 'BAD_FAKE', regex: /x/g, category: 'contact', fake: 'not a fn' }),
    /fake/
  );
});

test('resolvePatterns sorts by priority (lower first)', () => {
  _resetRegistry();
  const sorted = resolvePatterns();
  for (let i = 1; i < sorted.length; i++) {
    assert.ok(sorted[i - 1].priority <= sorted[i].priority);
  }
});

test('resolvePatterns supports categories filter', () => {
  _resetRegistry();
  const onlyContact = resolvePatterns({ categories: ['contact'] });
  for (const p of onlyContact) assert.equal(p.category, 'contact');
  assert.ok(onlyContact.length >= 2);
});

test('resolvePatterns supports exclude filter', () => {
  _resetRegistry();
  const noEmail = resolvePatterns({ exclude: ['EMAIL'] });
  for (const p of noEmail) assert.notEqual(p.label, 'EMAIL');
});

test('extraPatterns merge in (per-call, not persisted)', () => {
  _resetRegistry();
  const withExtra = resolvePatterns({
    extraPatterns: [{ label: 'EPHEMERAL', regex: /\bEPH-\d+\b/g, category: 'custom', priority: 99 }]
  });
  assert.ok(withExtra.find((p) => p.label === 'EPHEMERAL'));
  // Without opts, the extra is gone
  assert.ok(!resolvePatterns().find((p) => p.label === 'EPHEMERAL'));
});

test('custom priorities slot between defaults', () => {
  _resetRegistry();
  registerPattern({ label: 'BETWEEN', regex: /\bX\b/g, category: 'custom', priority: 25 });
  const sorted = resolvePatterns();
  const idx = sorted.findIndex((p) => p.label === 'BETWEEN');
  assert.ok(sorted[idx - 1].priority <= 25);
  assert.ok(sorted[idx + 1].priority >= 25);
  unregisterPattern('BETWEEN');
});
