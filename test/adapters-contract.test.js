import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BaseAdapter, parseAndUnshuffle, shuffleSeeded } from '../src/adapters/index.js';

class MockAdapter extends BaseAdapter {
  constructor() {
    super();
    this.calls = [];
  }
  async generateAlternates(realNames, count = 1) {
    const { _orderMap, _shuffled } = this._buildPrompt(realNames, count);
    this.calls.push({ realNames, count, shuffledSize: _shuffled.length });
    // Pretend the LLM returned an array of arrays — for each name in shuffled
    // order, return one fake.
    const fakeOutput = JSON.stringify(_shuffled.map((n) => [`fake-${n.toLowerCase()}`]));
    return parseAndUnshuffle(fakeOutput, realNames, _orderMap);
  }
}

test('BaseAdapter throws on direct use', async () => {
  const a = new BaseAdapter();
  await assert.rejects(a.generateAlternates(['x']), /implement/);
});

test('mock adapter satisfies the interface', async () => {
  const a = new MockAdapter();
  const out = await a.generateAlternates(['Marcus', 'Jane'], 1);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], ['fake-marcus']);
  assert.deepEqual(out[1], ['fake-jane']);
});

test('decoys are mixed in (shuffled prompt is larger than realNames)', async () => {
  const a = new MockAdapter();
  await a.generateAlternates(['Marcus'], 1);
  const call = a.calls[0];
  assert.ok(call.shuffledSize > 1, 'shuffled prompt should include decoys');
});

test('parseAndUnshuffle handles plain JSON', () => {
  const orderMap = [-1, 0, -1, 1]; // shuffled = [decoy, real0, decoy, real1]
  const raw = '[["decoyA"],["realA"],["decoyB"],["realB"]]';
  const out = parseAndUnshuffle(raw, ['real0name', 'real1name'], orderMap);
  assert.deepEqual(out, [['realA'], ['realB']]);
});

test('parseAndUnshuffle tolerates code-fenced JSON', () => {
  const orderMap = [0];
  const raw = '```json\n[["fake"]]\n```';
  const out = parseAndUnshuffle(raw, ['real'], orderMap);
  assert.deepEqual(out, [['fake']]);
});

test('parseAndUnshuffle returns empties on malformed', () => {
  const out = parseAndUnshuffle('not an array', ['real'], [0]);
  assert.deepEqual(out, [[]]);
});

test('shuffleSeeded is deterministic for same seed', () => {
  const a = shuffleSeeded(['a', 'b', 'c', 'd', 'e'], 12345);
  const b = shuffleSeeded(['a', 'b', 'c', 'd', 'e'], 12345);
  assert.deepEqual(a, b);
});

test('shuffleSeeded produces different orders for different seeds', () => {
  const a = shuffleSeeded(['a', 'b', 'c', 'd', 'e', 'f'], 1);
  const b = shuffleSeeded(['a', 'b', 'c', 'd', 'e', 'f'], 2);
  // Same elements, different order (probabilistically)
  assert.deepEqual([...a].sort(), [...b].sort());
  assert.notDeepEqual(a, b);
});

test('OpenRouterAdapter requires apiKey', async () => {
  const { OpenRouterAdapter } = await import('../src/adapters/openrouter.js');
  assert.throws(() => new OpenRouterAdapter({}), /apiKey/);
  assert.throws(() => new OpenRouterAdapter({ apiKey: 123 }), /apiKey/);
});

test('OllamaAdapter has sensible defaults', async () => {
  const { OllamaAdapter } = await import('../src/adapters/ollama.js');
  const a = new OllamaAdapter();
  assert.ok(a.host.includes('localhost'));
  assert.ok(a.model);
});

test('WebLLMAdapter requires engine', async () => {
  const { WebLLMAdapter } = await import('../src/adapters/webllm.js');
  assert.throws(() => new WebLLMAdapter({}), /engine/);
});
