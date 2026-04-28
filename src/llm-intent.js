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

  // We hand the model two contrasting few-shot examples so it doesn't anchor on
  // a single all-redact template and copy it verbatim. The two examples are
  // chosen so a small model (Llama-3.2-1B / Qwen2.5-1.5B) can pattern-match:
  //   1. Local-search query  -> location:preserve, everything else redact
  //   2. Generic data-handling -> everything redact
  // We do NOT ask for a "reason" field — small models tend to leak the input
  // back into a free-text reason, which is exactly what we are trying to avoid.
  const system = [
    'You decide which categories of PII a downstream assistant LLM needs preserved to answer a user query.',
    `Categories: ${cats.join(', ')}.`,
    'For each category, output exactly ONE of:',
    '  "redact"    — the assistant does NOT need this; tokenize it before sending.',
    '  "preserve"  — the assistant legitimately needs the original value to answer.',
    '  "synthetic" — the assistant needs a plausible value but not the real one.',
    '',
    'OUTPUT FORMAT: a single JSON object with one key "decisions". Nothing else. No prose, no reason field, no markdown.',
    '',
    'EXAMPLE 1',
    'Query: "Find Indian restaurants near 234 Main St, Brooklyn 11211. Email me the list at me@example.com."',
    'Output: {"decisions":{"secrets":"redact","contact":"redact","financial":"redact","identifiers":"redact","location":"preserve","network":"redact"}}',
    'Why (do NOT include in output): a local-search query needs the address to find nearby places.',
    '',
    'EXAMPLE 2',
    'Query: "Summarize this CV: Jane Doe, jane@acme.com, born 04/12/1990, lives at 99 Oak St."',
    'Output: {"decisions":{"secrets":"redact","contact":"redact","financial":"redact","identifiers":"redact","location":"redact","network":"redact"}}',
    'Why: pure summarization does not require any specific real value.',
    '',
    'EXAMPLE 3',
    'Query: "Schedule a call with the client for next Tuesday."',
    'Output: {"decisions":{"secrets":"redact","contact":"redact","financial":"redact","identifiers":"redact","location":"redact","network":"redact"}}',
    'Why: scheduling does not need any specific PII.',
    '',
    'RULES',
    '- When in doubt, pick "redact".',
    '- NEVER pick "preserve" for secrets, financial, or identifiers — those are always redact.',
    '- "preserve" is appropriate when the answer literally depends on the value (addresses for local search, ISBNs for book lookups, dates for time-sensitive scheduling, etc.).',
    '- Output the JSON and stop. No commentary.'
  ].join('\n');

  const user = `Query: ${JSON.stringify(text)}\nOutput:`;

  return { system, user };
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
  // We accept a "reason" field for backward-compat but the demo no longer
  // surfaces it — small models leak the input verbatim into reason text and
  // it adds noise without value.
  const reason = typeof obj.reason === 'string' ? obj.reason.slice(0, 240) : '';
  return { decisions, reason };
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
