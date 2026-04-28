// Default PII pattern catalog.
//
// Each entry: { label, regex, category, priority, validate?, fake?, referenceForms?, description? }
//
// Priorities are spaced by 10s so callers can slot custom patterns between defaults.
// Lower = applied first. Order within a priority is insertion order.

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

export function luhn(num) {
  const digits = num.replace(/\D/g, '');
  if (digits.length < 2) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (n < 0 || n > 9) return false;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

export function ibanMod97(iban) {
  const cleaned = iban.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(cleaned)) return false;
  const rearranged = cleaned.slice(4) + cleaned.slice(0, 4);
  // Convert letters to digits (A=10, B=11, ..., Z=35)
  let numeric = '';
  for (const ch of rearranged) {
    const code = ch.charCodeAt(0);
    if (code >= 48 && code <= 57) numeric += ch;
    else if (code >= 65 && code <= 90) numeric += String(code - 55);
    else return false;
  }
  // Compute mod 97 piecewise (numeric can be > 30 digits)
  let remainder = 0;
  for (let i = 0; i < numeric.length; i += 7) {
    const chunk = String(remainder) + numeric.slice(i, i + 7);
    remainder = Number(chunk) % 97;
  }
  return remainder === 1;
}

export function validSsn(ssn) {
  const digits = ssn.replace(/\D/g, '');
  if (digits.length !== 9) return false;
  const area = digits.slice(0, 3);
  const group = digits.slice(3, 5);
  const serial = digits.slice(5, 9);
  // Invalid area numbers
  if (area === '000' || area === '666') return false;
  if (area[0] === '9') return false;
  if (group === '00') return false;
  if (serial === '0000') return false;
  return true;
}

export function validVin(vin) {
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) return false;
  const transliteration = {
    A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8,
    J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9,
    S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9
  };
  const weights = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const ch = vin[i];
    const val = /\d/.test(ch) ? Number(ch) : transliteration[ch];
    if (val === undefined) return false;
    sum += val * weights[i];
  }
  const checkDigit = sum % 11;
  const expected = checkDigit === 10 ? 'X' : String(checkDigit);
  return vin[8] === expected;
}

export function validIpv4(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return false;
    if (p.length > 1 && p[0] === '0') return false; // no leading zeros
    const n = Number(p);
    if (n < 0 || n > 255) return false;
  }
  return true;
}

