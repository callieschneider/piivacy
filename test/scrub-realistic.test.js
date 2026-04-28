import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrub } from '../src/scrub.js';
import { createSession } from '../src/sessions.js';
import { presets } from '../src/modes.js';

test('realistic mode produces a fake email instead of a token', async () => {
  const session = createSession();
  const { text } = await scrub('email me at jane@acme.com', session, {
    labels: { EMAIL: 'realistic' }
  });
  assert.ok(!text.includes('jane@acme.com'));
  assert.match(text, /redacted\d+@example\.com/);
});

test('realistic phone produces 555-01XX form', async () => {
  const session = createSession();
  const { text } = await scrub('call (415) 555-0142', session, {
    labels: { PHONE_US: 'realistic' }
  });
  assert.match(text, /\(555\) 010-\d{4}/);
});

test('realistic falls back to token when pattern has no fake()', async () => {
  const session = createSession();
  const { text } = await scrub(
    'AKIAIOSFODNN7EXAMPLE',
    session,
    { labels: { AWS_ACCESS_KEY: 'realistic' } }
  );
  assert.match(text, /\[\[AWS_ACCESS_KEY_1\]\]/);
});

test('same value scrubbed twice gets the same fake', async () => {
  const session = createSession();
  const opts = { labels: { EMAIL: 'realistic' } };
  const { text: t1 } = await scrub('a@x.com is here', session, opts);
  const { text: t2 } = await scrub('a@x.com again', session, opts);
  const fake1 = t1.match(/redacted\d+@example\.com/)[0];
  const fake2 = t2.match(/redacted\d+@example\.com/)[0];
  assert.equal(fake1, fake2);
});

test('preset naturalConversation makes contact realistic', async () => {
  const session = createSession();
  const { text } = await scrub('email a@x.com', session, presets.naturalConversation);
  assert.match(text, /redacted\d+@example\.com/);
});

test('CC has a built-in realistic fake (Visa test card)', async () => {
  const session = createSession();
  const { text } = await scrub('card 4111 1111 1111 1111', session, {
    labels: { CC: 'realistic' }
  });
  assert.match(text, /4111-1111-1111-\d{4}/);
});

test('ZIP_US realistic produces 00001', async () => {
  const session = createSession();
  const { text } = await scrub('ZIP 90210', session, {
    labels: { ZIP_US: 'realistic' }
  });
  assert.ok(text.includes('00001'));
});

test('IPV4 realistic produces TEST-NET-1 form', async () => {
  const session = createSession();
  const { text } = await scrub('server 1.2.3.4', session, {
    labels: { IPV4: 'realistic' }
  });
  assert.match(text, /192\.0\.2\.\d+/);
});

test('DOB realistic produces epoch fallback', async () => {
  const session = createSession();
  const { text } = await scrub('born 05/12/1985', session, {
    labels: { DOB: 'realistic' }
  });
  assert.ok(text.includes('01/01/1970'));
});
