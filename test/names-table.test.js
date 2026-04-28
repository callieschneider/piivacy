import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getNameTable, pickAlternateName, _setNameTable, buildNameReferenceForms } from '../src/names-table.js';

test('lazy-loads the shipped names.json', async () => {
  _setNameTable(null);
  const table = await getNameTable();
  assert.ok(table.firstNames);
  assert.ok(table.lastNames);
  assert.ok(Object.keys(table.firstNames).length > 1000, 'firstNames should be sizeable');
  assert.ok(Object.keys(table.lastNames).length > 1000, 'lastNames should be sizeable');
});

test('repeated calls return the same table (cached)', async () => {
  _setNameTable(null);
  const t1 = await getNameTable();
  const t2 = await getNameTable();
  assert.equal(t1, t2);
});

test('known first name maps to a same-bucket alternate', async () => {
  _setNameTable(null);
  const table = await getNameTable();
  // marcus is a recognized name from the build data
  const marcus = table.firstNames['marcus'];
  if (marcus) {
    assert.ok(Array.isArray(marcus.alternates));
    assert.ok(marcus.alternates.length > 0);
    // The bucket should be male + a decade
    assert.match(marcus.bucket, /^[mf]:\d{4}s$/);
  }
});

test('pickAlternateName produces capitalized result for known name', async () => {
  _setNameTable(null);
  const table = await getNameTable();
  const out = pickAlternateName('Marcus Chen', table);
  assert.match(out, /^[A-Z][a-z]+(\s[A-Z][a-z]+)?$/);
  assert.notEqual(out.toLowerCase(), 'marcus chen');
});

test('pickAlternateName falls back to phonetic transform for unknown names', async () => {
  // Use an empty mock table so phonetic fallback fires
  _setNameTable({ firstNames: {}, lastNames: {} });
  const out = pickAlternateName('Xqzylphan', { firstNames: {}, lastNames: {} });
  assert.ok(typeof out === 'string' && out.length > 0);
  assert.notEqual(out, 'Xqzylphan');
});

test('pickAlternateName is deterministic for same input + seed', async () => {
  _setNameTable(null);
  const table = await getNameTable();
  const a = pickAlternateName('Marcus', table, 0);
  const b = pickAlternateName('Marcus', table, 0);
  assert.equal(a, b);
});

test('different seeds may give different picks', async () => {
  _setNameTable(null);
  const table = await getNameTable();
  // With a known name that has multiple alternates, varying the seed changes the pick
  const marcus = table.firstNames['marcus'];
  if (marcus && marcus.alternates.length >= 2) {
    const picks = new Set();
    for (let s = 0; s < 100; s++) picks.add(pickAlternateName('Marcus', table, s));
    assert.ok(picks.size >= 2, 'expected variety across seeds');
  }
});

test('buildNameReferenceForms returns sensible partials', () => {
  const forms = buildNameReferenceForms('Jane Smith', 'Marcus Chen');
  assert.equal(forms.Marcus, 'Jane');
  assert.equal(forms.Chen, 'Smith');
  assert.equal(forms["Marcus's"], "Jane's");
  assert.equal(forms["Mr. Chen"], 'Mr. Smith');
  assert.equal(forms["Dr. Chen"], 'Dr. Smith');
});
