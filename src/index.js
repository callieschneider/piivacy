// piivacy — public API
//
// Two functions you'll use 95% of the time:
//   const { text, session } = await scrub(input, existingSession?, opts?)
//   const restored          = restore(llmResponse, session)

export { scrub } from './scrub.js';
export { restore } from './restore.js';

// Sessions + redaction inventory
export {
  createSession,
  isExpired,
  registerSecret,
  listRedactions
} from './sessions.js';

// Pluggable pattern registry
export {
  registerPattern,
  unregisterPattern,
  listPatterns
} from './registry.js';

// Mode resolution + presets
export { presets } from './modes.js';

// BYO-LLM helpers — second-pass detection
export {
  buildPiiCheckPrompt,
  parsePiiCheckResponse,
  applyPiiCheckIssues
} from './llm-check.js';

// BYO-LLM helpers — dynamic mode picking based on query intent
export {
  buildScrubIntentPrompt,
  parseScrubIntentResponse,
  applyScrubIntent
} from './llm-intent.js';

// Note: name-substitution adapters (OpenRouterAdapter, OllamaAdapter,
// WebLLMAdapter) are exposed via subpath imports, not re-exported here:
//
//   import { OpenRouterAdapter } from 'piivacy/adapters/openrouter';
//   import { OllamaAdapter }     from 'piivacy/adapters/ollama';
//   import { WebLLMAdapter }     from 'piivacy/adapters/webllm';
//
// This keeps the main bundle lean for token-mode-only callers.
