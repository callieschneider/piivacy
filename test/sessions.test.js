import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSession,
  isExpired,
  getOrAssignToken,
  registerFake,
  registerSecret,
  listRedactions
} from '../src/sessions.js';

test('createSession returns a JSON-serializable session', () => {
  const s = createSession();
  assert.equal(typeof s.tokens, 'object');
  assert.equal(typeof s.reverse, 'object');
  assert.equal(typeof s.counters, 'object');
  assert.equal(typeof s.fakes, 'object');
  assert.equal(typeof s.referenceForms, 'object');
  assert.equal(typeof s.usage, 'object');
  assert.ok(Array.isArray(s._literalSecrets));
  assert.equal(typeof s.ttlMs, 'number');
  // Round-trip through JSON
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(s)));
});

test('createSession rejects invalid ttlMs', () => {
  assert.throws(() => createSession({ ttlMs: 0 }), /ttlMs/);
  assert.throws(() => createSession({ ttlMs: -1 }), /ttlMs/);
  assert.throws(() => createSession({ ttlMs: 'a lot' }), /ttlMs/);
});

test('getOrAssignToken assigns sequential per-label tokens', () => {
  const s = createSession();
  const t1 = getOrAssignToken(s, 'EMAIL', 'a@x.com');
  const t2 = getOrAssignToken(s, 'EMAIL', 'b@x.com');
  const t3 = getOrAssignToken(s, 'PHONE_US', '(555) 010-0000');
  assert.equal(t1, '[[EMAIL_1]]');
  assert.equal(t2, '[[EMAIL_2]]');
  assert.equal(t3, '[[PHONE_US_1]]');
});

test('getOrAssignToken dedups same value', () => {
  const s = createSession();
  const t1 = getOrAssignToken(s, 'EMAIL', 'a@x.com');
  const t2 = getOrAssignToken(s, 'EMAIL', 'a@x.com');
  assert.equal(t1, t2);
});

test('getOrAssignToken records usage stats', () => {
  const s = createSession();
  getOrAssignToken(s, 'EMAIL', 'a@x.com');
  getOrAssignToken(s, 'EMAIL', 'a@x.com');
  getOrAssignToken(s, 'EMAIL', 'a@x.com');
  assert.equal(s.usage['[[EMAIL_1]]'].count, 3);
  assert.ok(s.usage['[[EMAIL_1]]'].firstSeenAt > 0);
  assert.ok(s.usage['[[EMAIL_1]]'].lastSeenAt >= s.usage['[[EMAIL_1]]'].firstSeenAt);
});

test('isExpired honors expiresAt', () => {
  const s = createSession({ ttlMs: 1 });
  assert.equal(isExpired(s), false);
  s.expiresAt = Date.now() - 1000;
  assert.equal(isExpired(s), true);
});

test('sliding TTL: getOrAssignToken refreshes expiresAt', async () => {
  const s = createSession({ ttlMs: 1000 });
  const original = s.expiresAt;
  await new Promise((r) => setTimeout(r, 10));
  getOrAssignToken(s, 'EMAIL', 'a@x.com');
  assert.ok(s.expiresAt > original);
});

test('registerFake stores forward + reverse + reference forms', () => {
  const s = createSession();
  registerFake(s, 'Jane Smith', 'Marcus Chen', 'NAME', {
    Marcus: 'Jane',
    Chen: 'Smith'
  });
  assert.equal(s.fakes['Marcus Chen'], 'Jane Smith');
  assert.equal(s.reverse['NAME::Jane Smith'], 'Marcus Chen');
  assert.equal(s.referenceForms.Marcus, 'Jane');
  assert.equal(s.referenceForms.Chen, 'Smith');
});

test('registerFake dedups same original', () => {
  const s = createSession();
  registerFake(s, 'Jane', 'Marcus', 'NAME');
  const second = registerFake(s, 'Jane', 'Marcus2', 'NAME');
  // Second call returns the original fake
  assert.equal(second, 'Marcus');
});

test('registerSecret stores literal-secret entries with dedup', () => {
  const s = createSession();
  assert.equal(registerSecret(s, 'super-secret-token', 'API_KEY'), true);
  assert.equal(registerSecret(s, 'super-secret-token', 'API_KEY'), false);
  assert.equal(s._literalSecrets.length, 1);
});

test('registerSecret validates label and value', () => {
  const s = createSession();
  assert.throws(() => registerSecret(s, '', 'API_KEY'), /value/);
  assert.throws(() => registerSecret(s, 'x', 'lowercase'), /label/);
  assert.throws(() => registerSecret(s, 'x', '123_BAD'), /label/);
});

test('listRedactions returns combined token + fake inventory sorted by firstSeenAt', () => {
  const s = createSession();
  getOrAssignToken(s, 'EMAIL', 'a@x.com');
  registerFake(s, 'Jane Smith', 'Marcus Chen', 'NAME');
  getOrAssignToken(s, 'PHONE_US', '(555) 010-1234');
  const items = listRedactions(s);
  assert.equal(items.length, 3);
  // Sorted ascending by firstSeenAt
  for (let i = 1; i < items.length; i++) {
    assert.ok(items[i].firstSeenAt >= items[i - 1].firstSeenAt);
  }
  // Each item has the right shape
  for (const it of items) {
    assert.ok(it.kind === 'token' || it.kind === 'fake');
    assert.match(it.label, /^[A-Z][A-Z0-9_]*$/);
    assert.equal(typeof it.identifier, 'string');
    assert.equal(typeof it.count, 'number');
  }
});
