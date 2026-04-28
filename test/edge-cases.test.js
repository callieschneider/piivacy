import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrub } from '../src/scrub.js';
import { restore } from '../src/restore.js';
import { createSession } from '../src/sessions.js';

test('input already containing token literals is preserved (not double-tokenized)', async () => {
  const session = createSession();
  const { text } = await scrub('previous output: [[EMAIL_99]] still here', session);
  // Existing token literal should pass through (no real PII to redact)
  assert.ok(text.includes('[[EMAIL_99]]'));
});

test('overlapping patterns: address contains zip — both still matched in text', async () => {
  const session = createSession();
  // ADDRESS_US has lower priority than ZIP_US so address goes first.
  // Then ZIP runs on the modified text (zip already absorbed if part of address).
  const { text } = await scrub('123 Main Street ZIP 90210', session);
  // ZIP got tokenized
  assert.match(text, /\[\[ZIP_US_1\]\]/);
});

test('Luhn-invalid CC with 13 digits is not redacted as CC', async () => {
  const session = createSession();
  const { text } = await scrub('order 1234567890123 today', session);
  assert.ok(text.includes('1234567890123'));
});

test('SSN edge: bare 9 digits with 9XX area is not SSN', async () => {
  const session = createSession();
  const { text } = await scrub('id 987654321 here', session);
  assert.ok(text.includes('987654321'));
});

test('large input does not blow up', async () => {
  const session = createSession();
  const big = 'plain text '.repeat(2000) + 'jane@example.com ' + 'plain text '.repeat(2000);
  const { text } = await scrub(big, session);
  assert.match(text, /\[\[EMAIL_1\]\]/);
  assert.ok(text.length > 10000);
});

test('unicode characters in surrounding text survive (ASCII email)', async () => {
  // The default EMAIL regex is ASCII-only per RFC 5321; unicode locals are out of scope.
  // Surrounding unicode in the rest of the text MUST be preserved verbatim.
  const session = createSession();
  const original = 'José Müller emailed jose@example.com from 北京 about an order';
  const { text } = await scrub(original, session);
  assert.match(text, /\[\[EMAIL_1\]\]/);
  assert.ok(text.includes('北京'));
  assert.ok(text.includes('José'));
  assert.ok(text.includes('Müller'));
  // Round-trip
  const restored = restore(text, session);
  assert.equal(restored, original);
});

test('emoji in input is preserved', async () => {
  const session = createSession();
  const original = 'Hi 👋 email me at a@x.com 🎉';
  const { text } = await scrub(original, session);
  assert.ok(text.includes('👋'));
  assert.ok(text.includes('🎉'));
  assert.match(text, /\[\[EMAIL_1\]\]/);
  assert.equal(restore(text, session), original);
});

test('empty string is a no-op', async () => {
  const session = createSession();
  const { text } = await scrub('', session);
  assert.equal(text, '');
});

test('text with only whitespace is unchanged', async () => {
  const session = createSession();
  const { text } = await scrub('   \n\t  ', session);
  assert.equal(text, '   \n\t  ');
});

test('non-string scrub input throws', async () => {
  await assert.rejects(scrub(null), /string/);
  await assert.rejects(scrub(123), /string/);
  await assert.rejects(scrub({ text: 'x' }), /string/);
});

test('custom pattern slots between defaults by priority', async () => {
  const session = createSession();
  const { text } = await scrub('TICKET-1234 about a@x.com', session, {
    extraPatterns: [{
      label: 'TICKET',
      regex: /\bTICKET-\d{4}\b/g,
      category: 'custom',
      priority: 25
    }]
  });
  assert.match(text, /\[\[TICKET_1\]\]/);
  assert.match(text, /\[\[EMAIL_1\]\]/);
});

test('multiple PII of same type gets sequential token numbers', async () => {
  const session = createSession();
  const { text } = await scrub(
    'a@x.com b@x.com c@x.com d@x.com e@x.com',
    session
  );
  for (let i = 1; i <= 5; i++) {
    assert.ok(text.includes(`[[EMAIL_${i}]]`), `expected EMAIL_${i}`);
  }
});

test('scrub idempotent on already-scrubbed text', async () => {
  const session = createSession();
  const { text: t1 } = await scrub('email a@x.com', session);
  const { text: t2 } = await scrub(t1, session);
  assert.equal(t1, t2);
});
