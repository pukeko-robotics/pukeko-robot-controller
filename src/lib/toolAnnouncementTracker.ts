// EXT-6 Tool Belt, server-fulfilled half — the headless (PLAT-13) replacement
// for the bespoke `runState`/`statusText` fallback ToolBelt.vue used to read
// straight from vue-ui's chatService singletons.
//
// The browser has no handler for the server-fulfilled tools (stop /
// read_distance / read_status / finish_task), so — exactly as on the bespoke
// path — the only real signal it has for them is the SSE announcement window
// in the AG-UI event stream. The bespoke chatService flipped
// `runState = 'running-tool'` / `statusText = 'Running <name>…'` on
// TOOL_CALL_START and left that state until the next lifecycle event
// (TOOL_CALL_RESULT → 'waiting', TEXT_MESSAGE_START → 'streaming',
// RUN_FINISHED/stop → 'idle'). This tracker reproduces that exact window from
// the same events, but sourced via `AbstractAgent.subscribe()` on the
// CopilotKit-managed `HttpAgent` — no chatService involved. App.vue subscribes
// it to the live agent and passes `announcedToolName` down as ToolBelt's
// `announcedTool` prop.
//
// For CLIENT-fulfilled tools the announcement window also opens (their calls
// stream through the same events), but the precise handler-span signal
// (toolFiringTracker.ts) remains the authoritative pulse for those — ToolBelt
// ORs the two, exactly as it OR'd firingTool with the runState fallback.
import { ref, type Ref } from 'vue'

// The structural subset of @ag-ui/client's AgentSubscriber this tracker
// implements. Kept structural (not `implements AgentSubscriber`) so the module
// — like toolFiringTracker.ts — stays unit-testable without constructing real
// AG-UI event objects; `AbstractAgent.subscribe` accepts it as-is.
export interface ToolAnnouncementSubscriber {
  onToolCallStartEvent(params: { event: { toolCallName: string } }): void
  onToolCallResultEvent(): void
  onTextMessageStartEvent(): void
  onRunFinishedEvent(): void
  onRunFailed(): void
  onRunFinalized(): void
}

export interface ToolAnnouncementTracker {
  /** Name of the tool currently inside its SSE announcement window
   *  (TOOL_CALL_START → next lifecycle event), or null. Reactive. */
  announcedToolName: Ref<string | null>
  /** Hand to `AbstractAgent.subscribe()`. */
  subscriber: ToolAnnouncementSubscriber
}

export function createToolAnnouncementTracker(): ToolAnnouncementTracker {
  const announcedToolName = ref<string | null>(null)

  const clear = () => {
    announcedToolName.value = null
  }

  return {
    announcedToolName,
    subscriber: {
      onToolCallStartEvent({ event }) {
        announcedToolName.value = event.toolCallName
      },
      // The same transitions that ended the bespoke 'running-tool' state:
      onToolCallResultEvent: clear, // result arrived → back to 'waiting'
      onTextMessageStartEvent: clear, // model is talking again → 'streaming'
      onRunFinishedEvent: clear, // run over (incl. the client-tool interrupt)
      onRunFailed: clear,
      onRunFinalized: clear,
    },
  }
}
