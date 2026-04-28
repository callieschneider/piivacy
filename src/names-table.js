// Static name-substitution table (runtime lookup).
//
// Lazy-loaded on first realistic-mode NAME redaction. Token-only callers
// never pay the cost.
//
// The table is shipped as data/names.json. Format:
//   { firstNames: { "marcus": { bucket, alternates: [...] } }, lastNames: {...} }

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_TABLE_PATH = join(__dirname, '..', 'data', 'names.json');

let _table = null;
let _loadingPromise = null;

export async function getNameTable() {
  if (_table) return _table;
  if (_loadingPromise) return _loadingPromise;
  _loadingPromise = (async () => {
    const txt = await readFile(DEFAULT_TABLE_PATH, 'utf8');
    _table = JSON.parse(txt);
    return _table;
  })();
  return _loadingPromise;
}

// Test helper: inject a mock table. Pass `null` to reset.
export function _setNameTable(table) {
  _table = table;
  _loadingPromise = null;
}

// ---------------------------------------------------------------------------
// Picking
// ---------------------------------------------------------------------------

export function pickAlternateName(realName, table, seed = 0) {
  const trimmed = realName.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(/\s+/);
  const first = parts[0];
  const last = parts.length > 1 ? parts[parts.length - 1] : null;

  const fakeFirst = pickFromBucket(table?.firstNames, first.toLowerCase(), seed)
    ?? phoneticSimilar(first);
  const fakeLast = last
    ? (pickFromBucket(table?.lastNames, last.toLowerCase(), seed) ?? phoneticSimilar(last))
    : null;

  if (last) return `${capitalize(fakeFirst)} ${capitalize(fakeLast)}`;
  return capitalize(fakeFirst);
}

function pickFromBucket(table, lowerName, seed) {
  if (!table) return null;
  const entry = table[lowerName];
  if (!entry || !Array.isArray(entry.alternates) || entry.alternates.length === 0) return null;
  const idx = hash(lowerName + ':' + seed) % entry.alternates.length;
  return entry.alternates[idx];
}

// djb2-like hash. Tiny, deterministic, no deps.
function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0;
  }
  return h;
}

function capitalize(s) {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

// Phonetic fallback for names not present in the static table.
// Predictable, deterministic, length-preserving consonant shift.
const CONSONANT_MAP = {
  b: 'p', p: 'b', d: 't', t: 'd', f: 'v', v: 'f',
  g: 'k', k: 'g', m: 'n', n: 'm',
  s: 'z', z: 's', l: 'r', r: 'l',
  j: 'h', h: 'j', c: 'k', q: 'k', w: 'v', x: 'k', y: 'i'
};

function phoneticSimilar(name) {
  const trimmed = (name || '').trim();
  if (!trimmed) return trimmed;
  let out = '';
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    const lower = ch.toLowerCase();
    const mapped = CONSONANT_MAP[lower];
    if (mapped) {
      out += ch === lower ? mapped : mapped.toUpperCase();
    } else {
      out += ch;
    }
  }
  // Avoid producing the exact original when the word has no mappable consonants.
  return out === trimmed ? trimmed + 'a' : out;
}

// Build standard reference forms ("Marcus", "Chen", "Marcus's", etc.)
// for a [real -> fake] full-name swap. Used by NAME pattern referenceForms().
export function buildNameReferenceForms(realFull, fakeFull) {
  const realParts = realFull.trim().split(/\s+/);
  const fakeParts = fakeFull.trim().split(/\s+/);
  const forms = {};
  if (realParts.length === 0) return forms;
  // First name
  if (realParts[0] && fakeParts[0] && realParts[0] !== fakeParts[0]) {
    forms[fakeParts[0]] = realParts[0];
    forms[`${fakeParts[0]}'s`] = `${realParts[0]}'s`;
  }
  // Last name
  if (realParts.length > 1 && fakeParts.length > 1) {
    const realLast = realParts[realParts.length - 1];
    const fakeLast = fakeParts[fakeParts.length - 1];
    if (realLast !== fakeLast) {
      forms[fakeLast] = realLast;
      forms[`${fakeLast}'s`] = `${realLast}'s`;
      forms[`Mr. ${fakeLast}`] = `Mr. ${realLast}`;
      forms[`Mrs. ${fakeLast}`] = `Mrs. ${realLast}`;
      forms[`Ms. ${fakeLast}`] = `Ms. ${realLast}`;
      forms[`Dr. ${fakeLast}`] = `Dr. ${realLast}`;
    }
  }
  return forms;
}
