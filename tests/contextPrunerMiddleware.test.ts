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
    // Then the summary system message.
    expect(updated[2]).toBeInstanceOf(SystemMessage)
    expect((updated[2] as SystemMessage).content).toContain(SUMMARY_TEXT)
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
