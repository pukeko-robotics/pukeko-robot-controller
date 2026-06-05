import { createMiddleware } from 'langchain';
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  isAIMessage,
  type BaseMessage,
} from '@langchain/core/messages';

// ────────────────────────────────────────────────────────────────────────────
// Lazy-tool-recovery middleware
//
// Small local models (Gemma, Gemini in the same family) routinely *narrate* a
// tool they are about to use — "`read_distance` to check current range before
// moving." — and then end the turn WITHOUT emitting the tool call. The agent's
// react loop sees no tool call and routes to END, so the run finishes and the
// robot just sits there until the user pokes it ("so", "continue").
//
// This middleware wraps the model call. When a reply carries no tool call, it
// runs a cheap *isolated* classifier call (detached from the run's streaming
// callbacks) asking whether the model meant to invoke a tool it forgot to call.
// If so, it re-invokes the model **through the framework `handler`** with a
// nudge — going through `handler` (not a hand-built AIMessage) is what makes the
// recovered tool call stream as real TOOL_CALL_* events, which the client's
// run loop needs to fulfil the interrupt-based robot tools.
//
// Output truncation (`done_reason: 'length'` from Ollama) is a different beast —
// the model was cut off mid-output, not lazy — so we surface it and leave the
// turn alone rather than re-prompting into a half-finished thought.
// ────────────────────────────────────────────────────────────────────────────

export interface LazyToolRecoveryOptions {
  // How many recovery re-prompts to attempt within a single model-node call.
  // Each costs one classifier round-trip plus one model round-trip. Default 1.
  maxRecoveries?: number;
  // Skip the classifier and assume laziness whenever a no-tool reply mentions a
  // known tool name by name. Cheaper (no extra model call) but blunter — it will
  // re-prompt on a reply that merely refers to a tool while reporting to the
  // user. Default false.
  skipClassifier?: boolean;
  // Harshest mode: re-prompt on ANY no-tool reply, even one that doesn't mention
  // a tool and even an empty one. This is the Ollama-path equivalent of forcing
  // tool_choice (which ChatOllama can't do) — it leans on `finish_task` as the
  // always-available "I'm done" tool, so "no tool call" is never a valid way to
  // end. Implies skipClassifier (no classifier round-trip). Truncation
  // (done_reason: 'length') is still left alone. Default false.
  force?: boolean;
}

// Loosely-typed view of the bits of ModelRequest we touch. The langchain
// middleware request/handler generics are heavy; we only need messages, model,
// tools, and the ability to re-run the call.
interface ModelLike {
  invoke: (messages: BaseMessage[], options?: Record<string, unknown>) => Promise<BaseMessage>;
}
interface ModelRequestLike {
  model: ModelLike;
  messages: BaseMessage[];
  tools?: Array<{ name?: string }>;
}

function hasToolCalls(msg: BaseMessage): boolean {
  return (
    isAIMessage(msg) &&
    Array.isArray((msg as AIMessage).tool_calls) &&
    ((msg as AIMessage).tool_calls?.length ?? 0) > 0
  );
}

