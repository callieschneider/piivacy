// In-browser WebLLM adapter for name substitution.
//
// Trust boundary: the entire LLM runs inside the user's browser. PII never
// leaves the device. Best for client-side scrubbing of chat input before
// it goes to a server-side LLM.
//
// The caller is responsible for installing `@mlc-ai/web-llm` and creating
// an engine instance via `CreateMLCEngine(...)`. This package does NOT
// bundle WebLLM; we just wrap the chat API in the right prompt format.
//
// Example:
//   import { CreateMLCEngine } from '@mlc-ai/web-llm';
//   import { WebLLMAdapter } from 'mostly-no-pii/adapters/webllm';
//   const engine = await CreateMLCEngine('Phi-3.5-mini-instruct-q4f16_1-MLC');
//   const adapter = new WebLLMAdapter({ engine });

import { BaseAdapter, parseAndUnshuffle } from './index.js';

export class WebLLMAdapter extends BaseAdapter {
  constructor(opts = {}) {
    super();
    if (!opts.engine || typeof opts.engine !== 'object') {
      throw new TypeError(
        'WebLLMAdapter: pass `engine` (a WebLLM engine instance from @mlc-ai/web-llm)'
      );
    }
    this.engine = opts.engine;
  }

  async generateAlternates(realNames, count = 1) {
    if (!Array.isArray(realNames) || realNames.length === 0) return [];
    const { system, user, _orderMap } = this._buildPrompt(realNames, count);
    const res = await this.engine.chat.completions.create({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      temperature: 0.7
    });
    const content = res?.choices?.[0]?.message?.content ?? '';
    return parseAndUnshuffle(content, realNames, _orderMap);
  }
}
