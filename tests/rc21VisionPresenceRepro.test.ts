// RC-21 defect (1) — PRESENCE repro.
//
// Reproduces the real server middleware chain the way the langchain agent drives
// beforeModel: the two real middlewares (frontend-image-injection then
// context-pruner) wired into a REAL `createAgent`, with a checkpointer +
// thread_id, over the golden capture flow ([Human] -> AI(capture_image) ->
// Tool({mimeType,data}) -> model call). We record exactly what the model would
// receive on the capture-result call and assert whether a vision block is
// present, mirroring the golden dump
// (logs/549a8e06…/turn-002 -> imageCount:0, no injected vision HumanMessage).
//
// Diagnostic pass-through middlewares (D0 before FI, D1 between FI and CP, D2
// after CP) record per-node state so the CONFIRMED mechanism — execution order
// and what FI sees for the capture ToolMessage (.data present vs already
// dataDropped) — is observable, not assumed.

import { describe, it, expect } from 'vitest'
import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages'
import {
  BaseChatModel,
  type BaseChatModelParams,
} from '@langchain/core/language_models/chat_models'
import type { ChatResult } from '@langchain/core/outputs'
import { createAgent, createMiddleware, tool } from 'langchain'
import { MemorySaver, Command, interrupt } from '@langchain/langgraph'
import { z } from 'zod'
import { createFrontendImageInjectionMiddleware } from '../src/agent/frontendImageInjectionMiddleware.js'
import { createContextPrunerMiddleware } from '../src/agent/contextPrunerMiddleware.js'
import type { LlmProvider } from '../src/lib/config.js'

const B64 = 'BASE64IMAGEDATA_deadbeef'

// ── Message summary helpers (snapshot at capture time; middleware reuses objects) ──
interface MsgSummary {
  type: string
  name?: string
  hasImageBlock: boolean
  dataPresent?: boolean
  dataDropped?: boolean
}

function hasImageBlock(content: unknown): boolean {
  return (
    Array.isArray(content) &&
    (content as Array<{ type?: string }>).some(
      (b) => b && (b.type === 'image' || b.type === 'image_url')
    )
  )
}

function summarize(messages: BaseMessage[]): MsgSummary[] {
  return messages.map((m) => {
    const s: MsgSummary = { type: m.getType(), hasImageBlock: hasImageBlock(m.content) }
    const name = (m as unknown as { name?: string }).name
    if (name) s.name = name
    if (m instanceof ToolMessage && typeof m.content === 'string') {
      try {
        const parsed = JSON.parse(m.content) as Record<string, unknown>
        s.dataPresent = typeof parsed.data === 'string' && parsed.data.length > 0
        s.dataDropped = parsed.dataDropped === true
      } catch {
        /* non-JSON */
      }
    }
    return s
  })
}

function countVision(messages: BaseMessage[]): number {
  return messages.filter((m) => m instanceof HumanMessage && hasImageBlock(m.content)).length
}

// ── Recording, scripted, tool-calling fake model ──
// call 1 (no capture yet)  -> AI(capture_image)
// call 2 (capture present) -> plain text AIMessage (ends the react loop)
class RecordingModel extends BaseChatModel {
  public inputs: BaseMessage[][] = []
  public inputSummaries: MsgSummary[][] = []

  constructor(fields?: BaseChatModelParams) {
    super(fields ?? {})
  }
  _llmType(): string {
    return 'recording-fake'
  }
  override bindTools(): this {
    return this
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.inputs.push([...messages])
    this.inputSummaries.push(summarize(messages))
    const captureDone = messages.some(
      (m) => m.getType() === 'tool' && (m as unknown as { name?: string }).name === 'capture_image'
    )
    if (!captureDone) {
      const message = new AIMessage({
        content: '',
        tool_calls: [{ name: 'capture_image', args: {}, id: 'call_capture_1' }],
      })
      return { generations: [{ text: '', message }] }
    }
    const message = new AIMessage({ content: 'Done looking.' })
    return { generations: [{ text: 'Done looking.', message }] }
  }
}

// ── Diagnostic pass-through middleware: records per-node state, never mutates ──
type Trace = { label: string; call: number; msgs: MsgSummary[]; vision: number }

