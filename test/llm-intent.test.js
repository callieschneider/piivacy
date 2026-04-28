import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildScrubIntentPrompt,
  parseScrubIntentResponse,
  applyScrubIntent
} from '../src/llm-intent.js';

test('buildScrubIntentPrompt returns {system, user}', () => {
  const p = buildScrubIntentPrompt('find restaurants near 234 Main St');
  assert.equal(typeof p.system, 'string');
  assert.equal(p.user, 'find restaurants near 234 Main St');
  assert.ok(p.system.includes('redact'));
  assert.ok(p.system.includes('preserve'));
  assert.ok(p.system.includes('synthetic'));
});

test('parseScrubIntentResponse: well-formed JSON', () => {
  const raw = '{"decisions":{"location":"preserve","contact":"redact","secrets":"redact","financial":"redact","identifiers":"redact","network":"redact"},"reason":"local search"}';
  const { decisions, reason } = parseScrubIntentResponse(raw);
  assert.equal(decisions.location, 'preserve');
  assert.equal(decisions.contact, 'redact');
  assert.equal(reason, 'local search');
});

test('parseScrubIntentResponse: malformed JSON', () => {
  const { decisions, parseError } = parseScrubIntentResponse('not json');
  assert.deepEqual(decisions, {});
  assert.ok(parseError);
});

test('parseScrubIntentResponse: invalid choice values are dropped', () => {
  const raw = '{"decisions":{"contact":"obliterate","location":"preserve"}}';
  const { decisions } = parseScrubIntentResponse(raw);
  assert.equal(decisions.contact, undefined);
  assert.equal(decisions.location, 'preserve');
});

test('safety override: secrets cannot be preserved', () => {
  const raw = '{"decisions":{"secrets":"preserve","location":"preserve"}}';
  const { decisions } = parseScrubIntentResponse(raw);
  assert.equal(decisions.secrets, 'redact'); // forced
  assert.equal(decisions.location, 'preserve');
});

test('safety override: financial cannot be preserved', () => {
  const raw = '{"decisions":{"financial":"preserve"}}';
  const { decisions } = parseScrubIntentResponse(raw);
  assert.equal(decisions.financial, 'redact');
});

test('safety override: identifiers cannot be preserved', () => {
  const raw = '{"decisions":{"identifiers":"preserve"}}';
  const { decisions } = parseScrubIntentResponse(raw);
  assert.equal(decisions.identifiers, 'redact');
});

test('applyScrubIntent maps decisions to scrub modes', () => {
  const decisions = {
    location: 'preserve',
    contact: 'synthetic',
    secrets: 'redact'
  };
  const opts = applyScrubIntent(decisions, { defaultMode: 'token' });
  assert.equal(opts.modes.location, 'pass-through');
  assert.equal(opts.modes.contact, 'realistic');
  assert.equal(opts.modes.secrets, 'token');
  assert.equal(opts.defaultMode, 'token');
});

test('applyScrubIntent merges into existing modes', () => {
  const baseOpts = { defaultMode: 'token', modes: { location: 'token' } };
  const opts = applyScrubIntent({ location: 'preserve' }, baseOpts);
  assert.equal(opts.modes.location, 'pass-through');
});

test('applyScrubIntent with no decisions returns base opts', () => {
  const opts = applyScrubIntent({}, { defaultMode: 'token' });
  assert.equal(opts.defaultMode, 'token');
});

test('applyScrubIntent ignores invalid decisions', () => {
  const opts = applyScrubIntent({ contact: 'obliterate' }, { defaultMode: 'token' });
  assert.equal(opts.modes.contact, undefined);
});

test('full integration: parse → apply → resulting scrub opts', async () => {
  const { scrub } = await import('../src/scrub.js');
  const { createSession } = await import('../src/sessions.js');
  const fakeLLM = '{"decisions":{"location":"preserve","contact":"redact","secrets":"redact","financial":"redact","identifiers":"redact","network":"redact"}}';
  const { decisions } = parseScrubIntentResponse(fakeLLM);
  const opts = applyScrubIntent(decisions, { defaultMode: 'token' });
  const { text } = await scrub('email a@x.com near 234 Main Street', createSession(), opts);
  // Email tokenized
  assert.match(text, /\[\[EMAIL_1\]\]/);
  // Address preserved (location: pass-through)
  assert.ok(text.includes('234 Main Street'));
});
