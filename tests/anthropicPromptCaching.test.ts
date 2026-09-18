import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ChatAnthropic } from '@langchain/anthropic'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { createLlm } from '../server/createLlm.js'
import { toolFreeModel } from '../src/agent/toolFreeModel.js'

/**
 * RC-69 — `cache: true` on an anthropic profile actually reaches the request.
 *
 * **Why these assertions read the body handed to the Anthropic client and not the
 * fields on the model.** The defect this spec exists to prevent is precisely a field
 * that is stored and never sent. `@langchain/anthropic` declares `cache_control` on
 * its constructor input, so `new ChatAnthropic({ cache_control })` type-checks, stores
 * the value, and sends nothing — the implementation reads the key only from
 * per-invocation call options. A spec asserting "we passed `cache_control`" would have
 * been green for the whole life of the defect, because we did pass it; it just never
 * left the process. A live three-arm probe measured this: the constructor form wrote 0
 * cache tokens and read 0, the per-call form wrote 4,738 and then read 4,738 back.
 *
 * So the instrument here is the request object itself. `ChatAnthropic` builds its SDK
 * client through a `createClient` factory that it reads lazily, on the first request —
 * swapping that factory out on an already-constructed model captures the exact object
 * the library hands to `messages.create`, which is one `JSON.stringify` from the bytes
 * on the wire. That is past BOTH places the library merges `invocationKwargs`, so it
 * cannot be satisfied by a value that only looks right halfway down.
 *
 * The models under test are built by `createLlm` from an ordinary profile, so what is
 * measured is the production wiring rather than a second construction written to match.
 *
 * Nothing here touches the network: the fake client never makes a request, and `fetch`
 * is stubbed to throw so that an interception which failed to take would be a loud
 * failure rather than a live call.
 */

/** A message list big enough to be a normal request; its content is irrelevant here. */
const MESSAGES = [
  { role: 'system' as const, content: 'You are a fixture for a prompt-caching spec.' },
  { role: 'user' as const, content: 'ping' },
]

/** A minimal, well-formed non-streaming Anthropic response the library can parse. */
const CANNED_RESPONSE = {
  id: 'msg_rc69_fixture',
  type: 'message',
  role: 'assistant',
  model: 'claude-sonnet-5',
  content: [{ type: 'text', text: 'ok' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
}

type RequestBody = Record<string, unknown>

/** The `createClient` seam, as the library declares it on the instance. */
interface ClientFactoryHolder {
  createClient: (options: unknown) => unknown
}

/**
 * Replace the model's Anthropic client with one that records what it is asked to send.
 * Returns the array the bodies land in. The factory is read on the first request, so
 * this works on a model that is already built — which is the point: the model under
 * test is the one `createLlm` produced, untouched.
 */
function captureRequests(llm: BaseChatModel): RequestBody[] {
  const bodies: RequestBody[] = []
  const client = {
    messages: {
      create: async (body: RequestBody) => {
        bodies.push(body)
        return CANNED_RESPONSE
      },
    },
  }
  ;(llm as unknown as ClientFactoryHolder).createClient = () => client
  return bodies
}

/**
 * What survives `JSON.stringify`, which is what the SDK serialises. Round-tripping is
 * deliberate: a key whose value is `undefined` is dropped, so an absent breakpoint is
 * an absent key here rather than a present-but-empty one.
 */
async function wireBody(llm: BaseChatModel): Promise<RequestBody> {
  const bodies = captureRequests(llm)
  await llm.invoke(MESSAGES)
  expect(bodies, 'the fake client was never called — the interception did not take').toHaveLength(1)
  return JSON.parse(JSON.stringify(bodies[0])) as RequestBody
}

beforeEach(() => {
  // `createLlm` does not pass a key, so the constructor reads one from the environment.
  // Stubbing it also guarantees that no real credential is in play on a machine that
  // has one, and the value is never asserted on so it cannot reach the output either.
  vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-not-a-real-key')
  vi.stubGlobal('fetch', () => {
    throw new Error('RC-69 spec attempted a real network call')
  })
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('RC-69 anthropic prompt caching reaches the request', () => {
  it('sends a top-level cache_control when the profile sets cache: true', async () => {
    const { provider, llm } = createLlm({
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      cache: true,
    })

    expect(provider).toBe('anthropic')
    const body = await wireBody(llm)

    // The assertion the node turns on. A breakpoint that reaches this object is one
    // Anthropic is actually told about; one that stops at the model's fields is not.
    expect(body.cache_control).toEqual({ type: 'ephemeral' })
  })

  it('sends no cache_control when the profile does not opt in', async () => {
    // The control. Without it a wiring that always caches would pass the test above
    // while quietly changing the request on every profile, including the local ones
    // where the key means nothing.
    const { llm } = createLlm({ provider: 'anthropic', model: 'claude-sonnet-5' })

    const body = await wireBody(llm)

    expect('cache_control' in body).toBe(false)
  })

  it('still sends the tool_choice wiring alongside the breakpoint', async () => {
    // Prompt caching travels on a different channel from the tool controls, and the
    // two are assembled in the same place. This pins that adding one did not displace
    // the other — the interrupt-ordering fix that `tool_choice` carries is load-bearing.
    const { llm } = createLlm({
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      cache: true,
    })

    const body = await wireBody(llm)

    expect(body.tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: true })
    expect(body.model).toBe('claude-sonnet-5')
  })

  it('keeps caching across the tool-free rebuild the summarization sub-calls use', async () => {
    // `toolFreeModel` rebuilds the model from its own `lc_kwargs` to strip the
    // tool-only request params. A breakpoint carried on a field that rebuild drops
    // would silently stop caching on exactly the sub-calls that resend a transcript.
    const { llm } = createLlm({
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      cache: true,
    })

    const free = toolFreeModel(llm)
    expect(free).not.toBe(llm)
    expect(free).toBeInstanceOf(ChatAnthropic)

    const body = await wireBody(free)

    expect(body.cache_control).toEqual({ type: 'ephemeral' })
    expect('tool_choice' in body).toBe(false)
  })
})

describe('RC-69 the library channel this wiring is written against', () => {
  it('ignores a constructor cache_control on the pinned @langchain/anthropic', async () => {
    // Why the wiring cannot simply hand the value to the constructor, stated as a
    // measurement of the installed library rather than as a comment. This is also the
    // bump alarm: if a future `@langchain/anthropic` starts honouring the constructor
    // field, this goes red and the wiring above should be re-read against that version
    // before anything is simplified.
    //
    // The widening is deliberate and is half the story of the defect. `AnthropicInput`
    // does not declare `cache_control` at all — the key is declared only on the CALL
    // OPTIONS type, which is consistent with where the implementation reads it. What
    // let the broken wiring through the type checker was its spelling: a conditional
    // object spread, which TypeScript does not excess-property-check. Written as a
    // plain property it is a compile error. Reproducing it here needs the same escape
    // hatch, so it is written as an explicit cast rather than hidden in a spread.
    const shippedFields = {
      model: 'claude-sonnet-5',
      apiKey: 'sk-ant-not-a-real-key',
      cache_control: { type: 'ephemeral' },
    } as unknown as ConstructorParameters<typeof ChatAnthropic>[0]
    const direct = new ChatAnthropic(shippedFields)

    const body = await wireBody(direct)

    expect('cache_control' in body).toBe(false)
  })
})
