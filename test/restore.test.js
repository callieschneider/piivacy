import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrub } from '../src/scrub.js';
import { restore } from '../src/restore.js';
import { createSession } from '../src/sessions.js';

test('round-trip equality in token mode', async () => {
  const session = createSession();
  const original = 'Email a@x.com or call (415) 555-0142. SSN 123-45-6789.';
  const { text: scrubbed } = await scrub(original, session);
  const restored = restore(scrubbed, session);
  assert.equal(restored, original);
});

test('restore is idempotent (no changes for already-restored text)', () => {
  const session = createSession();
  session.tokens['[[EMAIL_1]]'] = 'a@x.com';
  const restored1 = restore('hello a@x.com', session);
  const restored2 = restore(restored1, session);
  assert.equal(restored1, restored2);
});

test('truncated tokens are left in place', () => {
  const session = createSession();
  session.tokens['[[EMAIL_1]]'] = 'a@x.com';
  const out = restore('partial [[EMAIL_ tail', session);
  assert.equal(out, 'partial [[EMAIL_ tail');
});

test('LLM-invented tokens (not in session) are left in place', () => {
  const session = createSession();
  session.tokens['[[EMAIL_1]]'] = 'a@x.com';
  const out = restore('see [[CITY_99]] for details', session);
  assert.ok(out.includes('[[CITY_99]]'));
});

test('multi-digit token counters work', () => {
  const session = createSession();
  for (let i = 1; i <= 50; i++) {
    session.tokens[`[[EMAIL_${i}]]`] = `email${i}@x.com`;
  }
  const out = restore('contact [[EMAIL_42]] please', session);
  assert.ok(out.includes('email42@x.com'));
});

test('text with no tokens passes through unchanged', () => {
  const session = createSession();
  session.tokens['[[EMAIL_1]]'] = 'a@x.com';
  assert.equal(restore('hello world', session), 'hello world');
});

test('restore validates session shape', () => {
  assert.throws(() => restore('text', null), /session/);
  assert.throws(() => restore('text', {}), /session/);
});

test('restore validates text type', () => {
  const session = createSession();
  assert.throws(() => restore(null, session), /string/);
  assert.throws(() => restore(123, session), /string/);
});

test('restore handles realistic-mode fakes', async () => {
  const session = createSession();
  const opts = { labels: { EMAIL: 'realistic' } };
  const { text: scrubbed } = await scrub('email a@x.com today', session, opts);
  // The LLM "responds" using the fake email exactly
  const fake = scrubbed.match(/redacted\d+@example\.com/)[0];
  const llmResponse = `I will email ${fake} now.`;
  const restored = restore(llmResponse, session);
  assert.ok(restored.includes('a@x.com'));
});
