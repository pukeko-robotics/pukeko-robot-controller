import { ChatAnthropic } from '@langchain/anthropic';
import { ChatOllama } from '@langchain/ollama';
import { ChatOpenAI } from '@langchain/openai';
import { ChatOpenRouter } from '@langchain/openrouter';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { LlmProvider, LlmSpec } from '../src/lib/config.js';

// Client-fulfilled tools (capture_image, motions) trigger a langgraph
// interrupt(). When the model batches several tool calls into one assistant
// message, the interrupt fires mid-batch and the history ends up with a
// tool_use that has no immediately-following tool_result — which the
// tool-calling providers reject on the next turn. Disabling parallel tool
// use keeps it to one tool call per assistant turn. (Anthropic exposes this
// via invocationKwargs.tool_choice; the OpenAI-shaped providers take it as a
// request-body param via modelKwargs.)
//
// We also FORCE a tool call every turn (tool_choice "required"/"any"). The loop
// always ends through the `finish_task` tool, so the model never needs to
// terminate by emitting a no-tool reply — forcing a tool makes the
// "narrate-but-don't-call" stall structurally impossible. NOTE: ChatOllama does
// NOT support tool_choice (`tool_choice?: never`), so the Ollama/Gemma path
// can't be forced — that path still relies on lazy-tool-recovery as the net.
const NO_PARALLEL_TOOLS = { parallel_tool_calls: false, tool_choice: 'required' } as const;

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
      // See NO_PARALLEL_TOOLS — Anthropic spells both controls on tool_choice:
      // type "any" forces a tool every turn; disable_parallel_tool_use keeps it
      // to one call.
      llm: new ChatAnthropic({
        model: spec.model,
        invocationKwargs: {
          tool_choice: { type: 'any', disable_parallel_tool_use: true },
        },
      }),
    };
  }

  if (spec.provider === 'openai') {
    return {
      provider: 'openai',
      // apiKey falls back to OPENAI_API_KEY; baseUrl (if set) lets users point
      // at an OpenAI-compatible endpoint.
      llm: new ChatOpenAI({
        model: spec.model,
        modelKwargs: NO_PARALLEL_TOOLS,
        ...(spec.baseUrl ? { configuration: { baseURL: spec.baseUrl } } : {}),
      }),
    };
  }

  if (spec.provider === 'openrouter') {
    return {
      provider: 'openrouter',
      // apiKey falls back to OPENROUTER_API_KEY; baseUrl overrides the default
      // https://openrouter.ai/api/v1.
      llm: new ChatOpenRouter({
        model: spec.model,
        modelKwargs: NO_PARALLEL_TOOLS,
        ...(spec.baseUrl ? { baseURL: spec.baseUrl } : {}),
      }),
    };
  }

  throw new Error(
    `Unknown LLM provider: ${spec.provider}. Expected 'ollama', 'anthropic', 'openai', or 'openrouter'.`
  );
}
