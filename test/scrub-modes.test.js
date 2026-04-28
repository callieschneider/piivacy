import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrub } from '../src/scrub.js';
import { createSession } from '../src/sessions.js';

test('full precedence in one call: exclude > passThrough > labels > modes > defaultMode', async () => {
  const session = createSession();
  const input = [
    'email me at jane@x.com',
    'phone (415) 555-0142',
    'lat/long 40.7128, -74.0060',
    'ZIP 90210',
    'card 4111 1111 1111 1111'
  ].join(' / ');

  const { text } = await scrub(input, session, {
    defaultMode: 'token',
    modes: { contact: 'realistic', location: 'pass-through' },
    labels: { ZIP_US: 'token' }, // override category for ZIP
    passThrough: ['LATLONG'],     // override per-label
    exclude: ['IPV4']             // skip pattern entirely
  });

  // EMAIL: contact category → realistic → fake
  assert.match(text, /redacted\d+@example\.com/);
  // PHONE_US: contact category → realistic
  assert.match(text, /\(555\) 010-\d{4}/);
  // LATLONG: passThrough → untouched
  assert.ok(text.includes('40.7128, -74.0060'));
  // ZIP_US: labels override forces token (despite location:pass-through)
  assert.match(text, /\[\[ZIP_US_1\]\]/);
  // CC: financial defaultMode → token
  assert.match(text, /\[\[CC_1\]\]/);
});

test('extraPatterns scoped to single call', async () => {
  const session = createSession();
  const opts = {
    extraPatterns: [{
      label: 'TICKET',
      regex: /\bTICKET-\d{4}\b/g,
      category: 'custom',
      priority: 100
    }]
  };
  const { text: t1 } = await scrub('issue TICKET-1234 today', session, opts);
  assert.match(t1, /\[\[TICKET_1\]\]/);
  // Without opts on a fresh session, the extra pattern is gone
  const { text: t2 } = await scrub('TICKET-9999', createSession());
  assert.ok(t2.includes('TICKET-9999'));
});

test('categories filter: only run patterns in given categories', async () => {
  const session = createSession();
  const { text } = await scrub(
    'email a@x.com phone (415) 555-0142',
    session,
    { categories: ['contact'] }
  );
  // Both contact patterns matched
  assert.match(text, /\[\[EMAIL_1\]\]/);
  assert.match(text, /\[\[PHONE_US_1\]\]/);
});

test('categories filter excludes other categories', async () => {
  const session = createSession();
  const { text } = await scrub(
    'email a@x.com SSN 123-45-6789',
    session,
    { categories: ['contact'] } // identifiers excluded
  );
  assert.match(text, /\[\[EMAIL_1\]\]/);
  assert.ok(text.includes('123-45-6789')); // SSN not redacted
});
