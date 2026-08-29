import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { runRecipe, type RobotCapabilities } from '../src/robotSession/index.js'
import type { RobotToolDef, RecipeStep } from '../src/agent/robotPresets/index.js'

// RC-44 task 1 — an ASYNCHRONOUS captureFrame must survive the recipe.
//
// The interpreter's capability contract used to declare `captureFrame(): string
// | null` and consume it without awaiting. An HTTP-backed capture source (a
// simulator serving rendered frames, or a robot's own snapshot endpoint) is
// necessarily async, and the old shape failed for it silently rather than
// loudly: the returned Promise is truthy, so `if (!frame)` lets it through, and
// it lands in the slots and then in composeBeforeAfter as though it were a
// `data:` URL. Nothing throws; the composite is simply wrong.
//
// So these specs assert on the VALUE that reaches composeBeforeAfter, not on
// the fact that it was called. The expected strings below are written out here
// by hand rather than read back off the fake, so a fake that stops resolving —
// or an interpreter that stops awaiting — cannot satisfy them.

const MOTION_RECIPE: RecipeStep[] = [
  {
    step: 'captureFrame',
    as: 'before',
    failMessage: 'Failed to capture Before frame. Is the camera active?',
  },
  { step: 'http', path: { fromDef: 'clientEndpoint' }, withSteps: true },
  { step: 'captureFrame', as: 'after', failMessage: 'Failed to capture After frame.' },
  { step: 'compose', before: 'before', after: 'after', as: 'composite' },
  { step: 'returnImage', from: 'composite' },
]

const DEF: RobotToolDef = {
  name: 'move_forward',
  description: 'test',
  zodSchema: z.object({ steps: z.number().int().min(1).max(10).optional() }),
  fulfillment: 'client',
  clientEndpoint: '/forward',
  recipe: MOTION_RECIPE,
}

/** Capabilities whose captureFrame is async, as an HTTP-backed source's is. */
function makeAsyncCaps(overrides?: Partial<RobotCapabilities>): {
  caps: RobotCapabilities
  composeBeforeAfter: ReturnType<typeof vi.fn>
} {
  const frames = ['data:image/png;base64,FIRSTFRAME', 'data:image/png;base64,SECONDFRAME']
  let index = 0
  const composeBeforeAfter = vi.fn(
    async (_before: string, _after: string) => 'data:image/jpeg;base64,COMPOSITEBYTES'
  )
  const caps: RobotCapabilities = {
    isReady: () => true,
    // Resolves on a later microtask, so an interpreter that forgets to await
    // cannot accidentally observe the value anyway.
    captureFrame: () => Promise.resolve().then(() => frames[index++] ?? null),
    composeBeforeAfter,
    fetch: vi.fn(async () => ({ ok: true, status: 200, text: async () => 'ok' }) as unknown as Response),
    robotHost: '192.168.4.1',
    robotUrl: (path: string) => `http://192.168.4.1${path}`,
    ...overrides,
  }
  return { caps, composeBeforeAfter }
}

describe('RC-44 — a Promise-returning captureFrame reaches composeBeforeAfter resolved', () => {
  it('hands composeBeforeAfter the two resolved data URLs, not two Promises', async () => {
    const { caps, composeBeforeAfter } = makeAsyncCaps()

    await runRecipe(DEF, {}, caps)

    expect(composeBeforeAfter).toHaveBeenCalledTimes(1)
    const [before, after] = composeBeforeAfter.mock.calls[0] as [unknown, unknown]
    // Typeof first: an un-awaited Promise is truthy and stringifies to
    // '[object Promise]', which is the exact shape of the silent failure.
    expect(typeof before).toBe('string')
    expect(typeof after).toBe('string')
    expect(before).toBe('data:image/png;base64,FIRSTFRAME')
    expect(after).toBe('data:image/png;base64,SECONDFRAME')
  })

  it('returns the composite envelope built from the resolved frames', async () => {
    const { caps } = makeAsyncCaps()

    const result = JSON.parse(await runRecipe(DEF, {}, caps))

    expect(result).toEqual({
      mimeType: 'image/jpeg',
      data: 'COMPOSITEBYTES',
      motion: 'move_forward',
    })
  })

  it('still reports the step failMessage when the Promise resolves to null', async () => {
    // The null guard has to bite THROUGH the await — a Promise resolving to
    // null is exactly what an unreachable HTTP snapshot source returns.
    const { caps } = makeAsyncCaps({ captureFrame: () => Promise.resolve(null) })

    const result = JSON.parse(await runRecipe(DEF, {}, caps))

    expect(result).toEqual({
      error: 'Failed to capture Before frame. Is the camera active?',
      motion: 'move_forward',
    })
  })

  it('still works for a synchronous captureFrame (the mounted webcam panel)', async () => {
    const frames = ['data:image/png;base64,SYNCBEFORE', 'data:image/png;base64,SYNCAFTER']
    let index = 0
    const { caps, composeBeforeAfter } = makeAsyncCaps({
      captureFrame: () => frames[index++] ?? null,
    })

    const result = JSON.parse(await runRecipe(DEF, { steps: 3 }, caps))

    expect(composeBeforeAfter).toHaveBeenCalledWith(
      'data:image/png;base64,SYNCBEFORE',
      'data:image/png;base64,SYNCAFTER'
    )
    expect(result).toEqual({
      mimeType: 'image/jpeg',
      data: 'COMPOSITEBYTES',
      motion: 'move_forward (steps=3)',
    })
  })
})
