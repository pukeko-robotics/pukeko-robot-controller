# Webcam → Vision via `capture_image` Tool

## Context

The robot controller has a webcam feed and a chat to a vision-capable agent (`claude-sonnet-4-5` via gaunt-sloth). Goal: let the agent **iteratively perceive** — issue a movement, then *decide on its own* to call a `capture_image` tool, look at the result, and repeat. Auto-attaching every frame is wrong because (a) the agent shouldn't always pay vision tokens, and (b) iterative tasks need on-demand perception, not synchronous human attachments.

Planned shape: `capture_image` is a **frontend-fulfilled tool** suspended via LangGraph `interrupt()` and resumed via `Command({ resume })` carried over AG-UI's `forwardedProps.command` convention. The browser captures a frame on resume, the resume value flows in as the tool's return → becomes a `ToolMessage`, and a server middleware translates it to a `HumanMessage` with multimodal blocks before the next model invocation.

History bloat from accumulated frames is acknowledged but **out of scope** — the user has signalled custom compaction (collapsing past frames, leaving the latest) is a separate future track.

### Repos under our control (all checked out under `_refs/`)

1. `pukeko-robot-controller` — this app
2. `_refs/gaunt-sloth-assistant` — agent server (AG-UI)
3. `_refs/galvanized-pukeko-ai-ui` — vue-ui (`ChatInterface`, `chatService`)
4. `_refs/ag-ui` — AG-UI protocol (TS SDK at `sdks/typescript/`). Reference only — no fork needed for v1.
5. `_refs/langchainjs` — LangChain JS. Reference only — no fork needed for v1; the existing `binaryContentInjectionMiddleware` already proves the LangChain Anthropic image-block shape works end-to-end.

### Findings from exploration

- **AG-UI resume convention** is `forwardedProps.command = { resume: <value>, interruptEvent: { toolCallId, runId, … } }` (per CopilotKit/Mastra; see `_refs/ag-ui/integrations/mastra/typescript/src/mastra.ts:100-160`). `RunAgentParameters` (the input to `HttpAgent.runAgent`) carries `forwardedProps` through to `RunAgentInput.forwardedProps` at `_refs/ag-ui/sdks/typescript/packages/client/src/agent/agent.ts:378`.
- **LangGraph JS** ships `interrupt()` and `Command` (`node_modules/@langchain/langgraph/dist/interrupt.d.ts`). `interrupt(value)` pauses the graph (throws `GraphInterrupt` internally), persisting state via the checkpointer; resume by invoking the graph with `new Command({ resume })`. The `interrupt(...)` expression then returns the resume value to the calling node.
- **gaunt-sloth `GthLangChainAgent`** at `_refs/gaunt-sloth-assistant/packages/core/src/core/GthLangChainAgent.ts` runs all tools server-side via `createAgent` from `langchain` (line 136). `streamWithEvents` (line 333) yields tool events as the agent streams; there's no API yet for resuming a paused graph with a `Command`. We must add one.
- **Checkpointing.** `apiAgUiModule.ts:85-87` already creates a `MemorySaver` and passes a `thread_id` from the AG-UI `threadId` (line 125). That suffices for resume on the same process.
- **AG-UI `ToolMessage.content`** is `string` only (`_refs/ag-ui/sdks/typescript/packages/core/src/types.ts:138-145`). LangChain JS `ToolMessage.content` likewise lacks robust multimodal-block support across providers. The image must travel as a **string** (a JSON envelope), and a server middleware translates that into a `HumanMessage` with image blocks before the next model call.

## End-to-end flow

1. **Client declares the tool.** `chatService.sendMessage` includes `capture_image` (no parameters) in its outbound `RunAgentInput.tools`.
2. **Agent decides to call it.** Model emits `tool_calls: [{ name: 'capture_image', args: {} }]`. LangGraph routes to the tool node.
3. **Server suspends via `interrupt`.** The server-registered `capture_image` is a stub whose body is `return await interrupt({ name: 'capture_image', toolCallId })`. LangGraph throws `GraphInterrupt`; `streamWithEvents` emits `tool_start` / `tool_args` / `tool_end` for the call, **does not emit `tool_result`**, and the run finishes (`RUN_FINISHED`) with the tool call hanging. State is persisted in `MemorySaver` keyed by `threadId`.
4. **Client fulfills.** Browser sees `TOOL_CALL_END` for `capture_image`, captures a frame from `WebcamPanel.captureFrame()`, parses the dataURL, builds a JSON envelope `{ mimeType, data }` (or an error envelope `{ error: '…' }`), and submits a new run carrying:
   ```ts
   forwardedProps: { command: { resume: <envelope-string>, interruptEvent: { toolCallId, runId } } }
   ```
   No new `messages` are appended — same `threadId`, no `messages` mutation; the resume command is the entire payload.
