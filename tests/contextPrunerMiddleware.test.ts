import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  RemoveMessage,
  type BaseMessage,
} from '@langchain/core/messages'
import {
  createContextPrunerMiddleware,
  estimateTokens,
  __inflightSummariesForTest,
} from '../src/agent/contextPrunerMiddleware.js'
import { __resetMotionLogForTest } from '../src/agent/motionLog.js'

interface HookContainer {
  beforeModel?: unknown
  afterModel?: unknown
}

function getHook(hook: unknown): (state: unknown, runtime: unknown) => unknown {
  if (typeof hook === 'function') return hook as (state: unknown, runtime: unknown) => unknown
  if (hook && typeof hook === 'object' && 'hook' in hook && typeof (hook as { hook: unknown }).hook === 'function') {
    return (hook as { hook: (state: unknown, runtime: unknown) => unknown }).hook
  }
  throw new Error('Hook not callable')
}

const SUMMARY_TEXT = 'Robot is south of cone, facing west; turn_right rotates clockwise here.'

function makeStubLlm(summary = SUMMARY_TEXT) {
  const invoke = vi.fn(async () => ({ content: summary }))
  return { invoke } as unknown as Parameters<typeof createContextPrunerMiddleware>[0]['llm'] & {
    invoke: ReturnType<typeof vi.fn>
  }
}

const runtime = { configurable: { thread_id: 'test-thread' } }

function imageBlock() {
  return { type: 'image_url' as const, image_url: 'data:image/jpeg;base64,XXXX' }
}

function motionResultJson(motion: string, dataLen = 100): string {
  return JSON.stringify({
    mimeType: 'image/jpeg',
    data: 'X'.repeat(dataLen),
    motion,
  })
}

beforeEach(() => {
  __inflightSummariesForTest.clear()
  // motionLog is shared module state; reset it so the pinned-state branch
  // exercised below (via afterModel) can't bleed motions into later tests.
  __resetMotionLogForTest()
})

