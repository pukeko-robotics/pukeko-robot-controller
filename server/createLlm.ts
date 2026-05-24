import { ChatAnthropic } from '@langchain/anthropic';
import { ChatOllama } from '@langchain/ollama';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { LlmProvider, LlmSpec } from '../src/lib/config.js';

export type { LlmProvider, LlmSpec };

export interface LlmSelection {
  provider: LlmProvider;
  llm: BaseChatModel;
}

export function createLlm(spec: LlmSpec): LlmSelection {
  if (spec.provider === 'ollama') {
    return {
      provider: 'ollama',
      llm: new ChatOllama({
        baseUrl: spec.baseUrl ?? 'http://localhost:11434',
        model: spec.model,
      }),
    };
  }

  if (spec.provider === 'anthropic') {
    return {
      provider: 'anthropic',
      // disable_parallel_tool_use: client-fulfilled tools (capture_image)
      // trigger langgraph interrupt(). When the model batches two tool calls
      // in one assistant message — e.g. read_status + capture_image — the
      // interrupt fires mid-batch and the message history ends up with one
      // tool_use that has no immediately-following tool_result, which
      // Anthropic rejects on the next turn.
      llm: new ChatAnthropic({
        model: spec.model,
        invocationKwargs: {
          tool_choice: { type: 'auto', disable_parallel_tool_use: true },
        },
      }),
    };
  }

  throw new Error(`Unknown LLM provider: ${spec.provider}. Expected 'ollama' or 'anthropic'.`);
}
