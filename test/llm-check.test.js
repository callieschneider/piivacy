import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPiiCheckPrompt,
  parsePiiCheckResponse,
  applyPiiCheckIssues,
  buildPiiAuditPrompt,
  parsePiiAuditResponse,
  applyPiiAudit
} from '../src/llm-check.js';
import { createSession, registerSecret, isSkipped, listRedactions } from '../src/sessions.js';
import { scrub } from '../src/scrub.js';

test('buildPiiCheckPrompt returns a {system, user} pair', () => {
  const p = buildPiiCheckPrompt('hello [[EMAIL_1]]');
  assert.equal(typeof p.system, 'string');
  // The user message is now wrapped in a Text/Output frame to constrain
  // small-model output to JSON. Just confirm the input text is in there.
  assert.ok(p.user.includes('hello [[EMAIL_1]]'));
  assert.ok(p.system.includes('NAME'));
  assert.ok(p.system.includes('JSON'));
});

test('buildPiiCheckPrompt rejects non-string input', () => {
  assert.throws(() => buildPiiCheckPrompt(123), /string/);
});

test('parsePiiCheckResponse: plain JSON', () => {
  const raw = '{"issues": [{"value": "Jane Doe", "label": "NAME", "confidence": 0.9, "reason": "obvious name"}]}';
  const { issues } = parsePiiCheckResponse(raw);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].value, 'Jane Doe');
  assert.equal(issues[0].label, 'NAME');
  assert.equal(issues[0].confidence, 0.9);
});

test('parsePiiCheckResponse: code-fenced JSON', () => {
  const raw = '```json\n{"issues": [{"value": "Acme Corp", "label": "COMPANY", "confidence": 0.7, "reason": "x"}]}\n```';
  const { issues } = parsePiiCheckResponse(raw);
  assert.equal(issues.length, 1);
});

test('parsePiiCheckResponse: prose around JSON', () => {
  const raw = 'Sure! Here is what I found:\n{"issues": [{"value": "x", "label": "NAME", "confidence": 0.8}]}\nLet me know.';
  const { issues } = parsePiiCheckResponse(raw);
  assert.equal(issues.length, 1);
});

test('parsePiiCheckResponse: rejects token-literal values', () => {
  const raw = '{"issues": [{"value": "[[EMAIL_1]]", "label": "EMAIL", "confidence": 0.9}]}';
  const { issues } = parsePiiCheckResponse(raw);
  assert.equal(issues.length, 0);
});

test('parsePiiCheckResponse: rejects malformed labels', () => {
  // Labels starting with a digit are invalid even after upper-casing
  const raw = '{"issues": [{"value": "x", "label": "1BAD", "confidence": 0.9}]}';
  const { issues } = parsePiiCheckResponse(raw);
  assert.equal(issues.length, 0);
});

test('parsePiiCheckResponse: lowercase labels are normalized to uppercase', () => {
  // Lenient: LLMs return inconsistent casing; we uppercase before validating
  const raw = '{"issues": [{"value": "Acme", "label": "company", "confidence": 0.9}]}';
  const { issues } = parsePiiCheckResponse(raw);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].label, 'COMPANY');
});

test('parsePiiCheckResponse: malformed JSON returns parseError', () => {
  const out = parsePiiCheckResponse('{ not valid json');
  assert.deepEqual(out.issues, []);
  assert.ok(out.parseError);
});

test('parsePiiCheckResponse: missing issues key returns parseError', () => {
  const out = parsePiiCheckResponse('{"foo": "bar"}');
  assert.deepEqual(out.issues, []);
  assert.match(out.parseError, /issues/);
});

test('parsePiiCheckResponse: non-string input', () => {
  const out = parsePiiCheckResponse(null);
  assert.deepEqual(out.issues, []);
});

test('applyPiiCheckIssues registers issues on the session', () => {
  const s = createSession();
  const issues = [
    { value: 'Jane Doe', label: 'NAME', confidence: 0.9 },
    { value: 'Acme Corp', label: 'COMPANY', confidence: 0.4 }, // below threshold
    { value: 'foo', label: 'CUSTOM', confidence: 0.8 }
  ];
  const applied = applyPiiCheckIssues(s, issues, { minConfidence: 0.6 });
  assert.equal(applied, 2); // CompanyV is below threshold
  assert.equal(s._literalSecrets.length, 2);
});

test('applyPiiCheckIssues honors minConfidence', () => {
  const s = createSession();
  const issues = [{ value: 'x', label: 'NAME', confidence: 0.5 }];
  const applied = applyPiiCheckIssues(s, issues, { minConfidence: 0.8 });
  assert.equal(applied, 0);
});

