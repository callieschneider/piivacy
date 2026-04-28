// scrub(text, session?, opts?) — async core algorithm.
//
// Two passes:
//   1. Literal secrets (LLM-flagged or manually registered via registerSecret)
//      are processed first using the same mode-resolution rules.
//   2. Regex patterns from the registry, applied in priority order. Each
//      match is mode-resolved (token | realistic | pass-through). Realistic
//      mode tries `pattern.fake()`; if it produces nothing (no fake func or
//      collision), we fall back to token mode for that match.

import { resolvePatterns } from './registry.js';
import { resolveMode } from './modes.js';
import { generateFake } from './fake-values.js';
import {
  createSession,
  getOrAssignToken,
  registerFake,
  isExpired
} from './sessions.js';

const TOKEN_LITERAL_RE = /\[\[[A-Z][A-Z0-9_]*_\d+\]\]/;

export async function scrub(text, existingSession, opts = {}) {
  if (typeof text !== 'string') {
    throw new TypeError('scrub: text must be a string');
  }
  if (existingSession && isExpired(existingSession) && !opts.allowExpired) {
    throw new Error('piivacy: session has expired');
  }
  const session = existingSession || createSession();

  // Use a stable copy of the original input for collision checks; mutate
  // `working` as we replace.
  const originalInput = text;
  let working = text;

  // ---------- PASS 1: literal secrets ----------
  for (const { value, label } of session._literalSecrets ?? []) {
    if (!value || !working.includes(value)) continue;
    const fakePattern = { label, category: 'custom' };
    const mode = resolveMode(fakePattern, opts);
    if (mode === null || mode === 'pass-through') continue;
    const escaped = escapeRegex(value);
    // Token mode only (we don't run fake() for literal-secret strings without
    // a pattern definition — those go to token).
    working = working.replace(new RegExp(escaped, 'g'), () =>
      getOrAssignToken(session, label, value)
    );
  }

  // ---------- PASS 2: regex patterns ----------
  for (const pattern of resolvePatterns(opts)) {
    const mode = resolveMode(pattern, opts);
    if (mode === null) continue;
    if (mode === 'pass-through') continue;

    const matches = collectMatches(working, pattern);
    if (matches.length === 0) continue;

    // Pre-compute per-match substitutes (in document order). Realistic mode
    // may be async (adapter-driven names), so we await sequentially.
    const replacements = [];
    for (const m of matches) {
      const value = m.value;
      if (TOKEN_LITERAL_RE.test(value)) continue; // never re-redact our own tokens
      // If this value is already a known FAKE produced by a previous pass on
      // the same session, leave it alone. Otherwise scrub-of-scrub is not
      // idempotent: e.g. the realistic ZIP fake "00001" itself matches the
      // ZIP regex, so a second pass would treat it as new PII.
      if (session.fakes && Object.prototype.hasOwnProperty.call(session.fakes, value)) continue;
      if (typeof pattern.validate === 'function' && !pattern.validate(value)) continue;

      let substitute;
      if (mode === 'realistic') {
        const fake = await generateFake({
          pattern,
          value,
          session,
          input: originalInput
        });
        if (fake) {
          const refForms =
            typeof pattern.referenceForms === 'function'
              ? safeRefForms(pattern, value, fake)
              : {};
          substitute = registerFake(session, value, fake, pattern.label, refForms);
        } else {
          // Fallback: token
          substitute = getOrAssignToken(session, pattern.label, value);
        }
      } else {
        substitute = getOrAssignToken(session, pattern.label, value);
      }
      replacements.push({ start: m.start, end: m.end, substitute });
    }
    if (replacements.length === 0) continue;

    // Apply right-to-left so offsets don't drift.
    replacements.sort((a, b) => b.start - a.start);
    for (const r of replacements) {
      working = working.slice(0, r.start) + r.substitute + working.slice(r.end);
    }
  }

  return { text: working, session };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function collectMatches(text, pattern) {
  const re = pattern.regex;
  // Reset lastIndex on the shared RegExp object — global flag is required by
  // the registry, so this is safe.
  re.lastIndex = 0;
  const out = [];
  let m;
  // Track [start,end] regions that have already been claimed so a longer
  // pattern (e.g. ADDRESS_US absorbing ZIP_US) prevents an inner pattern
  // from re-matching part of an earlier replacement. We use only the
  // current iteration's matches for this — cross-pattern de-duplication
  // happens because we replace working text between patterns, so an
  // already-tokenized region won't be matched again by a later pattern.
  while ((m = re.exec(text)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    out.push({ value: m[0], start: m.index, end: m.index + m[0].length });
  }
  return out;
}

function safeRefForms(pattern, value, fake) {
  try {
    const out = pattern.referenceForms(value, fake);
    return out && typeof out === 'object' ? out : {};
  } catch {
    return {};
  }
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
