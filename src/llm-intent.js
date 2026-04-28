// Dynamic mode picking via BYO-LLM.
//
// Given a user input, an LLM decides which PII categories should be
// redacted, preserved, or replaced with synthetic values, based on what
// the LLM legitimately needs to answer well.
//
//   "Find me good Indian restaurants near 234 Main St, Brooklyn"
//     → location: preserve   (LLM needs the address for local search)
//     → contact:  redact     (LLM doesn't need email/phone here)
//     → secrets:  redact     (always)
//
// The package builds the prompt and parses the response. The HTTP call is
// the caller's responsibility.

const VALID_DECISIONS = new Set(['redact', 'preserve', 'synthetic']);
const HARD_REDACT_CATEGORIES = new Set(['secrets', 'financial', 'identifiers']);

const DEFAULT_CATEGORIES = [
  'secrets', 'contact', 'financial', 'identifiers', 'location', 'network'
];

export function buildScrubIntentPrompt(text, opts = {}) {
  if (typeof text !== 'string') {
    throw new TypeError('buildScrubIntentPrompt: text must be a string');
  }
  const cats = Array.isArray(opts.categories) && opts.categories.length > 0
    ? opts.categories
    : DEFAULT_CATEGORIES;

  const system = [
    'You decide what categories of PII the assistant needs preserved to answer a user query well.',
    `Categories: ${cats.join(', ')}.`,
    'For each category, choose ONE of:',
    '  "redact"    — assistant does NOT need this; replace it before sending.',
    '  "preserve"  — assistant legitimately needs the original value to answer well.',
    '  "synthetic" — assistant needs a similar value but not the real one (e.g. a name to talk about).',
    'Reply with ONLY this JSON object and nothing else:',
    '{ "decisions": { "secrets": "redact", "contact": "redact", "financial": "redact", "identifiers": "redact", "location": "redact", "network": "redact" }, "reason": "<one sentence>" }',
    'When in doubt, choose "redact". Never choose "preserve" for secrets, financial, or identifiers.'
  ].join(' ');

  return { system, user: text };
}

export function parseScrubIntentResponse(rawText) {
  if (typeof rawText !== 'string') {
    return { decisions: {}, parseError: 'response is not a string' };
  }
  const m = rawText.match(/\{[\s\S]*\}/);
  if (!m) return { decisions: {}, parseError: 'no JSON object found' };
  let obj;
  try {
    obj = JSON.parse(m[0]);
  } catch (e) {
    return { decisions: {}, parseError: `JSON parse failed: ${e.message}` };
  }
  if (!obj || typeof obj !== 'object') {
    return { decisions: {}, parseError: 'response is not an object' };
  }
  const decisions = {};
  const src = obj.decisions ?? {};
  if (typeof src === 'object' && src !== null) {
    for (const [cat, choice] of Object.entries(src)) {
      if (typeof choice !== 'string') continue;
      const lower = choice.toLowerCase();
      if (!VALID_DECISIONS.has(lower)) continue;
      decisions[cat] = lower;
    }
  }
  // Safety override: dangerous categories always get redacted, regardless
  // of what the LLM said.
  for (const cat of HARD_REDACT_CATEGORIES) {
    if (decisions[cat] === 'preserve') decisions[cat] = 'redact';
  }
  return { decisions, reason: typeof obj.reason === 'string' ? obj.reason : '' };
}

const MODE_MAP = {
  redact: 'token',
  preserve: 'pass-through',
  synthetic: 'realistic'
};

export function applyScrubIntent(decisions, baseOpts = {}) {
  if (!decisions || typeof decisions !== 'object') return { ...baseOpts };
  const modes = { ...(baseOpts.modes ?? {}) };
  for (const [cat, choice] of Object.entries(decisions)) {
    const mode = MODE_MAP[choice];
    if (mode) modes[cat] = mode;
  }
  return { ...baseOpts, modes };
}
