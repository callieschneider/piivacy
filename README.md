# mostly-no-pii

> A serverless PII scrubber for LLM calls. Two functions. Three substitution modes. No proxy. No server. Zero runtime dependencies.

```bash
npm install mostly-no-pii
```

```js
import { scrub, restore, createSession } from 'mostly-no-pii';

const session = createSession();
const { text } = await scrub('Email me at jane@acme.com', session);
// "Email me at [[EMAIL_1]]"

// ...send `text` to your LLM, get a response that uses the tokens...

const restored = restore(llmResponse, session);
// "Sure, I will email jane@acme.com today"
```

That's the whole loop. The package never makes an HTTP call. Everything happens inside your process.

---

## Why "mostly"?

Regex catches **most** common PII — emails, phones, SSNs, credit cards, API keys, addresses, etc. — across **30+ patterns in 6 categories**. It will miss things a human or LLM would catch (names, codenames, oblique references, free-form sensitive context). For those, the package ships an opt-in **second-pass LLM check** that you run with any chat model you already have. Combined coverage gets you very close to "no PII"; the name acknowledges that's an asymptote, not a guarantee.

If you need cryptographic guarantees, hire a security team. If you need "stop accidentally pasting the customer's SSN into ChatGPT", this is for you.

---

## Quick decision tree

| You want… | Use mode |
|---|---|
| Maximum privacy, restore-bulletproof | `token` (default) |
| Natural-sounding text for the LLM, restore via fakes | `realistic` |
| The LLM legitimately needs the value (e.g. an address for local search) | `pass-through` |

You can mix and match per category, per label, or via built-in `presets`.

---

## The full API

### Core

```js
const { text, session } = await scrub(input, existingSession?, opts?)
```
Async. Walks default + custom patterns in priority order; replaces matches according to the mode resolver. Returns the scrubbed text and the session (so you can keep using it across turns).

```js
const restored = restore(llmResponse, session)
```
Synchronous. Three-pass longest-match-first restore: tokens → fakes → reference forms ("Marcus", "Marcus's", "Mr. Chen"). LLM-invented or truncated tokens pass through unchanged.

### Sessions

```js
const session = createSession({ ttlMs?: 1_800_000, nameAdapter?: NameSubstitutionAdapter })
isExpired(session)                 // boolean
registerSecret(session, value, label = 'CUSTOM')   // pre-flag a literal value
listRedactions(session)            // [{ kind, identifier, label, value, count, firstSeenAt, lastSeenAt }]
```
Sessions are JSON-serializable plain objects. Sliding TTL — every operation refreshes `expiresAt`. Persistence (Redis, file, etc.) is the caller's responsibility.

### Pluggable patterns

```js
registerPattern({ label, regex, category, priority?, validate?, fake?, referenceForms?, description? })
unregisterPattern(label)
listPatterns()                     // [{ label, category, priority, description, hasRealistic }]
```

### Modes & presets

```js
import { presets } from 'mostly-no-pii';
await scrub(text, session, presets.maximumRedaction);     // token everything
await scrub(text, session, presets.naturalConversation);  // contact + location realistic
await scrub(text, session, presets.localSearch);          // location pass-through
await scrub(text, session, presets.testFriendly);         // realistic where possible, token for danger
```

### BYO-LLM helpers

Second-pass detection (catch what regex missed):

```js
buildPiiCheckPrompt(scrubbedText, opts?)            // → { system, user }
parsePiiCheckResponse(rawText)                      // → { issues, parseError? }
applyPiiCheckIssues(session, issues, { minConfidence })   // → count applied
```

Dynamic mode picking (let an LLM decide what the assistant needs preserved):

```js
buildScrubIntentPrompt(text, opts?)                 // → { system, user }
parseScrubIntentResponse(rawText)                   // → { decisions, reason }
applyScrubIntent(decisions, baseOpts?)              // → scrub opts
```

---

## Mode comparison matrix

| Aspect | `token` | `realistic` | `pass-through` |
|---|---|---|---|
| Restore reliability | bulletproof | longest-match (good) | n/a (value never changed) |
| LLM fluency | poor (`[[EMAIL_1]]`) | excellent (`redacted1@example.com`) | excellent |
| Privacy | maximum | high | none for that label |
| Default? | yes | opt-in | opt-in |

**Safety override:** `secrets`, `financial`, and `identifiers` categories can NEVER be `pass-through`. Even if you (or an LLM intent classifier) explicitly request it, the package downgrades to `token`. This is hard-coded.

---

## Configuration recipes

### Per-category modes

```js
await scrub(text, session, {
  defaultMode: 'token',
  modes: {
    contact: 'realistic',
    location: 'pass-through'
  }
});
```

### Per-label overrides (highest specificity)

