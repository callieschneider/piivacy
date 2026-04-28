// OpenRouter cloud adapter for name substitution.
//
// Trust boundary: the request goes to api.openrouter.ai. The real names are
// in the request body (mixed with decoys, but still present as plaintext).
// Use only if your privacy model accepts cloud LLM round-trips.

import { BaseAdapter, parseAndUnshuffle } from './index.js';

const DEFAULT_MODEL = 'meta-llama/llama-3.1-8b-instruct';
const DEFAULT_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

export class OpenRouterAdapter extends BaseAdapter {
  constructor(opts = {}) {
    super();
    if (!opts.apiKey || typeof opts.apiKey !== 'string') {
      throw new TypeError('OpenRouterAdapter: opts.apiKey is required');
    }
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? DEFAULT_MODEL;
    this.endpoint = opts.endpoint ?? DEFAULT_ENDPOINT;
    this.referer = opts.referer ?? 'https://github.com/callieschneider/mostly-no-pii';
    this.title = opts.title ?? 'mostly-no-pii';
  }

  async generateAlternates(realNames, count = 1) {
    if (!Array.isArray(realNames) || realNames.length === 0) return [];
    const { system, user, _orderMap } = this._buildPrompt(realNames, count);
    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': this.referer,
        'X-Title': this.title
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ],
        temperature: 0.7
      })
    });
    if (!res.ok) {
      throw new Error(`OpenRouterAdapter: ${res.status} ${await safeText(res)}`);
    }
    const json = await res.json();
    const content = json?.choices?.[0]?.message?.content ?? '';
    return parseAndUnshuffle(content, realNames, _orderMap);
  }
}

async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return '<no body>';
  }
}
