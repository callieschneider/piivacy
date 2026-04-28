import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrub } from '../src/scrub.js';
import { createSession } from '../src/sessions.js';

test('input contains a colliding fake → next candidate is picked', async () => {
  const session = createSession();
  // Input already contains "redacted1@example.com" (the default first fake)
  // so the EMAIL fake() should advance the counter to avoid collision.
  const { text } = await scrub(
    'Real: jane@acme.com. Note: redacted1@example.com is reserved.',
    session,
    { labels: { EMAIL: 'realistic' } }
  );
  // jane@acme.com → some fake, but NOT redacted1@example.com
  assert.ok(!text.match(/jane@acme\.com/));
  // The second redacted email should be redacted2 or higher
  const fakes = [...text.matchAll(/redacted(\d+)@example\.com/g)].map((m) => Number(m[1]));
  // We expect one fake from the redacted (real) email, plus the one already in input
  assert.ok(fakes.length >= 1);
  // The new fake's counter must be > 1 (since redacted1 was already in input)
  assert.ok(Math.max(...fakes) >= 2);
});

test('all collision attempts fail → falls back to token', async () => {
  const session = createSession();
  // A custom pattern whose fake() always produces a value already in input
  const opts = {
    labels: { COLLIDER: 'realistic' },
    extraPatterns: [{
      label: 'COLLIDER',
      regex: /\bORIG\b/g,
      category: 'custom',
      priority: 100,
      fake: () => 'COLLIDE' // always matches input
    }]
  };
  const { text } = await scrub('ORIG and COLLIDE in the input', session, opts);
  // COLLIDER label fake produces "COLLIDE" which is in input → falls back to token
  assert.match(text, /\[\[COLLIDER_1\]\]/);
});

test('different originals can both reuse different fakes (no false collision)', async () => {
  const session = createSession();
  const { text } = await scrub('a@x.com and b@x.com', session, {
    labels: { EMAIL: 'realistic' }
  });
  const fakes = [...text.matchAll(/redacted(\d+)@example\.com/g)].map((m) => m[0]);
  assert.equal(fakes.length, 2);
  assert.notEqual(fakes[0], fakes[1]);
});
