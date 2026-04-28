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
    'You are a PII detection assistant. The user gives you text that has ALREADY been partially redacted (some PII appears as tokens like [[EMAIL_1]]).',
    `Your job: find any personal or sensitive info STILL present in the text. Recognized labels: ${labels.join(', ')}.`,
    '',
    'OUTPUT FORMAT: a single JSON object with one key "issues" (an array). Nothing else. No prose, no markdown.',
    '',
    'EXAMPLE 1',
    'Text: "Hi, my name is Jane Doe and I work at Acme Corp."',
    'Output: {"issues":[{"value":"Jane Doe","label":"NAME","confidence":0.95},{"value":"Acme Corp","label":"COMPANY","confidence":0.85}]}',
    '',
    'EXAMPLE 2',
    'Text: "Email me at [[EMAIL_1]]."',
    'Output: {"issues":[]}',
    '',
    'EXAMPLE 3',
    'Text: "Project Phoenix launches on the 5th. Contact Marcus Chen for details."',
    'Output: {"issues":[{"value":"Project Phoenix","label":"CODENAME","confidence":0.9},{"value":"Marcus Chen","label":"NAME","confidence":0.95}]}',
    '',
    'RULES',
    `- Only emit issues where confidence >= ${minConfidence}.`,
    '- Each "value" MUST be an exact substring that literally appears in the text. Do not invent values.',
    '- NEVER emit token literals (anything matching [[LABEL_N]]).',
    '- If you find nothing, output {"issues":[]}.',
    '- Output the JSON and stop. No commentary.'
  ].join('\n');

  return { system, user: `Text: ${JSON.stringify(scrubbedText)}\nOutput:` };
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
