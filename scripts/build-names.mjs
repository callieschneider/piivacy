#!/usr/bin/env node
// scripts/build-names.mjs
//
// Builds data/names.json from canonical public-domain sources. Includes
// EVERY name in the source data — no frequency floor, no bucket cap.
//
// Sources:
//   - US SSA: https://www.ssa.gov/oact/babynames/names.zip
//     (~110k unique names × {M,F} 1880-present, public domain)
//   - US Census 2010 surnames: https://www2.census.gov/topics/genealogy/2010surnames/names.zip
//     (~162k surnames with per-name racial/ethnic distribution, public domain)
//
// Algorithm:
//   1. Download + parse all sources
//   2. Filter each name to its dominant-sex variant (drops minority-gender
//      pollution: e.g. rare male "Sarah" entries don't end up in m:1980s)
//   3. Bucket by demographics:
//      - First names → (sex, decade-of-peak-popularity)
//      - Surnames → dominant Census ethnicity (>50% threshold), else "mixed"
//   4. For each bucket:
//      - Sort by lifetime frequency
//      - Take top POOL_SIZE as the "alternate pool" (recognizable names)
//   5. For every name in every bucket, alternates = 5 names from the pool
//      starting at hash(name) % horizon, skipping spelling variants.
//
// We tried OpenAI text-embedding-3-small for nearest-neighbor picks but it
// clusters by orthographic stem rather than demographic similarity (Marcus
// → Marquis, Marquise — exactly the "too similar" failure mode we want to
// avoid). Frequency-rank-with-hash-offset gives recognizable common-name
// alternates (Marcus → Terrance, Bryant, Orlando, Cedric, Terrell) which is
// what we actually want.
//
// Usage:
//   node scripts/build-names.mjs
//   node scripts/build-names.mjs --pool-size=500  # smaller pool

import { writeFile, readFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const RAW_DIR = join(DATA_DIR, '.raw');
const OUTPUT_PATH = join(DATA_DIR, 'names.json');

const SSA_URL = 'https://www.ssa.gov/oact/babynames/names.zip';
const CENSUS_SURNAMES_URL =
  'https://www2.census.gov/topics/genealogy/2010surnames/names.zip';

const args = process.argv.slice(2);
const POOL_ARG = args.find((a) => a.startsWith('--pool-size='));
const POOL_SIZE = POOL_ARG ? Number(POOL_ARG.split('=')[1]) : 1000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function ensureDir(p) {
  await mkdir(p, { recursive: true });
}

async function downloadIfMissing(url, target) {
  if (existsSync(target)) {
    console.log(`  cached: ${target}`);
    return;
  }
  console.log(`  fetching ${url}`);
  // Use curl for compatibility with Node fetch + large files; falls back to fetch.
  try {
    execSync(`curl -fsSL ${JSON.stringify(url)} -o ${JSON.stringify(target)}`);
  } catch {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`fetch failed: ${res.status} ${url}`);
    await writeFile(target, Buffer.from(await res.arrayBuffer()));
  }
}

function decade(year) {
  return `${Math.floor(year / 10) * 10}s`;
}

