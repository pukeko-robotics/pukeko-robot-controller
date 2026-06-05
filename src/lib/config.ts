// Declarative configuration for the robot controller.
//
// Users author either `pukeko.config.ts`, `pukeko.config.js`, or
// `pukeko.config.json` at the project root. The loader in `loadConfig.ts`
// resolves a profile and applies env-var overrides on top.

export type LlmProvider = 'ollama' | 'anthropic' | 'openai' | 'openrouter';

export interface LlmSpec {
  provider: LlmProvider;
  model: string;
  baseUrl?: string;
}

export type BuiltinMiddlewareId =
  | 'frontend-images'
  | 'motion-summary'
  | 'context-pruner'
  | 'lazy-tool-recovery'
  | 'observability';

// Arbitrary middleware object the user can pass in from a .ts/.js config.
// Kept loose; the loader doesn't introspect it.
export type MiddlewareObject = Record<string, unknown>;

export type MiddlewareEntry = BuiltinMiddlewareId | MiddlewareObject;

export interface ObservabilityOptions {
  verbose: boolean;
  dumpDir?: string;
  dumpImages?: boolean;
}

export interface RobotOptions {
  host?: string;
}

export interface ContextPrunerProfileOpts {
  maxContextTokens?: number;
  summarizeAtFraction?: number;
  keepLatestImages?: number;
  imageTokenBudget?: number;
}

export interface LazyToolRecoveryProfileOpts {
  maxRecoveries?: number;
  skipClassifier?: boolean;
  // Re-prompt on ANY no-tool reply (not just ones that name a tool). The
  // model must call some tool every turn — a real action or finish_task to end.
  // The Ollama-path equivalent of forcing tool_choice. Default false.
  force?: boolean;
}

export interface PukekoProfile {
  llm: LlmSpec;
  // Path to the agent's behavioural system prompt, resolved from the project
  // root. Wired into gaunt-sloth's `projectGuidelines` slot. Defaults to
  // `system-prompt.md`.
  systemPromptPath?: string;
  // Path to the motion-summarization prompt, resolved from the project root.
  // Defaults to `summarization-prompt.md`; the middleware keeps an identical
  // baked-in copy as a fallback if the file is missing.
  summaryPromptPath?: string;
  middleware?: MiddlewareEntry[];
  observability?: ObservabilityOptions;
  robot?: RobotOptions;
  contextPruner?: ContextPrunerProfileOpts;
  lazyToolRecovery?: LazyToolRecoveryProfileOpts;
}

export interface PukekoConfig {
  defaultProfile?: string;
  profiles: Record<string, PukekoProfile>;
}

// Identity helper that gives type inference + IDE completion when authoring
// `pukeko.config.ts`. Pure pass-through at runtime.
export function defineConfig(cfg: PukekoConfig): PukekoConfig {
  return cfg;
}
