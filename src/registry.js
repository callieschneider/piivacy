// Pluggable pattern registry.
//
// Combines defaults + globally-registered customs + per-call extras into a
// resolved, sorted list of patterns ready for the scrub algorithm.

import { DEFAULT_PATTERNS } from './patterns.js';

const _custom = new Map();

const LABEL_RE = /^[A-Z][A-Z0-9_]*$/;
const VALID_CATEGORIES = new Set([
  'secrets', 'contact', 'financial', 'identifiers',
  'location', 'network', 'custom'
]);

function validateEntry(entry) {
  if (!entry || typeof entry !== 'object') {
    throw new TypeError('mostly-no-pii: pattern entry must be an object');
  }
  if (typeof entry.label !== 'string' || !LABEL_RE.test(entry.label)) {
    throw new TypeError(
      `mostly-no-pii: pattern label must match /^[A-Z][A-Z0-9_]*$/, got ${JSON.stringify(entry.label)}`
    );
  }
  if (!(entry.regex instanceof RegExp)) {
    throw new TypeError(`mostly-no-pii: pattern.regex must be a RegExp (label=${entry.label})`);
  }
  if (!entry.regex.global) {
    throw new TypeError(`mostly-no-pii: pattern.regex must have the /g flag (label=${entry.label})`);
  }
  if (typeof entry.category !== 'string' || !VALID_CATEGORIES.has(entry.category)) {
    throw new TypeError(
      `mostly-no-pii: pattern.category must be one of ${[...VALID_CATEGORIES].join(', ')} (label=${entry.label})`
    );
  }
  if (entry.priority !== undefined && typeof entry.priority !== 'number') {
    throw new TypeError(`mostly-no-pii: pattern.priority must be a number (label=${entry.label})`);
  }
  if (entry.validate !== undefined && typeof entry.validate !== 'function') {
    throw new TypeError(`mostly-no-pii: pattern.validate must be a function (label=${entry.label})`);
  }
  if (entry.fake !== undefined && typeof entry.fake !== 'function') {
    throw new TypeError(`mostly-no-pii: pattern.fake must be a function (label=${entry.label})`);
  }
  if (entry.referenceForms !== undefined && typeof entry.referenceForms !== 'function') {
    throw new TypeError(`mostly-no-pii: pattern.referenceForms must be a function (label=${entry.label})`);
  }
  if (entry.description !== undefined && typeof entry.description !== 'string') {
    throw new TypeError(`mostly-no-pii: pattern.description must be a string (label=${entry.label})`);
  }
}

export function registerPattern(entry) {
  validateEntry(entry);
  _custom.set(entry.label, { priority: 100, ...entry });
}

export function unregisterPattern(label) {
  return _custom.delete(label);
}

export function listPatterns(opts) {
  return resolvePatterns(opts).map(({ label, category, priority, description, fake }) => ({
    label,
    category,
    priority,
    description: description ?? null,
    hasRealistic: typeof fake === 'function'
  }));
}

export function resolvePatterns(opts = {}) {
  const extras = (opts.extraPatterns ?? []).map((e) => {
    validateEntry(e);
    return { priority: 100, ...e };
  });
  let all = [...DEFAULT_PATTERNS, ..._custom.values(), ...extras];
  if (Array.isArray(opts.categories)) {
    const allowed = new Set(opts.categories);
    all = all.filter((p) => allowed.has(p.category));
  }
  if (Array.isArray(opts.exclude)) {
    const denied = new Set(opts.exclude);
    all = all.filter((p) => !denied.has(p.label));
  }
  // Stable sort by priority (lower applied first)
  return all
    .map((p, i) => ({ p, i }))
    .sort((a, b) => a.p.priority - b.p.priority || a.i - b.i)
    .map(({ p }) => p);
}

// Test/utility: clear globally-registered customs. Not part of public API.
export function _resetRegistry() {
  _custom.clear();
}
