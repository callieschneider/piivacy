import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrub } from '../src/scrub.js';
import { createSession, registerSecret } from '../src/sessions.js';

test('default mode tokenizes everything', async () => {
  const session = createSession();
  const { text } = await scrub('Email me at jane@example.com', session);
  assert.match(text, /\[\[EMAIL_1\]\]/);
});

test('multiple distinct values get separate tokens', async () => {
  const session = createSession();
  const { text } = await scrub('a@x.com and b@x.com', session);
  assert.ok(text.includes('[[EMAIL_1]]'));
  assert.ok(text.includes('[[EMAIL_2]]'));
});

test('repeated value gets the same token', async () => {
  const session = createSession();
  const { text } = await scrub('email a@x.com or a@x.com', session);
  const matches = text.match(/\[\[EMAIL_\d+\]\]/g);
  assert.equal(matches.length, 2);
  assert.equal(matches[0], matches[1]);
});

test('scrub processes multiple PII types in one pass', async () => {
  const session = createSession();
  const { text } = await scrub(
    'Email a@x.com, phone (415) 555-0142, ssn 123-45-6789, card 4111 1111 1111 1111',
    session
  );
  assert.match(text, /\[\[EMAIL_1\]\]/);
  assert.match(text, /\[\[PHONE_US_1\]\]/);
  assert.match(text, /\[\[SSN_1\]\]/);
  assert.match(text, /\[\[CC_1\]\]/);
});

test('literal-secret pre-pass: applyPiiCheckIssues path', async () => {
  const session = createSession();
  registerSecret(session, 'Project Phoenix', 'CODENAME');
  const { text } = await scrub('We launched Project Phoenix yesterday.', session);
  assert.match(text, /\[\[CODENAME_1\]\]/);
  assert.ok(!text.includes('Project Phoenix'));
});

test('token literals are not re-tokenized', async () => {
  const session = createSession();
  const { text: t1 } = await scrub('my email is a@x.com', session);
  const { text: t2 } = await scrub(t1, session);
  // Tokens stay tokens; counters don't increment
  assert.equal(t1, t2);
});

test('exclude removes a pattern entirely', async () => {
  const session = createSession();
  const { text } = await scrub('email a@x.com', session, { exclude: ['EMAIL'] });
  assert.ok(text.includes('a@x.com'));
});

test('Luhn-invalid CC is not redacted', async () => {
  const session = createSession();
  const { text } = await scrub('order number 1234567890123 here', session);
  // 1234567890123 is 13 digits but fails Luhn — should not be tokenized as CC
  assert.ok(text.includes('1234567890123'));
});

test('SSN with invalid range (000) is not redacted', async () => {
  const session = createSession();
  const { text } = await scrub('legacy ID 000-12-3456', session);
  assert.ok(text.includes('000-12-3456'));
});

test('scrub returns the same session passed in', async () => {
  const session = createSession();
  const { session: returned } = await scrub('a@x.com', session);
  assert.equal(returned, session);
});

test('expired session throws by default', async () => {
  const session = createSession();
  session.expiresAt = Date.now() - 1000;
  await assert.rejects(scrub('a@x.com', session), /expired/);
});

test('expired session bypassed with allowExpired', async () => {
  const session = createSession();
  session.expiresAt = Date.now() - 1000;
  const { text } = await scrub('a@x.com', session, { allowExpired: true });
  assert.match(text, /\[\[EMAIL_1\]\]/);
});

test('scrub accepts no session and creates one', async () => {
  const { text, session } = await scrub('a@x.com', null);
  assert.match(text, /\[\[EMAIL_1\]\]/);
  assert.ok(session.tokens['[[EMAIL_1]]'] === 'a@x.com');
});