function diag(label: string, sink: Trace[], counter: { n: number }) {
  return createMiddleware({
    name: `diag-${label}`,
    beforeModel: async (state: { messages?: BaseMessage[] }) => {
      const messages = state.messages ?? []
      sink.push({
        label,
        call: counter.n,
        msgs: summarize(messages),
        vision: countVision(messages),
      })
      return undefined
    },
  })
}

// Stub llm for the context-pruner's summarizer (never reached below threshold).
function stubSummarizerLlm() {
  return {
    invoke: async () => ({ content: 'stub summary' }),
  } as unknown as Parameters<typeof createContextPrunerMiddleware>[0]['llm']
}

async function runGoldenCaptureFlow(provider: LlmProvider, threadId: string) {
  const model = new RecordingModel()
  const trace: Trace[] = []
  const counter = { n: 0 }

  // Count model calls by incrementing right before each node-chain via D0.
  const d0 = createMiddleware({
    name: 'diag-D0-before-FI',
    beforeModel: async (state: { messages?: BaseMessage[] }) => {
      counter.n += 1
      const messages = state.messages ?? []
      trace.push({
        label: 'D0-before-FI',
        call: counter.n,
        msgs: summarize(messages),
        vision: countVision(messages),
      })
      return undefined
    },
  })

  const fi = createFrontendImageInjectionMiddleware({ provider })
  const d1 = diag('D1-after-FI', trace, counter)
  const cp = createContextPrunerMiddleware({ llm: stubSummarizerLlm() })
  const d2 = diag('D2-after-CP', trace, counter)

  const captureImage = tool(
    async () => JSON.stringify({ mimeType: 'image/jpeg', data: B64 }),
    {
      name: 'capture_image',
      description: 'Capture a webcam frame.',
      schema: z.object({}),
    }
  )

  const agent = createAgent({
    model,
    tools: [captureImage],
    // Exact gpt-5.5 profile order: frontend-images then context-pruner.
    // D0/D1/D2 are inert observers interleaved to trace per-node evolution.
    middleware: [d0, fi, d1, cp, d2],
    checkpointer: new MemorySaver(),
  })

  await agent.invoke(
    { messages: [new HumanMessage('Move forward 2 steps.')] },
    { configurable: { thread_id: threadId }, recursionLimit: 25 }
  )

  return { model, trace }
}

describe('RC-21 defect (1) — vision presence through the real FI→CP chain', () => {
  it('TRACE (openai): records per-node state + the model input on the capture-result call', async () => {
    const { model, trace } = await runGoldenCaptureFlow('openai', `repro-openai-${Date.now()}`)

    // Print the full per-node trace + model inputs for diagnosis.
    // eslint-disable-next-line no-console
    console.log('=== RC-21 openai per-node trace ===')
    for (const t of trace) {
      // eslint-disable-next-line no-console
      console.log(`call#${t.call} ${t.label} vision=${t.vision} ::`, JSON.stringify(t.msgs))
    }
    // eslint-disable-next-line no-console
    console.log('=== model inputs (what the model received each call) ===')
    model.inputSummaries.forEach((s, i) => {
      // eslint-disable-next-line no-console
      console.log(`model call ${i + 1} vision=${countVision(model.inputs[i])} ::`, JSON.stringify(s))
    })

    // There must be a capture-result model call (call 2).
    expect(model.inputs.length).toBeGreaterThanOrEqual(2)
    const captureResultCallIdx = model.inputs.findIndex((msgs) =>
      msgs.some(
        (m) => m.getType() === 'tool' && (m as unknown as { name?: string }).name === 'capture_image'
      )
    )
    expect(captureResultCallIdx).toBeGreaterThanOrEqual(0)
    // CONFIRMED: the real FI→CP chain (server tool → normal ToolMessage) DOES
    // deliver exactly one vision block to the model on the capture-result call.
    // The golden `imageCount:0` therefore did NOT originate in this chain — it is
    // reproduced only when the capture ToolMessage reaches FI already
    // data-stripped (see the "golden failure MODE" suite below), which no
    // robot-middleware code causes (only the context-pruner drops `data`, and it
    // runs AFTER FI). Regression guard: this must stay === 1.
    const visionAtCaptureCall = countVision(model.inputs[captureResultCallIdx])
    // eslint-disable-next-line no-console
    console.log(`>>> vision blocks the model saw on the capture-result call: ${visionAtCaptureCall}`)
    expect(visionAtCaptureCall).toBe(1)
  })

  it('TRACE (anthropic): same flow — resolves the provider-specificity question', async () => {
    const { model } = await runGoldenCaptureFlow('anthropic', `repro-anthropic-${Date.now()}`)
    const captureResultCallIdx = model.inputs.findIndex((msgs) =>
      msgs.some(
        (m) => m.getType() === 'tool' && (m as unknown as { name?: string }).name === 'capture_image'
      )
    )
    const visionAtCaptureCall = countVision(model.inputs[captureResultCallIdx])
    // eslint-disable-next-line no-console
    console.log(`>>> [anthropic] vision blocks on the capture-result call: ${visionAtCaptureCall}`)
    // Presence is provider-INDEPENDENT: anthropic behaves identically to openai.
    // "anthropic works / openai broke" is about defect (2) SHAPE, not presence.
    expect(visionAtCaptureCall).toBe(1)
  })
})