describe('contextPrunerMiddleware — mechanical prune', () => {
  it('strips `data` from every motion ToolMessage unconditionally', async () => {
    const llm = makeStubLlm()
    const mw = createContextPrunerMiddleware({ llm }) as HookContainer
    const before = getHook(mw.beforeModel)

    const userMsg = new HumanMessage('go')
    const motionAi = new AIMessage({
      content: '',
      tool_calls: [{ name: 'turn_right', args: { steps: 1 }, id: 'tc-1' }],
    })
    const motionTool = new ToolMessage({
      content: motionResultJson('turn_right (steps=1)'),
      tool_call_id: 'tc-1',
      name: 'turn_right',
    })
    const injected = new HumanMessage({
      content: [{ type: 'text', text: 'Before/After frames for turn_right (steps=1).' }, imageBlock()],
    })

    const result = await before(
      { messages: [userMsg, motionAi, motionTool, injected] },
      runtime
    )
    expect(result).toBeTruthy()
    const updated = (result as { messages: BaseMessage[] }).messages
    // [RemoveMessage, userMsg, motionAi, prunedToolMessage, injected]
    expect(updated[0]).toBeInstanceOf(RemoveMessage)
    const toolOut = updated[3] as ToolMessage
    expect(toolOut).toBeInstanceOf(ToolMessage)
    const parsed = JSON.parse(toolOut.content as string)
    expect(parsed.data).toBeUndefined()
    expect(parsed.motion).toBe('turn_right (steps=1)')
    expect(parsed.mimeType).toBe('image/jpeg')
    expect(parsed.dataDropped).toBe(true)
  })

  it('keeps only the latest N image HumanMessages, defaults N=1', async () => {
    const llm = makeStubLlm()
    const mw = createContextPrunerMiddleware({ llm }) as HookContainer
    const before = getHook(mw.beforeModel)

    const userMsg = new HumanMessage('go')
    const img1 = new HumanMessage({
      content: [{ type: 'text', text: 'Frame 1' }, imageBlock()],
    })
    const img2 = new HumanMessage({
      content: [{ type: 'text', text: 'Frame 2' }, imageBlock()],
    })
    const img3 = new HumanMessage({
      content: [{ type: 'text', text: 'Frame 3' }, imageBlock()],
    })

    const result = await before(
      { messages: [userMsg, img1, img2, img3] },
      runtime
    )
    const updated = (result as { messages: BaseMessage[] }).messages
    // RemoveMessage at index 0.
    const pruned1 = updated[2] as HumanMessage
    const pruned2 = updated[3] as HumanMessage
    const keptLatest = updated[4] as HumanMessage

    const hasImage = (m: HumanMessage) =>
      Array.isArray(m.content) &&
      (m.content as Array<{ type?: string }>).some(
        (b) => b.type === 'image' || b.type === 'image_url'
      )
    expect(hasImage(pruned1)).toBe(false)
    expect(hasImage(pruned2)).toBe(false)
    expect(hasImage(keptLatest)).toBe(true)
    // The pruned ones keep their text caption.
    expect((pruned1.content as Array<{ text?: string }>)[0].text).toBe('Frame 1')
    expect((pruned2.content as Array<{ text?: string }>)[0].text).toBe('Frame 2')
  })

  it('keepLatestImages=2 retains the last two image messages', async () => {
    const llm = makeStubLlm()
    const mw = createContextPrunerMiddleware({ llm, keepLatestImages: 2 }) as HookContainer
    const before = getHook(mw.beforeModel)

    const userMsg = new HumanMessage('go')
    const img1 = new HumanMessage({ content: [{ type: 'text', text: 'F1' }, imageBlock()] })
    const img2 = new HumanMessage({ content: [{ type: 'text', text: 'F2' }, imageBlock()] })
    const img3 = new HumanMessage({ content: [{ type: 'text', text: 'F3' }, imageBlock()] })

    const result = await before({ messages: [userMsg, img1, img2, img3] }, runtime)
    const updated = (result as { messages: BaseMessage[] }).messages
    const hasImage = (m: HumanMessage) =>
      Array.isArray(m.content) &&
      (m.content as Array<{ type?: string }>).some(
        (b) => b.type === 'image' || b.type === 'image_url'
      )
    expect(hasImage(updated[2] as HumanMessage)).toBe(false)
    expect(hasImage(updated[3] as HumanMessage)).toBe(true)
    expect(hasImage(updated[4] as HumanMessage)).toBe(true)
  })

  it('strips reasoning_content from all but the last AIMessage', async () => {
    const llm = makeStubLlm()
    const mw = createContextPrunerMiddleware({ llm }) as HookContainer
    const before = getHook(mw.beforeModel)

    const userMsg = new HumanMessage('go')
    const aiOld = new AIMessage({
      content: 'first thought',
      additional_kwargs: { reasoning_content: 'OLD reasoning', other_key: 'kept' },
    })
    const aiMid = new AIMessage({
      content: 'second thought',
      additional_kwargs: { reasoning_content: 'MID reasoning' },
    })
    const aiLast = new AIMessage({
      content: 'latest thought',
      additional_kwargs: { reasoning_content: 'LATEST reasoning' },
    })

    const result = await before(
      { messages: [userMsg, aiOld, aiMid, aiLast] },
      runtime
    )
    const updated = (result as { messages: BaseMessage[] }).messages
    const out0 = updated[2] as AIMessage
    const out1 = updated[3] as AIMessage
    const out2 = updated[4] as AIMessage
    expect(out0.additional_kwargs?.reasoning_content).toBeUndefined()
    expect(out0.additional_kwargs?.other_key).toBe('kept')
    expect(out1.additional_kwargs?.reasoning_content).toBeUndefined()
    expect(out2.additional_kwargs?.reasoning_content).toBe('LATEST reasoning')
  })

  it('preserves message ids on rewritten messages', async () => {
    // Rewritten messages MUST keep their original id. Otherwise the
    // add_messages reducer (after RemoveMessage(REMOVE_ALL)) assigns fresh
    // UUIDs every turn, breaking client-side dedup-by-id and causing the
    // AG-UI client to render the same tool call twice.
    const llm = makeStubLlm()
    const mw = createContextPrunerMiddleware({ llm }) as HookContainer
    const before = getHook(mw.beforeModel)

    const userMsg = new HumanMessage({ id: 'h-user', content: 'go' })
    const motionAi = new AIMessage({
      id: 'ai-motion',
      content: '',
      tool_calls: [{ name: 'turn_right', args: { steps: 1 }, id: 'tc-1' }],
      additional_kwargs: { reasoning_content: 'stale reasoning' },
    })
    const motionTool = new ToolMessage({
      id: 'tool-motion',
      content: motionResultJson('turn_right (steps=1)'),
      tool_call_id: 'tc-1',
      name: 'turn_right',
    })
    const oldImg = new HumanMessage({
      id: 'h-img-old',
      content: [{ type: 'text', text: 'Old frame' }, imageBlock()],
    })
    const lastAi = new AIMessage({ id: 'ai-last', content: 'done' })

    const result = await before(
      { messages: [userMsg, motionAi, motionTool, oldImg, lastAi] },
      runtime
    )
    const updated = (result as { messages: BaseMessage[] }).messages
    const ids = updated.filter((m) => !(m instanceof RemoveMessage)).map((m) => m.id)
    // Every rewritten message retains its original id; none are undefined.
    expect(ids).toEqual(['h-user', 'ai-motion', 'tool-motion', 'h-img-old', 'ai-last'])
  })

  it('returns undefined when there is nothing to prune and nothing to summarize', async () => {
    const llm = makeStubLlm()
    const mw = createContextPrunerMiddleware({ llm }) as HookContainer
    const before = getHook(mw.beforeModel)

    const result = await before(
      { messages: [new HumanMessage('hi'), new AIMessage('hello')] },
      runtime
    )
    expect(result).toBeUndefined()
    expect(llm.invoke).not.toHaveBeenCalled()
  })
})

