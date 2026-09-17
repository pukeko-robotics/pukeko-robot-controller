/**
 * @packageDocumentation
 * Robot's frontend-image-injection middleware: turns a `capture_image` or motion tool result
 * (`{mimeType,data}`) into a vision HumanMessage the model can actually see.
 *
 * SIBLING IMPLEMENTATION — read this before changing either one.
 * `@gaunt-sloth/agent/middleware/frontendImageInjectionMiddleware.js` carries the same
 * `capture_image` -> vision-block conversion; RC-22 promoted it out of this file. The two are
 * deliberately not merged, but they DO share the part that was drifting: the per-provider block
 * table `imageBlockFor` is imported from gaunt-sloth below rather than kept as a second copy here.
 * A per-provider fix therefore lands in gaunt-sloth once and reaches the robot on its next
 * `@gaunt-sloth/agent` bump, instead of having to be made twice by two people who do not know
 * about each other.
 *
 * Why the scan loop below is still robot-local, and NOT a wrapper around gth's factory (RC-23).
 * gth's `createFrontendImageInjectionMiddleware` cannot emit a motion frame under any setting:
 *   - its options are exactly `{ provider, toolName? }`, and `toolName` is ONE name — the four
 *     `MOTION_TOOL_NAMES` cannot be matched alongside `capture_image`;
 *   - both of its strings are hardcoded (`Camera frame captured:` / `Camera unavailable: …`),
 *     whereas a motion frame needs `Before/After frames for <motion>.` and `Motion (<tool>) failed`;
 *   - `payload.motion`, the human-facing label those strings interpolate, is not part of gth's
 *     envelope model at all.
 * So this scan loop has to exist whatever we do. Wrapping would mean running gth's hook for
 * `capture_image` and this loop for the motion tools: it removes no code, it adds a chained call
 * plus the `beforeModel`-is-a-function-or-`{hook}` unwrapping that even our own tests need a helper
 * for, and it splits one chronological scan into two category-grouped passes — which changes which
 * frame the context-pruner's "keep the latest N image HumanMessages" step retains when a capture
 * and a motion result are pending together. The seam actually worth sharing was `imageBlockFor`.
 *
 * A change to the capture path in either file should be made in the other.
 */
import { createMiddleware } from 'langchain';
import { HumanMessage, isToolMessage } from '@langchain/core/messages';
import type { MessageContent } from '@langchain/core/messages';
import { imageBlockFor } from '@gaunt-sloth/agent/middleware/frontendImageInjectionMiddleware.js';
import { MOTION_TOOL_NAMES } from './robotToolNames.js';
import type { LlmProvider } from "../lib/config.js";

interface ImagePayload {
  mimeType?: string;
  data?: string;
  error?: string;
  // Optional human-facing motion label, e.g. "move_forward (steps=2)".
  motion?: string;
}

const MOTION_NAMES: ReadonlySet<string> = new Set(MOTION_TOOL_NAMES);

// thread_id → set of tool_call_ids whose image has already been injected.
// The motion-summarization middleware keeps the latest motion's ToolMessage in
// its retained tail, so without this guard that ToolMessage would be seen again
// on the next turn and its image re-injected — appended *after* the newest
// motion's image, mispairing the current assistant message with a stale frame
// (e.g. a move_forward turn showing the previous turn_right image).
const injectedByThread = new Map<string, Set<string>>();

export interface ImageInjectionOptions {
  // Providers disagree on the vision-block shape they can decode. The mapping and
  // the evidence behind it live in gaunt-sloth's `imageBlockFor` (imported above);
  // each of robot's five `LlmProvider` values is covered there. Two notes on the
  // ones that differ from a naive reading of that table:
  //   - anthropic gets the provider-NATIVE block {type:'image', source:{type:'base64',
  //     media_type, data}}, not the LangChain standard `source_type` one. Measured
  //     against the installed @langchain/anthropic 1.5.10: `_formatContentBlocks`
  //     converts a standard block and then FALLS THROUGH (no `continue`) into its own
  //     `type === 'image'` branch, which reads `media_type` from camelCase `mimeType` —
  //     a key the snake_case standard block never has — and defaults it to the literal
  //     `image/jpeg`. So a standard block yields TWO image blocks, the second
  //     mislabelled; the native block yields exactly one, correctly labelled.
  //   - robot's `'google'` has no explicit case in gth's switch and rides its `default`
  //     branch, which is the same standard base64 block robot has always emitted for
  //     google. Identical output today — but gth naming its google providers
  //     `google-genai`/`vertexai` means a future explicit `case 'google'` there would
  //     change robot silently. `rc21VisionBlockShape.test.ts` pins the shape.
  provider: LlmProvider;
}

