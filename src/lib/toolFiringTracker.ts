// EXT-6 Tool Belt "pulse briefly when their tool fires" — the piece that
// decides WHEN a client-fulfilled tool counts as "firing".
//
// Extracted out of App.vue (mirrors how RC-7 pulled RobotSession out of
// App.vue) so the actual fix here is independently unit-testable without
// mounting the whole app: wrap the REAL handler call, not a guess.
//
// Why this exists as its own module — the bug it fixes: the first cut of
// this feature watched vue-ui's exported `runState`/`statusText` singletons
// (chatService.ts) for every tool. That looked reasonable but was WRONG for
// client-fulfilled tools specifically: `chatService`'s run loop calls a
// client tool's handler *after* the SSE stream's RUN_FINISHED event, and
// `onRunFinishedEvent` sets `runState` back to `'idle'` right then — so by
// the time the handler (the robot fetch + webcam capture/compose) actually
// runs, `runState` has already left `'running-tool'`. The pulse silently
// never fired for the motion tools, the ones the brief calls out by name
// ("Move Forward, turn, back"). Caught in manual browser testing (see
// task-1-report.md), not by a test — hence this module + its test.
import { ref, type Ref } from 'vue'

export interface ToolFiringTracker {
  /** Name of the client-fulfilled tool whose handler is currently in
   *  flight, or null. Reactive — bind directly to a template/prop. */
  firingToolName: Ref<string | null>
  /**
   * Wrap a real client-tool handler so `firingToolName` is set for exactly
   * the span of its actual execution (from call to settle), not the SSE
   * announcement around it. Safe to call the same tool concurrently only in
   * the sense that the LATER call's clear won't stomp an EARLIER call's
   * still-in-flight name — see the `finally` guard below.
   */
  wrap<Args, Result>(
    name: string,
    handler: (args: Args) => Promise<Result>,
  ): (args: Args) => Promise<Result>
}

export function createToolFiringTracker(): ToolFiringTracker {
  const firingToolName = ref<string | null>(null)

  function wrap<Args, Result>(
    name: string,
    handler: (args: Args) => Promise<Result>,
  ): (args: Args) => Promise<Result> {
    return async (args: Args) => {
      firingToolName.value = name
      try {
        return await handler(args)
      } finally {
        // Only clear if nothing newer has claimed the slot (defensive; the
        // client tool loop runs at most one at a time in practice).
        if (firingToolName.value === name) firingToolName.value = null
      }
    }
  }

  return { firingToolName, wrap }
}