// ── Faithful CLIENT-tool path: capture_image is an interrupt() stub, resumed
//    with Command({resume}) — exactly how gaunt-sloth's streamWithEventsResume
//    drives the graph (apiAgUiModule buildClientToolStub → interrupt({name});
//    GthAbstractAgent.streamWithEventsResume → agent.stream(new Command({resume}))).
//    The server-tool flow above delivers the vision block correctly; this checks
//    whether the interrupt/resume path — the one the golden run actually took —
//    behaves differently.
async function runInterruptCaptureFlow(provider: LlmProvider, threadId: string) {
  const model = new RecordingModel()
  const trace: Trace[] = []
  const counter = { n: 0 }

  const d0 = createMiddleware({
    name: 'diag-D0-before-FI',
    beforeModel: async (state: { messages?: BaseMessage[] }) => {
      counter.n += 1
      trace.push({
        label: 'D0-before-FI',
        call: counter.n,
        msgs: summarize(state.messages ?? []),
        vision: countVision(state.messages ?? []),
      })
      return undefined
    },
  })
  const fi = createFrontendImageInjectionMiddleware({ provider })
  const d1 = diag('D1-after-FI', trace, counter)
  const cp = createContextPrunerMiddleware({ llm: stubSummarizerLlm() })
  const d2 = diag('D2-after-CP', trace, counter)

  // Client tool: the body never returns a value directly — it interrupts, and
  // the resume value becomes the tool result (mirrors buildClientToolStub).
  const captureImage = tool(
    async () => {
      const resumed = interrupt({ name: 'capture_image' })
      return typeof resumed === 'string' ? resumed : JSON.stringify(resumed)
    },
    {
      name: 'capture_image',
      description: 'Capture a webcam frame (client-fulfilled).',
      schema: z.object({}),
    }
  )

  const agent = createAgent({
    model,
    tools: [captureImage],
    middleware: [d0, fi, d1, cp, d2],
    checkpointer: new MemorySaver(),
  })

  const cfg = { configurable: { thread_id: threadId }, recursionLimit: 25 }
  // Run until the interrupt (model call 1 → AI(capture_image) → suspend).
  await agent.invoke({ messages: [new HumanMessage('Move forward 2 steps.')] }, cfg)
  // Resume with the client tool result — the golden capture envelope.
  await agent.invoke(
    new Command({ resume: JSON.stringify({ mimeType: 'image/jpeg', data: B64 }) }),
    cfg
  )

  return { model, trace }
}

