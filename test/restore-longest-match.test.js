import { test } from 'node:test';
import assert from 'node:assert/strict';
import { restore } from '../src/restore.js';
import { createSession, registerFake } from '../src/sessions.js';

test('full fake replaces before partial reference form', () => {
  const s = createSession();
  registerFake(s, 'Jane Smith', 'Marcus Chen', 'NAME', {
    Marcus: 'Jane',
    Chen: 'Smith'
  });
  // LLM uses the full name once and the first-name reference twice
  const llm = 'Marcus Chen will respond. Marcus is busy. Chen wrote yesterday.';
  const out = restore(llm, s);
  assert.equal(out, 'Jane Smith will respond. Jane is busy. Smith wrote yesterday.');
});

test('possessives in reference forms are restored', () => {
  const s = createSession();
  registerFake(s, 'Jane Smith', 'Marcus Chen', 'NAME', {
    Marcus: 'Jane',
    "Marcus's": "Jane's",
    Chen: 'Smith',
    "Chen's": "Smith's"
  });
  const out = restore("Marcus's car was at Chen's office", s);
  assert.equal(out, "Jane's car was at Smith's office");
});

test('honorifics in reference forms are restored', () => {
  const s = createSession();
  registerFake(s, 'Jane Smith', 'Marcus Chen', 'NAME', {
    Chen: 'Smith',
    'Mr. Chen': 'Mr. Smith',
    'Dr. Chen': 'Dr. Smith'
  });
  assert.equal(restore('Mr. Chen attended', s), 'Mr. Smith attended');
  assert.equal(restore('Dr. Chen presented', s), 'Dr. Smith presented');
});

test('word-boundary protects against eating substrings', () => {
  const s = createSession();
  registerFake(s, 'Jane', 'Marcus', 'NAME', { Marcus: 'Jane' });
  // "Marcusland" is a different word; "Marcus" inside it shouldn't be touched
  const out = restore('Marcus visited Marcusland today', s);
  assert.equal(out, 'Jane visited Marcusland today');
});

test('longest fakes are processed first', () => {
  const s = createSession();
  // Two distinct people: "Jane Smith" → "Marcus Chen", "Jane Doe" → "Marcus Lee"
  registerFake(s, 'Jane Smith', 'Marcus Chen', 'NAME', {});
  registerFake(s, 'Jane Doe', 'Marcus Lee', 'NAME', {});
  const out = restore('Marcus Chen and Marcus Lee met yesterday', s);
  assert.ok(out.includes('Jane Smith'));
  assert.ok(out.includes('Jane Doe'));
});

test('shorter reference form does not break a longer fake', () => {
  const s = createSession();
  registerFake(s, 'Jane Doe', 'Marcus Chen', 'NAME', {
    Marcus: 'Jane',
    Chen: 'Doe'
  });
  // "Marcus Chen" should restore to "Jane Doe" (full fake), not "Jane Doe" via two reference replacements
  const out = restore('Marcus Chen attended', s);
  assert.equal(out, 'Jane Doe attended');
});