interface MaybeBlock {
  type?: string;
  text?: string;
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

// First known tool name that appears (case-insensitive substring) in `s`.
function findToolName(s: string, toolNames: string[]): string | undefined {
  const lower = s.toLowerCase();
  for (const n of toolNames) {
    if (lower.includes(n.toLowerCase())) return n;
  }
  return undefined;
}

const CLASSIFIER_SYSTEM = (toolNames: string[]) =>
  'You audit a robot-control assistant for one specific mistake: announcing or describing a ' +
  'tool action in prose but forgetting to actually invoke the tool. ' +
  `The tools it can call are: ${toolNames.join(', ')}. ` +
  "Given the assistant's latest message, decide whether it intended to perform a tool action " +
  'RIGHT NOW that it did NOT actually call. A message that reports results to the user, asks the ' +
  'user a question, or states the task is complete is NOT this mistake. ' +
  'Answer with exactly YES or NO on the first line. If YES, put the single tool name on the second line.';

interface Verdict {
  intended: boolean;
  tool?: string;
}

async function classifyIntendedTool(
  model: ModelLike,
  text: string,
  toolNames: string[]
): Promise<Verdict> {
  let out = '';
  try {
    const res = await model.invoke(
      [
        new SystemMessage(CLASSIFIER_SYSTEM(toolNames)),
        new HumanMessage(`Assistant message:\n"""\n${text}\n"""`),
      ],
      // callbacks: [] detaches this probe from the main run's streaming
      // controller so its tokens are never emitted to the client (same trick
      // the summarizer middlewares use).
      { callbacks: [], tags: ['lazy-tool-classifier'] }
    );
    out = extractText(res.content);
  } catch (e) {
    console.warn('[lazy-tool-recovery] classifier call failed; treating as not-lazy:', e);
    return { intended: false };
  }
  if (!/^\s*yes\b/i.test(out)) return { intended: false };
  const tool = findToolName(out, toolNames) ?? findToolName(text, toolNames);
  return { intended: true, tool };
}

export function createLazyToolRecoveryMiddleware(opts: LazyToolRecoveryOptions = {}) {
  const force = opts.force ?? false;
  // force is harsher, so it gets a couple of attempts by default; callers can
  // still override. force also implies skipping the classifier — in force mode
  // we re-prompt on any no-tool reply, so there's nothing for it to gate.
  const maxRecoveries = Math.max(0, opts.maxRecoveries ?? (force ? 2 : 1));
  const skipClassifier = force || (opts.skipClassifier ?? false);

  return createMiddleware({
    name: 'lazy-tool-recovery',

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wrapModelCall: async (request: any, handler: any) => {
      const req = request as ModelRequestLike;
      let result = (await handler(request)) as AIMessage;
      let messages = req.messages;

      for (let attempt = 0; attempt < maxRecoveries; attempt++) {
        if (hasToolCalls(result)) return result; // model called a tool — nothing to do.

        const text = extractText(result.content).trim();
        const doneReason = (result.response_metadata as Record<string, unknown> | undefined)
          ?.done_reason;

        // Truncation, not laziness — the model ran into its output cap mid-thought.
        // Respected even in force mode: re-prompting a cut-off thought is wrong.
        if (doneReason === 'length') {
          console.warn(
            '[lazy-tool-recovery] model output truncated (done_reason=length); ' +
              'not a laziness stop — leaving the turn as-is.'
          );
          return result;
        }

        // Harshest mode: any no-tool reply (even empty, even one that names no
        // tool) is recovered. The model must call SOME tool every turn — a real
        // action, or finish_task to end. No mention/classifier gates.
        if (force) {
          console.warn(
            `[lazy-tool-recovery] no tool call (force mode); ` +
              `re-prompting (attempt ${attempt + 1}/${maxRecoveries}).`
          );
          const nudge = new HumanMessage(
            'You ended your turn without calling a tool. You must call exactly one tool ' +
              'every turn: perform the next action, or call `finish_task` to end the task ' +
              '(status success / failed / need_input). Emit the tool call now — do not reply ' +
              'with prose only.'
          );
          messages = [...messages, result, nudge];
          result = (await handler({ ...request, messages })) as AIMessage;
          continue;
        }

        if (!text) return result; // empty + no tool call — genuinely nothing.

        const toolNames = (req.tools ?? [])
          .map((t) => t?.name)
          .filter((n): n is string => typeof n === 'string' && n.length > 0);
        if (toolNames.length === 0) return result;

        // Cheap gate: a reply that doesn't even mention a tool by name is almost
        // certainly a genuine user-facing answer — skip the classifier round-trip.
        const mentioned = findToolName(text, toolNames);
        if (!mentioned) return result;

        const verdict = skipClassifier
          ? { intended: true, tool: mentioned }
          : await classifyIntendedTool(req.model, text, toolNames);
        if (!verdict.intended) return result;

        const tool = verdict.tool ?? mentioned;
        console.warn(
          `[lazy-tool-recovery] assistant described "${tool}" without calling it; ` +
            `re-prompting (attempt ${attempt + 1}/${maxRecoveries}).`
        );

        const nudge = new HumanMessage(
          `You described the \`${tool}\` action but did not actually call the tool. ` +
            'Invoke the tool now with appropriate arguments. Do not explain — emit the tool call.'
        );
        // Re-run through the framework handler so the recovered tool call streams
        // as real TOOL_CALL_* events. The nudge feeds only this model call; it is
        // not persisted to graph state (only the returned message is).
        messages = [...messages, result, nudge];
        result = (await handler({ ...request, messages })) as AIMessage;
      }

      return result;
    },
  });
}
