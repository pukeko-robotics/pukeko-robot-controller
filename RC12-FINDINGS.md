# RC-12 measurement — run 2026-09-18, emulator, live Claude Sonnet 5

28 turns, 4.8 minutes wall clock, one navigation task in the `phase-one-arena`
simulated world. Profile: the shipped hosted shape — `context-pruner`
(`keepLatestImages: 1`, `maxContextTokens: 130000`), `frontend-images`,
`observability`, `cache: true`. Dumps: `logs/rc12-2026-09-18T12-42-08-861Z/`.

**Why the emulator is a valid instrument here, and why sonnet.** In the simulated
world `captureUrlForWorld` sources *both* Before/After frames from the emulator's
`GET /capture`, so Chromium's fake camera is out of the loop and the composite is
made of real rendered pixels. The model had to be Sonnet 5: Anthropic's minimum
cacheable prefix is 1024 tokens for Sonnet 5 but **4096 for Haiku 4.5**, and this
repo's system prompt (~1887) plus tool schemas (~1285) is ~3172 — on haiku, which
is what `it-robot.js` defaults to under `E2E_LIVE`, caching could never engage and
the run would have reported the cache as broken for a reason that had nothing to
do with the code.

## Finding 1 — the O(N²) image blow-up is GONE. Fix-direction #3 is not needed.

`keepLatestImages: 1` holds: **exactly one image block in history on every turn**,
all 28 of them. Per-turn input tokens rose 5,995 → 28,500, and the growth is
linear-to-*decelerating*, not quadratic:

| fit | result |
|---|---|
| linear | **943 tokens/turn**, R² = 0.970 |
| quadratic | x² coefficient **−14.9** (negative — decelerating), R² = 0.983 |
| first difference | mean 834/turn; **first half 1061, second half 622** |

A quadratic blow-up needs a positive x² coefficient and a *rising* first
difference. Both say the opposite. What remains is ordinary linear text growth —
thinking blocks, tool results, the motion log — not image bytes.

**So fix-direction #3 (downscale the composite image) has no measurement behind it
and should not be built.** The lever it was reaching for is no longer the one that
matters.

## Finding 2 — `cache: true` has never done anything. The opt-in is inert.

**Every one of the 28 turns reported `cache_creation_input_tokens: 0` and
`cache_read_input_tokens: 0`.** Not a TTL miss — turns were seconds apart, far
inside the 5-minute window. The cache was never even *written*.

Cause, read off `@langchain/anthropic` 1.5.10: its `invocationParams` builds
`cache_control: options?.cache_control` — per-invocation call options — and there
is **no `this.cache_control` anywhere in the implementation**. The constructor
field exists in the `.d.ts`, so `server/createLlm.ts` type-checks and looks
correct, but nothing ever reads it. (`...this.invocationKwargs` is spread *before*
that line, so routing it through `invocationKwargs` is clobbered too.)

Measured, not just read — `rc12-cache-probe.ts`, three arms, same 4,740-token
prompt:

| arm | wiring | cache_creation | cache_read |
|---|---|---:|---:|
| A | constructor `cache_control` — **what `createLlm.ts` does today** | **0** | **0** |
| B | per-call `options` | **4,738** | 0 |
| C | per-call `options`, repeated | 0 | **4,738** |

Arm C is the control: it proves the mechanism works end to end when the value is
passed where the library reads it, which rules out "caching just doesn't work
here". A is the shipped wiring and it is inert.

### What it costs

This session billed **516,552 uncached input tokens** and 21,856 output — about
**$1.25** at Sonnet 5 rates ($2/$10 per MTok). On each turn the stable prefix is
approximately the previous turn's entire input; summed, that is 488,052 tokens
that should have billed at 0.1× rather than 1×. Fixing the wiring should take the
session's input cost from ~$1.03 to roughly $0.30 — **a ~60–70% cut**, on a
one-line change.

## What this says about the attention item

`docs/attention/2026-07-23-rc-12-robot-cost-remeasure-blocked-on-credit.md` says
the measurement "needs the real hardware" because a stub run reproduces neither
the token growth nor the cache-TTL misses. The first half is answered — the
emulator reproduces the image path exactly. The second half was aimed at the wrong
mechanism: **the cache never engages at all**, so TTL was never the variable.

The item's other premise — that physical motion makes turns slow enough to blow
the 5-minute TTL — is also worth retiring. Andrew's correction stands: the LLM
dominates per-turn wall clock. This session's 28 turns took 4.8 minutes, roughly
10 s/turn, and Anthropic's own guidance says an agent loop whose turns run well
under 5 minutes keeps a 5-minute entry warm indefinitely, because every read
refreshes the timer.

## Caveat on absolute numbers

Emulator frames are 448×384 (measured, matching `TILE_PX 32 × 14×12` tiles);
`composeBeforeAfter` sizes the composite from its sources with no cap, giving
924×420 ≈ 517 image tokens. The real webcam path downscales to a 640px long edge,
so hardware composites are ~1308×516 ≈ 900 tokens. **Emulator runs therefore
understate per-image cost by about 1.74×** — a deterministic function of known
dimensions, so it is a correction to apply, not a guess. Neither size crosses
Anthropic's 1568px resize threshold. Both findings above are about *shape* and
*wiring*, and neither depends on that factor.