5. **Server resumes.** `apiAgUiModule.ts` reads `forwardedProps.command`. If `resume` is present, it invokes the agent with `new Command({ resume })` instead of feeding messages. LangGraph wakes the paused tool node; `interrupt(...)` returns the resume value, the tool's body returns it, LangGraph wraps it in a `ToolMessage` keyed to the original `toolCallId`.
6. **Image injection middleware.** `frontendImageInjectionMiddleware.beforeModel` detects a fresh `ToolMessage` whose name is `capture_image` and whose content parses as `{ mimeType, data }`. It appends a `HumanMessage` with `[ {type:'text',text:'Camera frame:'}, {type:'image',source_type:'base64',mime_type,data} ]`. (Error envelopes pass through with a text-only "camera unavailable" `HumanMessage`.)
7. **Model sees the image.** The next model call receives the image as a content block. Anthropic vision answers; agent continues iteratively.

## Plan

### 1. Server (gaunt-sloth)

**A. Register `capture_image` as an interrupt-suspended tool.**
Prefer static declaration in `.gsloth.config.json` with metadata `{ client: true }` and the `pukeko-robot-controller`'s config opts in.

**File:** `_refs/gaunt-sloth-assistant/packages/core/src/core/GthLangChainAgent.ts`
- At tool-flattening (line 78, `extractAndFlattenTools`) detect tools tagged `client: true` in their metadata and replace their `func` with a stub that calls `interrupt({ name: <toolName>, toolCallId })` from `@langchain/langgraph`. 
- Maintain a `clientToolNames: Set<string>` on the agent for diagnostic logging.
- In `streamWithEvents` (line 333) — when the underlying `agent.streamEvents` surfaces a `GraphInterrupt` chunk end the iterator gracefully.
- **Add a resume entry point.** New method `streamWithEventsResume(resumeValue: unknown, runConfig)` that invokes the underlying LangGraph agent via `this.agent!.streamEvents(new Command({ resume: resumeValue }), runConfig, …)` and emits the same event stream as `streamWithEvents`.

**File:** `_refs/gaunt-sloth-assistant/packages/api/src/modules/apiAgUiModule.ts`
- Lift `express.json` body limit (line 60): `express.json({ limit: '5mb' })`.
- Read `forwardedProps` from `req.body` (line 93). If `forwardedProps?.command?.resume !== undefined`:
  - Skip `convertMessage` mapping.
  - Skip the `buildSystemMessages` prepend.
  - Call `agent.streamWithEventsResume(forwardedProps.command.resume, runConfig)` instead of `agent.streamWithEvents(...)`.

**B. New middleware: `frontendImageInjectionMiddleware`.**

**File (new):** `_refs/gaunt-sloth-assistant/packages/tools/src/middleware/frontendImageInjectionMiddleware.ts`
- Modeled on `binaryContentInjectionMiddleware.ts`.
- Trigger: `ToolMessage` whose `name === 'capture_image'` and whose `content` parses as JSON `{ mimeType: string, data: string }`.
- Action (`beforeModel`): append a `HumanMessage` with `[ { type:'text', text:'Camera frame captured at <time>:' }, { type:'image', source_type:'base64', mime_type: <mimeType>, data: <data> } ]`.
- Error envelope (`{ error: '…' }`): append a text-only `HumanMessage` describing the failure (`"Camera unavailable: <error>"`).

**File:** `_refs/gaunt-sloth-assistant/packages/tools/src/builtInToolsConfig.ts`
- Auto-register when any client tool is configured.

### 2. vue-ui (`chatService` + `ChatInterface`)

**File:** `_refs/galvanized-pukeko-ai-ui/packages/galvanized-pukeko-vue-ui/src/services/chatService.ts`
- Allow callers to declare tools. Extend `sendMessage` to take `opts?: { tools?: Tool[] }`.
- Add a sibling `resumeWithCommand(resumeValue: unknown, interruptEvent: { toolCallId: string; runId?: string }, callbacks: ChatCallbacks, opts?: { tools?: Tool[] })`.
- Extend `ChatCallbacks` to include `onRunStart(runId: string)` to allow the caller to deterministically track the current run ID from the `RUN_STARTED` protocol event.

