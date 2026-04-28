import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateFake } from '../src/fake-values.js';
import { createSession } from '../src/sessions.js';

test('returns null when pattern has no fake() function', async () => {
  const session = createSession();
  const out = await generateFake({
    pattern: { label: 'OPENAI_KEY' },
    value: 'sk-anything',
    session,
    input: 'hello sk-anything'
  });
  assert.equal(out, null);
});

test('returns the fake value and bumps counter', async () => {
  const session = createSession();
  const pattern = {
    label: 'EMAIL',
    fake: (_value, { counter }) => `redacted${counter}@example.com`
  };
  const out1 = await generateFake({ pattern, value: 'a@x.com', session, input: 'a@x.com' });
  const out2 = await generateFake({ pattern, value: 'b@x.com', session, input: 'b@x.com' });
  assert.equal(out1, 'redacted1@example.com');
  assert.equal(out2, 'redacted2@example.com');
});

test('avoids producing the original value', async () => {
  const session = createSession();
  const pattern = { label: 'X', fake: (v) => v }; // returns same value
  const out = await generateFake({ pattern, value: 'foo', session, input: 'foo' });
  assert.equal(out, null);
});

test('detects collision with input and retries with different counter', async () => {
  const session = createSession();
  let calls = 0;
  const pattern = {
    label: 'EMAIL',
    fake: (_value, { counter }) => {
      calls++;
      // First few candidates are already in input; 6th attempt is fresh
      return calls < 4 ? 'collide@example.com' : `redacted${counter}@example.com`;
    }
  };
  const out = await generateFake({
    pattern,
    value: 'real@example.com',
    session,
    input: 'real@example.com and collide@example.com'
  });
  assert.ok(out && out !== 'collide@example.com');
});

test('gives up after 5 retry attempts and returns null', async () => {
  const session = createSession();
  const pattern = { label: 'X', fake: () => 'always_collides' };
  const out = await generateFake({
    pattern,
    value: 'foo',
    session,
    input: 'always_collides is in here'
  });
  assert.equal(out, null);
});

test('detects collision with existing fake for different original', async () => {
  const session = createSession();
  // Pre-register a fake already mapped to a different original
  session.fakes['Marcus Chen'] = 'Some Other Real Person';
  session.reverse['NAME::Some Other Real Person'] = 'Marcus Chen';
  const pattern = {
    label: 'NAME',
    fake: () => 'Marcus Chen' // collides with existing
  };
  const out = await generateFake({ pattern, value: 'Real Person', session, input: 'Real Person' });
  assert.equal(out, null);
});