describe('RC-21 defect (1) — vision presence through the CLIENT-tool interrupt/resume path', () => {
  it('TRACE (openai): interrupt/resume — does the model see the vision block?', async () => {
    const { model, trace } = await runInterruptCaptureFlow('openai', `irq-openai-${Date.now()}`)

    // eslint-disable-next-line no-console
    console.log('=== RC-21 INTERRUPT openai per-node trace ===')
    for (const t of trace) {
      // eslint-disable-next-line no-console
      console.log(`irq call#${t.call} ${t.label} vision=${t.vision} ::`, JSON.stringify(t.msgs))
    }
    // eslint-disable-next-line no-console
    console.log('=== INTERRUPT model inputs ===')
    model.inputSummaries.forEach((s, i) => {
      // eslint-disable-next-line no-console
      console.log(`irq model call ${i + 1} vision=${countVision(model.inputs[i])} ::`, JSON.stringify(s))
    })

    const captureResultCallIdx = model.inputs.findIndex((msgs) =>
      msgs.some(
        (m) => m.getType() === 'tool' && (m as unknown as { name?: string }).name === 'capture_image'
      )
    )
    // eslint-disable-next-line no-console
    console.log(`>>> INTERRUPT capture-result model-call index: ${captureResultCallIdx}`)
    const visionAtCaptureCall =
      captureResultCallIdx >= 0 ? countVision(model.inputs[captureResultCallIdx]) : -1
    // eslint-disable-next-line no-console
    console.log(`>>> INTERRUPT vision blocks the model saw on the capture-result call: ${visionAtCaptureCall}`)
    // CONFIRMED: even the faithful client-tool interrupt/resume path (the one the
    // golden run actually took) delivers exactly one vision block to the model.
    // The FI→CP chain is NOT the presence defect.
    expect(captureResultCallIdx).toBeGreaterThanOrEqual(0)
    expect(visionAtCaptureCall).toBe(1)
  })

  it('TRACE (anthropic): interrupt/resume', async () => {
    const { model } = await runInterruptCaptureFlow('anthropic', `irq-anthropic-${Date.now()}`)
    const captureResultCallIdx = model.inputs.findIndex((msgs) =>
      msgs.some(
        (m) => m.getType() === 'tool' && (m as unknown as { name?: string }).name === 'capture_image'
      )
    )
    const visionAtCaptureCall =
      captureResultCallIdx >= 0 ? countVision(model.inputs[captureResultCallIdx]) : -1
    // eslint-disable-next-line no-console
    console.log(`>>> [anthropic INTERRUPT] capture-result idx=${captureResultCallIdx} vision=${visionAtCaptureCall}`)
    expect(captureResultCallIdx).toBeGreaterThanOrEqual(0)
    expect(visionAtCaptureCall).toBe(1)
  })
})

// ── The failure MODE that produces the golden shape, isolated ──
// The golden dump's model input has the capture ToolMessage already
// data-stripped ({mimeType, dataDropped:true}, no base64). When FI first meets
// a capture tool in that shape, its `.mimeType && .data` guard is false, so it
// injects NOTHING — reproducing `imageCount:0`. (Why the tool reached FI
// data-less is upstream of this repo — see the report; within this process only
// the context-pruner drops `data`, and it runs AFTER FI.)
//
// The RC-21 defect-(1) hardening is about what happens NEXT: the original code
// marked the tool_call_id in its module-level idempotency map BEFORE the guard,
// so a data-less sighting permanently POISONED the guard and blocked the frame
// even if the data-bearing result arrived on a later turn. The fix marks only on
// successful injection, so a later data-bearing sighting can still recover.
function getBeforeModel(mw: unknown): (s: unknown, r: unknown) => Promise<unknown> {
  const hook = (mw as { beforeModel?: unknown }).beforeModel
  if (typeof hook === 'function') return hook as (s: unknown, r: unknown) => Promise<unknown>
  if (hook && typeof hook === 'object' && 'hook' in hook) {
    return (hook as { hook: (s: unknown, r: unknown) => Promise<unknown> }).hook
  }
  throw new Error('no beforeModel hook')
}