export function validDob(dob) {
  // Accepts MM/DD/YYYY, MM-DD-YYYY, or YYYY-MM-DD
  let m, d, y;
  let match = dob.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (match) {
    m = Number(match[1]);
    d = Number(match[2]);
    y = Number(match[3]);
    if (y < 100) y += y < 30 ? 2000 : 1900;
  } else {
    match = dob.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (!match) return false;
    y = Number(match[1]);
    m = Number(match[2]);
    d = Number(match[3]);
  }
  if (m < 1 || m > 12) return false;
  if (d < 1 || d > 31) return false;
  if (y < 1900 || y > 2100) return false;
  // Day-in-month check
  const daysInMonth = [31, (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28,
    31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return d <= daysInMonth[m - 1];
}

// ---------------------------------------------------------------------------
// Helpers used by fake() functions
// ---------------------------------------------------------------------------

function pad(n, width) {
  const s = String(n);
  return s.length >= width ? s : '0'.repeat(width - s.length) + s;
}

// ---------------------------------------------------------------------------
// The catalog
// ---------------------------------------------------------------------------

export const DEFAULT_PATTERNS = [
  // -------------------- secrets (token-only) --------------------
  {
    label: 'OPENAI_KEY',
    regex: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/g,
    category: 'secrets',
    priority: 10,
    description: 'OpenAI API key (sk- or sk-proj- prefix)'
  },
  {
    label: 'ANTHROPIC_KEY',
    regex: /\bsk-ant-(?:api\d{2}-)?[A-Za-z0-9_-]{40,}\b/g,
    category: 'secrets',
    priority: 11,
    description: 'Anthropic API key (sk-ant-... prefix)'
  },
  {
    label: 'GITHUB_TOKEN',
    regex: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{82,})\b/g,
    category: 'secrets',
    priority: 12,
    description: 'GitHub personal access token, OAuth, or fine-grained PAT'
  },
  {
    label: 'AWS_ACCESS_KEY',
    regex: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
    category: 'secrets',
    priority: 13,
    description: 'AWS access key ID (AKIA / ASIA prefix)'
  },
  {
    label: 'AWS_SECRET_KEY',
    // Match a 40-char base64ish value when preceded by an aws-secret-key keyword.
    // Lookbehind is supported in Node 18+ (V8 ≥ 6.2).
    regex: /(?<=aws[_-]?(?:secret[_-]?)?(?:access[_-]?)?key\s*[:=]\s*['"]?)[A-Za-z0-9/+]{40}(?=['"]?)/gi,
    category: 'secrets',
    priority: 14,
    validate: (v) => /[A-Z]/.test(v) && /[a-z]/.test(v) && /[0-9]/.test(v),
    description: 'AWS secret access key (40 chars, requires keyword context)'
  },
  {
    label: 'GOOGLE_API_KEY',
    regex: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    category: 'secrets',
    priority: 15,
    description: 'Google API key (AIza... prefix)'
  },
  {
    label: 'STRIPE_KEY',
    regex: /\b[ps]k_(?:live|test)_[0-9a-zA-Z]{24,}\b/g,
    category: 'secrets',
    priority: 16,
    description: 'Stripe API key (sk_live, pk_live, sk_test, pk_test)'
  },
  {
    label: 'SLACK_TOKEN',
    regex: /\bxox[abprs]-[0-9a-zA-Z-]{10,}\b/g,
    category: 'secrets',
    priority: 17,
    description: 'Slack token (xoxa, xoxb, xoxp, xoxr, xoxs)'
  },
  {
    label: 'JWT',
    regex: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    category: 'secrets',
    priority: 18,
    description: 'JSON Web Token (three base64url segments)'
  },
  {
    label: 'URL_CREDENTIALS',
    regex: /\b(?:https?|ftp|ssh|mysql):\/\/[^:/\s]+:[^@/\s]+@[^\s]+/g,
    category: 'secrets',
    priority: 19,
    description: 'URL with embedded user:password credentials (generic)'
  },
  {
    label: 'POSTGRES_URL',
    regex: /\b(?:postgres|postgresql):\/\/[^:/\s]+:[^@/\s]+@[^\s]+/g,
    category: 'secrets',
    priority: 19.1,
    description: 'PostgreSQL connection string with credentials'
  },
  {
    label: 'MONGODB_URL',
    regex: /\bmongodb(?:\+srv)?:\/\/[^:/\s]+:[^@/\s]+@[^\s]+/g,
    category: 'secrets',
    priority: 19.2,
    description: 'MongoDB connection string with credentials'
  },
  {
    label: 'REDIS_URL',
    regex: /\bredis(?:s)?:\/\/(?:[^:/\s]*:)?[^@/\s]+@[^\s]+/g,
    category: 'secrets',
    priority: 19.3,
    description: 'Redis connection string with auth'
  },
  // -- LLM provider keys --
  {
    label: 'GROQ_KEY',
    regex: /\bgsk_[A-Za-z0-9]{50,}\b/g,
    category: 'secrets',
    priority: 19.4,
    description: 'Groq API key (gsk_ prefix)'
  },
  {
    label: 'HUGGINGFACE_TOKEN',
    regex: /\bhf_[A-Za-z0-9]{30,40}\b/g,
    category: 'secrets',
    priority: 19.5,
    description: 'Hugging Face access token (hf_ prefix)'
  },
  {
    label: 'REPLICATE_TOKEN',
    regex: /\br8_[A-Za-z0-9]{38,42}\b/g,
    category: 'secrets',
    priority: 19.6,
    description: 'Replicate API token (r8_ prefix)'
  },
  {
    label: 'COHERE_KEY',
    regex: /(?<=cohere[_-]?(?:api[_-]?)?key\s*[:=]\s*['"]?)[A-Za-z0-9]{40}(?=['"]?)/gi,
    category: 'secrets',
    priority: 19.7,
    description: 'Cohere API key (40-char, requires keyword context)'
  },
  {
    label: 'ELEVENLABS_KEY',
    regex: /(?<=(?:xi[-_]?api[-_]?key|elevenlabs[_-]?key)\s*[:=]\s*['"]?)[a-f0-9]{32}(?=['"]?)/gi,
    category: 'secrets',
    priority: 19.8,
    description: 'ElevenLabs API key (32 hex, requires keyword context)'
  },
  // -- Communication / notifications --
  {
    label: 'TWILIO_KEY',
    regex: /\bAC[a-f0-9]{32}\b/g,
    category: 'secrets',
    priority: 19.9,
    description: 'Twilio Account SID (AC prefix + 32 hex)'
  },
  {
    label: 'SENDGRID_KEY',
    regex: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g,
    category: 'secrets',
    priority: 19.91,
    description: 'SendGrid API key (SG.xxx.yyy format)'
  },
  {
    label: 'MAILGUN_KEY',
    regex: /\bkey-[a-f0-9]{32}\b/g,
    category: 'secrets',
    priority: 19.92,
    description: 'Mailgun API key (key-{32 hex})'
  },
  {
    label: 'POSTMARK_TOKEN',
    regex: /\b[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b/g,
    category: 'secrets',
    priority: 19.93,
    validate: (v) => /^[a-f0-9-]{36}$/.test(v),
    description: 'Postmark server token (UUID format)'
  },
  {
    label: 'DISCORD_WEBHOOK',
    regex: /\bhttps:\/\/(?:discord(?:app)?\.com|ptb\.discord\.com|canary\.discord\.com)\/api\/webhooks\/\d{17,20}\/[A-Za-z0-9_-]{60,}\b/g,
    category: 'secrets',
    priority: 19.94,
    description: 'Discord webhook URL'
  },
  {
    label: 'SLACK_WEBHOOK',
    regex: /\bhttps:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]{8,}\/B[A-Z0-9]{8,}\/[A-Za-z0-9]{20,}\b/g,
    category: 'secrets',
    priority: 19.95,
    description: 'Slack incoming webhook URL'
  },
  // -- Productivity / dev --
  {
    label: 'NOTION_TOKEN',
    regex: /\bsecret_[A-Za-z0-9]{43}\b/g,
    category: 'secrets',
    priority: 19.96,
    description: 'Notion integration token (secret_ prefix)'
  },
  {
    label: 'FIGMA_TOKEN',
    regex: /\bfigd_[A-Za-z0-9_-]{40,}\b/g,
    category: 'secrets',
    priority: 19.97,
    description: 'Figma personal access token (figd_ prefix)'
  },
  {
    label: 'LINEAR_KEY',
    regex: /\blin_api_[A-Za-z0-9]{40,}\b/g,
    category: 'secrets',
    priority: 19.98,
    description: 'Linear API key (lin_api_ prefix)'
  },
  {
    label: 'NPM_TOKEN',
    regex: /\bnpm_[A-Za-z0-9]{36}\b/g,
    category: 'secrets',
    priority: 19.99,
    description: 'npm access token (npm_ prefix)'
  },
  {
    label: 'GITLAB_PAT',
    regex: /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
    category: 'secrets',
    priority: 19.991,
    description: 'GitLab personal access token (glpat- prefix)'
  },
  // -- Cloud / infra --
  {
    label: 'SUPABASE_KEY',
    regex: /\bsbp_[a-f0-9]{40,}\b/g,
    category: 'secrets',
    priority: 19.992,
    description: 'Supabase service-role key (sbp_ prefix)'
  },
  {
    label: 'DIGITALOCEAN_TOKEN',
    regex: /\bdop_v1_[a-f0-9]{64}\b/g,
    category: 'secrets',
    priority: 19.993,
    description: 'DigitalOcean access token (dop_v1_ prefix)'
  },
  {
    label: 'CLOUDFLARE_KEY',
    regex: /(?<=(?:cf[-_]?api[-_]?key|cloudflare[_-]?key)\s*[:=]\s*['"]?)[a-f0-9]{37}(?=['"]?)/gi,
    category: 'secrets',
    priority: 19.994,
    description: 'Cloudflare API key (37 hex, requires keyword context)'
  },
  {
    label: 'ALGOLIA_KEY',
    regex: /(?<=algolia[_-]?(?:api[_-]?|admin[_-]?)?key\s*[:=]\s*['"]?)[a-f0-9]{32}(?=['"]?)/gi,
    category: 'secrets',
    priority: 19.995,
    description: 'Algolia API key (32 hex, requires keyword context)'
  },
  {
    label: 'HEROKU_KEY',
    regex: /(?<=heroku[_-]?(?:api[_-]?)?key\s*[:=]\s*['"]?)[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?=['"]?)/gi,
    category: 'secrets',
    priority: 19.996,
    description: 'Heroku API key (UUID, requires keyword context)'
  },
  // -- Observability --
  {
    label: 'SENTRY_DSN',
    regex: /\bhttps:\/\/[a-f0-9]{32,}@[a-z0-9.-]*sentry\.io\/\d+\b/g,
    category: 'secrets',
    priority: 19.997,
    description: 'Sentry DSN (URL with project key)'
  },
  {
    label: 'DATADOG_KEY',
    regex: /(?<=(?:dd[-_]?api[-_]?key|datadog[_-]?key)\s*[:=]\s*['"]?)[a-f0-9]{32}(?=['"]?)/gi,
    category: 'secrets',
    priority: 19.998,
    description: 'Datadog API key (32 hex, requires keyword context)'
  },
  // -- Crypto / certs --
  {
    label: 'PEM_PRIVATE_KEY',
    regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY-----/g,
    category: 'secrets',
    priority: 19.999,
    description: 'PEM/PGP private key block'
  },

  // -------------------- contact (realistic-friendly) --------------------
  {
    label: 'EMAIL',
    regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    category: 'contact',
    priority: 20,
    fake: (_value, { counter }) => `redacted${counter}@example.com`,
    description: 'Email address'
  },
  {
    label: 'PHONE_US',
    // Optional +1, optional parens, optional separators. First digit of area & exchange must be 2-9.
    // Negative lookbehind prevents matching the tail of a longer digit run (e.g. credit-card-like substrings).
    regex: /(?<![0-9])(?:\+?1[-.\s]?)?\(?[2-9]\d{2}\)?[-.\s]?[2-9]\d{2}[-.\s]?\d{4}(?![0-9])/g,
    category: 'contact',
    priority: 21,
    fake: (_value, { counter }) => `(555) 010-${pad(counter % 10000, 4)}`,
    description: 'US phone number (NANP)'
  },
  {
    label: 'PHONE_E164',
    // Plus, 1-3 digit country code != 1 (US handled above), 6-12 more digits
    regex: /(?<![0-9])\+(?!1\b)[2-9]\d{0,2}[-.\s]?\d{1,4}[-.\s]?\d{4,12}(?![0-9])/g,
    category: 'contact',
    priority: 22,
    validate: (v) => v.replace(/\D/g, '').length >= 8 && v.replace(/\D/g, '').length <= 15,
    fake: (_value, { counter }) => `+44 555 010 ${pad(counter % 10000, 4)}`,
    description: 'International phone number (E.164)'
  },

  // -------------------- financial --------------------
  {
    label: 'IBAN',
    // Two valid formats:
    //   1. No-separator: GB82WEST12345698765432 (country + check + 11-30 alphanumeric)
    //   2. Space-grouped: GB82 WEST 1234 5698 7654 32 (4-char groups, last 1-4)
    // Earlier looser pattern allowed separators between any chars and would
    // extend the match into adjacent text (e.g. "GB82...432 EB" eating MAC
    // bytes), which then failed mod-97 validation and lost the IBAN entirely.
    regex: /\b[A-Z]{2}\d{2}(?:[A-Z0-9]{11,30}|[ -](?:[A-Z0-9]{4}[ -]){1,7}[A-Z0-9]{1,4})\b/g,
    category: 'financial',
    priority: 30,
    validate: (v) => ibanMod97(v),
    description: 'IBAN (validated via mod-97)'
  },
  {
    label: 'CC',
    // Earlier looser pattern `\b(?:\d[ -]?){12,18}\d\b` allowed any single
    // separator between any two digits, so a 5-digit ZIP followed by a CC
    // (e.g. "35000 4197 0518 4714 0496") would match as one 16-digit run
    // starting at the ZIP. Luhn would then reject the wrong slice and the
    // real CC was lost. New regex requires either an unbroken 12-19 digit
    // run, or a consistent 4-digit-group format (single separator type).
    // (?<![0-9]) + (?![0-9]) prevent the match from starting/ending mid-run.
    regex: /(?<![0-9])(?:\d{12,19}|\d{4}(?:[ ]\d{4}){2,3}(?:[ ]\d{1,3})?|\d{4}(?:-\d{4}){2,3}(?:-\d{1,3})?|\d{4}\.\d{4}\.\d{4}\.\d{4})(?![0-9])/g,
    category: 'financial',
    priority: 31,
    validate: (v) => luhn(v),
    fake: (_value, { counter }) => {
      // Visa test card with sequential last-4 to keep dedup working visually
      const last4 = pad(counter % 10000, 4);
      return `4111-1111-1111-${last4 === '1111' ? '1112' : last4}`;
    },
    description: 'Credit card number (validated via Luhn)'
  },
  {
    label: 'BTC',
    regex: /\b(?:[13][1-9A-HJ-NP-Za-km-z]{25,34}|bc1[a-z0-9]{39,59})\b/g,
    category: 'financial',
    priority: 32,
    description: 'Bitcoin address (legacy, P2SH, or bech32)'
  },
  {
    label: 'ETH',
    regex: /\b0x[a-fA-F0-9]{40}\b/g,
    category: 'financial',
    priority: 33,
    description: 'Ethereum address'
  },

  // -------------------- identifiers (token-only) --------------------
  {
    label: 'SSN',
    regex: /\b\d{3}-\d{2}-\d{4}\b/g,
    category: 'identifiers',
    priority: 40,
    validate: (v) => validSsn(v),
    description: 'US Social Security Number (formatted)'
  },
  {
    label: 'SSN_BARE',
    regex: /\b\d{9}\b/g,
    category: 'identifiers',
    priority: 41,
    validate: (v) => validSsn(v),
    description: 'US Social Security Number (unformatted, 9 digits)'
  },
  {
    label: 'CA_SIN',
    regex: /\b\d{3}[-\s]\d{3}[-\s]\d{3}\b/g,
    category: 'identifiers',
    priority: 42,
    validate: (v) => luhn(v),
    description: 'Canadian Social Insurance Number'
  },
  {
    label: 'PASSPORT_US',
    regex: /\b[A-Z]\d{8}\b/g,
    category: 'identifiers',
    priority: 43,
    description: 'US passport number (1 letter + 8 digits)'
  },
  {
    label: 'VIN',
    regex: /\b[A-HJ-NPR-Z0-9]{17}\b/g,
    category: 'identifiers',
    priority: 44,
    validate: (v) => validVin(v),
    description: 'Vehicle Identification Number (17 chars, validated)'
  },
  {
    label: 'MAC',
    regex: /\b(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b/g,
    category: 'identifiers',
    priority: 45,
    description: 'MAC address'
  },

  // -------------------- location --------------------
  {
    label: 'ADDRESS_US',
    regex: /\b\d{1,5}\s+(?:[A-Z][A-Za-z]+\s+){1,4}(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Ln|Lane|Dr|Drive|Way|Pl|Place|Ct|Court|Pkwy|Parkway|Hwy|Highway)\.?\b/g,
    category: 'location',
    priority: 50,
    fake: (_value, { counter }) => `${100 + (counter * 100)} Example St`,
    description: 'US street address (number + street name + suffix)'
  },
  {
    label: 'ZIP_US',
    regex: /\b\d{5}(?:-\d{4})?\b/g,
    category: 'location',
    priority: 51,
    fake: () => '00001',
    description: 'US ZIP code (5-digit or ZIP+4)'
  },
  {
    label: 'POSTCODE_UK',
    regex: /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/g,
    category: 'location',
    priority: 52,
    fake: () => 'XX1 1XX',
    description: 'UK postcode'
  },
  {
    label: 'POSTCODE_CA',
    regex: /\b[A-Z]\d[A-Z][\s-]?\d[A-Z]\d\b/g,
    category: 'location',
    priority: 53,
    fake: () => 'A1A 1A1',
    description: 'Canadian postal code'
  },
  {
    label: 'LATLONG',
    regex: /\b-?\d{1,3}\.\d{2,},\s*-?\d{1,3}\.\d{2,}\b/g,
    category: 'location',
    priority: 54,
    fake: () => '0.0, 0.0',
    description: 'Decimal lat,long pair'
  },

  // -------------------- network --------------------
  {
    label: 'IPV4',
    regex: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    category: 'network',
    priority: 60,
    validate: (v) => validIpv4(v),
    fake: (_value, { counter }) => `192.0.2.${1 + (counter % 254)}`,
    description: 'IPv4 address'
  },
  {
    label: 'IPV6',
    regex: /\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b|\b(?:[0-9a-fA-F]{1,4}:){1,7}:(?:[0-9a-fA-F]{1,4}:){0,6}[0-9a-fA-F]{1,4}\b/g,
    category: 'network',
    priority: 61,
    description: 'IPv6 address (full or compressed)'
  },
  {
    label: 'DOB',
    regex: /\b(?:(?:0?[1-9]|1[0-2])[\/\-](?:0?[1-9]|[12]\d|3[01])[\/\-](?:19|20)?\d{2}|(?:19|20)\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01]))\b/g,
    category: 'network',
    priority: 62,
    validate: (v) => validDob(v),
    fake: () => '01/01/1970',
    description: 'Date of birth (MM/DD/YYYY, MM-DD-YYYY, YYYY-MM-DD)'
  }
];
