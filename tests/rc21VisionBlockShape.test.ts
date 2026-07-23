// RC-21 defect (2) — the injected vision block must be the shape each provider's
// installed @langchain converter actually decodes. Asserts the per-provider
// mapping in frontendImageInjectionMiddleware (`imageBlockFor`).
//
// The concrete shapes were verified against the installed converters (see the
// RC-21 report's truth table): ChatOpenAI/ChatOpenRouter want
// {type:'image_url', image_url:{url}} (correct on both the Completions and
// Responses API paths); ChatOllama wants {type:'image_url', image_url:<string>};
// ChatAnthropic (native) and ChatGoogle (→ inlineData) decode the LangChain
// standard {type:'image', source_type:'base64', ...} block.
import { describe, it, expect } from 'vitest'
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages'
import { createFrontendImageInjectionMiddleware } from '../src/agent/frontendImageInjectionMiddleware.js'
import type { LlmProvider } from '../src/lib/config.js'

const MIME = 'image/jpeg'
const DATA = 'BASE64DATA_deadbeef'
const DATA_URL = `data:${MIME};base64,${DATA}`

function getBeforeModel(mw: unknown): (s: unknown, r: unknown) => Promise<unknown> {
  const hook = (mw as { beforeModel?: unknown }).beforeModel
  if (typeof hook === 'function') return hook as (s: unknown, r: unknown) => Promise<unknown>
  if (hook && typeof hook === 'object' && 'hook' in hook) {
    return (hook as { hook: (s: unknown, r: unknown) => Promise<unknown> }).hook
  }
  throw new Error('no beforeModel hook')
}

// Globally-unique nonce: `injectedByThread` is module-level with no reset, so
// thread_id + tool_call_id must be unique per call to avoid cross-test guard
// bleed (two calls in the same ms would otherwise share a thread).
let nonce = 0

// Run FI over a data-bearing capture turn and return the injected image block.
async function injectedImageBlock(provider: LlmProvider): Promise<Record<string, unknown>> {
  const uid = `${provider}-${Date.now()}-${nonce++}`
  const fi = createFrontendImageInjectionMiddleware({ provider })
  const before = getBeforeModel(fi)
  const state = {
    messages: [
      new HumanMessage('look'),
      new AIMessage({ content: '', tool_calls: [{ name: 'capture_image', args: {}, id: `tc-${uid}` }] }),
      new ToolMessage({
        content: JSON.stringify({ mimeType: MIME, data: DATA }),
        tool_call_id: `tc-${uid}`,
        name: 'capture_image',
      }),
    ],
  }
  const res = (await before(state, { configurable: { thread_id: `shape-${uid}` } })) as {
    messages: BaseMessage[]
  }
  const injected = res.messages.at(-1) as HumanMessage
  const content = injected.content as Array<Record<string, unknown>>
  // [ {type:'text', ...}, <image block> ]
  return content[1]
}

describe('RC-21 defect (2) — provider-correct injected vision block shape', () => {
  it('openai → {type:"image_url", image_url:{url}} (native; valid on Completions AND Responses)', async () => {
    expect(await injectedImageBlock('openai')).toEqual({
      type: 'image_url',
      image_url: { url: DATA_URL },
    })
  })

  it('openrouter → {type:"image_url", image_url:{url}} (OpenAI-compatible)', async () => {
    expect(await injectedImageBlock('openrouter')).toEqual({
      type: 'image_url',
      image_url: { url: DATA_URL },
    })
  })

  it('ollama → {type:"image_url", image_url:<data-URL string>} (ChatOllama form)', async () => {
    expect(await injectedImageBlock('ollama')).toEqual({
      type: 'image_url',
      image_url: DATA_URL,
    })
  })

  it('anthropic → LangChain standard {type:"image", source_type:"base64", ...}', async () => {
    expect(await injectedImageBlock('anthropic')).toEqual({
      type: 'image',
      source_type: 'base64',
      mime_type: MIME,
      data: DATA,
    })
  })

  it('google → LangChain standard block (ChatGoogle decodes it → inlineData)', async () => {
    expect(await injectedImageBlock('google')).toEqual({
      type: 'image',
      source_type: 'base64',
      mime_type: MIME,
      data: DATA,
    })
  })

  it('every provider still emits a recognizable image block type (pruner keeps recognizing it)', async () => {
    for (const p of ['openai', 'openrouter', 'ollama', 'anthropic', 'google'] as LlmProvider[]) {
      const block = await injectedImageBlock(p)
      expect(block.type === 'image' || block.type === 'image_url').toBe(true)
    }
  })
})