describe('RC-21 defect (1) — the golden failure MODE: FI meets a data-stripped capture tool', () => {
  it('injects no vision on a data-less sighting, but does NOT poison the guard (fix)', async () => {
    const fi = createFrontendImageInjectionMiddleware({ provider: 'openai' })
    const before = getBeforeModel(fi)
    const runtime = { configurable: { thread_id: `stripped-${Date.now()}` } }

    // Exactly the golden turn-002 model input shape: data already dropped.
    const strippedCapture = new ToolMessage({
      content: JSON.stringify({ mimeType: 'image/jpeg', dataDropped: true }),
      tool_call_id: 'call_capture_1',
      name: 'capture_image',
    })
    const state = {
      messages: [
        new HumanMessage('Move forward.'),
        new AIMessage({ content: '', tool_calls: [{ name: 'capture_image', args: {}, id: 'call_capture_1' }] }),
        strippedCapture,
      ],
    }
    // No bytes to inject → no vision block (this reproduces `imageCount:0`).
    const res = (await before(state, runtime)) as { messages?: BaseMessage[] } | undefined
    const out = res?.messages ?? state.messages
    expect(countVision(out)).toBe(0)

    // FIX: the SAME tool_call_id later arrives WITH data — FI must now inject it
    // (the data-less sighting did not poison the idempotency guard).
    const withData = new ToolMessage({
      content: JSON.stringify({ mimeType: 'image/jpeg', data: B64 }),
      tool_call_id: 'call_capture_1',
      name: 'capture_image',
    })
    const state2 = {
      messages: [
        new HumanMessage('Move forward.'),
        new AIMessage({ content: '', tool_calls: [{ name: 'capture_image', args: {}, id: 'call_capture_1' }] }),
        withData,
      ],
    }
    const res2 = (await before(state2, runtime)) as { messages?: BaseMessage[] } | undefined
    const out2 = res2?.messages ?? state2.messages
    // eslint-disable-next-line no-console
    console.log(`>>> data-stripped-first then WITH data: vision = ${countVision(out2)} (guard not poisoned by the fix)`)
    expect(countVision(out2)).toBe(1)
  })
})

// ── Two-capture multi-turn flow: exercises the guard + CP REMOVE_ALL
//    persistence across supersteps (the brief's named suspect) end-to-end. ──
class TwoCaptureModel extends BaseChatModel {
  public inputSummaries: MsgSummary[][] = []
  public inputs: BaseMessage[][] = []
  constructor(fields?: BaseChatModelParams) {
    super(fields ?? {})
  }
  _llmType() {
    return 'two-capture-fake'
  }
  override bindTools(): this {
    return this
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.inputs.push([...messages])
    this.inputSummaries.push(summarize(messages))
    const captures = messages.filter(
      (m) => m.getType() === 'tool' && (m as unknown as { name?: string }).name === 'capture_image'
    ).length
    if (captures < 2) {
      return {
        generations: [
          {
            text: '',
            message: new AIMessage({
              content: '',
              tool_calls: [{ name: 'capture_image', args: {}, id: `call_capture_${captures + 1}` }],
            }),
          },
        ],
      }
    }
    return { generations: [{ text: 'ok', message: new AIMessage({ content: 'ok' }) }] }
  }
}

describe('RC-21 defect (1) — two-capture multi-turn (guard + REMOVE_ALL persistence)', () => {
  it('delivers a vision block to the model on BOTH capture-result calls (openai)', async () => {
    const model = new TwoCaptureModel()
    const captureImage = tool(
      async () => JSON.stringify({ mimeType: 'image/jpeg', data: B64 }),
      { name: 'capture_image', description: 'cap', schema: z.object({}) }
    )
    const agent = createAgent({
      model,
      tools: [captureImage],
      middleware: [
        createFrontendImageInjectionMiddleware({ provider: 'openai' }),
        createContextPrunerMiddleware({ llm: stubSummarizerLlm() }),
      ],
      checkpointer: new MemorySaver(),
    })
    await agent.invoke(
      { messages: [new HumanMessage('look twice')] },
      { configurable: { thread_id: `two-cap-${Date.now()}` }, recursionLimit: 25 }
    )
    // Model calls that had >=1 capture tool result in their input.
    const captureCalls = model.inputs.filter((msgs) =>
      msgs.some(
        (m) => m.getType() === 'tool' && (m as unknown as { name?: string }).name === 'capture_image'
      )
    )
    const visionCounts = captureCalls.map(countVision)
    // eslint-disable-next-line no-console
    console.log(`>>> two-capture vision-per-capture-call: ${JSON.stringify(visionCounts)}`)
    // Every capture-result model call must carry at least one vision block
    // (keepLatestImages=1 keeps the newest; older ones become text-only).
    expect(captureCalls.length).toBeGreaterThanOrEqual(2)
    for (const v of visionCounts) expect(v).toBeGreaterThanOrEqual(1)
  })
})
