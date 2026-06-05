# AGENTS.md — Pukeko Robot Controller

A Vue web UI + AG-UI backend that lets an LLM drive an Acebott biped robot in front of a webcam. Tuned to work well with local Gemma 4 via Ollama; also runs against Claude (Anthropic) and the robot stub.

## Run

```sh
# robot stub (port 8080)
npm run stub

# AG-UI backend (port 3000)
ROBOT_HOST=localhost:8080 npm run server

# web UI (port 5173)
npm run dev:ag-ui
```

Real robot: skip `npm run stub` and connect to the robot's Wi-Fi AP. Set `ROBOT_HOST=192.168.4.1` (default) or whatever IP it picks up.

## Architecture

- **`server/index.ts`** — boots `@gaunt-sloth/api` AG-UI server. Wires LLM, tools, and middleware.
- **`src/agent/robotTools.ts`** — declares the agent's tools.
  - **Motion tools** (`move_forward`, `move_backward`, `turn_left`, `turn_right`) are **client-fulfilled** (`metadata: { client: true }`). The browser orchestrates the whole capture+move+capture+compose sequence — see below.
  - **Sensor & control tools** (`read_distance`, `read_status`, `stop`) stay server-side and hit the robot's HTTP API directly.
  - **`capture_image`** is the original standalone client-fulfilled camera tool, kept for mid-sequence alignment checks.
  - **`finish_task`** is the agent's **structured terminal action** — the only intended way to end a run. Server-fulfilled, no robot side effect. It's marked **`returnDirect: true`**, which is what actually stops the graph: `createAgent` routes straight to END after a returnDirect tool runs (matching on the ToolMessage name), instead of looping the result back to the model. **Do not** try to end from a tool with `Command({ goto: END })` — `createAgent` ignores it and the run grinds to the recursion limit. `status` is `success | failed | need_input`; a required one-line `summary` says what was achieved or what's blocking. The "do a real action before giving up" rule is **prompt-level** guidance (not a hard runtime gate — a per-tool `returnDirect` can't both reject and continue); `motionLog`'s `hasRunRealTool` flag remains available should a middleware-enforced gate be wanted later.
- **`src/agent/robotToolNames.ts`** / **`src/agent/motionLog.ts`** — `robotToolNames` is a tiny leaf module holding the motion/`finish_task` tool-name constants (so `robotTools` can depend on `motionLog` without a cycle). `motionLog` is the deterministic, process-memory loop state keyed by `thread_id`: the recent-motion log (immune to summary drift), the `finish_task` give-up gate, and the pinned calibration line. `observeAssistantMessage` is called once per assistant turn from each pruning middleware's `afterModel`; `formatPinnedState` is appended to the summary by both so the durable facts survive a prune.
- **`src/agent/frontendImageInjectionMiddleware.ts`** — converts the JSON envelope `{ mimeType, data, motion }` that comes back from `capture_image` / motion tools into a provider-shaped `HumanMessage` content block (Ollama: `image_url`; Anthropic: `image`). For motion envelopes it labels the block `Before/After frames for <motion>.`. (The motion tools do **not** capture distance — the model calls `read_distance` itself; there is no auto-stamped sensor line.)
- **`src/agent/motionSummarizationMiddleware.ts`** — concurrent-with-motion history compression. `afterModel` detects a motion tool call in the assistant message and immediately fires a summarization LLM call (uses the same `llm`). `beforeModel` on the next turn awaits the summary and rewrites the message history to keep only: the original user prompt verbatim, a single `SystemMessage` summary, and the most recent motion turn cluster.
- **`src/agent/contextPrunerMiddleware.ts`** — mechanical alternative to `motion-summary`. `beforeModel` strips base64 `data` from motion/capture `ToolMessage`s (the image rides in the next `HumanMessage` anyway), keeps only the latest N image-bearing `HumanMessage`s, and drops stale `reasoning_content` from older AI turns — preserving reasoning text and tool calls verbatim. It only fires the summarizer LLM when pruned history crosses `summarizeAtFraction × maxContextTokens`. Its `afterModel` records loop state into `motionLog`, and when it summarizes it appends `formatPinnedState` (recent-motion log + calibration) to the summary — so, like `motion-summary`, it never erases the attempted-motion record. **Rewritten messages must keep their original `id`** — `add_messages` assigns fresh UUIDs to id-less messages after `RemoveMessage(REMOVE_ALL)`, which breaks the AG-UI client's dedup-by-id and double-renders tool cards. Mutually exclusive with `motion-summary` (both rewrite the head on `beforeModel`).
- **`src/agent/lazyToolRecoveryMiddleware.ts`** — counters small-local-model laziness: Gemma/Gemini often *narrate* a tool ("`read_distance` to check the range.") and end the turn without emitting the call, stalling the run. `wrapModelCall` inspects the reply; on a no-tool answer that names a known tool it runs a cheap **isolated** classifier call (`callbacks: []`, detached from streaming) asking whether a tool was intended, then re-invokes **through the framework `handler`** (not a hand-built message) so the recovered tool call streams as real `TOOL_CALL_*` events the client run loop can fulfil. `done_reason: 'length'` (Ollama output-cap truncation) is treated as a cutoff, not laziness, and left alone. Knobs: `maxRecoveries` (default 1, or 2 when `force`), `skipClassifier` (recover on any tool-name mention, no classifier round-trip), `force` (harshest — re-prompt on ANY no-tool reply, even one naming no tool; the model must call some tool every turn, leaning on `finish_task` as the always-available "done" tool; this is the Ollama-path equivalent of forcing tool_choice). **Still required for the Ollama/Gemma path:** the hosted providers now force a tool call every turn (see `tool_choice` below), which makes the narrate-but-don't-call stall structurally impossible there — but ChatOllama does not support `tool_choice` (`tool_choice?: never`), so on the default Ollama path this middleware remains the only net.
- **`src/App.vue` + `src/components/WebcamPanel.vue`** — Vue UI. Camera capture happens in the hidden `<canvas>` in `WebcamPanel`. The motion-tool handlers in `App.vue` fetch the robot directly (`http://${VITE_ROBOT_HOST}/forward?steps=N`), capture Before/After frames, and compose them via `WebcamPanel.composeBeforeAfter`. **Requires CORS on the robot** — both `robot-stub/robotStub.ts` and `acebot-biped/for-agents/Biped_Robot_Web.py` send `Access-Control-Allow-Origin: *`.

