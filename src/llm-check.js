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

import { registerSecret, skipValue } from './sessions.js';
import { DEFAULT_PATTERNS } from './patterns.js';

const TOKEN_LITERAL_RE = /^\[\[[A-Z][A-Z0-9_]*_\d+\]\]$/;
const LABEL_RE = /^[A-Z][A-Z0-9_]*$/;

// Build the label-to-category map from the default pattern catalog.
// Used by applyPiiAudit to enforce the safety override: the LLM auditor
// can never release a redaction whose label belongs to a high-stakes
// category (secrets, financial, identifiers). Same list as modes.js.
const LABEL_TO_CATEGORY = Object.fromEntries(
  DEFAULT_PATTERNS.map((p) => [p.label, p.category])
);
const NEVER_RELEASE_CATEGORIES = new Set(['secrets', 'financial', 'identifiers']);

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

// ============================================================================
// LLM AUDIT — second-pass that BOTH adds missed PII and removes false positives
// ============================================================================
//
// Shape:
//   buildPiiAuditPrompt(originalText, inventory, opts)
//   parsePiiAuditResponse(rawText) -> { missed: [...], falsePositives: [...] }
//   applyPiiAudit(session, audit, opts) -> { added, removed, blocked }
//
// Safety: false-positive REMOVALS are blocked for any label whose category is
// in NEVER_RELEASE_CATEGORIES (secrets / financial / identifiers). Even if the
// LLM is confidently wrong, an API key, credit card, IBAN, SSN, etc. will
// NEVER be un-redacted by the auditor. The check is enforced server-side in
// applyPiiAudit and cannot be bypassed by prompt-engineering the LLM.

export function buildPiiAuditPrompt(originalText, inventory, opts = {}) {
  if (typeof originalText !== 'string') {
    throw new TypeError('buildPiiAuditPrompt: originalText must be a string');
  }
  if (!Array.isArray(inventory)) {
    throw new TypeError('buildPiiAuditPrompt: inventory must be an array');
  }
  const labels = Array.isArray(opts.labels) && opts.labels.length > 0
    ? opts.labels
    : DEFAULT_LABELS;
  const minConfidence = opts.minConfidence ?? 0.6;

  // Pre-format the findings list compactly: "1. EMAIL=marcus@acme.com"
  const findings = inventory
    .map((i, idx) => `${idx + 1}. ${i.label}="${i.value}"`)
    .join('\n') || '(none)';

  const system = [
    'You audit the output of a PII redaction system.',
    `Recognized labels: ${labels.join(', ')}.`,
    '',
    'INPUT',
    '- ORIGINAL TEXT (PII still visible).',
    '- FINDINGS: each item the regex detector flagged as PII.',
    '',
    'YOUR JOB',
    'For each finding, decide if it is genuinely PII in this context. Also identify any PII the detector MISSED.',
    '',
    'OUTPUT FORMAT — a single JSON object, nothing else:',
    '{"missed":[{"value":"...","label":"NAME","confidence":0.9}],',
    ' "false_positives":[{"value":"...","label":"...","confidence":0.9,"reason":"..."}]}',
    '',
    'EXAMPLE 1 — auditor adds a missed name',
    'Text: "Hi, I\'m Marcus and my email is marcus@acme.com"',
    'Findings:\n1. EMAIL="marcus@acme.com"',
    'Output: {"missed":[{"value":"Marcus","label":"NAME","confidence":0.95}],"false_positives":[]}',
    '',
    'EXAMPLE 2 — auditor catches a false positive',
    'Text: "Use the test card 4111 1111 1111 1111 in staging (it is a documented placeholder)."',
    'Findings:\n1. CC="4111 1111 1111 1111"',
    'Output: {"missed":[],"false_positives":[{"value":"4111 1111 1111 1111","label":"CC","confidence":0.9,"reason":"documented test/placeholder card"}]}',
    '',
    'EXAMPLE 3 — auditor adds a name AND releases a private IP',
    'Text: "Customer Anna Lee\'s laptop has internal IP 192.168.1.42 (LAN-only)."',
    'Findings:\n1. IPV4="192.168.1.42"',
    'Output: {"missed":[{"value":"Anna Lee","label":"NAME","confidence":0.95}],"false_positives":[{"value":"192.168.1.42","label":"IPV4","confidence":0.85,"reason":"private LAN address, not personal data"}]}',
    '',
    'RULES',
    `- Only emit items where confidence >= ${minConfidence}.`,
    '- "value" must be an EXACT substring that literally appears in the text. Do not invent.',
    '- NEVER emit token literals (anything matching [[LABEL_N]]).',
    '- For false_positives, prefer high confidence (>= 0.85). When in doubt, leave it redacted.',
    '- Real secrets/keys/credit-card-numbers/SSNs are almost always real even if they look like placeholders. Be conservative.',
    '- If everything looks right and nothing is missed, output {"missed":[],"false_positives":[]}.',
    '- Output the JSON and stop. No commentary.'
  ].join('\n');

  return {
    system,
    user: `Text: ${JSON.stringify(originalText)}\nFindings:\n${findings}\nOutput:`
  };
}

