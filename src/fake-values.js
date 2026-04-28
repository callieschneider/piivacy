// Fake-value orchestrator.
//
// Drives a pattern's `fake()` function with the right context, increments
// per-label counters on the session, and avoids collisions with values that
// already appear in the input or are already registered for a different
// original.

import { getNameTable } from './names-table.js';

export async function generateFake({ pattern, value, session, input }) {
  if (typeof pattern.fake !== 'function') return null;

  if (!session._fakeCounters) session._fakeCounters = {};
  session._fakeCounters[pattern.label] ??= 0;
  const baseCounter = ++session._fakeCounters[pattern.label];

  const opts = {
    session,
    input,
    counter: baseCounter,
    adapter: session.nameAdapter ?? null,
    nameTable: pattern.label === 'NAME' ? await getNameTable() : null
  };

  let candidate = await pattern.fake(value, opts);
  if (typeof candidate !== 'string' || candidate.length === 0) return null;
  if (candidate === value) return null; // never produce the same value as a "fake"

  // Collision check: produced fake must not already appear literally in input,
  // and must not already be registered as the fake for a *different* original.
  let attempts = 0;
  while (
    attempts < 5 &&
    (input.includes(candidate) || isExistingFake(session, candidate, value))
  ) {
    attempts++;
    candidate = await pattern.fake(value, { ...opts, counter: baseCounter + attempts * 100 });
    if (typeof candidate !== 'string' || candidate.length === 0) return null;
    if (candidate === value) return null;
  }

  if (input.includes(candidate)) return null;
  if (isExistingFake(session, candidate, value)) return null;

  return candidate;
}

function isExistingFake(session, candidate, originalValue) {
  if (!session.fakes) return false;
  const owner = session.fakes[candidate];
  return owner !== undefined && owner !== originalValue;
}