```js
await scrub(text, session, {
  defaultMode: 'token',
  modes: { contact: 'realistic' },
  labels: {
    EMAIL: 'realistic',     // explicit wins
    DOB:   'pass-through',  // we want to discuss age
    ZIP_US: 'token'         // override the location-category default
  }
});
```

### `passThrough` shorthand

```js
await scrub(text, session, {
  passThrough: ['CITY', 'STATE', 'ZIP_US']  // sugar for labels: { CITY: 'pass-through', ... }
});
```

### `exclude` — skip a pattern entirely

```js
await scrub(text, session, { exclude: ['IPV6'] });  // never even check for IPv6
```

### Resolution order (most-specific first)

1. `exclude` → pattern doesn't run
2. `passThrough` → `pass-through`
3. `labels[label]` → that mode
4. `modes[category]` → that mode
5. `defaultMode` → that mode (default `'token'`)
6. **Safety override**: secrets/financial/identifiers → `token` if any of the above said `pass-through`

---

## Multi-turn example

```js
import { scrub, restore, createSession } from 'mostly-no-pii';

const session = createSession();

// Turn 1
let { text } = await scrub('Email a@x.com please', session);
const reply1 = await yourLLM(text);
console.log(restore(reply1, session));

// Turn 2 — same session, same tokens for the same values
({ text } = await scrub('Actually email a@x.com and b@x.com', session));
const reply2 = await yourLLM(text);
console.log(restore(reply2, session));

console.log(listRedactions(session));
// [{ kind: 'token', identifier: '[[EMAIL_1]]', value: 'a@x.com', count: 2, ... },
//  { kind: 'token', identifier: '[[EMAIL_2]]', value: 'b@x.com', count: 1, ... }]
```

---

## OpenAI / Anthropic / fetch examples

### Token mode (the safe default)

```js
import OpenAI from 'openai';
import { scrub, restore, createSession } from 'mostly-no-pii';

const openai = new OpenAI();
const session = createSession();

const { text } = await scrub(userInput, session);
const completion = await openai.chat.completions.create({
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: text }]
});
const restored = restore(completion.choices[0].message.content, session);
```

### Realistic mode (better LLM fluency)

```js
import { scrub, restore, createSession, presets } from 'mostly-no-pii';

const session = createSession();
const { text } = await scrub(userInput, session, presets.naturalConversation);
// `text` reads naturally — "redacted1@example.com" instead of "[[EMAIL_1]]"
```

### Anthropic (any LLM works)

```js
import Anthropic from '@anthropic-ai/sdk';
const claude = new Anthropic();
const { text } = await scrub(userInput, session);
const response = await claude.messages.create({
  model: 'claude-3-5-sonnet-latest',
  max_tokens: 1024,
  messages: [{ role: 'user', content: text }]
});
const restored = restore(response.content[0].text, session);
```

---

## Pattern catalog

### secrets (token-only — never realistic)

| Label | Catches |
|---|---|
| `OPENAI_KEY` | `sk-...` and `sk-proj-...` |
| `ANTHROPIC_KEY` | `sk-ant-...` |
| `GITHUB_TOKEN` | `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_...` |
| `AWS_ACCESS_KEY` | `AKIA...`, `ASIA...` |
| `AWS_SECRET_KEY` | 40-char value preceded by `aws_secret_access_key=` etc. |
| `GOOGLE_API_KEY` | `AIza...` |
| `STRIPE_KEY` | `sk_live_`, `pk_live_`, `sk_test_`, `pk_test_` |
| `SLACK_TOKEN` | `xoxa-`, `xoxb-`, `xoxp-`, `xoxr-`, `xoxs-` |
| `JWT` | three base64url segments |
| `URL_CREDENTIALS` | `https://user:pass@host/...` |

### contact (realistic-friendly)

| Label | Realistic fake |
|---|---|
| `EMAIL` | `redacted{N}@example.com` (RFC 6761 reserved) |
| `PHONE_US` | `(555) 010-{NNNN}` (FCC fictional range) |
| `PHONE_E164` | `+44 555 010 {NNNN}` |

### financial

| Label | Notes |
|---|---|
| `IBAN` | mod-97 validated |
| `CC` | Luhn validated; realistic = Visa test card `4111-1111-1111-XXXX` |
| `BTC` | legacy, P2SH, bech32 |
| `ETH` | `0x` + 40 hex |

### identifiers (token-only)

`SSN`, `SSN_BARE`, `CA_SIN` (Luhn), `PASSPORT_US`, `VIN` (check-digit validated), `MAC`.

### location (realistic OR pass-through friendly)

`ADDRESS_US`, `ZIP_US`, `POSTCODE_UK`, `POSTCODE_CA`, `LATLONG`.

### network

