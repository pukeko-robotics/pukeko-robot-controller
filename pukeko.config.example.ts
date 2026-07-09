import { defineConfig } from './src/lib/config.js'

// Sample profiles — select one with `PUKEKO_PROFILE=<name> npm run server`.
// Env vars (OLLAMA_MODEL, ANTHROPIC_MODEL, ROBOT_HOST, PUKEKO_VERBOSE=1, ...) override
// individual fields on top of the chosen profile.
//
// Unified middleware stack — the same on every profile:
//   'frontend-images' — surfaces the robot camera frame to the model and the web client.
//   'context-pruner'  — bounds cost: mechanically drops old image BYTES (keepLatestImages)
//                       and summarizes lazily only past summarizeAtFraction × maxContextTokens.
//                       Prefer this over 'motion-summary': motion-summary's per-turn summary
//                       LLM call fails on Anthropic (unpaired tool_use/tool_result → 400) and so
//                       never compresses, leaving the image history to grow unbounded → huge bills.
//   'observability'   — debug logging: per-turn messages/response (+ images) under dumpDir.
// Local (Ollama) models additionally get 'lazy-tool-recovery' (force): small models narrate a
//   tool instead of calling it; this re-prompts so the call streams for real. Do NOT add it to
//   hosted models — it would force a tool onto legitimate plain-text replies.
const PRUNER_LOCAL = { maxContextTokens: 30_000, summarizeAtFraction: 0.7, keepLatestImages: 1, imageTokenBudget: 800 }
const PRUNER_HOSTED = { maxContextTokens: 130_000, summarizeAtFraction: 0.7, keepLatestImages: 1, imageTokenBudget: 800 }
const OBSERVABILITY = { verbose: true, dumpDir: './logs', dumpImages: true }

export default defineConfig({
  defaultProfile: 'gemma-default',
  profiles: {
    'gemma-default': {
      llm: { provider: 'ollama', model: 'gemma4:31b' },
      middleware: ['frontend-images', 'context-pruner', 'observability', 'lazy-tool-recovery'],
      contextPruner: PRUNER_LOCAL,
      observability: OBSERVABILITY,
      lazyToolRecovery: { force: true },
      // Both prompt files default to the repo root and may be overridden per profile:
      // systemPromptPath: 'system-prompt.md',        // behavioural prompt (gaunt-sloth projectGuidelines)
      // summaryPromptPath: 'summarization-prompt.md', // context-pruner's lazy-summary prompt
      // robot: { host: '192.168.4.1', preset: 'ACEBOTT-QD021' }, // overridable with ROBOT_HOST / ROBOT_PRESET
    },

    'gpt-5.5': {
      llm: { provider: 'openai', model: 'gpt-5.5' },
      middleware: ['frontend-images', 'context-pruner', 'observability'],
      contextPruner: PRUNER_HOSTED,
      observability: OBSERVABILITY,
    },

    openrouter: {
      llm: { provider: 'openrouter', model: 'google/gemini-2.5-pro' },
      middleware: ['frontend-images', 'context-pruner', 'observability'],
      contextPruner: PRUNER_HOSTED,
      observability: OBSERVABILITY,
    },

    anthropic: {
      // `cache: true` enables Anthropic prompt caching (system prompt + tool schemas re-read at ~0.1x).
      llm: { provider: 'anthropic', model: 'claude-sonnet-4-6', cache: true },
      middleware: ['frontend-images', 'context-pruner', 'observability'],
      contextPruner: PRUNER_HOSTED,
      observability: OBSERVABILITY,
    },
  },
})