describe('contextPrunerMiddleware — threshold summarization', () => {
  it('does not summarize when pruned tokens stay under threshold', async () => {
    const llm = makeStubLlm()
    const mw = createContextPrunerMiddleware({
      llm,
      maxContextTokens: 30_000,
      summarizeAtFraction: 0.7,
    }) as HookContainer
    const before = getHook(mw.beforeModel)

    const userMsg = new HumanMessage('go')
    const motionAi = new AIMessage({
      content: '',
      tool_calls: [{ name: 'turn_right', args: { steps: 1 }, id: 'tc' }],
    })
    const motionTool = new ToolMessage({
      content: motionResultJson('turn_right (steps=1)', 200),
      tool_call_id: 'tc',
      name: 'turn_right',
    })

    await before({ messages: [userMsg, motionAi, motionTool] }, runtime)
    expect(llm.invoke).not.toHaveBeenCalled()
  })

  it('summarizes synchronously when pruned tokens cross threshold', async () => {
    const llm = makeStubLlm()
    const mw = createContextPrunerMiddleware({
      llm,
      maxContextTokens: 1000,
      summarizeAtFraction: 0.5, // threshold = 500
      keepLatestImages: 1,
      imageTokenBudget: 50,
    }) as HookContainer
    const before = getHook(mw.beforeModel)

    const userMsg = new HumanMessage('Get the robot to the cone.')
    // Pad the head with a bunch of long-text AIMessages so we cross 500 tokens.
    const filler: BaseMessage[] = []
    for (let i = 0; i < 6; i++) {
      filler.push(new AIMessage('A'.repeat(400)))
    }
    const motionAi = new AIMessage({
      content: '',
      tool_calls: [{ name: 'turn_right', args: { steps: 1 }, id: 'tc' }],
    })
    const motionTool = new ToolMessage({
      content: motionResultJson('turn_right (steps=1)'),
      tool_call_id: 'tc',
      name: 'turn_right',
    })
    const injected = new HumanMessage({
      content: [{ type: 'text', text: 'Before/After.' }, imageBlock()],
    })

    const result = await before(
      { messages: [userMsg, ...filler, motionAi, motionTool, injected] },
      runtime
    )

    expect(llm.invoke).toHaveBeenCalledTimes(1)
    const updated = (result as { messages: BaseMessage[] }).messages
    expect(updated[0]).toBeInstanceOf(RemoveMessage)
    // First non-Remove entry is the original user message verbatim.
    expect(updated[1]).toBeInstanceOf(HumanMessage)
    expect((updated[1] as HumanMessage).content).toBe('Get the robot to the cone.')
    // Then the summary as a clearly-marked HumanMessage (RC-17: a SystemMessage
    // here sits at index ≥ 1, which @langchain/anthropic rejects outright).
    expect(updated[2]).toBeInstanceOf(HumanMessage)
    expect(updated[2]).not.toBeInstanceOf(SystemMessage)
    expect((updated[2] as HumanMessage).content).toContain('[Context summary]')
    expect((updated[2] as HumanMessage).content).toContain(SUMMARY_TEXT)
    // Tail is the motion turn (AIMessage + ToolMessage + injected composite).
    expect(updated[3]).toBe(motionAi)
    expect(updated[4]).toBeInstanceOf(ToolMessage)
    expect(updated[5]).toBe(injected)
  })

  it('summarizer sees image-stripped input', async () => {
    const llm = makeStubLlm()
    const mw = createContextPrunerMiddleware({
      llm,
      maxContextTokens: 1000,
      summarizeAtFraction: 0.5,
      imageTokenBudget: 50,
    }) as HookContainer
    const before = getHook(mw.beforeModel)

    const userMsg = new HumanMessage('Find the cone.')
    const filler: BaseMessage[] = []
    for (let i = 0; i < 6; i++) filler.push(new AIMessage('B'.repeat(400)))
    const motionAi = new AIMessage({
      content: '',
      tool_calls: [{ name: 'move_forward', args: { steps: 2 }, id: 'tc' }],
    })
    const motionTool = new ToolMessage({
      content: motionResultJson('move_forward (steps=2)'),
      tool_call_id: 'tc',
      name: 'move_forward',
    })
    const injected = new HumanMessage({
      content: [{ type: 'text', text: 'frame' }, imageBlock()],
    })

    await before(
      { messages: [userMsg, ...filler, motionAi, motionTool, injected] },
      runtime
    )
    expect(llm.invoke).toHaveBeenCalledTimes(1)
    const sanitizedInput = llm.invoke.mock.calls[0][0] as BaseMessage[]
    for (const m of sanitizedInput) {
      if (Array.isArray(m.content)) {
        for (const block of m.content as Array<{ type?: string }>) {
          expect(block.type === 'image' || block.type === 'image_url').toBe(false)
        }
      }
    }
  })

  it('uses a provided summaryPrompt override', async () => {
    const llm = makeStubLlm()
    const mw = createContextPrunerMiddleware({
      llm,
      summaryPrompt: 'CUSTOM PRUNER PROMPT',
      maxContextTokens: 1000,
      summarizeAtFraction: 0.5,
    }) as HookContainer
    const before = getHook(mw.beforeModel)

    const userMsg = new HumanMessage('go')
    const filler: BaseMessage[] = []
    for (let i = 0; i < 6; i++) filler.push(new AIMessage('Z'.repeat(400)))
    const motionAi = new AIMessage({
      content: '',
      tool_calls: [{ name: 'turn_left', args: {}, id: 'tc' }],
    })
    const motionTool = new ToolMessage({
      content: motionResultJson('turn_left'),
      tool_call_id: 'tc',
      name: 'turn_left',
    })

    await before(
      { messages: [userMsg, ...filler, motionAi, motionTool] },
      runtime
    )
    expect(llm.invoke).toHaveBeenCalledTimes(1)
    const sanitizedInput = llm.invoke.mock.calls[0][0] as BaseMessage[]
    expect(sanitizedInput[0]).toBeInstanceOf(SystemMessage)
    expect((sanitizedInput[0] as SystemMessage).content).toBe('CUSTOM PRUNER PROMPT')
  })
})