**File:** `_refs/galvanized-pukeko-ai-ui/packages/galvanized-pukeko-vue-ui/src/components/ChatInterface.vue`
- Add optional props:
  ```ts
  defineProps<{
    a2ui?: …,
    clientTools?: Tool[],
    clientToolHandlers?: Record<string, (args: unknown, ctx: { toolCallId: string }) => Promise<string> | string>,
  }>()
  ```
- Track the latest `runId` explicitly by defining `onRunStart(runId)` in `createStreamCallbacks` and saving it to a Vue `ref`.
- In `onToolCallEnd` of `createStreamCallbacks`: if `toolCallName` matches a key in `clientToolHandlers`:
  1. `await handler(args, { toolCallId })` to obtain the result string.
  2. Call `chatService.resumeWithCommand(result, { toolCallId, runId: currentRunId.value }, createStreamCallbacks(), { tools: props.clientTools })`.

### 3. robot-controller

**`.gsloth.config.json`** 
- Declare `capture_image` with `metadata: { client: true }`. Add a system-prompt hint.

**`src/components/WebcamPanel.vue`**
- Extend `captureFrame` to accept `maxWidth = 512` and downscale via canvas; drop quality to ~0.7. Default-arg keeps existing tests/callers working.

**`src/App.vue`**
- Define `clientTools` array and `clientToolHandlers` map containing `capture_image` logic (extracting dataUrl from `webcamRef.value?.captureFrame()`). Pass these down to `<ChatInterface>`.

### Local Deployment & Testing

Since the repositories are unreleased (checked out to `_refs/`), we will run them locally during verification:
1. **Frontend (`galvanized-pukeko-ai-ui`)**: Vite aliases `@galvanized-pukeko/vue-ui` to the `_refs/` folder out-of-the-box. Changes made will automatically reflect in the robot controller UI.
2. **Backend (`gaunt-sloth-assistant`)**: 
   - We must build the backend inside `_refs/gaunt-sloth-assistant` (via `npm run build` or `npx tsc -b`).
   - In `pukeko-robot-controller/package.json`, we will temporarily change the `"server"` script from `npx gaunt-sloth-api ...` to `node _refs/gaunt-sloth-assistant/packages/api/cli.js ...` so that it uses the local compiled code instead of the NPM published version.

## Resolutions to Open Questions

- **`createAgent` and `interrupt` Interoperability**: We will stick with using `interrupt()` from `@langchain/langgraph` inside the tool stub. This is the official and future-proof standard for LangGraph sub-graph interruptions. If `createAgent` catches the `GraphInterrupt` exception and fails to bubble it up, the contingency is to replace `createAgent` with the native `createReactAgent` from `@langchain/langgraph` which handles interrupts flawlessly.
- **`runId` capture in vue-ui**: The `runId` will be retrieved cleanly by extending `ChatCallbacks` with an `onRunStart(runId: string)` hook. `chatService.ts` will emit this on `EventType.RUN_STARTED`, and `ChatInterface.vue` will capture and store it in a `ref`. This future-proofs the implementation against internal changes in the AG-UI `HttpAgent` subscriber logic.

## Critical files
- `/home/parents/Documents/robots/pukeko-robot-controller/_refs/gaunt-sloth-assistant/packages/api/src/modules/apiAgUiModule.ts`
- `/home/parents/Documents/robots/pukeko-robot-controller/_refs/gaunt-sloth-assistant/packages/core/src/core/GthLangChainAgent.ts`
- `/home/parents/Documents/robots/pukeko-robot-controller/_refs/gaunt-sloth-assistant/packages/tools/src/middleware/frontendImageInjectionMiddleware.ts` (NEW)
- `/home/parents/Documents/robots/pukeko-robot-controller/_refs/gaunt-sloth-assistant/packages/tools/src/builtInToolsConfig.ts`
- `/home/parents/Documents/robots/pukeko-robot-controller/_refs/galvanized-pukeko-ai-ui/packages/galvanized-pukeko-vue-ui/src/services/chatService.ts`
- `/home/parents/Documents/robots/pukeko-robot-controller/_refs/galvanized-pukeko-ai-ui/packages/galvanized-pukeko-vue-ui/src/components/ChatInterface.vue`
- `/home/parents/Documents/robots/pukeko-robot-controller/.gsloth.config.json`
- `/home/parents/Documents/robots/pukeko-robot-controller/src/components/WebcamPanel.vue`
- `/home/parents/Documents/robots/pukeko-robot-controller/src/App.vue`
- `/home/parents/Documents/robots/pukeko-robot-controller/package.json` (server script modification)
