// restore(text, session) — longest-match-first three-pass restore.
//
// Pass 1: Tokens (`[[LABEL_N]]`). Unambiguous, do first.
// Pass 2: Full fake values (e.g. `redacted1@example.com`, `Marcus Chen`).
//         Sorted longest-first so "Marcus Chen" wins over "Marcus".
// Pass 3: Reference forms (e.g. "Marcus", "Marcus's", "Mr. Chen") —
//         partial fakes that the LLM may have used in its response.
//         Word-boundary protected to avoid eating "Marcus" inside
//         "Marcusland".
//
// Tokens or fakes that aren't registered on the session are passed through
// unchanged. This handles LLM-invented tokens and truncated tokens
// gracefully.

const TOKEN_RE = /\[\[[A-Z][A-Z0-9_]*_\d+\]\]/g;

export function restore(text, session) {
  if (typeof text !== 'string') {
    throw new TypeError('restore: text must be a string');
  }
  if (!session || typeof session !== 'object' || !session.tokens) {
    throw new TypeError('restore: invalid session (must have a `tokens` map)');
  }

  // Pass 1: tokens
  let working = text.replace(TOKEN_RE, (m) => session.tokens[m] ?? m);

  // Pass 2: fakes (longest-first, word-boundary aware to avoid eating substrings)
  if (session.fakes && Object.keys(session.fakes).length > 0) {
    const fakeKeys = Object.keys(session.fakes).sort((a, b) => b.length - a.length);
    for (const fake of fakeKeys) {
      if (!working.includes(fake)) continue;
      working = working.replace(buildBoundaryRegex(fake), () => session.fakes[fake]);
    }
  }

  // Pass 3: reference forms (longest-first, word-boundary aware)
  if (session.referenceForms && Object.keys(session.referenceForms).length > 0) {
    const refKeys = Object.keys(session.referenceForms).sort((a, b) => b.length - a.length);
    for (const partial of refKeys) {
      if (!working.includes(partial)) continue;
      working = working.replace(buildBoundaryRegex(partial), () => session.referenceForms[partial]);
    }
  }

  return working;
}

// Build a regex that matches `s` literally, but with negative lookahead /
// lookbehind for word characters at any boundary that itself ends/begins
// with a word character. This prevents "Marcus" from matching inside
// "Marcusland", and "redacted1@example.com" from matching inside
// "redacted1@example.community".
function buildBoundaryRegex(s) {
  const escaped = escapeRegex(s);
  const startsWithWord = /^\w/.test(s);
  const endsWithWord = /\w$/.test(s);
  const lb = startsWithWord ? '(?<![A-Za-z0-9_])' : '';
  const la = endsWithWord ? '(?![A-Za-z0-9_])' : '';
  try {
    return new RegExp(lb + escaped + la, 'g');
  } catch {
    return new RegExp(escaped, 'g');
  }
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