test('applyPiiCheckIssues dedups', () => {
  const s = createSession();
  registerSecret(s, 'x', 'NAME');
  const applied = applyPiiCheckIssues(s, [{ value: 'x', label: 'NAME', confidence: 0.9 }]);
  assert.equal(applied, 0); // already registered
});

test('full integration: parse → apply → next scrub catches the missed PII', async () => {
  const { scrub } = await import('../src/scrub.js');
  const session = createSession();
  const original = 'Hello, my name is Jane Doe and I work at Acme.';
  const { text: pass1 } = await scrub(original, session);
  // Pass 1 misses the name & company (not in regex catalog)
  assert.ok(pass1.includes('Jane Doe'));
  // Simulate the LLM-check pass
  const fakeLLM = '{"issues": [{"value": "Jane Doe", "label": "NAME", "confidence": 0.95}, {"value": "Acme", "label": "COMPANY", "confidence": 0.8}]}';
  const { issues } = parsePiiCheckResponse(fakeLLM);
  applyPiiCheckIssues(session, issues);
  // Pass 2 picks up the literals
  const { text: pass2 } = await scrub(original, session);
  assert.ok(!pass2.includes('Jane Doe'));
  assert.ok(!pass2.includes('Acme'));
  assert.match(pass2, /\[\[NAME_1\]\]/);
  assert.match(pass2, /\[\[COMPANY_1\]\]/);
});

// ============================================================================
// AUDIT: smarter second-pass (adds missed + removes false positives)
// ============================================================================

test('buildPiiAuditPrompt returns a {system, user} pair with findings rendered', () => {
  const inv = [
    { kind: 'token', identifier: '[[EMAIL_1]]', label: 'EMAIL', value: 'a@b.com', count: 1 },
    { kind: 'token', identifier: '[[CC_1]]', label: 'CC', value: '4111 1111 1111 1111', count: 1 }
  ];
  const p = buildPiiAuditPrompt('hello a@b.com card 4111 1111 1111 1111', inv);
  assert.equal(typeof p.system, 'string');
  assert.ok(p.user.includes('hello a@b.com'));
  assert.ok(p.user.includes('EMAIL="a@b.com"'));
  assert.ok(p.user.includes('CC="4111 1111 1111 1111"'));
  assert.ok(p.system.includes('missed'));
  assert.ok(p.system.includes('false_positives'));
});

test('buildPiiAuditPrompt rejects non-string text or non-array inventory', () => {
  assert.throws(() => buildPiiAuditPrompt(123, []), /string/);
  assert.throws(() => buildPiiAuditPrompt('x', null), /array/);
});

test('parsePiiAuditResponse: typical valid response', () => {
  const raw = '{"missed":[{"value":"Marcus","label":"NAME","confidence":0.95}],"false_positives":[{"value":"192.168.1.1","label":"IPV4","confidence":0.9,"reason":"LAN"}]}';
  const { missed, falsePositives } = parsePiiAuditResponse(raw);
  assert.equal(missed.length, 1);
  assert.equal(missed[0].value, 'Marcus');
  assert.equal(missed[0].label, 'NAME');
  assert.equal(falsePositives.length, 1);
  assert.equal(falsePositives[0].value, '192.168.1.1');
  assert.equal(falsePositives[0].label, 'IPV4');
  assert.equal(falsePositives[0].reason, 'LAN');
});

test('parsePiiAuditResponse: tolerates camelCase falsePositives key', () => {
  const raw = '{"missed":[],"falsePositives":[{"value":"x","label":"IPV4","confidence":0.9}]}';
  const { falsePositives } = parsePiiAuditResponse(raw);
  assert.equal(falsePositives.length, 1);
});

test('parsePiiAuditResponse: rejects bogus values + token literals', () => {
  const raw = '{"missed":[{"value":"[[EMAIL_1]]","label":"EMAIL","confidence":0.9},{"value":"bad","label":"123","confidence":0.9}],"false_positives":[]}';
  const { missed } = parsePiiAuditResponse(raw);
  assert.equal(missed.length, 0);
});

test('parsePiiAuditResponse: handles malformed input', () => {
  const r1 = parsePiiAuditResponse('not json');
  assert.equal(r1.missed.length, 0);
  assert.equal(r1.falsePositives.length, 0);
  assert.ok(r1.parseError);
  const r2 = parsePiiAuditResponse('{"missed":"oops","false_positives":[]}');
  assert.equal(r2.missed.length, 0);
});

test('applyPiiAudit: adds missed PII', () => {
  const session = createSession();
  const result = applyPiiAudit(session, {
    missed: [{ value: 'Marcus Chen', label: 'NAME', confidence: 0.95 }],
    falsePositives: []
  });
  assert.equal(result.added, 1);
  assert.equal(result.removed, 0);
  assert.equal(session._literalSecrets.length, 1);
});

