// Missed-PII feedback loop helpers (BYO-LLM).
//
// The package never makes HTTP calls itself. The flow is:
//
//   1. scrub(input) → scrubbedText
//   2. ask any chat LLM with buildPiiCheckPrompt(scrubbedText) prompts
//   3. parsePiiCheckResponse(rawResponse) → { issues }
//   4. applyPiiCheckIssues(session, issues) → registers them as literal
//      secrets so the NEXT scrub() catches them
//   5. scrub(input, session) again → cleaner output
//
// Issue shape: { value, label, confidence, reason }

import { registerSecret } from './sessions.js';

const TOKEN_LITERAL_RE = /^\[\[[A-Z][A-Z0-9_]*_\d+\]\]$/;
const LABEL_RE = /^[A-Z][A-Z0-9_]*$/;

const DEFAULT_LABELS = [
  'NAME', 'EMAIL', 'PHONE', 'ADDRESS', 'DOB',
  'SSN', 'CC', 'IBAN', 'API_KEY', 'PASSWORD',
  'IPV4', 'URL', 'COMPANY', 'CUSTOM'
];

export function buildPiiCheckPrompt(scrubbedText, opts = {}) {
  if (typeof scrubbedText !== 'string') {
    throw new TypeError('buildPiiCheckPrompt: scrubbedText must be a string');
  }
  const labels = Array.isArray(opts.labels) && opts.labels.length > 0
    ? opts.labels
    : DEFAULT_LABELS;
  const minConfidence = opts.minConfidence ?? 0.6;

  const system = [
    'You are a PII detection assistant. The user will give you a piece of text',
    'that has ALREADY been partially redacted (some PII may appear as tokens like [[EMAIL_1]]).',
    'Your job is to identify any PERSONAL or SENSITIVE information that is STILL present in the text',
    `and was missed by regex. Recognized labels include: ${labels.join(', ')}.`,
    'Reply with ONLY a JSON object in this shape and nothing else:',
    '{ "issues": [{ "value": "<exact substring>", "label": "<LABEL>", "confidence": 0.0-1.0, "reason": "<one-line>" }] }',
    `Only include issues where confidence >= ${minConfidence}.`,
    'NEVER include token literals (anything matching [[LABEL_N]]) as an issue.',
    'NEVER invent values that don\'t literally appear in the text.',
    'If you find nothing, respond with { "issues": [] }.'
  ].join(' ');

  return { system, user: scrubbedText };
}

export function parsePiiCheckResponse(rawText) {
  if (typeof rawText !== 'string') {
    return { issues: [], parseError: 'response is not a string' };
  }
  // Tolerate code fences and stray prose
  const m = rawText.match(/\{[\s\S]*\}/);
  if (!m) return { issues: [], parseError: 'no JSON object found in response' };
  let obj;
  try {
    obj = JSON.parse(m[0]);
  } catch (e) {
    return { issues: [], parseError: `JSON parse failed: ${e.message}` };
  }
  if (!obj || typeof obj !== 'object' || !Array.isArray(obj.issues)) {
    return { issues: [], parseError: 'response is missing `issues` array' };
  }
  const issues = [];
  for (const raw of obj.issues) {
    if (!raw || typeof raw !== 'object') continue;
    const value = typeof raw.value === 'string' ? raw.value.trim() : '';
    const label = typeof raw.label === 'string' ? raw.label.trim().toUpperCase() : '';
    const confidence = Number(raw.confidence);
    const reason = typeof raw.reason === 'string' ? raw.reason : '';
    if (!value) continue;
    if (TOKEN_LITERAL_RE.test(value)) continue; // never accept tokens as issues
    if (!LABEL_RE.test(label)) continue;
    if (!Number.isFinite(confidence)) continue;
    issues.push({ value, label, confidence, reason });
  }
  return { issues };
}

export function applyPiiCheckIssues(session, issues, opts = {}) {
  if (!session) throw new TypeError('applyPiiCheckIssues: session required');
  if (!Array.isArray(issues)) return 0;
  const minConfidence = opts.minConfidence ?? 0.6;
  let applied = 0;
  for (const issue of issues) {
    if (!issue || typeof issue !== 'object') continue;
    if (!issue.value || !issue.label) continue;
    if (Number(issue.confidence) < minConfidence) continue;
    if (TOKEN_LITERAL_RE.test(issue.value)) continue;
    if (!LABEL_RE.test(issue.label)) continue;
    const ok = registerSecret(session, issue.value, issue.label);
    if (ok) applied++;
  }
  return applied;
}