`IPV4` (octet validated), `IPV6`, `DOB` (month/day validated, realistic = `01/01/1970`).

### Names — special case

Names are **not** in the regex catalog (too noisy). They enter the system three ways:

1. The opt-in **LLM second-pass check** (recommended)
2. Manual `registerSecret(session, 'Jane Doe', 'NAME')`
3. A custom regex pattern you register yourself

In `realistic` mode, NAME redaction prefers (in order): your session's name adapter → the static `data/names.json` table (267k names from US SSA + US Census 2010, bucketed by gender/era/ethnicity) → a phonetic-shift fallback.

---

## Adding custom patterns

```js
import { registerPattern } from 'mostly-no-pii';

registerPattern({
  label: 'INTERNAL_TICKET',
  regex: /\bTICKET-\d{6}\b/g,        // /g flag REQUIRED
  category: 'custom',
  priority: 25,                      // slots between defaults
  validate: (v) => Number(v.slice(7)) > 100000,
  fake: (_value, { counter }) => `TICKET-${(counter + 1000).toString().padStart(6, '0')}`,
  description: 'Internal Jira-style ticket'
});
```

Or scope a pattern to a single `scrub` call without registering globally:

```js
await scrub(text, session, {
  extraPatterns: [{ label: 'EPHEMERAL', regex: /\bEPH-\d+\b/g, category: 'custom' }]
});
```

---

## LLM second-pass loop (catch what regex missed)

The package never calls an LLM itself. You wire it up using whatever chat client you already have:

```js
import OpenAI from 'openai';
import {
  scrub,
  buildPiiCheckPrompt,
  parsePiiCheckResponse,
  applyPiiCheckIssues
} from 'mostly-no-pii';

const openai = new OpenAI();
const session = createSession();

// Pass 1
let { text } = await scrub(userInput, session);

// Pass 2: ask a cheap model "did regex miss anything?"
const { system, user } = buildPiiCheckPrompt(text);
const checkRes = await openai.chat.completions.create({
  model: 'gpt-4o-mini',
  messages: [
    { role: 'system', content: system },
    { role: 'user', content: user }
  ]
});

const { issues } = parsePiiCheckResponse(checkRes.choices[0].message.content);
applyPiiCheckIssues(session, issues, { minConfidence: 0.7 });

// Pass 3: re-scrub with the new literals registered
({ text } = await scrub(userInput, session));

// Now `text` is much cleaner. Send it to your real LLM.
```

The second-pass model can be cheap (`gpt-4o-mini`, `claude-haiku`, an Ollama 7B) — it just needs to follow JSON output instructions.

---

## Dynamic mode picking with `llm-intent`

Sometimes the LLM **legitimately needs** certain PII to answer well — addresses for local search, dates for scheduling, etc. The intent helpers ask any LLM to make that decision per category:

```js
import {
  buildScrubIntentPrompt,
  parseScrubIntentResponse,
  applyScrubIntent
} from 'mostly-no-pii';

const userInput = 'Find Indian restaurants near 234 Main St, Brooklyn, NY 11211';

const intent = buildScrubIntentPrompt(userInput);
const intentRes = await openai.chat.completions.create({
  model: 'gpt-4o-mini',
  messages: [
    { role: 'system', content: intent.system },
    { role: 'user', content: intent.user }
  ]
});

const { decisions } = parseScrubIntentResponse(intentRes.choices[0].message.content);
// decisions = { location: 'preserve', contact: 'redact', secrets: 'redact', ... }

const opts = applyScrubIntent(decisions, { defaultMode: 'token' });
const { text } = await scrub(userInput, session, opts);
// → "Find Indian restaurants near 234 Main St, Brooklyn, NY 11211"  (location preserved)
//   But if user added "my SSN is 123-45-6789", that would still get tokenized.
```

The package hard-codes a **safety override**: even if the LLM hallucinates `secrets: 'preserve'`, we downgrade it to `redact`. Same for `financial` and `identifiers`.

---

## Name redaction with adapters (browser / local / cloud)

`realistic` mode for NAMES uses (in order):

1. The session's configured **adapter**, if any
2. The static **`data/names.json`** table (267k names, ships with the package, lazy-loaded)
3. **Phonetic shift fallback** for unknown names

Adapters live behind subpath imports — they're not loaded unless you import them.

### WebLLM (in-browser, zero network egress)

```bash
npm install @mlc-ai/web-llm
```

```js
import { CreateMLCEngine } from '@mlc-ai/web-llm';
import { WebLLMAdapter } from 'mostly-no-pii/adapters/webllm';
import { createSession, scrub } from 'mostly-no-pii';

const engine = await CreateMLCEngine('Phi-3.5-mini-instruct-q4f16_1-MLC');
const session = createSession({ nameAdapter: new WebLLMAdapter({ engine }) });
```

