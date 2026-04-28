import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrub } from '../src/scrub.js';
import { createSession } from '../src/sessions.js';
import { presets } from '../src/modes.js';

test('per-label passThrough leaves the value untouched', async () => {
  const session = createSession();
  const { text } = await scrub('ZIP 90210', session, { passThrough: ['ZIP_US'] });
  assert.ok(text.includes('90210'));
});

test('category-level location pass-through leaves zip untouched', async () => {
  const session = createSession();
  const { text } = await scrub('ZIP 90210', session, {
    modes: { location: 'pass-through' }
  });
  assert.ok(text.includes('90210'));
});

test('localSearch preset preserves location', async () => {
  const session = createSession();
  const { text } = await scrub('Find restaurants near 234 Main Street', session, presets.localSearch);
  assert.ok(text.includes('234 Main Street'));
});

test('safety override: secrets cannot be pass-through (downgraded to token)', async () => {
  const session = createSession();
  const { text } = await scrub(
    'key: AKIAIOSFODNN7EXAMPLE',
    session,
    { passThrough: ['AWS_ACCESS_KEY'] }
  );
  // Should be tokenized despite passThrough request
  assert.match(text, /\[\[AWS_ACCESS_KEY_1\]\]/);
});

test('safety override: financial cannot be pass-through', async () => {
  const session = createSession();
  const { text } = await scrub(
    'card 4111 1111 1111 1111',
    session,
    { modes: { financial: 'pass-through' } }
  );
  assert.match(text, /\[\[CC_1\]\]/);
});

test('per-label passThrough overrides category mode', async () => {
  const session = createSession();
  const { text } = await scrub(
    'ZIP 90210, lat/long 40.7128, -74.0060',
    session,
    { modes: { location: 'token' }, passThrough: ['ZIP_US'] }
  );
  assert.ok(text.includes('90210'));
  assert.match(text, /\[\[LATLONG_1\]\]/); // still tokenized
});

test('pass-through mode does not register anything in session', async () => {
  const session = createSession();
  await scrub('ZIP 90210', session, { passThrough: ['ZIP_US'] });
  assert.equal(Object.keys(session.tokens).length, 0);
  assert.equal(Object.keys(session.fakes).length, 0);
});
