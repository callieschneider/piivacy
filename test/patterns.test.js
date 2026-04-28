import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PATTERNS,
  luhn,
  ibanMod97,
  validSsn,
  validVin,
  validIpv4,
  validDob
} from '../src/patterns.js';

const byLabel = Object.fromEntries(DEFAULT_PATTERNS.map((p) => [p.label, p]));

function matchAll(text, label) {
  const p = byLabel[label];
  p.regex.lastIndex = 0;
  return [...text.matchAll(p.regex)].map((m) => m[0]);
}

function isMatchAndValid(text, label) {
  const p = byLabel[label];
  p.regex.lastIndex = 0;
  const matches = [...text.matchAll(p.regex)];
  if (matches.length === 0) return false;
  for (const m of matches) {
    if (typeof p.validate === 'function' && !p.validate(m[0])) continue;
    return true;
  }
  return false;
}

test('every pattern has required fields', () => {
  for (const p of DEFAULT_PATTERNS) {
    assert.match(p.label, /^[A-Z][A-Z0-9_]*$/);
    assert.ok(p.regex instanceof RegExp);
    assert.ok(p.regex.global, `${p.label} must be /g`);
    assert.ok(typeof p.category === 'string');
    assert.ok(typeof p.priority === 'number');
  }
});

test('luhn validator', () => {
  assert.equal(luhn('4111 1111 1111 1111'), true);
  assert.equal(luhn('4111111111111111'), true);
  assert.equal(luhn('4111-1111-1111-1112'), false);
  assert.equal(luhn('378282246310005'), true); // Amex test
  assert.equal(luhn('1234567890'), false);
});

test('iban mod-97 validator', () => {
  assert.equal(ibanMod97('GB82 WEST 1234 5698 7654 32'), true);
  assert.equal(ibanMod97('DE89370400440532013000'), true);
  assert.equal(ibanMod97('FR1420041010050500013M02606'), true);
  assert.equal(ibanMod97('GB82WEST12345698765431'), false); // bad check digit
  assert.equal(ibanMod97('not-an-iban'), false);
});

test('ssn range validator', () => {
  assert.equal(validSsn('123-45-6789'), true);
  assert.equal(validSsn('000-12-3456'), false);
  assert.equal(validSsn('666-12-3456'), false);
  assert.equal(validSsn('900-12-3456'), false);
  assert.equal(validSsn('123-00-3456'), false);
  assert.equal(validSsn('123-45-0000'), false);
});

test('vin validator', () => {
  assert.equal(validVin('1HGBH41JXMN109186'), true);
  assert.equal(validVin('1HGBH41JXMN10918X'), false); // wrong check digit
  assert.equal(validVin('1HGBH41JXMN10918'), false); // 16 chars
  assert.equal(validVin('1HGBH41JIMN109186'), false); // contains 'I'
});

test('ipv4 validator', () => {
  assert.equal(validIpv4('192.168.1.1'), true);
  assert.equal(validIpv4('255.255.255.255'), true);
  assert.equal(validIpv4('256.1.1.1'), false);
  assert.equal(validIpv4('192.168.01.1'), false); // leading zero
  assert.equal(validIpv4('1.2.3'), false);
});

test('dob validator', () => {
  assert.equal(validDob('01/15/1990'), true);
  assert.equal(validDob('12-31-2020'), true);
  assert.equal(validDob('1990-01-15'), true);
  assert.equal(validDob('13/01/1990'), false); // invalid month
  assert.equal(validDob('02/30/1990'), false); // invalid day in feb
  assert.equal(validDob('not-a-date'), false);
});

test('OPENAI_KEY: sk- and sk-proj- prefixes', () => {
  assert.ok(matchAll('key=sk-abcdefghijklmnopqrstuvwxyz0123456789ABCDE', 'OPENAI_KEY').length === 1);
  assert.ok(matchAll('key=sk-proj-abcdef0123456789abcdef0123456789ABCDEF', 'OPENAI_KEY').length === 1);
  assert.equal(matchAll('not a key', 'OPENAI_KEY').length, 0);
});

