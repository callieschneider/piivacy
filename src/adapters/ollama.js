// Local Ollama adapter for name substitution.
//
// Trust boundary: the request goes to a local Ollama instance (default
// http://localhost:11434). PII does not leave the machine. Recommended for
// privacy-sensitive deployments.
//
// Suggested models: phi3:mini (fast), llama3.1:8b (better quality).

import { BaseAdapter, parseAndUnshuffle } from './index.js';

const DEFAULT_HOST = 'http://localhost:11434';
const DEFAULT_MODEL = 'phi3:mini';

export class OllamaAdapter extends BaseAdapter {
  constructor(opts = {}) {
    super();
    this.host = (opts.host ?? DEFAULT_HOST).replace(/\/+$/, '');
    this.model = opts.model ?? DEFAULT_MODEL;
  }

  async generateAlternates(realNames, count = 1) {
    if (!Array.isArray(realNames) || realNames.length === 0) return [];
    const { system, user, _orderMap } = this._buildPrompt(realNames, count);
    const res = await fetch(`${this.host}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        stream: false,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ]
      })
    });
    if (!res.ok) {
      throw new Error(`OllamaAdapter: ${res.status} ${await safeText(res)}`);
    }
    const json = await res.json();
    const content = json?.message?.content ?? '';
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
