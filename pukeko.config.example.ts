import { defineConfig } from './src/lib/config.js';

// Three sample profiles. Select one with `PUKEKO_PROFILE=<name> npm run server`.
// Env vars (OLLAMA_MODEL, ANTHROPIC_MODEL, ROBOT_HOST, PUKEKO_VERBOSE=1, ...)
// override individual fields on top of the chosen profile.
export default defineConfig({
  defaultProfile: 'gemma-default',
  profiles: {
    'gemma-default': {
      llm: { provider: 'ollama', model: 'gemma4:31b' },
      middleware: ['frontend-images', 'motion-summary'],
      // Both prompt files default to the repo root and may be overridden per profile:
      // systemPromptPath: 'system-prompt.md',          // behavioural prompt (gaunt-sloth projectGuidelines)
      // summaryPromptPath: 'summarization-prompt.md',   // motion-summarization prompt
    },

    'gemma-debug': {
      llm: { provider: 'ollama', model: 'gemma4:31b' },
      middleware: ['frontend-images', 'motion-summary', 'observability'],
      observability: { verbose: true, dumpDir: './logs', dumpImages: true },
    },

    anthropic: {
      llm: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      middleware: ['frontend-images', 'motion-summary'],
    },

    // Alternative: mechanical pruner. Preserves reasoning and tool calls
    // verbatim; only drops image bytes from old messages and reasoning blocks
    // from old AI turns. Summarizes lazily — only when the pruned history
    // crosses summarizeAtFraction × maxContextTokens. Mutually exclusive with
    // 'motion-summary' (both rewrite the head on beforeModel).
    'gemma-pruner': {
      llm: { provider: 'ollama', model: 'gemma4:31b' },
      middleware: ['frontend-images', 'context-pruner'],
      contextPruner: {
        maxContextTokens: 30_000,
        summarizeAtFraction: 0.7,
        keepLatestImages: 1,
        imageTokenBudget: 800,
      },
    },
  },
});
