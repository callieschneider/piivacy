// Mode resolution.
//
// Given a pattern and the user's scrub options, decide whether the match
// should be replaced with a [[TOKEN]], a realistic fake, or left untouched
// (pass-through). Returns null when the pattern is excluded entirely.
//
// Resolution order (most-specific first):
//   1. exclude       -> null  (pattern doesn't run)
//   2. passThrough   -> 'pass-through'
//   3. labels[label] -> the named mode
//   4. modes[category] -> the named mode
//   5. defaultMode   -> the named mode (default 'token')

const VALID_MODES = new Set(['token', 'realistic', 'pass-through']);
// Categories that MUST never be pass-through. Hard-coded safety.
// Even if a caller writes labels.OPENAI_KEY = 'pass-through', we override.
const NEVER_PASS_THROUGH_CATEGORIES = new Set(['secrets', 'financial', 'identifiers']);

function validate(mode) {
  if (!VALID_MODES.has(mode)) {
    throw new Error(
      `mostly-no-pii: invalid mode "${mode}". Use 'token' | 'realistic' | 'pass-through'`
    );
  }
  return mode;
}

export function resolveMode(pattern, opts = {}) {
  const { label, category } = pattern;

  if (Array.isArray(opts.exclude) && opts.exclude.includes(label)) return null;

  let chosen;
  if (Array.isArray(opts.passThrough) && opts.passThrough.includes(label)) {
    chosen = 'pass-through';
  } else if (opts.labels && Object.prototype.hasOwnProperty.call(opts.labels, label)) {
    chosen = validate(opts.labels[label]);
  } else if (opts.modes && Object.prototype.hasOwnProperty.call(opts.modes, category)) {
    chosen = validate(opts.modes[category]);
  } else {
    chosen = validate(opts.defaultMode ?? 'token');
  }

  // Safety override: certain categories must never pass-through
  if (chosen === 'pass-through' && NEVER_PASS_THROUGH_CATEGORIES.has(category)) {
    return 'token';
  }

  return chosen;
}

// Convenience presets. Spread one into the scrub() opts object.
export const presets = {
  // Everything tokenized. Maximum privacy.
  maximumRedaction: { defaultMode: 'token' },

  // Common contact + location stay realistic so the LLM reads natural text.
  // Secrets/identifiers/financial stay token (high-stakes).
  naturalConversation: {
    defaultMode: 'token',
    modes: {
      contact: 'realistic',
      location: 'realistic'
    }
  },

  // Local search style: location passes through (LLM legitimately needs it),
  // everything else tokenized.
  localSearch: {
    defaultMode: 'token',
    modes: {
      location: 'pass-through'
    }
  },

  // Test fixture style: realistic everywhere it makes sense, token for
  // dangerous categories.
  testFriendly: {
    defaultMode: 'realistic',
    modes: {
      secrets: 'token',
      identifiers: 'token',
      financial: 'token'
    }
  }
};