### Ollama (local model)

```js
import { OllamaAdapter } from 'mostly-no-pii/adapters/ollama';

const session = createSession({
  nameAdapter: new OllamaAdapter({ model: 'phi3:mini' })  // assumes ollama is running locally
});
```

### OpenRouter (cloud, any small model)

```js
import { OpenRouterAdapter } from 'mostly-no-pii/adapters/openrouter';

const session = createSession({
  nameAdapter: new OpenRouterAdapter({
    apiKey: process.env.OPENROUTER_API_KEY,
    model: 'meta-llama/llama-3.1-8b-instruct'
  })
});
```

All three adapters mix the real names with **decoy names** before sending the prompt, so even a logging provider can't easily tell which input was the redaction target.

---

## Inspecting redactions

```js
import { listRedactions } from 'mostly-no-pii';

await scrub('Email a@x.com phone (415) 555-0142 SSN 123-45-6789', session);

console.log(listRedactions(session));
// [
//   { kind: 'token', identifier: '[[EMAIL_1]]',    label: 'EMAIL',    value: 'a@x.com',         count: 1, ... },
//   { kind: 'token', identifier: '[[PHONE_US_1]]', label: 'PHONE_US', value: '(415) 555-0142', count: 1, ... },
//   { kind: 'token', identifier: '[[SSN_1]]',      label: 'SSN',      value: '123-45-6789',    count: 1, ... }
// ]
```

Useful for: audit trails, downstream feature calls (e.g. enriching the LLM call with structured PII metadata after scrubbing the raw text), debugging which patterns triggered.

---

## What it catches / What it misses

**Catches reliably:** common emails, US/E.164 phones, US/UK/Canadian addresses & postcodes, SSN, credit cards (Luhn), IBAN (mod-97), VIN (check-digit), JWTs, API keys for 8 major providers, IP addresses, dates of birth, MAC addresses, BTC/ETH wallets, lat/long pairs.

**Misses (regex can't catch these reliably; use the LLM second-pass):**
- Names ("Jane Doe", "Dr. Smith")
- Companies, projects, codenames
- Free-form sensitive context ("my divorce", "the layoff")
- Internationalized email (unicode local-parts)
- Non-Latin-script identifiers
- PII embedded in unstructured prose with no formatting cues

The package is **defense in depth**, not a magic shield. Think of regex as the cheap fast filter, the LLM check as the expensive accurate filter, and your security review as the human in the loop.

---

## Sessions, sliding TTL

Sessions store the bidirectional maps between real values and tokens/fakes. Default TTL is 30 minutes; every `scrub` or `getOrAssignToken` call refreshes the expiry. After expiry, calls throw unless you pass `{ allowExpired: true }`.

Sessions are plain JSON objects. To persist across processes, just `JSON.stringify(session)` and rehydrate. The package provides no built-in persistence layer — that's deliberately the caller's call.

---

## What's in the box vs. opt-in

| Always loaded | Lazy-loaded | Sub-import |
|---|---|---|
| Core (scrub, restore, registry, modes, sessions, BYO-LLM helpers) | `data/names.json` (~23 MB, only on first realistic NAME use) | `mostly-no-pii/adapters/openrouter` |
| 30+ default patterns | | `mostly-no-pii/adapters/ollama` |
| | | `mostly-no-pii/adapters/webllm` |

Token-mode-only callers pay zero overhead beyond core. Realistic-mode callers without NAMEs pay zero extra. Adapter users pay only their adapter's tiny wrapper.

---

## Disclaimer

This package reduces the surface area for accidentally pasting PII into an LLM prompt. It does **not**:

- Guarantee zero leakage (regex misses things; LLMs may infer)
- Replace your security review process
- Replace data-handling agreements with your LLM provider
- Provide cryptographic guarantees of any kind
- Constitute legal compliance with GDPR / CCPA / HIPAA / etc.

If you're handling regulated data, consult a security professional. If you're trying to stop yourself from accidentally pasting your customer's SSN into Claude, this is the right tool.

---

## Why "mostly"?

There is no perfect PII detector. Names are ambiguous. "John" is a name, a noun ("john" as toilet), a verb ("to john"). Companies are names. Aliases exist. Free text contains thousands of leakage modes regex can't cover. We get most of them. We don't claim to get all of them.

The honest naming up front beats a confidently-named library that silently fails.

---

## License

MIT.

## Contributing

PRs welcome. Particularly valuable:

- Patterns for non-US/UK locales (Indian Aadhaar, EU VAT, Australian TFN, Brazilian CPF, etc.)
- Better validators
- Languages other than English for the LLM-check prompts
- A name table for non-Latin scripts (Hangul, CJK, Arabic, Devanagari)

Run `npm test` before submitting.