export function createFrontendImageInjectionMiddleware(opts: ImageInjectionOptions) {
  return createMiddleware({
    name: 'frontend-image-injection',

    beforeModel: async (state, runtime) => {
      const messages = state.messages || [];
      const threadId = runtime?.configurable?.thread_id ?? '__default__';
      let injectedIds = injectedByThread.get(threadId);
      if (!injectedIds) {
        injectedIds = new Set<string>();
        injectedByThread.set(threadId, injectedIds);
      }

      // Each entry pairs the parsed envelope with the originating tool name so
      // we can prepend a motion label when relevant. Scan forward so injected
      // frames stay in chronological order, and skip any tool_call_id we've
      // already injected (idempotent across the summarizer's retained tail).
      const injected: Array<{ payload: ImagePayload; toolName: string; id: string }> = [];

      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (
          // RC-21 (golden fix): a capture ToolMessage does not always answer to
          // the `ToolMessage` class WE import. `msg instanceof ToolMessage`
          // silently returned false on the real server and no frame was ever
          // injected (the pruner's duck-typed `isToolMessage` saw it fine, hence
          // tool-data:1 / human-images:0 in the dumps) — measured when the robot
          // resolved two @langchain/core copies, which it no longer does. The
          // class check is unreliable here regardless: core answers `instanceof`
          // through a duck test keyed on `Symbol.for('langchain.message')`, so a
          // result rebuilt from the wire without that marker fails it just the
          // same. Use the duck-typed guard the pruner uses.
          isToolMessage(msg) &&
          typeof msg.content === 'string' &&
          (msg.name === 'capture_image' || (msg.name && MOTION_NAMES.has(msg.name)))
        ) {
          const id = msg.tool_call_id;
          if (!id || injectedIds.has(id)) continue;
          try {
            injected.push({
              payload: JSON.parse(msg.content) as ImagePayload,
              toolName: msg.name,
              id,
            });
          } catch {
            // Non-JSON tool result — skip injection.
          }
        }
      }

      if (injected.length === 0) return undefined;

      const newMessages = [...messages];
      for (const { payload, toolName, id } of injected) {
        if (payload.error) {
          // Mark injected so the error note isn't re-emitted on a later turn.
          injectedIds.add(id);
          const label = MOTION_NAMES.has(toolName) ? `Motion (${toolName}) failed` : 'Camera unavailable';
          newMessages.push(new HumanMessage({ content: `${label}: ${payload.error}` }));
          continue;
        }
        if (payload.mimeType && payload.data) {
          // RC-21: mark the tool_call_id as injected ONLY when we actually emit a
          // frame. The original code marked up-front, so a capture ToolMessage
          // that arrived WITHOUT its base64 `data` (dropped upstream — e.g. a
          // pruned/replayed history) both injected nothing AND poisoned the
          // guard, permanently blocking that frame even if the data-bearing
          // result showed up on a later turn. Marking on successful injection
          // keeps the "never re-inject a retained frame" idempotency (a real
          // frame always has data) while letting a later data-bearing sighting
          // recover. (Within this process the context-pruner strips `data` only
          // AFTER this middleware runs, so a data-less sighting means the bytes
          // were absent before FI ever saw them — the RC-21 upstream case.)
          injectedIds.add(id);
          const block = imageBlockFor(opts.provider, payload.mimeType, payload.data);

          const isMotion = MOTION_NAMES.has(toolName);
          const headerText = isMotion
            ? `Before/After frames for ${payload.motion ?? toolName}.`
            : 'Camera frame captured:';

          newMessages.push(
            new HumanMessage({
              content: [
                { type: 'text', text: headerText },
                block,
              ] as MessageContent,
            })
          );
        }
        // else: a capture/motion tool result whose `data` is absent — inject
        // nothing and leave the guard clean so a later data-bearing result for
        // the same tool_call_id can still be injected.
      }

      return { messages: newMessages };
    },
  });
}
