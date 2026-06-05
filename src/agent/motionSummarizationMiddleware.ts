import { createMiddleware } from 'langchain';
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  RemoveMessage,
  isAIMessage,
  isHumanMessage,
  isToolMessage,
  isSystemMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { REMOVE_ALL_MESSAGES } from '@langchain/langgraph';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import {
  formatPinnedState,
  isMotionToolCall,
  observeAssistantMessage,
  __motionLogForTest,
} from './motionLog.js';

// thread_id → in-flight summary Promise. afterModel kicks off the summary call
// the moment the assistant decides to move; beforeModel on the next turn awaits
// the same Promise and rewrites the message history. The two hooks straddle
// the slow browser round-trip (capture → move → capture → compose), giving the
// summarization wall-clock parallelism with the motion itself.
const pendingSummaries = new Map<string, Promise<string>>();

// Baked-in fallback. Kept identical to `summarization-prompt.md` at the repo
// root, which the server loads and passes in via `summaryPrompt`. This copy is
// used only when that file is missing.
const DEFAULT_SUMMARY_PROMPT = `You are compressing a robot-control conversation log so a small local model can stay on task. The summary REPLACES the detailed history, so capture the operator's understanding so far — conclusions, not a play-by-play.

Cover, in a few terse sentences:
- The user's objective (verbatim if short).
- What has been learned about the controls in this camera view: which on-screen direction each turn produces (and whether turn_left/turn_right are inverted here), which end is the robot's face, and the rough movement scale.
- Where the robot currently is and which way it is facing relative to the target, and the intended next move.
- Open questions, obstacles, or sensor caveats (e.g. a flat or thin target the ultrasonic can't see).

Rules:
- Write conclusions and current state, NOT a list of the commands issued — recent moves are tracked separately and appended for you.
- Do NOT describe raw image content ("the photo shows..."), and do NOT include base64 data or image URLs.
- Plain text, terse, present tense.`;

interface MaybeBlock {
  type?: string;
  text?: string;
}

function stripImageBlocks(msg: BaseMessage): BaseMessage {
  if (typeof msg.content === 'string') return msg;
  if (!Array.isArray(msg.content)) return msg;
  const original = msg.content as MaybeBlock[];
  const textOnly = original.filter(
    (b) => b && b.type !== 'image' && b.type !== 'image_url'
  );
  if (textOnly.length === original.length) return msg;
  const newContent = (textOnly.length === 0 ? '[image omitted]' : textOnly) as unknown as BaseMessage['content'];
  if (isAIMessage(msg)) {
    return new AIMessage({ content: newContent, tool_calls: (msg as AIMessage).tool_calls, name: msg.name });
  }
  if (isHumanMessage(msg)) {
    return new HumanMessage({ content: newContent, name: msg.name });
  }
  if (isToolMessage(msg)) {
    return new ToolMessage({
      content: typeof newContent === 'string' ? newContent : JSON.stringify(newContent),
      tool_call_id: (msg as ToolMessage).tool_call_id,
      name: msg.name,
    });
  }
  if (isSystemMessage(msg)) {
    return new SystemMessage({ content: newContent, name: msg.name });
  }
  return msg;
}

function extractText(content: BaseMessage['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as MaybeBlock[])
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join(' ')
    .trim();
}

export interface MotionSummarizationOptions {
  llm: BaseChatModel;
  // Override for the summarization system prompt. Falls back to
  // DEFAULT_SUMMARY_PROMPT when omitted.
  summaryPrompt?: string;
}

export function createMotionSummarizationMiddleware(opts: MotionSummarizationOptions) {
  const summaryPrompt = opts.summaryPrompt ?? DEFAULT_SUMMARY_PROMPT;
  return createMiddleware({
    name: 'motion-summarization',

    afterModel: async (state, runtime) => {
      const messages = (state.messages || []) as BaseMessage[];
      if (messages.length === 0) return undefined;
      const last = messages[messages.length - 1];

      const threadId = runtime?.configurable?.thread_id ?? '__default__';
      // Durable per-thread bookkeeping (recent-motion log, give-up gate, pinned
      // calibration) — every assistant turn, even when a summary is already in
      // flight (the guard below only skips the expensive LLM call).
      observeAssistantMessage(threadId, last);

      // Summarization only fires after a motion: its slow browser round-trip is
      // the wall-clock cover for the summary call.
      if (!isMotionToolCall(last)) return undefined;
      if (pendingSummaries.has(threadId)) return undefined;

      const sanitized = messages.map(stripImageBlocks);

      const promise = (async () => {
        try {
          // Detach from the main agent's run config — otherwise tokens
          // streamed by this parallel call hit the now-closed StreamMessages
          // controller for the original turn and spam ERR_INVALID_STATE.
          const result = await opts.llm.invoke(
            [
              new SystemMessage(summaryPrompt),
              ...sanitized,
              new HumanMessage('Write the summary now.'),
            ],
            { callbacks: [], tags: ['motion-summarization'] }
          );
          return extractText(result.content);
        } catch (err) {
          console.error('[motion-summarization] LLM call failed:', err);
          return '';
        }
      })();
      pendingSummaries.set(threadId, promise);
      console.log(`[motion-summarization] kicked off (thread=${threadId}, history=${messages.length})`);
      return undefined;
    },

    beforeModel: async (state, runtime) => {
      const threadId = runtime?.configurable?.thread_id ?? '__default__';
      const pending = pendingSummaries.get(threadId);
      if (!pending) return undefined;
      const summary = await pending;
      pendingSummaries.delete(threadId);
      if (!summary) return undefined;

      const messages = (state.messages || []) as BaseMessage[];
      const firstHumanIdx = messages.findIndex((m) => isHumanMessage(m));
      let lastMotionIdx = -1;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (isMotionToolCall(messages[i])) {
          lastMotionIdx = i;
          break;
        }
      }
      if (firstHumanIdx < 0 || lastMotionIdx < 0 || lastMotionIdx <= firstHumanIdx + 1) {
        return undefined;
      }

      const head = messages.slice(0, firstHumanIdx + 1);
      const tail = messages.slice(lastMotionIdx);
      const pinned = formatPinnedState(threadId);
      const summaryBody = pinned
        ? `Summary of prior steps:\n${summary}\n\n${pinned}`
        : `Summary of prior steps:\n${summary}`;
      const replaced: BaseMessage[] = [
        ...head,
        new SystemMessage(summaryBody),
        ...tail,
      ];

      console.log(
        `[motion-summarization] applied (thread=${threadId}, ${messages.length} → ${replaced.length} messages, ${summary.length} chars)`
      );
      return {
        messages: [new RemoveMessage({ id: REMOVE_ALL_MESSAGES }), ...replaced],
      };
    },
  });
}

// Exposed for tests; do not call from app code. The motion log itself now lives
// in ./motionLog — re-exported here so existing tests keep their import path.
export const __pendingSummariesForTest = pendingSummaries;
export { __motionLogForTest };
