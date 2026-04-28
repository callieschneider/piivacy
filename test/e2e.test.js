import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scrub,
  restore,
  createSession,
  registerSecret,
  listRedactions,
  presets,
  buildPiiCheckPrompt,
  parsePiiCheckResponse,
  applyPiiCheckIssues,
  buildScrubIntentPrompt,
  parseScrubIntentResponse,
  applyScrubIntent
} from '../src/index.js';

test('full token-mode workflow: scrub → simulate LLM → restore round-trips', async () => {
  const session = createSession();
  const userInput = 'Hi, I am Jane Doe (jane@acme.com, (415) 555-0142). My SSN is 123-45-6789.';
  const { text: scrubbed } = await scrub(userInput, session);
  // Simulate LLM response that uses the tokens it received
  const llmResponse = `Got it — I will email [[EMAIL_1]] and call [[PHONE_US_1]].`;
  const restored = restore(llmResponse, session);
  assert.ok(restored.includes('jane@acme.com'));
  assert.ok(restored.includes('(415) 555-0142'));
  assert.ok(!restored.includes('[[EMAIL_'));
});

test('multi-turn: same session reused across three scrubs maintains dedup', async () => {
  const session = createSession();
  const opts = {};
  const a = await scrub('email a@x.com', session, opts);
  const b = await scrub('also a@x.com and b@x.com', session, opts);
  const c = await scrub('finally a@x.com', session, opts);
  // a@x.com should always map to EMAIL_1 across all three turns
  assert.match(a.text, /\[\[EMAIL_1\]\]/);
  assert.ok(b.text.includes('[[EMAIL_1]]'));
  assert.ok(b.text.includes('[[EMAIL_2]]'));
  assert.ok(c.text.includes('[[EMAIL_1]]'));
  // listRedactions confirms exactly 2 unique values
  const items = listRedactions(session);
  assert.equal(items.filter((i) => i.label === 'EMAIL').length, 2);
});

test('llm-check loop: pass 1 misses, pass 2 catches', async () => {
  const session = createSession();
  const original = 'Hello, my name is Marcus Chen and I work at Globex Corporation.';
  // Pass 1
  const pass1 = await scrub(original, session);
  // The LLM-check finds the missed name + company
  const fakeLLMResponse = JSON.stringify({
    issues: [
      { value: 'Marcus Chen', label: 'NAME', confidence: 0.95 },
      { value: 'Globex Corporation', label: 'COMPANY', confidence: 0.85 }
    ]
  });
  const { issues } = parsePiiCheckResponse(fakeLLMResponse);
  const applied = applyPiiCheckIssues(session, issues);
  assert.equal(applied, 2);
  // Pass 2
  const pass2 = await scrub(original, session);
  assert.ok(!pass2.text.includes('Marcus Chen'));
  assert.ok(!pass2.text.includes('Globex Corporation'));
  assert.match(pass2.text, /\[\[NAME_1\]\]/);
  assert.match(pass2.text, /\[\[COMPANY_1\]\]/);
  // Restore round-trips
  assert.equal(restore(pass2.text, session), original);
});

test('llm-intent loop: location preserved for local search', async () => {
  const session = createSession();
  const userInput = 'Find Indian restaurants near 234 Main Street, Brooklyn, NY 11211. Email me at me@x.com.';
  // Intent: preserve location, redact contact
  const fakeLLMResponse = JSON.stringify({
    decisions: {
      location: 'preserve',
      contact: 'redact',
      secrets: 'redact',
      financial: 'redact',
      identifiers: 'redact',
      network: 'redact'
    },
    reason: 'local search needs the address'
  });
  const { decisions } = parseScrubIntentResponse(fakeLLMResponse);
  const opts = applyScrubIntent(decisions, { defaultMode: 'token' });
  const { text } = await scrub(userInput, session, opts);
  // Address preserved
  assert.ok(text.includes('234 Main Street'));
  // Contact tokenized
  assert.match(text, /\[\[EMAIL_1\]\]/);
  assert.ok(!text.includes('me@x.com'));
});

test('preset + multi-turn + listRedactions inventory', async () => {
  const session = createSession();
  await scrub('a@x.com', session, presets.naturalConversation);
  await scrub('(415) 555-0142', session, presets.naturalConversation);
  const items = listRedactions(session);
  assert.equal(items.length, 2);
  // Both should be 'fake' kind under naturalConversation (contact is realistic)
  const fakeKinds = items.filter((i) => i.kind === 'fake');
  assert.equal(fakeKinds.length, 2);
});

test('manual registerSecret + scrub catches it on first pass', async () => {
  const session = createSession();
  registerSecret(session, 'Project Phoenix', 'CODENAME');
  const { text } = await scrub('We launched Project Phoenix yesterday.', session);
  assert.match(text, /\[\[CODENAME_1\]\]/);
});

test('full realistic mode: scrub → fake LLM responds with fakes → restore', async () => {
  const session = createSession();
  const original = 'Email a@example.com and call (415) 555-0142';
  const { text: scrubbed } = await scrub(original, session, presets.naturalConversation);
  // The LLM sees fakes and uses them in its response
  const llmReply = `Will email ${scrubbed.match(/redacted\d+@example\.com/)[0]} and call ${scrubbed.match(/\(555\) 010-\d{4}/)[0]}.`;
  const restored = restore(llmReply, session);
  assert.ok(restored.includes('a@example.com'));
  assert.ok(restored.includes('(415) 555-0142'));
});

test('listRedactions exposes inventory for a complex session', async () => {
  const session = createSession();
  await scrub(
    'Email a@x.com phone (415) 555-0142 SSN 123-45-6789 card 4111 1111 1111 1111',
    session
  );
  const items = listRedactions(session);
  const labels = items.map((i) => i.label).sort();
  assert.ok(labels.includes('EMAIL'));
  assert.ok(labels.includes('PHONE_US'));
  assert.ok(labels.includes('SSN'));
  assert.ok(labels.includes('CC'));
  for (const item of items) {
    assert.equal(typeof item.identifier, 'string');
    assert.equal(typeof item.value, 'string');
    assert.equal(typeof item.count, 'number');
    assert.ok(item.firstSeenAt > 0);
  }
});