export function parsePiiAuditResponse(rawText) {
  if (typeof rawText !== 'string') {
    return { missed: [], falsePositives: [], parseError: 'response is not a string' };
  }
  const m = rawText.match(/\{[\s\S]*\}/);
  if (!m) {
    return { missed: [], falsePositives: [], parseError: 'no JSON object found in response' };
  }
  let obj;
  try {
    obj = JSON.parse(m[0]);
  } catch (e) {
    return { missed: [], falsePositives: [], parseError: `JSON parse failed: ${e.message}` };
  }
  if (!obj || typeof obj !== 'object') {
    return { missed: [], falsePositives: [], parseError: 'response is not an object' };
  }

  const cleanItem = (raw) => {
    if (!raw || typeof raw !== 'object') return null;
    const value = typeof raw.value === 'string' ? raw.value.trim() : '';
    const label = typeof raw.label === 'string' ? raw.label.trim().toUpperCase() : '';
    const confidence = Number(raw.confidence);
    const reason = typeof raw.reason === 'string' ? raw.reason : '';
    if (!value) return null;
    if (TOKEN_LITERAL_RE.test(value)) return null;
    if (!LABEL_RE.test(label)) return null;
    if (!Number.isFinite(confidence)) return null;
    return { value, label, confidence, reason };
  };

  const missedRaw = Array.isArray(obj.missed) ? obj.missed : [];
  // Accept both "false_positives" (snake) and "falsePositives" (camel) from the LLM.
  const fpRaw = Array.isArray(obj.false_positives)
    ? obj.false_positives
    : Array.isArray(obj.falsePositives)
      ? obj.falsePositives
      : [];

  const missed = [];
  for (const r of missedRaw) {
    const c = cleanItem(r);
    if (c) missed.push(c);
  }
  const falsePositives = [];
  for (const r of fpRaw) {
    const c = cleanItem(r);
    if (c) falsePositives.push(c);
  }
  return { missed, falsePositives };
}

export function applyPiiAudit(session, audit, opts = {}) {
  if (!session) throw new TypeError('applyPiiAudit: session required');
  const result = { added: 0, removed: 0, blocked: 0, blockedItems: [] };
  if (!audit || typeof audit !== 'object') return result;

  const minConfidence = opts.minConfidence ?? 0.6;
  const releaseMinConfidence = opts.releaseMinConfidence ?? 0.85;

  // 1) Add missed PII (same rules as applyPiiCheckIssues)
  if (Array.isArray(audit.missed)) {
    for (const issue of audit.missed) {
      if (!issue || typeof issue !== 'object') continue;
      if (!issue.value || !issue.label) continue;
      if (Number(issue.confidence) < minConfidence) continue;
      if (TOKEN_LITERAL_RE.test(issue.value)) continue;
      if (!LABEL_RE.test(issue.label)) continue;
      const ok = registerSecret(session, issue.value, issue.label);
      if (ok) result.added++;
    }
  }

  // 2) Release false positives, but block any whose category is high-stakes.
  if (Array.isArray(audit.falsePositives)) {
    for (const fp of audit.falsePositives) {
      if (!fp || typeof fp !== 'object') continue;
      if (!fp.value || !fp.label) continue;
      if (Number(fp.confidence) < releaseMinConfidence) continue;
      if (!LABEL_RE.test(fp.label)) continue;
      const category = LABEL_TO_CATEGORY[fp.label];
      if (category && NEVER_RELEASE_CATEGORIES.has(category)) {
        result.blocked++;
        result.blockedItems.push({
          value: fp.value, label: fp.label, category, reason: 'high-stakes category cannot be released by LLM auditor'
        });
        continue;
      }
      const { skipped, removedIdentifier } = skipValue(session, fp.value, fp.label);
      if (skipped || removedIdentifier) result.removed++;
    }
  }

  return result;
}
