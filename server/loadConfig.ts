import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  LlmProvider,
  MiddlewareEntry,
  PukekoConfig,
  PukekoProfile,
} from '../src/lib/config.js';

const CONFIG_FILENAMES = [
  'pukeko.config.ts',
  'pukeko.config.js',
  'pukeko.config.mjs',
  'pukeko.config.json',
] as const;

const FALLBACK_PROFILE: PukekoProfile = {
  llm: { provider: 'ollama', model: 'gemma4:31b' },
  middleware: ['frontend-images', 'motion-summary'],
};

const FALLBACK_CONFIG: PukekoConfig = {
  defaultProfile: 'default',
  profiles: { default: FALLBACK_PROFILE },
};

export interface ResolvedConfig {
  configPath: string | null;
  profileName: string;
  profile: PukekoProfile;
}

async function importConfigModule(absPath: string): Promise<PukekoConfig> {
  // `node --import=tsx` registers tsx for both .ts and .js imports, so a
  // dynamic import of either works. JSON is handled separately.
  const mod = await import(pathToFileURL(absPath).href);
  const cfg = (mod.default ?? mod.config ?? mod) as PukekoConfig;
  if (!cfg || typeof cfg !== 'object' || !cfg.profiles) {
    throw new Error(
      `Invalid pukeko config at ${absPath}: missing 'profiles' object.`
    );
  }
  return cfg;
}

function readJsonConfig(absPath: string): PukekoConfig {
  const raw = readFileSync(absPath, 'utf8');
  const cfg = JSON.parse(raw) as PukekoConfig;
  if (!cfg.profiles) {
    throw new Error(`Invalid pukeko config at ${absPath}: missing 'profiles' object.`);
  }
  return cfg;
}

function applyEnvOverrides(profile: PukekoProfile): PukekoProfile {
  const next: PukekoProfile = {
    ...profile,
    llm: { ...profile.llm },
    robot: { ...(profile.robot ?? {}) },
    observability: profile.observability ? { ...profile.observability } : undefined,
  };

  if (process.env.LLM_PROVIDER) {
    next.llm.provider = process.env.LLM_PROVIDER as LlmProvider;
  }
  if (next.llm.provider === 'ollama') {
    if (process.env.OLLAMA_MODEL) next.llm.model = process.env.OLLAMA_MODEL;
    if (process.env.OLLAMA_BASE_URL) next.llm.baseUrl = process.env.OLLAMA_BASE_URL;
  } else if (next.llm.provider === 'anthropic') {
    if (process.env.ANTHROPIC_MODEL) next.llm.model = process.env.ANTHROPIC_MODEL;
  } else if (next.llm.provider === 'openai') {
    if (process.env.OPENAI_MODEL) next.llm.model = process.env.OPENAI_MODEL;
    if (process.env.OPENAI_BASE_URL) next.llm.baseUrl = process.env.OPENAI_BASE_URL;
  } else if (next.llm.provider === 'openrouter') {
    if (process.env.OPENROUTER_MODEL) next.llm.model = process.env.OPENROUTER_MODEL;
    if (process.env.OPENROUTER_BASE_URL) next.llm.baseUrl = process.env.OPENROUTER_BASE_URL;
  } else if (next.llm.provider === 'google') {
    if (process.env.GOOGLE_MODEL) next.llm.model = process.env.GOOGLE_MODEL;
  }
  if (process.env.ROBOT_HOST) {
    next.robot = { ...(next.robot ?? {}), host: process.env.ROBOT_HOST };
  }
  if (process.env.ROBOT_PRESET) {
    next.robot = { ...(next.robot ?? {}), preset: process.env.ROBOT_PRESET };
  }
  if (process.env.PUKEKO_DUMP_DIR) {
    next.observability = {
      verbose: next.observability?.verbose ?? true,
      dumpImages: next.observability?.dumpImages ?? true,
      ...next.observability,
      dumpDir: process.env.PUKEKO_DUMP_DIR,
    };
  }
  if (process.env.PUKEKO_VERBOSE === '1') {
    next.observability = {
      dumpImages: true,
      ...next.observability,
      verbose: true,
    };
  }

  return next;
}

function locateConfigFile(cwd: string): string | null {
  for (const name of CONFIG_FILENAMES) {
    const candidate = resolve(cwd, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export async function loadConfig(cwd: string = process.cwd()): Promise<ResolvedConfig> {
  const configPath = locateConfigFile(cwd);
  let cfg: PukekoConfig;
  if (configPath) {
    cfg = configPath.endsWith('.json')
      ? readJsonConfig(configPath)
      : await importConfigModule(configPath);
  } else {
    cfg = FALLBACK_CONFIG;
  }

  const requested = process.env.PUKEKO_PROFILE ?? cfg.defaultProfile;
  const available = Object.keys(cfg.profiles);
  const profileName =
    requested && available.includes(requested) ? requested : available[0];
  if (!profileName) {
    throw new Error(`pukeko config at ${configPath} has no profiles defined.`);
  }
  if (requested && requested !== profileName) {
    console.warn(
      `[config] PUKEKO_PROFILE='${requested}' not found; falling back to '${profileName}'. Available: ${available.join(', ')}`
    );
  }

  const profile = applyEnvOverrides(cfg.profiles[profileName]);
  return { configPath, profileName, profile };
}

// Re-exported for tests.
export { FALLBACK_CONFIG, FALLBACK_PROFILE, CONFIG_FILENAMES };
export type { MiddlewareEntry };
