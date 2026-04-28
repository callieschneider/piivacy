#!/usr/bin/env node
// scripts/fuzz.mjs
//
// Generative property-test runner for piivacy.
//
// Runs N iterations across multiple scenario types. For each iteration:
//   - generates a random PII-laden input + a random mode/opts config
//   - exercises the relevant invariant (round-trip, dedup, idempotence, etc.)
//   - records pass/fail with enough detail to debug
//
// On exit:
//   - prints a summary
//   - exits 0 on full pass, 1 on any failure
//
// The runner uses ONLY the public package API. No internals. So if it passes,
// the public contract is solid.
//
// Usage:
//   node scripts/fuzz.mjs              # 500 iterations (default)
//   node scripts/fuzz.mjs --n 2000     # custom count
//   node scripts/fuzz.mjs --seed 42    # deterministic seed
//   node scripts/fuzz.mjs --only roundtrip,dedup
//   node scripts/fuzz.mjs --bail       # exit on first failure

import {
  scrub,
  restore,
  createSession,
  registerSecret,
  listRedactions,
  presets
} from '../src/index.js';

// ----- arg parsing -----
const argv = process.argv.slice(2);
function flag(name) {
  const i = argv.indexOf('--' + name);
  if (i < 0) return null;
  return argv[i + 1] ?? true;
}
const N = Number(flag('n')) || 500;
const SEED = Number(flag('seed')) || Math.floor(Math.random() * 2 ** 32);
const ONLY = flag('only') ? String(flag('only')).split(',') : null;
const BAIL = !!flag('bail');

// ----- deterministic RNG (mulberry32) -----
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(SEED);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const intRange = (a, b) => Math.floor(rand() * (b - a + 1)) + a;
const pad = (n, w) => String(n).padStart(w, '0');

// ----- PII generators (all FAKE: visa test cards, 555-01XX phones, example.com) -----
const FIRSTS = ['Marcus', 'Sarah', 'Chris', 'Emma', 'Liam', 'Olivia', 'Jamal', 'Priya', 'Aiden', 'Sofia', 'Diego', 'Yuki'];
const LASTS = ['Smith', 'Chen', 'Patel', 'Garcia', 'Nguyen', 'Williams', 'Kim', 'Park', 'Lee', 'Singh'];
const STREETS = ['Main', 'Oak', 'Maple', 'Sunset', 'Park', 'Lake', 'Hill', 'Cedar'];
const CITIES = ['Brooklyn, NY', 'Austin, TX', 'Portland, OR', 'Denver, CO', 'Seattle, WA'];
const SUFFIXES = ['Street', 'Ave', 'Road', 'Boulevard', 'Lane', 'Drive', 'Way'];