## Conventions worth knowing

- Default model: Gemma 4 via Ollama (`OLLAMA_MODEL=gemma4:31b`). Optimized for small models — the motion-tools auto-capture + summarization combo means the LLM doesn't have to remember to bracket motions with `capture_image` and the context window stays trim.
- Parallel tool calls are **disabled** on Anthropic (`disable_parallel_tool_use: true` in `server/createLlm.ts`) because client-fulfilled tools rely on a LangGraph interrupt and parallel batching breaks the resume ordering.
- **Forced tool choice** (`tool_choice` "any"/"required" in `server/createLlm.ts`) is set on the hosted providers (Anthropic / OpenAI / OpenRouter) so the model must emit a tool every turn; combined with `finish_task` (which ends the run via `Command{goto: END}`) the loop never depends on a no-tool reply to terminate. **ChatOllama can't be forced** (`tool_choice?: never`), so the Ollama path is unforced and leans on `lazy-tool-recovery` instead.
- **`recursionLimit`** is set to `64` in `server/index.ts` (gaunt-sloth's default is 1000). It caps the agent's super-steps per run so a stuck embodied loop fails fast and visibly instead of grinding ~1000 local inferences. Plumbed through gaunt-sloth's `GthConfig.recursionLimit` → `getNewRunnableConfig(recursionLimit)` → the AG-UI run config.
- The agent's behavioural prompt lives in `system-prompt.md` at the repo root (the operating mindset, calibration sequence, distance-sensor caveats). Update there, not in code, when changing how the agent thinks. It's loaded via gaunt-sloth's configurable `projectGuidelines` slot (set in `server/index.ts`), overridable per profile with `systemPromptPath`.
- The motion-summarization prompt lives in `summarization-prompt.md` at the repo root (what each compressed history must carry forward — objective, calibration outcomes, action log, findings). Overridable per profile with `summaryPromptPath`. `src/agent/motionSummarizationMiddleware.ts` keeps an identical `DEFAULT_SUMMARY_PROMPT` as a fallback for when the file is absent — keep the two in sync.
- Briefs in `_briefs/` describe planned/completed work. `01-*` documented the `capture_image` interrupt/resume flow; `02-*` documented the motion-tool auto-capture and summarization work that this AGENTS.md describes; `03-*` reviewed the agentic loop (termination, exits, memory durability) and motivated `finish_task`, the shared `motionLog`, forced tool choice, and the `recursionLimit` cap.

## Tests

`npm test` — 40+ vitest cases covering the robot stub HTTP behaviour, the webcam panel, and the motion-summarization middleware. The before/after canvas composition is **not** covered by unit tests (jsdom has no canvas) — verify it in the browser instead.

## Smoke-testing in the browser

Always exercise a motion tool in a real Chrome tab before declaring UI changes done. Type-check + unit-test passes are not sufficient for the camera + canvas path. Open `http://localhost:5173`, allow camera permission, and ask the agent to e.g. "turn right one cycle". The tool-call badge should expand to show a single composite image with **Before / After** labels and a divider.