test('ANTHROPIC_KEY', () => {
  assert.ok(
    matchAll('header=sk-ant-api03-' + 'a'.repeat(95), 'ANTHROPIC_KEY').length === 1
  );
});

test('GITHUB_TOKEN', () => {
  assert.ok(matchAll('token: ghp_' + 'A'.repeat(40), 'GITHUB_TOKEN').length === 1);
  assert.ok(matchAll('token: ghs_' + 'B'.repeat(40), 'GITHUB_TOKEN').length === 1);
  assert.ok(matchAll('token: github_pat_' + 'A'.repeat(82), 'GITHUB_TOKEN').length === 1);
});

test('AWS_ACCESS_KEY', () => {
  assert.ok(matchAll('AKIAIOSFODNN7EXAMPLE', 'AWS_ACCESS_KEY').length === 1);
  assert.ok(matchAll('ASIAY34FZKBOKMUTVV7A', 'AWS_ACCESS_KEY').length === 1);
});

test('AWS_SECRET_KEY (requires keyword context)', () => {
  // With keyword: matches the 40-char value
  const m = matchAll(
    'aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    'AWS_SECRET_KEY'
  );
  assert.ok(m.length === 1);
  // Without keyword: no match
  assert.equal(matchAll('wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'AWS_SECRET_KEY').length, 0);
});

test('GOOGLE_API_KEY', () => {
  assert.ok(matchAll('key=AIza' + 'A'.repeat(35), 'GOOGLE_API_KEY').length === 1);
});

test('STRIPE_KEY', () => {
  // Build the test fixture at runtime so GitHub's push-protection scanner
  // doesn't flag the source file as containing a real Stripe key.
  const fakeLive = 'sk' + '_' + 'live' + '_' + 'A'.repeat(24);
  const fakeTest = 'pk' + '_' + 'test' + '_' + 'B'.repeat(24);
  assert.ok(matchAll(fakeLive, 'STRIPE_KEY').length === 1);
  assert.ok(matchAll(fakeTest, 'STRIPE_KEY').length === 1);
});

test('SLACK_TOKEN', () => {
  assert.ok(matchAll('xoxb-1234567890-abcdefghij', 'SLACK_TOKEN').length === 1);
  assert.ok(matchAll('xoxp-1234567890-abcdefghij', 'SLACK_TOKEN').length === 1);
});

test('JWT', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.abcdefghijklmnop';
  assert.ok(matchAll(`token=${jwt}`, 'JWT').length === 1);
});

test('URL_CREDENTIALS (generic http/ftp/ssh/mysql)', () => {
  assert.ok(matchAll('connect to https://user:p4ss@db.example.com/foo', 'URL_CREDENTIALS').length === 1);
  assert.ok(matchAll('mysql://admin:secret@host:3306/mydb', 'URL_CREDENTIALS').length === 1);
  assert.ok(matchAll('ssh://root:hunter2@server.example.com', 'URL_CREDENTIALS').length === 1);
  assert.equal(matchAll('https://example.com/path', 'URL_CREDENTIALS').length, 0);
});

test('POSTGRES_URL', () => {
  assert.ok(matchAll('postgres://admin:secret@host:5432/mydb', 'POSTGRES_URL').length === 1);
  assert.ok(matchAll('postgresql://user:p4ss@db.example.com/app_prod', 'POSTGRES_URL').length === 1);
});

test('MONGODB_URL', () => {
  assert.ok(matchAll('mongodb://admin:secret@cluster0.example.net:27017/mydb', 'MONGODB_URL').length === 1);
  assert.ok(matchAll('mongodb+srv://user:p4ss@cluster0.example.net/mydb', 'MONGODB_URL').length === 1);
});

test('REDIS_URL', () => {
  assert.ok(matchAll('redis://:p4ss@cache.example.com:6379', 'REDIS_URL').length === 1);
  assert.ok(matchAll('rediss://user:p4ss@cache.example.com:6380', 'REDIS_URL').length === 1);
});

test('GROQ_KEY', () => {
  assert.ok(matchAll('GROQ_API_KEY=gsk_' + 'a'.repeat(56), 'GROQ_KEY').length === 1);
});

test('HUGGINGFACE_TOKEN', () => {
  assert.ok(matchAll('HF_TOKEN=hf_' + 'A'.repeat(34), 'HUGGINGFACE_TOKEN').length === 1);
});

test('REPLICATE_TOKEN', () => {
  assert.ok(matchAll('REPLICATE_API_TOKEN=r8_' + 'a'.repeat(40), 'REPLICATE_TOKEN').length === 1);
});

test('COHERE_KEY (with keyword context)', () => {
  const k = 'a'.repeat(40);
  assert.ok(matchAll(`cohere_api_key=${k}`, 'COHERE_KEY').length === 1);
  assert.equal(matchAll(k, 'COHERE_KEY').length, 0);
});

test('ELEVENLABS_KEY (with keyword context)', () => {
  const k = 'a'.repeat(32);
  assert.ok(matchAll(`xi-api-key: ${k}`, 'ELEVENLABS_KEY').length === 1);
});

test('TWILIO_KEY', () => {
  assert.ok(matchAll('TWILIO_ACCOUNT_SID=AC' + 'a'.repeat(32), 'TWILIO_KEY').length === 1);
});

test('SENDGRID_KEY', () => {
  assert.ok(matchAll('SENDGRID_API_KEY=SG.' + 'a'.repeat(22) + '.' + 'b'.repeat(43), 'SENDGRID_KEY').length === 1);
});

test('MAILGUN_KEY', () => {
  assert.ok(matchAll('MAILGUN_API_KEY=key-' + 'a'.repeat(32), 'MAILGUN_KEY').length === 1);
});

test('POSTMARK_TOKEN (UUID format)', () => {
  assert.ok(matchAll('POSTMARK_SERVER_TOKEN=12345678-1234-1234-1234-123456789abc', 'POSTMARK_TOKEN').length === 1);
});

test('DISCORD_WEBHOOK', () => {
  assert.ok(matchAll('webhook=https://discord.com/api/webhooks/' + '1'.repeat(18) + '/' + 'a'.repeat(68), 'DISCORD_WEBHOOK').length === 1);
});

test('SLACK_WEBHOOK', () => {
  assert.ok(matchAll('webhook=https://hooks.slack.com/services/T' + 'A'.repeat(10) + '/B' + 'A'.repeat(10) + '/' + 'a'.repeat(24), 'SLACK_WEBHOOK').length === 1);
});

test('NOTION_TOKEN', () => {
  assert.ok(matchAll('NOTION_API_KEY=secret_' + 'a'.repeat(43), 'NOTION_TOKEN').length === 1);
});

test('FIGMA_TOKEN', () => {
  assert.ok(matchAll('FIGMA_TOKEN=figd_' + 'a'.repeat(43), 'FIGMA_TOKEN').length === 1);
});

test('LINEAR_KEY', () => {
  assert.ok(matchAll('LINEAR_API_KEY=lin_api_' + 'a'.repeat(40), 'LINEAR_KEY').length === 1);
});

test('NPM_TOKEN', () => {
  assert.ok(matchAll('NPM_TOKEN=npm_' + 'a'.repeat(36), 'NPM_TOKEN').length === 1);
});

test('GITLAB_PAT', () => {
  assert.ok(matchAll('GITLAB_TOKEN=glpat-' + 'a'.repeat(20), 'GITLAB_PAT').length === 1);
});

test('SUPABASE_KEY', () => {
  assert.ok(matchAll('SUPABASE_SERVICE_KEY=sbp_' + 'a'.repeat(40), 'SUPABASE_KEY').length === 1);
});

test('DIGITALOCEAN_TOKEN', () => {
  assert.ok(matchAll('DO_TOKEN=dop_v1_' + 'a'.repeat(64), 'DIGITALOCEAN_TOKEN').length === 1);
});

test('CLOUDFLARE_KEY (with keyword context)', () => {
  assert.ok(matchAll('cf_api_key=' + 'a'.repeat(37), 'CLOUDFLARE_KEY').length === 1);
});

test('ALGOLIA_KEY (with keyword context)', () => {
  assert.ok(matchAll('algolia_api_key=' + 'a'.repeat(32), 'ALGOLIA_KEY').length === 1);
});

test('HEROKU_KEY (with keyword context)', () => {
  assert.ok(matchAll('heroku_api_key=12345678-1234-1234-1234-123456789abc', 'HEROKU_KEY').length === 1);
});

test('SENTRY_DSN', () => {
  assert.ok(matchAll('SENTRY_DSN=https://' + 'a'.repeat(32) + '@o123.ingest.sentry.io/456', 'SENTRY_DSN').length === 1);
});

test('DATADOG_KEY (with keyword context)', () => {
  assert.ok(matchAll('DD_API_KEY=' + 'a'.repeat(32), 'DATADOG_KEY').length === 1);
});

test('PEM_PRIVATE_KEY', () => {
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----';
  assert.ok(matchAll(pem, 'PEM_PRIVATE_KEY').length === 1);
  const openssh = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXkt...\n-----END OPENSSH PRIVATE KEY-----';
  assert.ok(matchAll(openssh, 'PEM_PRIVATE_KEY').length === 1);
});

test('EMAIL', () => {
  assert.ok(matchAll('me@example.com', 'EMAIL').length === 1);
  assert.ok(matchAll('first.last+tag@subdomain.example.co.uk', 'EMAIL').length === 1);
  assert.equal(matchAll('me at example dot com', 'EMAIL').length, 0);
});

test('PHONE_US', () => {
  assert.ok(matchAll('Call (415) 555-0100', 'PHONE_US').length === 1);
  assert.ok(matchAll('415-555-0100', 'PHONE_US').length === 1);
  assert.ok(matchAll('+1 415 555 0100', 'PHONE_US').length === 1);
  assert.ok(matchAll('4155550100', 'PHONE_US').length === 1);
  assert.equal(matchAll('111-555-0100', 'PHONE_US').length, 0); // bad area
});

test('PHONE_E164', () => {
  assert.ok(isMatchAndValid('+44 20 7946 0958', 'PHONE_E164'));
  assert.ok(isMatchAndValid('+33123456789', 'PHONE_E164'));
});

test('IBAN', () => {
  assert.ok(isMatchAndValid('account GB82 WEST 1234 5698 7654 32 belongs to', 'IBAN'));
  assert.ok(isMatchAndValid('DE89370400440532013000', 'IBAN'));
  // Invalid check digit → validator rejects
  assert.equal(isMatchAndValid('GB99WEST12345698765432', 'IBAN'), false);
});

test('CC with Luhn validation', () => {
  assert.ok(isMatchAndValid('Card 4111 1111 1111 1111 expires soon', 'CC'));
  assert.ok(isMatchAndValid('378282246310005', 'CC')); // Amex test
  assert.equal(isMatchAndValid('4111 1111 1111 1112', 'CC'), false); // bad Luhn
});

test('BTC', () => {
  assert.ok(matchAll('btc 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa send', 'BTC').length === 1);
  assert.ok(matchAll('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 'BTC').length === 1);
});

test('ETH', () => {
  assert.ok(matchAll('0x' + 'a'.repeat(40), 'ETH').length === 1);
});

test('SSN formatted + bare', () => {
  assert.ok(isMatchAndValid('SSN 123-45-6789', 'SSN'));
  assert.ok(isMatchAndValid('123456789', 'SSN_BARE'));
  assert.equal(isMatchAndValid('000-12-3456', 'SSN'), false);
});

test('CA_SIN', () => {
  assert.ok(isMatchAndValid('SIN 046-454-286', 'CA_SIN'));
  assert.equal(isMatchAndValid('SIN 123-456-789', 'CA_SIN'), false);
});

test('PASSPORT_US', () => {
  assert.ok(matchAll('Passport: A12345678', 'PASSPORT_US').length === 1);
});

test('VIN', () => {
  assert.ok(isMatchAndValid('VIN 1HGBH41JXMN109186', 'VIN'));
});

test('MAC address', () => {
  assert.ok(matchAll('mac=00:1A:2B:3C:4D:5E', 'MAC').length === 1);
  assert.ok(matchAll('mac=00-1A-2B-3C-4D-5E', 'MAC').length === 1);
});

test('ADDRESS_US', () => {
  assert.ok(matchAll('We live at 123 Main Street.', 'ADDRESS_US').length === 1);
  assert.ok(matchAll('Visit 4567 Sunset Boulevard', 'ADDRESS_US').length === 1);
});

test('ZIP_US', () => {
  assert.ok(matchAll('ZIP 90210', 'ZIP_US').length === 1);
  assert.ok(matchAll('ZIP 90210-1234', 'ZIP_US').length === 1);
});

test('POSTCODE_UK', () => {
  assert.ok(matchAll('post EC1A 1BB please', 'POSTCODE_UK').length === 1);
  assert.ok(matchAll('SW1A 0AA', 'POSTCODE_UK').length === 1);
});

test('POSTCODE_CA', () => {
  assert.ok(matchAll('K1A 0B1', 'POSTCODE_CA').length === 1);
  assert.ok(matchAll('K1A-0B1', 'POSTCODE_CA').length === 1);
});

test('LATLONG', () => {
  assert.ok(matchAll('coords: 40.7128, -74.0060', 'LATLONG').length === 1);
  assert.ok(matchAll('-33.86,151.21', 'LATLONG').length === 1);
});

test('IPV4 with validation', () => {
  assert.ok(isMatchAndValid('192.168.1.1', 'IPV4'));
  assert.equal(isMatchAndValid('256.1.1.1', 'IPV4'), false);
});

test('IPV6', () => {
  assert.ok(matchAll('2001:0db8:85a3:0000:0000:8a2e:0370:7334', 'IPV6').length === 1);
});

test('DOB with validation', () => {
  assert.ok(isMatchAndValid('born 01/15/1990 in', 'DOB'));
  assert.ok(isMatchAndValid('1990-01-15', 'DOB'));
  // 13/01/1990 — first segment is 13, regex requires 0?[1-9]|1[0-2], so 13 doesn't match
  assert.equal(isMatchAndValid('13/01/1990', 'DOB'), false);
});

test('fake() functions produce non-original strings', () => {
  for (const p of DEFAULT_PATTERNS) {
    if (typeof p.fake !== 'function') continue;
    p.regex.lastIndex = 0;
    // Synthesize a sample match for each pattern so fake() runs deterministically
    const sample = sampleFor(p.label);
    if (!sample) continue;
    const out = p.fake(sample, { counter: 1, session: { fakes: {} }, input: sample });
    if (out instanceof Promise) continue; // async paths covered elsewhere
    assert.ok(typeof out === 'string' && out.length > 0, `${p.label} fake() returned ${out}`);
    assert.notEqual(out, sample, `${p.label} fake() returned the original value`);
  }
});

function sampleFor(label) {
  switch (label) {
    case 'EMAIL': return 'someone@real.example';
    case 'PHONE_US': return '(415) 555-2367';
    case 'PHONE_E164': return '+44 20 7946 0958';
    case 'CC': return '4111 1111 1111 1111';
    case 'ADDRESS_US': return '123 Main Street';
    case 'ZIP_US': return '90210';
    case 'POSTCODE_UK': return 'EC1A 1BB';
    case 'POSTCODE_CA': return 'K1A 0B1';
    case 'LATLONG': return '40.7128, -74.0060';
    case 'IPV4': return '192.168.1.1';
    case 'DOB': return '01/15/1990';
    default: return null;
  }
}