function genEmail() {
  const u = pick(FIRSTS).toLowerCase() + (rand() < 0.5 ? '' : '.' + pick(LASTS).toLowerCase());
  return `${u}${rand() < 0.4 ? intRange(1, 99) : ''}@example.com`;
}
function genPhoneUS() {
  const area = intRange(2, 9) * 100 + intRange(0, 9) * 10 + intRange(0, 9);
  const exch = intRange(2, 9) * 100 + intRange(0, 9) * 10 + intRange(0, 9);
  const last = pad(intRange(0, 9999), 4);
  return pick([`(${area}) ${exch}-${last}`, `${area}-${exch}-${last}`, `${area}.${exch}.${last}`, `+1-${area}-${exch}-${last}`]);
}
function genSSN() {
  let area;
  do { area = intRange(1, 899); } while (area === 666);
  return `${pad(area, 3)}-${pad(intRange(1, 99), 2)}-${pad(intRange(1, 9999), 4)}`;
}
function genVisaCC() {
  const head = '4' + Array.from({ length: 14 }, () => intRange(0, 9)).join('');
  let s = 0, alt = false;
  for (let i = 14; i >= 0; i--) {
    let d = Number(head[i]);
    if (alt) { d *= 2; if (d > 9) d -= 9; }
    s += d;
    alt = !alt;
  }
  return (head + ((10 - (s % 10)) % 10)).replace(/(\d{4})/g, '$1 ').trim();
}
function genIPv4() { return `${intRange(1, 223)}.${intRange(0, 255)}.${intRange(0, 255)}.${intRange(1, 254)}`; }
function genMAC() { return Array.from({ length: 6 }, () => pad(intRange(0, 255).toString(16).toUpperCase(), 2)).join(':'); }
function genDOB() {
  const m = intRange(1, 12), d = intRange(1, 28), y = intRange(1950, 2005);
  return pick([`${pad(m, 2)}/${pad(d, 2)}/${y}`, `${y}-${pad(m, 2)}-${pad(d, 2)}`]);
}
function genAddress() { return `${intRange(1, 9999)} ${pick(STREETS)} ${pick(SUFFIXES)}`; }
function genZip() { return pad(intRange(10000, 99999), 5); }
function genOpenAIKey() { return 'sk-proj-' + Array.from({ length: 48 }, () => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[intRange(0, 61)]).join(''); }
function genGitHubPAT() { return 'ghp_' + Array.from({ length: 40 }, () => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[intRange(0, 61)]).join(''); }
function genAWSAccessKey() { return 'AKIA' + Array.from({ length: 16 }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[intRange(0, 35)]).join(''); }
function genGroqKey() { return 'gsk_' + Array.from({ length: 56 }, () => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[intRange(0, 61)]).join(''); }
function genJWT() { return 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.' + Array.from({length: 32}, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[intRange(0, 35)]).join(''); }
function genIBAN() { return 'GB82WEST12345698765432'; } // canonical valid example
function genBitcoin() { return '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'; }

const PII_GENERATORS = {
  EMAIL: genEmail,
  PHONE_US: genPhoneUS,
  SSN: genSSN,
  CC: genVisaCC,
  IPV4: genIPv4,
  MAC: genMAC,
  DOB: genDOB,
  ADDRESS_US: genAddress,
  ZIP_US: genZip,
  OPENAI_KEY: genOpenAIKey,
  GITHUB_TOKEN: genGitHubPAT,
  AWS_ACCESS_KEY: genAWSAccessKey,
  GROQ_KEY: genGroqKey,
  JWT: genJWT,
  IBAN: genIBAN,
  BTC: genBitcoin
};

// Filler templates that EMBED pii values into prose
function buildInput({ density = 'medium' } = {}) {
  const piiCount = density === 'sparse' ? intRange(1, 2) : density === 'dense' ? intRange(5, 9) : intRange(2, 4);
  const labels = Object.keys(PII_GENERATORS);
  const fragments = [];
  const seenValues = new Set();
  for (let i = 0; i < piiCount; i++) {
    const label = pick(labels);
    let val = PII_GENERATORS[label]();
    // Avoid colliding with a value already produced for this same input
    if (seenValues.has(val)) continue;
    seenValues.add(val);
    const tpl = pick([
      `Contact ${val} for details.`,
      `Reach me at ${val}.`,
      `${label} = ${val}`,
      `The ${label.toLowerCase()} is ${val}.`,
      `${val}`,
      `(value: ${val})`
    ]);
    fragments.push(tpl);
  }
  // Insert filler prose
  const FILLER = [
    'Hi there,',
    'Thanks for reaching out.',
    'We received your request.',
    'Please confirm.',
    'Order #' + intRange(1000, 99999),
    'Reply by EOD.'
  ];
  const out = [pick(FILLER), ...fragments, pick(FILLER)].join(' ');
  return out;
}

// ----- scenarios -----

const scenarios = {
  // Property: restore(scrub(text, session)) === text
  async roundtrip() {
    const text = buildInput({ density: pick(['sparse', 'medium', 'dense']) });
    const opts = pickOpts();
    const session = createSession();
    const { text: scrubbed } = await scrub(text, session, opts);
    const restored = restore(scrubbed, session);
    if (restored !== text) {
      return {
        ok: false,
        msg: 'round-trip mismatch',
        details: { input: text, scrubbed, restored, opts, diff: firstDiff(text, restored) }
      };
    }
    return { ok: true };
  },

  // Property: scrub(scrub(x, session), session) === scrub(x, session)
  // (idempotence — once tokenized, re-running scrub doesn't double-tokenize)
  async idempotence() {
    const text = buildInput({ density: 'medium' });
    const opts = pickOpts();
    const session = createSession();
    const r1 = await scrub(text, session, opts);
    const r2 = await scrub(r1.text, session, opts);
    if (r1.text !== r2.text) {
      return {
        ok: false,
        msg: 'idempotence violated',
        details: { input: text, pass1: r1.text, pass2: r2.text, opts }
      };
    }
    return { ok: true };
  },

  // Multi-turn: same session across multiple scrubs. Same value should map to
  // the same substitute every time. Round-trip must still hold.
  async multiturn() {
    const turns = intRange(2, 5);
    const opts = pickOpts();
    const session = createSession();
    const inputs = [];
    const scrubbed = [];
    // Generate turns that share a few overlapping PII values
    const sharedEmail = genEmail();
    const sharedPhone = genPhoneUS();
    for (let t = 0; t < turns; t++) {
      const extra = buildInput({ density: 'sparse' });
      const text = `${extra} ${sharedEmail} ${sharedPhone} ${pick(['ack', 'thanks', 'noted', 'confirmed'])}.`;
      inputs.push(text);
      const { text: out } = await scrub(text, session, opts);
      scrubbed.push(out);
    }
    // Round-trip every turn
    for (let t = 0; t < turns; t++) {
      const restored = restore(scrubbed[t], session);
      if (restored !== inputs[t]) {
        return {
          ok: false,
          msg: 'multi-turn round-trip failed at turn ' + t,
          details: { turn: t, input: inputs[t], scrubbed: scrubbed[t], restored, opts, diff: firstDiff(inputs[t], restored) }
        };
      }
    }
    // Dedup: shared email + phone should appear with the SAME substitute in every turn.
    // Only meaningful when the email/phone categories aren't pass-through.
    const emailSub = findSubstitute(session, sharedEmail);
    const phoneSub = findSubstitute(session, sharedPhone);
    // emailSub or phoneSub being null means the category is pass-through (no
    // substitute was registered) — that's fine, skip the dedup check for that
    // value.
    for (let t = 0; t < turns; t++) {
      if (emailSub && !scrubbed[t].includes(emailSub) && !scrubbed[t].includes(sharedEmail)) {
        return {
          ok: false,
          msg: `multi-turn dedup broken: email substitute "${emailSub}" missing from turn ${t}`,
          details: { turn: t, expected: emailSub, scrubbed: scrubbed[t], opts }
        };
      }
      if (phoneSub && !scrubbed[t].includes(phoneSub) && !scrubbed[t].includes(sharedPhone)) {
        return {
          ok: false,
          msg: `multi-turn dedup broken: phone substitute "${phoneSub}" missing from turn ${t}`,
          details: { turn: t, expected: phoneSub, scrubbed: scrubbed[t], opts }
        };
      }
    }
    return { ok: true };
  },

  // Token literals already present in input should pass through unchanged.
  // Restore on a never-issued token also passes through unchanged.
  async tokenLiteralPassthrough() {
    const fakeToken = `[[EMAIL_${intRange(50, 999)}]]`;
    const text = `Earlier output: ${fakeToken}, plus a real email ${genEmail()}.`;
    const session = createSession();
    const { text: scrubbed } = await scrub(text, session);
    if (!scrubbed.includes(fakeToken)) {
      return {
        ok: false,
        msg: 'pre-existing token literal was rewritten by scrub',
        details: { input: text, scrubbed, fakeToken }
      };
    }
    // Restore should also leave the never-seen token alone
    const restored = restore(scrubbed, session);
    if (!restored.includes(fakeToken)) {
      return {
        ok: false,
        msg: 'restore rewrote an unknown token literal',
        details: { scrubbed, restored, fakeToken }
      };
    }
    return { ok: true };
  },

  // registerSecret pre-pass should redact a literal value that regex would miss
  async manualSecret() {
    const codename = 'Project ' + pick(['Phoenix', 'Atlas', 'Nexus', 'Helix', 'Orion']);
    const text = `We launched ${codename} yesterday with a customer at ${genEmail()}.`;
    const session = createSession();
    registerSecret(session, codename, 'CODENAME');
    const { text: scrubbed } = await scrub(text, session);
    if (scrubbed.includes(codename)) {
      return {
        ok: false,
        msg: 'manually registered secret was not redacted',
        details: { input: text, scrubbed, codename }
      };
    }
    // Round-trip
    const restored = restore(scrubbed, session);
    if (restored !== text) {
      return {
        ok: false,
        msg: 'manualSecret round-trip failed',
        details: { input: text, scrubbed, restored, diff: firstDiff(text, restored) }
      };
    }
    return { ok: true };
  },

  // Inventory should report each unique value exactly once
  async inventoryDedup() {
    const email = genEmail();
    const phone = genPhoneUS();
    const text = `Email ${email} or phone ${phone}. Repeating: ${email}, ${phone}, ${email}.`;
    const session = createSession();
    await scrub(text, session, { defaultMode: 'token' });
    const inv = listRedactions(session);
    const emailItems = inv.filter((i) => i.value === email);
    const phoneItems = inv.filter((i) => i.value === phone);
    if (emailItems.length !== 1) {
      return { ok: false, msg: 'email appeared more than once in inventory', details: { email, inv } };
    }
    if (phoneItems.length !== 1) {
      return { ok: false, msg: 'phone appeared more than once in inventory', details: { phone, inv } };
    }
    if (emailItems[0].count !== 3) {
      return { ok: false, msg: 'usage count incorrect for repeated email', details: { email, count: emailItems[0].count, expected: 3 } };
    }
    return { ok: true };
  }
};

function pickOpts() {
  const choice = pick([
    () => ({ defaultMode: 'token' }),
    () => presets.maximumRedaction,
    () => presets.naturalConversation,
    () => presets.localSearch,
    () => ({ defaultMode: 'token', modes: { contact: 'realistic' } }),
    () => ({ defaultMode: 'realistic', modes: { secrets: 'token', identifiers: 'token', financial: 'token' } }),
    () => ({ defaultMode: 'token', labels: { EMAIL: 'realistic', PHONE_US: 'realistic' } }),
    () => ({ defaultMode: 'token', exclude: ['IPV6', 'POSTCODE_UK'] })
  ]);
  return choice();
}

// helpers
function firstDiff(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return {
    pos: i,
    orig: a.slice(Math.max(0, i - 20), i + 40),
    got:  b.slice(Math.max(0, i - 20), i + 40)
  };
}
function findSubstitute(session, value) {
  // Use the public inventory API to look up the substitute for `value`.
  // Don't try to character-align input/scrubbed text — there may be multiple
  // substitutes in the output and string-position alignment doesn't survive
  // length changes.
  const inv = listRedactions(session);
  const item = inv.find((i) => i.value === value);
  return item?.identifier ?? null;
}

// ----- runner -----

async function main() {
  const types = ONLY ?? Object.keys(scenarios);
  for (const t of types) if (!scenarios[t]) {
    console.error(`Unknown scenario: ${t}. Available: ${Object.keys(scenarios).join(', ')}`);
    process.exit(2);
  }

  console.log(`fuzz: N=${N} seed=${SEED} scenarios=[${types.join(', ')}]${BAIL ? ' (bail)' : ''}\n`);

  const stats = {};
  for (const t of types) stats[t] = { ran: 0, passed: 0, failed: 0, failures: [] };

  let totalRan = 0;
  for (let i = 0; i < N; i++) {
    const type = pick(types);
    const start = Date.now();
    let result;
    try {
      result = await scenarios[type]();
    } catch (err) {
      result = { ok: false, msg: 'threw: ' + err.message, details: { stack: err.stack?.split('\n').slice(0, 5).join('\n') } };
    }
    const elapsed = Date.now() - start;
    stats[type].ran++;
    totalRan++;
    if (result.ok) {
      stats[type].passed++;
    } else {
      stats[type].failed++;
      stats[type].failures.push({ iteration: i, elapsed, ...result });
      if (BAIL) {
        printSummary(stats);
        printFailures(stats);
        process.exit(1);
      }
    }
    if (totalRan % 50 === 0) {
      const totalFailed = Object.values(stats).reduce((s, v) => s + v.failed, 0);
      process.stdout.write(`  ${totalRan}/${N}  (failed so far: ${totalFailed})\r`);
    }
  }
  process.stdout.write('\n');
  printSummary(stats);
  const totalFailed = Object.values(stats).reduce((s, v) => s + v.failed, 0);
  if (totalFailed > 0) {
    printFailures(stats);
    process.exit(1);
  }
  console.log('\n✓ all scenarios passed.');
}

function printSummary(stats) {
  console.log('\n--- summary ---');
  console.log('scenario'.padEnd(28) + 'ran'.padStart(6) + 'passed'.padStart(8) + 'failed'.padStart(8));
  console.log('-'.repeat(50));
  for (const [k, v] of Object.entries(stats)) {
    console.log(k.padEnd(28) + String(v.ran).padStart(6) + String(v.passed).padStart(8) + String(v.failed).padStart(8));
  }
}
function printFailures(stats) {
  console.log('\n--- failures ---');
  for (const [k, v] of Object.entries(stats)) {
    if (v.failed === 0) continue;
    console.log(`\n[${k}] ${v.failed} failure(s):`);
    for (const f of v.failures.slice(0, 8)) {
      console.log(`  iter#${f.iteration}  ${f.msg}`);
      if (f.details) {
        const d = JSON.stringify(f.details, null, 2).split('\n').map(l => '    ' + l).join('\n');
        console.log(d);
      }
    }
    if (v.failures.length > 8) console.log(`  ... and ${v.failures.length - 8} more`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
