// A tool-free variant of a chat model, for sub-calls that send NO `tools`.
//
// The agent's model is deliberately built with tool-only request params baked in
// as constructor fields (see server/createLlm.ts): the OpenAI-shaped providers
// take `parallel_tool_calls` / `tool_choice` via `modelKwargs`, Anthropic via
// `invocationKwargs.tool_choice`. Those are spread into *every* request the
// instance makes, and per-call options cannot remove them — `modelKwargs` is
// merged last, so `invoke(msgs, { tool_choice: undefined })` still sends the
// baked-in value.
//
// That is fatal for a summarization sub-call, which sends a transcript and no
// `tools` at all. OpenAI rejects both keys outright:
//   400 Invalid value for 'tool_choice': 'tool_choice' is only allowed when
//       'tools' are specified.
//   400 Invalid value for 'parallel_tool_calls': 'parallel_tool_calls' is only
//       allowed when 'tools' are specified.
// Both must go — removing only `tool_choice` just surfaces the second one.
//
// The rebuild goes through the model's own constructor and its `lc_kwargs` (the
// Serializable record of the fields it was constructed with) rather than poking
// at provider internals: `ChatOpenAI` delegates request-param assembly to
// internal sub-models that hold their own copy of `modelKwargs`, so mutating or
// shallow-cloning the outer instance has no effect on the request body.

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

// Request params that are only valid alongside a `tools` array.
//
// `tool_choice` and `parallel_tool_calls` are the two `server/createLlm.ts`
// actually bakes in, and the two measured to 400. `tools` is **defensive
// breadth**: no production path in this repo writes it into either kwargs bag
// today, so removing the entry changes nothing that ships — it is here because
// a bag that did carry one would be equally wrong on a call that sends none.
// It has its own unit test so the entry cannot quietly rot into decoration.
const TOOL_ONLY_REQUEST_KEYS: ReadonlySet<string> = new Set([
  'tool_choice',
  'tools',
  'parallel_tool_calls',
]);

interface SerializableLike {
  lc_kwargs?: Record<string, unknown>;
}

function withoutToolKeys(bag: unknown): {
  changed: boolean;
  value: Record<string, unknown>;
} {
  if (!bag || typeof bag !== 'object') return { changed: false, value: {} };
  let changed = false;
  const value: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(bag as Record<string, unknown>)) {
    if (TOOL_ONLY_REQUEST_KEYS.has(key)) {
      changed = true;
      continue;
    }
    value[key] = val;
  }
  return { changed, value };
}

// Returns a model equivalent to `llm` but with every tool-only request param
// removed, for use on calls that pass no tools. Returns the SAME instance when
// there is nothing to strip (the common case: Ollama, Google, and every test
// double), so callers can use it unconditionally. Never mutates `llm`.
//
// Falls back to the original instance if the model cannot be rebuilt — the
// caller's sub-call is already failure-tolerant, and degrading is better than
// throwing out of a middleware hook.
export function toolFreeModel<T extends BaseChatModel>(llm: T): T {
  const kwargs = (llm as unknown as SerializableLike | undefined)?.lc_kwargs;
  if (!kwargs || typeof kwargs !== 'object') return llm;

  const modelKwargs = withoutToolKeys(kwargs.modelKwargs);
  const invocationKwargs = withoutToolKeys(kwargs.invocationKwargs);
  if (!modelKwargs.changed && !invocationKwargs.changed) return llm;

  const fields: Record<string, unknown> = { ...kwargs };
  if (modelKwargs.changed) fields.modelKwargs = modelKwargs.value;
  if (invocationKwargs.changed) fields.invocationKwargs = invocationKwargs.value;

  try {
    const Ctor = (llm as unknown as object).constructor as new (fields: unknown) => T;
    return new Ctor(fields);
  } catch (err) {
    console.warn(
      '[tool-free-model] could not rebuild a tool-free model; tool-less sub-calls may be rejected:',
      err
    );
    return llm;
  }
}
