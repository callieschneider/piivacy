import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPiiCheckPrompt,
  parsePiiCheckResponse,
  applyPiiCheckIssues
} from '../src/llm-check.js';
import { createSession, registerSecret } from '../src/sessions.js';

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
