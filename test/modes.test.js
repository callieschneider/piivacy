import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveMode, presets } from '../src/modes.js';

const email = { label: 'EMAIL', category: 'contact' };
const openai = { label: 'OPENAI_KEY', category: 'secrets' };
const zip = { label: 'ZIP_US', category: 'location' };
const cc = { label: 'CC', category: 'financial' };

test('default mode is "token"', () => {
  assert.equal(resolveMode(email), 'token');
});

test('exclude returns null', () => {
  assert.equal(resolveMode(email, { exclude: ['EMAIL'] }), null);
});

test('passThrough wins over labels & modes', () => {
  assert.equal(
    resolveMode(zip, { passThrough: ['ZIP_US'], labels: { ZIP_US: 'token' } }),
    'pass-through'
  );
});

test('labels override category modes', () => {
  assert.equal(
    resolveMode(email, { labels: { EMAIL: 'realistic' }, modes: { contact: 'token' } }),
    'realistic'
  );
});

test('modes (category) used when no label-specific override', () => {
  assert.equal(resolveMode(email, { modes: { contact: 'realistic' } }), 'realistic');
});

test('defaultMode used when nothing else applies', () => {
  assert.equal(resolveMode(email, { defaultMode: 'realistic' }), 'realistic');
});

test('safety override: secrets/financial/identifiers cannot be pass-through', () => {
  // Even if user explicitly tries to pass-through a secret, we downgrade
  assert.equal(resolveMode(openai, { passThrough: ['OPENAI_KEY'] }), 'token');
  assert.equal(resolveMode(openai, { labels: { OPENAI_KEY: 'pass-through' } }), 'token');
  assert.equal(resolveMode(cc, { modes: { financial: 'pass-through' } }), 'token');
});

test('invalid mode throws', () => {
  assert.throws(() => resolveMode(email, { defaultMode: 'invalid' }), /invalid mode/);
  assert.throws(() => resolveMode(email, { labels: { EMAIL: 'bogus' } }), /invalid mode/);
});

test('presets shape', () => {
  assert.equal(presets.maximumRedaction.defaultMode, 'token');
  assert.equal(presets.naturalConversation.modes.contact, 'realistic');
  assert.equal(presets.localSearch.modes.location, 'pass-through');
  assert.equal(presets.testFriendly.defaultMode, 'realistic');
  assert.equal(presets.testFriendly.modes.secrets, 'token');
});
