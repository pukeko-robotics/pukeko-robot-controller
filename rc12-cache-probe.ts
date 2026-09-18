// RC-12 cache probe — is `cache: true` actually doing anything?
//
// The 28-turn measurement session reported cache_creation_input_tokens: 0 and
// cache_read_input_tokens: 0 on every single turn, with `cache: true` set on the
// profile. Reading @langchain/anthropic 1.5.10's dist says why: its
// `invocationParams` builds `cache_control: options?.cache_control` and there is
// no `this.cache_control` anywhere in the implementation — the constructor field
// exists in the .d.ts (so `server/createLlm.ts` type-checks) but is never read.
//
// Reading dist is not proof, so this measures it. Three arms, same prompt, big
// enough to clear Sonnet 5's 1024-token minimum cacheable prefix:
//
//   A  constructor cache_control   — what createLlm.ts does today
//   B  per-call options            — what the library actually reads
//   C  second per-call invocation  — proves the entry from B can be READ back
//
// Arm C is the control that matters: without it, a nonzero cache_creation in B
// would show a write but not that the mechanism works end to end.

import { ChatAnthropic } from '@langchain/anthropic'

const SYSTEM = (
  'You are a test fixture for a prompt-caching probe. ' +
  'The following filler exists only to push this system prompt past the minimum ' +
  'cacheable prefix so that a cache entry is eligible to be created. '
).repeat(80)

type Usage = { cache_creation?: number; cache_read?: number; input?: number }

function read(res: { usage_metadata?: Record<string, unknown> }): Usage {
  const u = (res.usage_metadata ?? {}) as Record<string, unknown>
  const d = (u.input_token_details ?? {}) as Record<string, number>
  return { cache_creation: d.cache_creation, cache_read: d.cache_read, input: u.input_tokens as number }
}

const show = (label: string, u: Usage) =>
  console.log(
    `${label.padEnd(34)} input=${String(u.input).padStart(6)}  ` +
      `cache_creation=${String(u.cache_creation).padStart(6)}  cache_read=${String(u.cache_read).padStart(6)}`,
  )

const msgs = [
  { role: 'system' as const, content: SYSTEM },
  { role: 'user' as const, content: 'Reply with exactly the word: ok' },
]

// A — exactly how server/createLlm.ts wires it today.
const a = new ChatAnthropic({
  model: 'claude-sonnet-5',
  cache_control: { type: 'ephemeral' },
} as ConstructorParameters<typeof ChatAnthropic>[0])
show('A constructor cache_control', read(await a.invoke(msgs)))

// B — the same thing passed where the library actually reads it.
const b = new ChatAnthropic({ model: 'claude-sonnet-5' })
show('B per-call options', read(await b.invoke(msgs, { cache_control: { type: 'ephemeral' } } as never)))

// C — repeat B; a working cache serves this one from the entry B created.
show('C per-call options (repeat)', read(await b.invoke(msgs, { cache_control: { type: 'ephemeral' } } as never)))
