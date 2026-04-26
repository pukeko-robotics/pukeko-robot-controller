import { ChatAnthropic } from '@langchain/anthropic';
import { startAgUiServer } from '@gaunt-sloth/api';
import { DEFAULT_CONFIG, type GthConfig } from '@gaunt-sloth/core/config.js';
import { captureImageTool } from '../src/agent/captureImageTool.js';
import { frontendImageInjectionMiddleware } from '../src/agent/frontendImageInjectionMiddleware.js';
import { createRobotTools } from '../src/agent/robotTools.js';

const ROBOT_HOST = process.env.ROBOT_HOST ?? '192.168.4.1';
const PORT = 3000;

// disable_parallel_tool_use: client-fulfilled tools (capture_image) trigger
// langgraph interrupt(). When the model batches two tool calls in one
// assistant message — e.g. read_status + capture_image — the interrupt
// fires mid-batch and the message history ends up with one tool_use that
// has no immediately-following tool_result, which Anthropic rejects on the
// next turn ("tool_use ids were found without tool_result blocks
// immediately after"). Forcing one tool call per turn sidesteps this.
const llm = new ChatAnthropic({
  model: 'claude-sonnet-4-6',
  invocationKwargs: {
    tool_choice: { type: 'auto', disable_parallel_tool_use: true },
  },
});

const config = {
  ...DEFAULT_CONFIG,
  llm,
  noDefaultPrompts: true,
  tools: [captureImageTool, ...createRobotTools(ROBOT_HOST)],
  middleware: [frontendImageInjectionMiddleware],
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