describe('contextPrunerMiddleware — estimateTokens', () => {
  it('counts string-content text via the 4-chars/token heuristic', () => {
    const msg = new HumanMessage('A'.repeat(40))
    // 40 chars / 4 = 10 text tokens + 4 envelope = 14
    expect(estimateTokens([msg], 800)).toBe(14)
  })

  it('charges imageTokenBudget per image block', () => {
    const noImg = new HumanMessage('hi')
    const withImg = new HumanMessage({
      content: [{ type: 'text', text: 'hi' }, { type: 'image_url', image_url: 'data:...' }],
    })
    const noImgTokens = estimateTokens([noImg], 800)
    const withImgTokens = estimateTokens([withImg], 800)
    expect(withImgTokens - noImgTokens).toBe(800)
  })

  it('charges for AIMessage tool_calls', () => {
    const plain = new AIMessage('hello')
    const withTool = new AIMessage({
      content: '',
      tool_calls: [{ name: 'turn_right', args: { steps: 3 }, id: 'x' }],
    })
    expect(estimateTokens([withTool], 800)).toBeGreaterThan(estimateTokens([plain], 800))
  })
})

// ── RC-17: no mid-history SystemMessage, ever ───────────────────────────────
// @langchain/anthropic throws "System messages are only permitted as the first
// passed message." for a SystemMessage at index ≥ 1 — the PLAT-13 crash, the
// exact defect RC-16 fixed in motion-summarization. Every branch of the
// context-pruner's beforeModel that rebuilds a history must leave no
// SystemMessage past index 0; the summary rides as a marked HumanMessage. The
// two-cycle case additionally proves the marked HumanMessage summary is FOLDED
// (replaced), not accumulated, on a later prune.
describe('contextPrunerMiddleware — RC-17 mid-history SystemMessage fix', () => {
  function systemIndices(messages: BaseMessage[]): number[] {
    return messages
      .map((m, i) => (m instanceof SystemMessage ? i : -1))
      .filter((i) => i >= 0)
  }

  function summaryMessages(messages: BaseMessage[]): HumanMessage[] {
    return messages.filter(
      (m): m is HumanMessage =>
        m instanceof HumanMessage && String(m.content).startsWith('[Context summary]')
    )
  }

  // Force the summarize branch regardless of real token counts: threshold = 1.
  const FORCE_SUMMARIZE = { maxContextTokens: 10, summarizeAtFraction: 0.1 } as const

  // The PLAT-13 crash shape: a read_status tool turn BEFORE the first motion,
  // so the rewrite window (firstHumanIdx+1 .. lastMotionAiIdx) is non-empty.
  function crashShapedHistory() {
    const user = new HumanMessage('Drive the robot to the red cone.')
    const statusAi = new AIMessage({
      content: '',
      tool_calls: [{ name: 'read_status', args: {}, id: 'tc-status' }],
    })
    const statusTool = new ToolMessage({
      content: JSON.stringify({ battery: '7.4V', ok: true }),
      tool_call_id: 'tc-status',
      name: 'read_status',
    })
    const thinking = new AIMessage('Status fine. Turning right to scan.')
    const motionAi = new AIMessage({
      content: '',
      tool_calls: [{ name: 'turn_right', args: { steps: 3 }, id: 'tc-motion' }],
    })
    const motionTool = new ToolMessage({
      content: JSON.stringify({ mimeType: 'image/jpeg', data: 'B', motion: 'turn_right (steps=3)' }),
      tool_call_id: 'tc-motion',
      name: 'turn_right',
    })
    const composite = new HumanMessage({
      content: [{ type: 'text', text: 'Before/After frames for turn_right (steps=3).' }, imageBlock()],
    })
    const atMotion: BaseMessage[] = [user, statusAi, statusTool, thinking, motionAi]
    return { atMotion, nextTurn: [...atMotion, motionTool, composite] as BaseMessage[] }
  }

  it('summary-applied branch (pinned state present): no SystemMessage at index ≥ 1', async () => {
    const llm = makeStubLlm()
    const mw = createContextPrunerMiddleware({ llm, ...FORCE_SUMMARIZE }) as HookContainer
    const after = getHook(mw.afterModel)
    const before = getHook(mw.beforeModel)

    const { atMotion, nextTurn } = crashShapedHistory()
    // afterModel observes the just-emitted motion, so formatPinnedState() is
    // non-empty on the following beforeModel.
    await after({ messages: atMotion }, runtime)
    const result = await before({ messages: nextTurn }, runtime)

    expect(result).toBeTruthy()
    const updated = (result as { messages: BaseMessage[] }).messages
    expect(updated[0]).toBeInstanceOf(RemoveMessage)
    const rebuilt = updated.slice(1)
    // The invariant Anthropic enforces.
    expect(systemIndices(rebuilt)).toEqual([])
    // The summary lands as a marked HumanMessage carrying both the LLM summary
    // and the deterministic pinned motion log.
    const summaries = summaryMessages(rebuilt)
    expect(summaries).toHaveLength(1)
    expect(String(summaries[0].content)).toContain(SUMMARY_TEXT)
    expect(String(summaries[0].content)).toContain('Recent motions (newest last):')
  })

  it('summary-applied branch (no pinned state): no SystemMessage at index ≥ 1', async () => {
    const llm = makeStubLlm()
    const mw = createContextPrunerMiddleware({ llm, ...FORCE_SUMMARIZE }) as HookContainer
    const before = getHook(mw.beforeModel)

    // No afterModel call → motion log empty → formatPinnedState() === '' (the
    // pinned-less branch).
    const { nextTurn } = crashShapedHistory()
    const result = await before({ messages: nextTurn }, runtime)

    expect(result).toBeTruthy()
    const rebuilt = (result as { messages: BaseMessage[] }).messages.slice(1)
    expect(systemIndices(rebuilt)).toEqual([])
    const summaries = summaryMessages(rebuilt)
    expect(summaries).toHaveLength(1)
    expect(String(summaries[0].content)).toContain(SUMMARY_TEXT)
    expect(String(summaries[0].content)).not.toContain('Recent motions')
  })

  it('a pre-existing first-position SystemMessage stays at index 0 only', async () => {
    const llm = makeStubLlm()
    const mw = createContextPrunerMiddleware({ llm, ...FORCE_SUMMARIZE }) as HookContainer
    const before = getHook(mw.beforeModel)

    const { nextTurn } = crashShapedHistory()
    const withSystem = [new SystemMessage('agent system prompt'), ...nextTurn]
    const result = await before({ messages: withSystem }, runtime)

    expect(result).toBeTruthy()
    const rebuilt = (result as { messages: BaseMessage[] }).messages.slice(1)
    // The leading system message survives in place; no OTHER system message
    // appears anywhere past index 0.
    expect(systemIndices(rebuilt)).toEqual([0])
    expect((rebuilt[0] as SystemMessage).content).toBe('agent system prompt')
    expect(summaryMessages(rebuilt)).toHaveLength(1)
  })

  it('two prune cycles: the summary is folded, not accumulated', async () => {
    // Distinct summary text per call so "no accumulation" is a real content
    // discrimination, not just a count check.
    let n = 0
    const invoke = vi.fn(async () => ({ content: `summary ${++n}: robot scanned then moved.` }))
    const llm = { invoke } as unknown as Parameters<typeof createContextPrunerMiddleware>[0]['llm'] & {
      invoke: ReturnType<typeof vi.fn>
    }
    const mw = createContextPrunerMiddleware({ llm, ...FORCE_SUMMARIZE }) as HookContainer
    const before = getHook(mw.beforeModel)

    // Cycle 1.
    const { nextTurn } = crashShapedHistory()
    const r1 = await before({ messages: nextTurn }, runtime)
    const rebuilt1 = (r1 as { messages: BaseMessage[] }).messages.filter(
      (m) => !(m instanceof RemoveMessage)
    )
    const c1 = summaryMessages(rebuilt1)
    expect(c1).toHaveLength(1)
    expect(String(c1[0].content)).toContain('summary 1')

    // Cycle 2: the model emits a second motion off the rebuilt state; the prior
    // summary (now at firstHumanIdx+1) falls inside the next head slice.
    const motionAi2 = new AIMessage({
      content: '',
      tool_calls: [{ name: 'move_forward', args: { steps: 2 }, id: 'tc-motion-2' }],
    })
    const motionTool2 = new ToolMessage({
      content: JSON.stringify({ mimeType: 'image/jpeg', data: 'C', motion: 'move_forward (steps=2)' }),
      tool_call_id: 'tc-motion-2',
      name: 'move_forward',
    })
    const composite2 = new HumanMessage({
      content: [{ type: 'text', text: 'Before/After frames for move_forward (steps=2).' }, imageBlock()],
    })
    const cycle2Input = [...rebuilt1, motionAi2, motionTool2, composite2]
    const r2 = await before({ messages: cycle2Input }, runtime)
    const rebuilt2 = (r2 as { messages: BaseMessage[] }).messages.filter(
      (m) => !(m instanceof RemoveMessage)
    )

    // No accumulation: exactly ONE summary, carrying cycle-2's text and NOT
    // cycle-1's; and still no SystemMessage at index ≥ 1.
    const c2 = summaryMessages(rebuilt2)
    expect(c2).toHaveLength(1)
    expect(String(c2[0].content)).toContain('summary 2')
    expect(String(c2[0].content)).not.toContain('summary 1')
    expect(systemIndices(rebuilt2)).toEqual([])
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it('guard branch preserved: motion directly after the first human → no rewrite', async () => {
    const llm = makeStubLlm()
    const mw = createContextPrunerMiddleware({ llm, ...FORCE_SUMMARIZE }) as HookContainer
    const before = getHook(mw.beforeModel)

    // lastMotionAiIdx === firstHumanIdx + 1 → the summarize window is empty and
    // nothing else needs pruning (plain ToolMessage, no image data) → undefined.
    const messages: BaseMessage[] = [
      new HumanMessage('go'),
      new AIMessage({ content: '', tool_calls: [{ name: 'turn_right', args: { steps: 1 }, id: 'm' }] }),
      new ToolMessage({ content: '{}', tool_call_id: 'm', name: 'turn_right' }),
    ]
    const result = await before({ messages }, runtime)
    expect(result).toBeUndefined()
    expect(llm.invoke).not.toHaveBeenCalled()
  })

  it('empty-summary branch: summary not applied, no SystemMessage introduced', async () => {
    const llm = makeStubLlm('')
    const mw = createContextPrunerMiddleware({ llm, ...FORCE_SUMMARIZE }) as HookContainer
    const before = getHook(mw.beforeModel)

    // The summarizer returns '' → the summary is NOT applied. Mechanical prune
    // still runs (the crash history's ToolMessage carries image data), so a
    // rewrite may be emitted, but it must carry no summary and no mid-history
    // SystemMessage.
    const { nextTurn } = crashShapedHistory()
    const result = await before({ messages: nextTurn }, runtime)

    expect(llm.invoke).toHaveBeenCalledTimes(1)
    const rebuilt =
      result === undefined
        ? []
        : (result as { messages: BaseMessage[] }).messages.filter(
            (m) => !(m instanceof RemoveMessage)
          )
    expect(systemIndices(rebuilt)).toEqual([])
    expect(summaryMessages(rebuilt)).toHaveLength(0)
  })
})
