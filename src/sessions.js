// Session state.
//
// A session is a plain object that holds the bidirectional maps between
// real values and their substitutes (tokens or fakes), plus per-label
// counters, usage stats, a sliding TTL, and an optional name-substitution
// adapter.
//
// Sessions are JSON-serializable. The caller is responsible for any
// persistence (Redis, file, etc.).

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const LABEL_RE = /^[A-Z][A-Z0-9_]*$/;

export function createSession(opts = {}) {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  if (typeof ttlMs !== 'number' || ttlMs <= 0) {
    throw new TypeError('createSession: ttlMs must be a positive number');
  }
  const now = Date.now();
  return {
    tokens: {},                  // token -> original value
    reverse: {},                 // `${label}::${value}` -> token (or fake)
    counters: {},                // label -> next token counter
    _fakeCounters: {},           // label -> next fake counter
    fakes: {},                   // fakeValue -> originalValue
    referenceForms: {},          // partialFake -> partialOriginal
    usage: {},                   // identifier -> { count, firstSeenAt, lastSeenAt }
    _literalSecrets: [],         // [{ value, label }]
    nameAdapter: opts.nameAdapter ?? null,
    ttlMs,
    createdAt: now,
    expiresAt: now + ttlMs
  };
}

export function isExpired(session) {
  if (!session || typeof session.expiresAt !== 'number') return false;
  return Date.now() > session.expiresAt;
}

function bump(session) {
  session.expiresAt = Date.now() + session.ttlMs;
}

function recordUsage(session, identifier) {
  const now = Date.now();
  const u = session.usage[identifier];
  if (!u) {
    session.usage[identifier] = { count: 1, firstSeenAt: now, lastSeenAt: now };
  } else {
    u.count++;
    u.lastSeenAt = now;
  }
}

// Token-mode assignment. Used directly OR as fallback when realistic mode
// can't produce a fake.
export function getOrAssignToken(session, label, value) {
  bump(session);
  const reverseKey = `${label}::${value}`;
  let token = session.reverse[reverseKey];
  if (!token) {
    const n = (session.counters[label] = (session.counters[label] || 0) + 1);
    token = `[[${label}_${n}]]`;
    session.tokens[token] = value;
    session.reverse[reverseKey] = token;
  }
  recordUsage(session, token);
  return token;
}

// Realistic-mode assignment. Stores the forward map (fake -> original) and
// any reference forms supplied by the pattern.
export function registerFake(session, originalValue, fakeValue, label, referenceForms = {}) {
  bump(session);
  const reverseKey = `${label}::${originalValue}`;
  if (session.reverse[reverseKey]) {
    recordUsage(session, session.reverse[reverseKey]);
    return session.reverse[reverseKey];
  }
  session.reverse[reverseKey] = fakeValue;
  session.fakes[fakeValue] = originalValue;
  for (const [partialFake, partialOriginal] of Object.entries(referenceForms)) {
    if (typeof partialFake !== 'string' || typeof partialOriginal !== 'string') continue;
    if (partialFake === partialOriginal) continue;
    if (!session.referenceForms[partialFake]) {
      session.referenceForms[partialFake] = partialOriginal;
    }
  }
  recordUsage(session, fakeValue);
  return fakeValue;
}

// Pre-register a literal value to be redacted on the next scrub. Used by
// applyPiiCheckIssues() and callable directly.
export function registerSecret(session, value, label = 'CUSTOM') {
  if (!session || typeof session !== 'object') {
    throw new TypeError('registerSecret: session required');
  }
  if (!value || typeof value !== 'string') {
    throw new TypeError('registerSecret: value required (non-empty string)');
  }
  if (typeof label !== 'string' || !LABEL_RE.test(label)) {
    throw new TypeError(
      `registerSecret: invalid label ${JSON.stringify(label)} — must match /^[A-Z][A-Z0-9_]*$/`
    );
  }
  if (!Array.isArray(session._literalSecrets)) session._literalSecrets = [];
  if (session._literalSecrets.some((s) => s.value === value && s.label === label)) return false;
  session._literalSecrets.push({ value, label });
  return true;
}

// Inventory: returns combined token + fake redactions, sorted by first-seen.
export function listRedactions(session) {
  if (!session) return [];
  const items = [];
  // Tokens
  for (const [token, value] of Object.entries(session.tokens || {})) {
    const m = token.match(/^\[\[([A-Z][A-Z0-9_]*)_\d+\]\]$/);
    const usage = session.usage[token] || {};
    items.push({
      kind: 'token',
      identifier: token,
      label: m?.[1] ?? 'UNKNOWN',
      value,
      count: usage.count ?? 0,
      firstSeenAt: usage.firstSeenAt ?? null,
      lastSeenAt: usage.lastSeenAt ?? null
    });
  }
  // Fakes
  for (const [fake, value] of Object.entries(session.fakes || {})) {
    let label = 'UNKNOWN';
    for (const [revKey, revVal] of Object.entries(session.reverse || {})) {
      if (revVal === fake) {
        label = revKey.split('::')[0];
        break;
      }
    }
    const usage = session.usage[fake] || {};
    items.push({
      kind: 'fake',
      identifier: fake,
      label,
      value,
      count: usage.count ?? 0,
      firstSeenAt: usage.firstSeenAt ?? null,
      lastSeenAt: usage.lastSeenAt ?? null
    });
  }
  return items.sort(
    (a, b) => (a.firstSeenAt ?? 0) - (b.firstSeenAt ?? 0)
      || a.identifier.localeCompare(b.identifier)
  );
}