async function readdirSafe(p) {
  try {
    return await readdir(p);
  } catch {
    return [];
  }
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const al = a.length, bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;
  let prev = new Array(bl + 1);
  let curr = new Array(bl + 1);
  for (let j = 0; j <= bl; j++) prev[j] = j;
  for (let i = 1; i <= al; i++) {
    curr[0] = i;
    for (let j = 1; j <= bl; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[bl];
}

function djb2(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0;
  return h;
}

// ---------------------------------------------------------------------------
// SSA first names — keep ALL names, no frequency floor
// ---------------------------------------------------------------------------

async function loadSsaFirstNames() {
  const zipPath = join(RAW_DIR, 'ssa-names.zip');
  await downloadIfMissing(SSA_URL, zipPath);
  const unzipDir = join(RAW_DIR, 'ssa-yob');
  await ensureDir(unzipDir);
  if ((await readdirSafe(unzipDir)).length === 0) {
    execSync(`unzip -o -q ${JSON.stringify(zipPath)} -d ${JSON.stringify(unzipDir)}`);
  }

  const files = (await readdirSafe(unzipDir)).filter((f) => /^yob\d{4}\.txt$/.test(f));
  const totals = new Map();
  for (const f of files) {
    const year = Number(f.match(/yob(\d{4})/)[1]);
    const txt = await readFile(join(unzipDir, f), 'utf8');
    for (const line of txt.split('\n')) {
      if (!line) continue;
      const [name, sex, countStr] = line.split(',');
      if (!name || !sex || !countStr) continue;
      const count = Number(countStr);
      if (!Number.isFinite(count)) continue;
      const key = `${name.toLowerCase()}|${sex}`;
      const existing = totals.get(key);
      if (!existing) {
        totals.set(key, { name: name.toLowerCase(), sex, count, peakYear: year, peakCount: count });
      } else {
        existing.count += count;
        if (count > existing.peakCount) {
          existing.peakCount = count;
          existing.peakYear = year;
        }
      }
    }
  }
  return [...totals.values()];
}

// ---------------------------------------------------------------------------
// Census 2010 surnames — keep ALL with non-zero count
// ---------------------------------------------------------------------------

async function loadCensusSurnames() {
  const zipPath = join(RAW_DIR, 'census-surnames.zip');
  await downloadIfMissing(CENSUS_SURNAMES_URL, zipPath);
  const unzipDir = join(RAW_DIR, 'census-surnames');
  await ensureDir(unzipDir);
  if ((await readdirSafe(unzipDir)).length === 0) {
    execSync(`unzip -o -q ${JSON.stringify(zipPath)} -d ${JSON.stringify(unzipDir)}`);
  }
  const files = (await readdirSafe(unzipDir)).filter((f) => f.toLowerCase().endsWith('.csv'));
  if (files.length === 0) throw new Error('no Census CSV in zip');
  const csv = await readFile(join(unzipDir, files[0]), 'utf8');
  const lines = csv.split('\n');
  const header = lines[0].split(',').map((s) => s.trim().toLowerCase());
  const idx = {
    name: header.indexOf('name'),
    count: header.indexOf('count'),
    pwhite: header.indexOf('pctwhite'),
    pblack: header.indexOf('pctblack'),
    pasian: header.indexOf('pctapi'),
    phispanic: header.indexOf('pcthispanic'),
    pnative: header.indexOf('pctaian'),
    p2prace: header.indexOf('pct2prace')
  };
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (cols.length < 6) continue;
    const name = (cols[idx.name] || '').toLowerCase();
    if (!name || name.startsWith('all other')) continue;
    const count = Number(cols[idx.count]);
    if (!Number.isFinite(count) || count <= 0) continue;
    out.push({
      name,
      count,
      pcts: {
        white: pctOrZero(cols[idx.pwhite]),
        black: pctOrZero(cols[idx.pblack]),
        asian: pctOrZero(cols[idx.pasian]),
        hispanic: pctOrZero(cols[idx.phispanic]),
        native: pctOrZero(cols[idx.pnative]),
        multi: pctOrZero(cols[idx.p2prace])
      }
    });
  }
  return out;
}

function pctOrZero(s) {
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

// ---------------------------------------------------------------------------
// Bucketing — no caps; ALL names land in their bucket
// ---------------------------------------------------------------------------

function bucketFirstNames(rows) {
  // For each unique name, keep ONLY its dominant-sex record. Many names
  // appear in both SSA M and F files (Sarah, Ashley, Dorothy as a rare male
  // name in early 20th century, etc.). Without this filter, the rare-sex
  // variants pollute the opposite-sex buckets — e.g. "Mervyn → Dorothy,
  // Betty" because some boys were named Dorothy in the 1930s. We keep
  // each name only in the sex bucket where it was the dominant gender.
  const dominantPerName = new Map();
  for (const r of rows) {
    const existing = dominantPerName.get(r.name);
    if (!existing || r.count > existing.count) {
      dominantPerName.set(r.name, r);
    }
  }
  const buckets = new Map();
  for (const r of dominantPerName.values()) {
    const sexKey = r.sex === 'M' ? 'm' : 'f';
    const key = `${sexKey}:${decade(r.peakYear)}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(r);
  }
  for (const arr of buckets.values()) arr.sort((a, b) => b.count - a.count);
  return buckets;
}

function bucketSurnames(rows) {
  const buckets = new Map();
  for (const r of rows) {
    const dominant = pickDominant(r.pcts) ?? 'mixed';
    if (!buckets.has(dominant)) buckets.set(dominant, []);
    buckets.get(dominant).push(r);
  }
  for (const arr of buckets.values()) arr.sort((a, b) => b.count - a.count);
  return buckets;
}

function pickDominant(pcts) {
  let best = null;
  let bestVal = 50;
  for (const [k, v] of Object.entries(pcts)) {
    if (v > bestVal) { best = k; bestVal = v; }
  }
  if (best === 'asian') return 'eastAsian';
  return best;
}

// Pick K alternates for `target` from the same-bucket pool.
//
// Strategy: top-frequency-with-hash-offset.
//   - The pool is the bucket's top POOL_SIZE most-frequent names (the
//     "recognizable" pool — Marcus, Brandon, Tyler, Jordan, etc.).
//   - We hash the target to choose a starting offset into the pool.
//   - We walk the pool from that offset, skipping the target itself and
//     anything within Levenshtein distance < MIN_LD (spelling variants
//     like Marc/Marco/Markus when target is Marcus).
//   - We cap at TOP_FREQ_HORIZON to keep alternates among recognizable
//     names rather than letting wraparound dive into rare names.
//
// We do NOT use the embedding similarity for picking. Empirically,
// text-embedding-3-small on single name tokens clusters by orthographic
// stem (Marcus → Marquis, Marquise, Marrio) which is exactly the
// "too similar" failure mode we want to avoid.
const MIN_LD = 4;
const TOP_FREQ_HORIZON = 100;

function pickAlternates(target, pool, k = 5) {
  if (pool.length === 0) return [];
  const horizon = Math.min(TOP_FREQ_HORIZON, pool.length);
  const candidates = [];
  for (let i = 0; i < horizon; i++) {
    const c = pool[i];
    if (c === target) continue;
    if (levenshtein(target, c) < MIN_LD) continue;
    candidates.push(c);
  }
  // If too aggressive a filter starved us, relax to LD >= 2
  if (candidates.length < k) {
    for (let i = 0; i < horizon; i++) {
      const c = pool[i];
      if (c === target) continue;
      if (candidates.includes(c)) continue;
      if (levenshtein(target, c) < 2) continue;
      candidates.push(c);
      if (candidates.length >= k * 2) break;
    }
  }
  if (candidates.length === 0) return [];
  const start = djb2(target) % candidates.length;
  const out = [];
  for (let i = 0; i < k && i < candidates.length; i++) {
    out.push(candidates[(start + i) % candidates.length]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  await ensureDir(DATA_DIR);
  await ensureDir(RAW_DIR);

  console.log('Loading SSA first names...');
  const ssa = await loadSsaFirstNames();
  console.log(`  ${ssa.length} (name, sex) entries — ALL retained`);

  console.log('Loading Census surnames...');
  const census = await loadCensusSurnames();
  console.log(`  ${census.length} surname entries — ALL retained`);

  const firstBuckets = bucketFirstNames(ssa);
  const lastBuckets = bucketSurnames(census);

  console.log('\nFirst-name buckets:');
  for (const [k, v] of [...firstBuckets].sort()) console.log(`  ${k}: ${v.length}`);
  console.log('Surname buckets:');
  for (const [k, v] of [...lastBuckets].sort()) console.log(`  ${k}: ${v.length}`);

  // Compose final tables — frequency-rank alternates with hash offset
  const firstNames = {};
  const lastNames = {};

  for (const [bucket, arr] of firstBuckets) {
    const pool = arr.slice(0, POOL_SIZE).map((e) => e.name);
    for (const e of arr) {
      firstNames[e.name] = { bucket, alternates: pickAlternates(e.name, pool, 5) };
    }
  }
  for (const [bucket, arr] of lastBuckets) {
    const pool = arr.slice(0, POOL_SIZE).map((e) => e.name);
    for (const e of arr) {
      lastNames[e.name] = { bucket, alternates: pickAlternates(e.name, pool, 5) };
    }
  }

  const output = {
    version: 1,
    generatedAt: new Date().toISOString(),
    poolSize: POOL_SIZE,
    firstNames,
    lastNames
  };

  await writeFile(OUTPUT_PATH, JSON.stringify(output));
  console.log(`\nWrote ${OUTPUT_PATH}`);
  console.log(`  firstNames: ${Object.keys(firstNames).length}`);
  console.log(`  lastNames:  ${Object.keys(lastNames).length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
