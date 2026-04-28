// Name-substitution adapter interface.
//
// All adapters implement:
//   async generateAlternates(realNames: string[], count: number): Promise<string[][]>
//
// Returned shape: result[i] = alternates for realNames[i]. The interface
// requires that adapters mix the real names with decoys before sending to
// any LLM, so the model can't tell which input was the actual redaction
// target. Decoy mixing is provided by the BaseAdapter._buildPrompt helper.
//
// Trust model: adapters MUST NOT log, persist, or transmit `realNames`
// outside their declared trust boundary.
//
//   OpenRouterAdapter — sends to OpenRouter (cloud trust boundary)
//   OllamaAdapter     — sends to local Ollama (local-machine trust boundary)
//   WebLLMAdapter     — runs in browser (no network egress for PII)

const DEFAULT_DECOYS = [
  'Aiden', 'Sofia', 'Liam', 'Mei', 'Rohan', 'Olivia', 'Mateo', 'Aisha',
  'Noah', 'Yui', 'Ezra', 'Priya', 'Jack', 'Anya', 'Ravi', 'Nadia',
  'Caleb', 'Zara', 'Ethan', 'Fatima', 'Omar', 'Hannah', 'Isaac', 'Mira',
  'Lucas', 'Sana', 'Wyatt', 'Ines', 'Owen', 'Yara', 'Felix', 'Esme',
  'Hugo', 'Lena', 'Theo', 'Alma', 'Otto', 'Vera', 'Nico', 'Selma',
  'Arlo', 'Iris', 'Levi', 'Maeve', 'Jude', 'Cora', 'Soren', 'Bella',
  'Kai', 'Anika', 'Asher', 'Saoirse', 'Atlas', 'Juno', 'Beau', 'Wren',
  'Cyrus', 'Esther', 'Dante', 'Greta', 'Elliot', 'Hazel', 'Finn', 'Iris',
  'Gideon', 'Lara', 'Henry', 'Mira', 'Idris', 'Nora', 'Jonah', 'Ophelia',
  'Kasper', 'Penelope', 'Lior', 'Quinn', 'Marlon', 'Romy', 'Niko', 'Sage',
  'Orion', 'Tess', 'Pax', 'Una', 'Quill', 'Vela', 'Rafe', 'Wynn',
  'Silas', 'Xiomara', 'Tobias', 'Yvette', 'Ulysses', 'Zelda', 'Vance', 'Astrid',
  'Wesley', 'Bianca', 'Xander', 'Cleo', 'Yusuf', 'Delia', 'Zane', 'Echo'
];

export class BaseAdapter {
  /**
   * @param {string[]} realNames
   * @param {number} count
   * @returns {Promise<string[][]>}
   */
  async generateAlternates(_realNames, _count) {
    throw new Error('NameSubstitutionAdapter must implement generateAlternates()');
  }

  // Build a decoy-mixed prompt. Returns:
  //   { system, user, _orderMap }
  // _orderMap[i] = index in realNames if all[i] is real, else -1.
  _buildPrompt(realNames, count = 1, decoys = null) {
    const decoyPool = decoys ?? this._defaultDecoys(Math.max(realNames.length * 3, 6));
    const all = shuffleSeeded([...realNames, ...decoyPool], djb2(realNames.join('|')));
    const orderMap = all.map((n) => realNames.indexOf(n));
    const system = [
      'You are a name-similarity assistant. For each input name, return',
      `${count} culturally and demographically similar alternative name(s) (matching gender,`,
      'ethnic origin, and approximate era). Reply with ONLY a JSON array of arrays —',
      'alternatives[i] is the alternates for name[i]. Do not explain.'
    ].join(' ');
    const user = `Names: ${JSON.stringify(all)}\nReturn ${count} alternate(s) per name.`;
    return { system, user, _orderMap: orderMap, _shuffled: all };
  }

  _defaultDecoys(n) {
    const out = [];
    const seed = Math.floor(Math.random() * 0xffffffff);
    const shuffled = shuffleSeeded([...DEFAULT_DECOYS], seed);
    for (let i = 0; i < n && i < shuffled.length; i++) out.push(shuffled[i]);
    return out;
  }
}

// ---------------------------------------------------------------------------
// Helpers exposed for adapter implementations
// ---------------------------------------------------------------------------

export function parseAndUnshuffle(rawText, realNames, orderMap) {
  // Tolerate code fences and stray prose
  const m = rawText.match(/\[[\s\S]*\]/);
  if (!m) return realNames.map(() => []);
  let arr;
  try {
    arr = JSON.parse(m[0]);
  } catch {
    return realNames.map(() => []);
  }
  if (!Array.isArray(arr)) return realNames.map(() => []);
  const result = realNames.map(() => []);
  for (let i = 0; i < orderMap.length; i++) {
    const realIdx = orderMap[i];
    if (realIdx < 0) continue; // decoy slot
    const alts = Array.isArray(arr[i]) ? arr[i].filter((x) => typeof x === 'string') : [];
    result[realIdx] = alts;
  }
  return result;
}

export function shuffleSeeded(arr, seed) {
  const out = [...arr];
  let h = (seed >>> 0) || 1;
  for (let i = out.length - 1; i > 0; i--) {
    h = ((h * 1103515245) + 12345) >>> 0;
    const j = h % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function djb2(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0;
  return h;
}