test('applyPiiAudit: removes IPv4 false positive (network category, releasable)', async () => {
  const session = createSession();
  const text = 'Internal probe at 192.168.1.42 succeeded.';
  await scrub(text, session);
  // The IP should be in the session as IPV4
  const inv1 = listRedactions(session);
  assert.ok(inv1.find((i) => i.label === 'IPV4' && i.value === '192.168.1.42'));

  // Now the auditor flags it as a false positive
  const result = applyPiiAudit(session, {
    missed: [],
    falsePositives: [{ value: '192.168.1.42', label: 'IPV4', confidence: 0.9, reason: 'LAN address' }]
  });
  assert.equal(result.removed, 1);
  assert.equal(result.blocked, 0);
  assert.ok(isSkipped(session, '192.168.1.42', 'IPV4'));

  // Re-scrub the original text: IP should now stay visible
  const { text: rescrubbed } = await scrub(text, session);
  assert.ok(rescrubbed.includes('192.168.1.42'), 'IP should stay visible after audit released it');
});

test('applyPiiAudit: BLOCKS releases of secrets/financial/identifiers categories', async () => {
  const session = createSession();
  const text = 'Test card 4111 1111 1111 1111 and SSN 123-45-6789 and key sk-proj-' + 'a'.repeat(48);
  await scrub(text, session);
  const inv = listRedactions(session);
  // sanity: all three should be redacted by regex
  assert.ok(inv.find((i) => i.label === 'CC'));
  assert.ok(inv.find((i) => i.label === 'SSN'));
  assert.ok(inv.find((i) => i.label === 'OPENAI_KEY'));

  const result = applyPiiAudit(session, {
    missed: [],
    falsePositives: [
      { value: '4111 1111 1111 1111', label: 'CC', confidence: 0.99, reason: 'test card' },
      { value: '123-45-6789', label: 'SSN', confidence: 0.99, reason: 'placeholder' },
      { value: 'sk-proj-' + 'a'.repeat(48), label: 'OPENAI_KEY', confidence: 0.99, reason: 'placeholder' }
    ]
  });
  assert.equal(result.removed, 0);
  assert.equal(result.blocked, 3);
  assert.equal(result.blockedItems.length, 3);
  // The session should NOT have the values in the skip list
  assert.ok(!isSkipped(session, '4111 1111 1111 1111', 'CC'));
  assert.ok(!isSkipped(session, '123-45-6789', 'SSN'));

  // Re-scrub: all three should STILL be redacted
  const { text: rescrubbed } = await scrub(text, session);
  assert.ok(!rescrubbed.includes('4111 1111 1111 1111'));
  assert.ok(!rescrubbed.includes('123-45-6789'));
  assert.ok(!rescrubbed.includes('sk-proj-' + 'a'.repeat(48)));
});

test('applyPiiAudit: respects confidence thresholds', () => {
  const session = createSession();
  const result = applyPiiAudit(session, {
    missed: [
      { value: 'low conf', label: 'NAME', confidence: 0.3 }, // below default 0.6
      { value: 'High Conf', label: 'NAME', confidence: 0.9 }
    ],
    falsePositives: [
      { value: 'x', label: 'IPV4', confidence: 0.7 } // below release threshold 0.85
    ]
  });
  assert.equal(result.added, 1);
  assert.equal(result.removed, 0); // low confidence FP rejected
});

test('applyPiiAudit: full integration — audit fixes both add and remove', async () => {
  const session = createSession();
  const text = 'Customer Anna Lee at internal IP 192.168.1.42. Her real email is anna@acme.com.';
  await scrub(text, session);
  const inv1 = listRedactions(session);
  // Regex catches: EMAIL, IPV4 (but NOT Anna Lee — needs LLM)
  assert.ok(inv1.find((i) => i.label === 'EMAIL'));
  assert.ok(inv1.find((i) => i.label === 'IPV4'));
  assert.ok(!inv1.find((i) => i.label === 'NAME'));

  // Auditor: add the name, release the LAN IP
  applyPiiAudit(session, {
    missed: [{ value: 'Anna Lee', label: 'NAME', confidence: 0.95 }],
    falsePositives: [{ value: '192.168.1.42', label: 'IPV4', confidence: 0.9, reason: 'LAN' }]
  });

  // Re-scrub: name now redacted, IP visible, email still redacted
  const { text: pass2 } = await scrub(text, session);
  assert.ok(!pass2.includes('Anna Lee'));
  assert.ok(pass2.includes('192.168.1.42'));
  assert.ok(!pass2.includes('anna@acme.com'));
});
