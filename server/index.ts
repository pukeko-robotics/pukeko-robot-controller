import { startAgUiServer } from '@gaunt-sloth/api';
import { DEFAULT_CONFIG, type GthConfig } from '@gaunt-sloth/core/config.js';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { captureImageTool } from '../src/agent/captureImageTool.js';
import { createFrontendImageInjectionMiddleware } from '../src/agent/frontendImageInjectionMiddleware.js';
import { createMotionSummarizationMiddleware } from '../src/agent/motionSummarizationMiddleware.js';
import { createObservabilityMiddleware } from './observabilityMiddleware.js';
import { createRobotTools } from '../src/agent/robotTools.js';
import { loadConfig } from './loadConfig.js';
import type { MiddlewareEntry, PukekoProfile } from '../src/lib/config.js';
import { createLlm } from './createLlm.js';

const PORT = 3000;
const DEFAULT_ROBOT_HOST = '192.168.4.1';

const { configPath, profileName, profile } = await loadConfig();
console.log(
  `[server] Loaded profile '${profileName}'${configPath ? ` from ${configPath}` : ' (fallback defaults — no config file found)'}.`
);

const robotHost = profile.robot?.host ?? DEFAULT_ROBOT_HOST;
const { provider, llm } = createLlm(profile.llm);
console.log(
  `[server] LLM: ${provider} / ${profile.llm.model}${profile.llm.baseUrl ? ` @ ${profile.llm.baseUrl}` : ''}; robot host: ${robotHost}`
);

function buildMiddleware(entries: MiddlewareEntry[] | undefined, llm: BaseChatModel, profile: PukekoProfile): unknown[] {
  const list = entries ?? ['frontend-images', 'motion-summary'];
  const built: unknown[] = [];
  const enabled: string[] = [];
  for (const entry of list) {
    if (typeof entry === 'string') {
      switch (entry) {
        case 'frontend-images':
          built.push(createFrontendImageInjectionMiddleware({ provider }));
          enabled.push(entry);
          break;
        case 'motion-summary':
          built.push(createMotionSummarizationMiddleware({ llm }));
          enabled.push(entry);
          break;
        case 'observability': {
          const obs = profile.observability;
          if (!obs?.verbose) {
            console.warn(
              `[server] middleware 'observability' listed but profile.observability.verbose is falsy — skipping.`
            );
            break;
          }
          built.push(
            createObservabilityMiddleware({
              dumpDir: obs.dumpDir ?? './logs',
              dumpImages: obs.dumpImages ?? true,
            })
          );
          enabled.push(entry);
          break;
        }
        default:
          console.warn(`[server] Unknown built-in middleware id: '${entry}' — skipped.`);
      }
    } else if (entry && typeof entry === 'object') {
      built.push(entry);
      enabled.push('<custom>');
    }
  }
  console.log(`[server] Middleware: ${enabled.join(', ') || '(none)'}`);
  return built;
}

const middleware = buildMiddleware(profile.middleware, llm, profile);

const config = {
  ...DEFAULT_CONFIG,
  llm,
  noDefaultPrompts: true,
  tools: [captureImageTool, ...createRobotTools(robotHost)],
  middleware,
  commands: {
    ...DEFAULT_CONFIG.commands,
    api: {
      ...DEFAULT_CONFIG.commands.api,
      filesystem: 'none',
      port: PORT,
      cors: {
        allowOrigin: 'http://localhost:5173',
        allowMethods: 'POST, GET, OPTIONS',
        allowHeaders: 'Content-Type, Accept',
      },
    },
  },
} as unknown as GthConfig;

await startAgUiServer(config, PORT);
