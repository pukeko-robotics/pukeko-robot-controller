import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import {
  RobotSession,
  runRecipe,
  frameToEnvelope,
  coerceSteps,
  type RobotCapabilities,
} from '../src/robotSession/index.js'
import type { RobotToolDef, RecipeStep } from '../src/agent/robotPresets/index.js'
import { ACEBOTT_QD021_PRESET } from '../src/agent/robotPresets/index.js'

// --- test doubles ----------------------------------------------------------

// A recording fake `fetch`. Each response is queued (or a default 200 is
// returned); every call's URL is captured so recipe ordering can be asserted.
type FakeRes = { ok: boolean; status: number; body?: string; json?: unknown }

function makeFetch(opts?: {
  responses?: Record<string, FakeRes>
  throwOn?: (url: string) => Error | undefined
}) {
  const calls: string[] = []
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    calls.push(url)
    const thrown = opts?.throwOn?.(url)
    if (thrown) throw thrown
    // match by longest key that the url startsWith (so '/forward?steps=3' hits '/forward')
    const key = Object.keys(opts?.responses ?? {})
      .filter((k) => url.includes(k))
      .sort((a, b) => b.length - a.length)[0]
    const res: FakeRes = key ? opts!.responses![key] : { ok: true, status: 200, body: 'ok' }
    return {
      ok: res.ok,
      status: res.status,
      text: async () => res.body ?? '',
      json: async () => res.json ?? {},
    } as unknown as Response
  })
  return { fn, calls }
}

// A full RobotCapabilities backed by simple fakes. captureFrame returns a
// distinct data URL per call (Before then After); composeBeforeAfter returns a
// composite data URL by default.
function makeCaps(overrides?: Partial<RobotCapabilities>): {
  caps: RobotCapabilities
  fetchCalls: string[]
  captureFrame: ReturnType<typeof vi.fn>
  composeBeforeAfter: ReturnType<typeof vi.fn>
} {
  const frames = ['data:image/png;base64,BEFORE', 'data:image/png;base64,AFTER']
  let i = 0
  const captureFrame = vi.fn(() => frames[i++] ?? null)
  const composeBeforeAfter = vi.fn(
    async (_b: string, _a: string) => 'data:image/png;base64,COMPOSITE'
  )
  const { fn, calls } = makeFetch()
  const caps: RobotCapabilities = {
    isReady: () => true,
    captureFrame,
    composeBeforeAfter,
    fetch: fn as unknown as typeof fetch,
    robotHost: '192.168.4.1',
    robotUrl: (path: string) => `http://192.168.4.1${path}`,
    ...overrides,
  }
  return { caps, fetchCalls: calls, captureFrame, composeBeforeAfter }
}

function makeDef(recipe: RecipeStep[], clientEndpoint = '/forward'): RobotToolDef {
  return {
    name: 'move_forward',
    description: 'test',
    zodSchema: z.object({ steps: z.number().int().min(1).max(10).optional() }),
    fulfillment: 'client',
    clientEndpoint,
    recipe,
  }
}

// The recipe App.vue's runMotion used to hardcode (with the /stop halt).
const FULL_RECIPE: RecipeStep[] = [
  {
    step: 'captureFrame',
    as: 'before',
    failMessage: 'Failed to capture Before frame. Is the camera active?',
  },
  { step: 'http', path: { fromDef: 'clientEndpoint' }, withSteps: true },
  { step: 'http', path: '/stop', optional: true },
  { step: 'captureFrame', as: 'after', failMessage: 'Failed to capture After frame.' },
  { step: 'compose', before: 'before', after: 'after', as: 'composite' },
  { step: 'returnImage', from: 'composite' },
]

// The same recipe for a self-terminating-gait robot: no /stop step.
const NO_STOP_RECIPE: RecipeStep[] = FULL_RECIPE.filter(
  (s) => !(s.step === 'http' && s.path === '/stop')
)

// --- pure helpers ----------------------------------------------------------

describe('frameToEnvelope', () => {
  it('parses a valid image data URL into { mimeType, data }', () => {
    expect(frameToEnvelope('data:image/png;base64,ABC')).toEqual({
      mimeType: 'image/png',
      data: 'ABC',
    })
  })
  it('returns null for null / non-image / malformed input', () => {
    expect(frameToEnvelope(null)).toBeNull()
    expect(frameToEnvelope('data:text/plain;base64,ABC')).toBeNull()
    expect(frameToEnvelope('not a data url')).toBeNull()
  })
})

describe('coerceSteps', () => {
  it('defaults to 1 and clamps/floors to the 1..10 firmware range', () => {
    expect(coerceSteps(undefined)).toBe(1)
    expect(coerceSteps({})).toBe(1)
    expect(coerceSteps({ steps: 0 })).toBe(1)
    expect(coerceSteps({ steps: 3 })).toBe(3)
    expect(coerceSteps({ steps: 3.9 })).toBe(3)
    expect(coerceSteps({ steps: 50 })).toBe(10)
    expect(coerceSteps({ steps: 'x' })).toBe(1)
  })
})

// --- interpreter: individual step types ------------------------------------

describe('runRecipe — individual step types', () => {
  it('captureFrame: stores the frame; returns failMessage (+motion) when the camera is empty', async () => {
    const { caps } = makeCaps({ captureFrame: vi.fn(() => null) })
    const def = makeDef([
      { step: 'captureFrame', as: 'before', failMessage: 'no cam' },
      { step: 'returnImage', from: 'before' },
    ])
    const out = JSON.parse(await runRecipe(def, {}, caps))
    expect(out).toEqual({ error: 'no cam', motion: 'move_forward' })
  })

  it('http (motion): hits clientEndpoint with ?steps=N only when N>1', async () => {
    const { caps, fetchCalls } = makeCaps()
    const def = makeDef([
      { step: 'http', path: { fromDef: 'clientEndpoint' }, withSteps: true },
      { step: 'captureFrame', as: 'f', failMessage: 'x' },
      { step: 'returnImage', from: 'f' },
    ])
    await runRecipe(def, { steps: 4 }, caps)
    expect(fetchCalls).toEqual(['http://192.168.4.1/forward?steps=4'])

    const { caps: caps1, fetchCalls: calls1 } = makeCaps()
    await runRecipe(def, { steps: 1 }, caps1)
    expect(calls1).toEqual(['http://192.168.4.1/forward'])
  })

  it('http (non-optional): non-ok status aborts with the HTTP error', async () => {
    const { fn } = makeFetch({ responses: { '/forward': { ok: false, status: 503 } } })
    const { caps } = makeCaps({ fetch: fn as unknown as typeof fetch })
    const def = makeDef([{ step: 'http', path: { fromDef: 'clientEndpoint' } }])
    const out = JSON.parse(await runRecipe(def, {}, caps))
    expect(out).toEqual({ error: 'Robot returned HTTP 503 for /forward', motion: 'move_forward' })
  })

  it('http (non-optional): a thrown fetch aborts with the reach error naming the host', async () => {
    const { fn } = makeFetch({ throwOn: () => new Error('ECONNREFUSED') })
    const { caps } = makeCaps({ fetch: fn as unknown as typeof fetch })
    const def = makeDef([{ step: 'http', path: { fromDef: 'clientEndpoint' } }])
    const out = JSON.parse(await runRecipe(def, {}, caps))
    expect(out).toEqual({
      error: 'Failed to reach robot at 192.168.4.1: ECONNREFUSED',
      motion: 'move_forward',
    })
  })

  it('http (optional): ignores status and swallows a throw, continuing the recipe', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { fn, calls } = makeFetch({ throwOn: (u) => (u.includes('/stop') ? new Error('down') : undefined) })
    const { caps } = makeCaps({ fetch: fn as unknown as typeof fetch })
    const def = makeDef([
      { step: 'http', path: '/stop', optional: true },
      { step: 'captureFrame', as: 'f', failMessage: 'x' },
      { step: 'returnImage', from: 'f' },
    ])
    const out = JSON.parse(await runRecipe(def, {}, caps))
    expect(out.mimeType).toBe('image/png') // recipe completed despite the /stop throw
    expect(calls).toEqual(['http://192.168.4.1/stop'])
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('compose: passes the two named slots to composeBeforeAfter and stores the result', async () => {
    const { caps, composeBeforeAfter } = makeCaps()
    const def = makeDef([
      { step: 'captureFrame', as: 'before', failMessage: 'x' },
      { step: 'captureFrame', as: 'after', failMessage: 'x' },
      { step: 'compose', before: 'before', after: 'after', as: 'composite' },
      { step: 'returnImage', from: 'composite' },
    ])
    const out = JSON.parse(await runRecipe(def, {}, caps))
    expect(composeBeforeAfter).toHaveBeenCalledWith(
      'data:image/png;base64,BEFORE',
      'data:image/png;base64,AFTER'
    )
    expect(out.data).toBe('COMPOSITE')
  })

  it('compose: a thrown compose aborts with the compose error', async () => {
    const { caps } = makeCaps({
      composeBeforeAfter: vi.fn(async () => {
        throw new Error('canvas boom')
      }),
    })
    const def = makeDef([
      { step: 'captureFrame', as: 'before', failMessage: 'x' },
      { step: 'captureFrame', as: 'after', failMessage: 'x' },
      { step: 'compose', before: 'before', after: 'after', as: 'composite' },
      { step: 'returnImage', from: 'composite' },
    ])
    const out = JSON.parse(await runRecipe(def, {}, caps))
    expect(out).toEqual({
      error: 'Failed to compose Before/After image: canvas boom',
      motion: 'move_forward',
    })
  })

  it('returnImage: errors when the slot holds no valid frame', async () => {
    const { caps } = makeCaps({
      composeBeforeAfter: vi.fn(async () => null),
    })
    const def = makeDef([
      { step: 'captureFrame', as: 'before', failMessage: 'x' },
      { step: 'captureFrame', as: 'after', failMessage: 'x' },
      { step: 'compose', before: 'before', after: 'after', as: 'composite' },
      { step: 'returnImage', from: 'composite' },
    ])
    const out = JSON.parse(await runRecipe(def, {}, caps))
    expect(out).toEqual({ error: 'Invalid composite frame format', motion: 'move_forward' })
  })

  it('guards "Webcam not initialized" (no motion label) before running any step', async () => {
    const { caps } = makeCaps({ isReady: () => false })
    const out = JSON.parse(await runRecipe(makeDef(FULL_RECIPE), { steps: 2 }, caps))
    expect(out).toEqual({ error: 'Webcam not initialized' })
  })
})

// --- interpreter: the full multi-step recipe (runMotion parity) ------------

describe('runRecipe — full motion recipe reproduces the old runMotion envelope', () => {
  it('Before → /forward?steps=3 → /stop → After → compose → returnImage', async () => {
    const { caps, fetchCalls, captureFrame } = makeCaps()
    const out = JSON.parse(await runRecipe(makeDef(FULL_RECIPE), { steps: 3 }, caps))
    // exact envelope the pre-RC-7 runMotion produced
    expect(out).toEqual({
      mimeType: 'image/png',
      data: 'COMPOSITE',
      motion: 'move_forward (steps=3)',
    })
    // ordering: motion endpoint (with steps query) then the /stop halt
    expect(fetchCalls).toEqual([
      'http://192.168.4.1/forward?steps=3',
      'http://192.168.4.1/stop',
    ])
    expect(captureFrame).toHaveBeenCalledTimes(2)
  })

  it('a recipe omitting /stop produces the SAME envelope and never calls /stop', async () => {
    const { caps: full, fetchCalls: fullCalls } = makeCaps()
    const withStop = JSON.parse(await runRecipe(makeDef(FULL_RECIPE), { steps: 2 }, full))

    const { caps: lean, fetchCalls: leanCalls } = makeCaps()
    const noStop = JSON.parse(await runRecipe(makeDef(NO_STOP_RECIPE), { steps: 2 }, lean))

    expect(noStop).toEqual(withStop) // identical model-facing result
    // the /stop halt is absent for a self-terminating-gait robot
    expect(fullCalls).toContain('http://192.168.4.1/stop')
    expect(leanCalls).toEqual(['http://192.168.4.1/forward?steps=2'])
  })
})

// --- RobotSession service --------------------------------------------------

describe('RobotSession', () => {
  function session(overrides?: {
    caps?: Partial<RobotCapabilities>
    fetch?: typeof fetch
    agUiUrl?: string
  }) {
    const { caps } = makeCaps(overrides?.caps)
    const s = new RobotSession({
      robotHost: '192.168.4.1',
      agUiUrl: overrides?.agUiUrl,
      capabilities: {
        isReady: caps.isReady,
        captureFrame: caps.captureFrame,
        composeBeforeAfter: caps.composeBeforeAfter,
        fetch: overrides?.fetch ?? caps.fetch,
      },
    })
    return s
  }

  it('robotUrl builds http://host<path>', () => {
    expect(session().robotUrl('/forward')).toBe('http://192.168.4.1/forward')
  })

  it('clientTools = capture_image + the 4 preset motion tools, in order', () => {
    const names = session().clientTools.map((t) => t.name)
    expect(names).toEqual([
      'capture_image',
      'move_forward',
      'move_backward',
      'turn_left',
      'turn_right',
    ])
  })

  it('clientToolHandlers is keyed for capture_image + the 4 motion tools', () => {
    expect(Object.keys(session().clientToolHandlers).sort()).toEqual(
      ['capture_image', 'move_backward', 'move_forward', 'turn_left', 'turn_right'].sort()
    )
  })

  it('the move_forward handler runs the preset recipe end-to-end (envelope + motion)', async () => {
    const s = session()
    const out = JSON.parse(await s.clientToolHandlers.move_forward({ steps: 2 }))
    expect(out).toEqual({
      mimeType: 'image/png',
      data: 'COMPOSITE',
      motion: 'move_forward (steps=2)',
    })
  })

  it('the turn_left handler drives its own /turn_left endpoint via the shared recipe', async () => {
    const { caps } = makeCaps()
    const s = new RobotSession({
      robotHost: '192.168.4.1',
      capabilities: {
        isReady: caps.isReady,
        captureFrame: caps.captureFrame,
        composeBeforeAfter: caps.composeBeforeAfter,
        fetch: caps.fetch,
      },
    })
    await s.clientToolHandlers.turn_left({})
    const calls = (caps.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) =>
      String(c[0])
    )
    expect(calls[0]).toBe('http://192.168.4.1/turn_left')
    expect(calls).toContain('http://192.168.4.1/stop')
  })

  it('captureImage returns the current frame envelope', async () => {
    const out = JSON.parse(await session().captureImage())
    expect(out).toEqual({ mimeType: 'image/png', data: 'BEFORE' })
  })

  it('captureImage reports "Webcam not initialized" when not ready', async () => {
    const out = JSON.parse(
      await session({ caps: { isReady: () => false } }).captureImage()
    )
    expect(out).toEqual({ error: 'Webcam not initialized' })
  })

  it('captureImage reports a capture failure when the camera yields no frame', async () => {
    const out = JSON.parse(
      await session({ caps: { captureFrame: vi.fn(() => null) } }).captureImage()
    )
    expect(out).toEqual({ error: 'Failed to capture frame. Is the camera active?' })
  })

  // --- PLAT-13: the CopilotKit frontendTools registration shape ------------

  it('frontendTools mirrors clientTools: same names, order and descriptions', () => {
    const s = session()
    const fts = s.frontendTools()
    expect(fts.map((t) => t.name)).toEqual(s.clientTools.map((t) => t.name))
    expect(fts.map((t) => t.description)).toEqual(s.clientTools.map((t) => t.description))
  })

  it('frontendTools delivers each declaration JSON Schema VERBATIM via the Standard JSON Schema protocol', () => {
    const s = session()
    const fts = s.frontendTools()
    for (const [i, ft] of fts.entries()) {
      const declared = s.clientTools[i].parameters
      // CopilotKit's createToolSchema calls `~standard.jsonSchema.input(...)`
      // when present — this is what keeps the AG-UI run-input declaration
      // byte-identical to the bespoke path's (RC-1 client-authoritative text).
      const std = (
        ft.parameters as unknown as {
          '~standard': { jsonSchema: { input: (o: unknown) => unknown }; validate: unknown }
        }
      )['~standard']
      const emitted = std.jsonSchema.input({ target: 'draft-07' })
      expect(emitted).toEqual(declared)
      // ...and as a CLONE, so CopilotKit post-processing can't mutate presets.
      expect(emitted).not.toBe(declared)
      expect(typeof std.validate).toBe('function')
    }
  })

  it('frontendTools pins the WIRE shape through createToolSchema post-processing (review M1)', () => {
    // Replicates @copilotkit/core@1.61.0's (internal, unexported)
    // createToolSchema: take the Standard-JSON-Schema emission, strip a
    // top-level $schema, force-default type/properties, then recursively
    // DELETE every `additionalProperties`. Asserting THROUGH this pins the
    // actual run-input declaration, not just the input() emission — a future
    // preset using $schema/additionalProperties would fail here instead of
    // silently losing wire byte-identity.
    function stripAdditionalProperties(schema: unknown): void {
      if (!schema || typeof schema !== 'object') return
      if (Array.isArray(schema)) return schema.forEach(stripAdditionalProperties)
      const record = schema as Record<string, unknown>
      if (record.additionalProperties !== undefined) delete record.additionalProperties
      for (const value of Object.values(record)) stripAdditionalProperties(value)
    }
    function createToolSchemaReplica(parameters: unknown): Record<string, unknown> {
      const std = (
        parameters as { '~standard': { jsonSchema: { input: (o: unknown) => unknown } } }
      )['~standard']
      const rawSchema = std.jsonSchema.input({ target: 'draft-07' }) as Record<string, unknown>
      const { $schema: _dropped, ...schema } = rawSchema
      if (typeof schema.type !== 'string') schema.type = 'object'
      if (typeof schema.properties !== 'object' || schema.properties === null)
        schema.properties = {}
      stripAdditionalProperties(schema)
      return schema
    }

    const s = session()
    const fts = s.frontendTools()
    for (const [i, ft] of fts.entries()) {
      const wire = createToolSchemaReplica(ft.parameters)
      // The post-processed wire declaration must equal the bespoke-declared
      // JSON Schema byte-for-byte (today's presets use none of the keys the
      // post-processing touches, so it must be a no-op).
      expect(wire, ft.name).toEqual(s.clientTools[i].parameters)
    }
  })

  it('frontendTools handlers run the real fulfilment (motion recipe + capture envelope)', async () => {
    const s = session()
    const byName = Object.fromEntries(s.frontendTools().map((t) => [t.name, t]))
    const motion = JSON.parse(
      (await byName.move_forward.handler!({ steps: 2 }, {} as never)) as string
    )
    expect(motion).toEqual({
      mimeType: 'image/png',
      data: 'COMPOSITE',
      motion: 'move_forward (steps=2)',
    })
    const capture = JSON.parse(
      (await byName.capture_image.handler!({}, {} as never)) as string
    )
    // makeCaps' fake camera has already yielded BEFORE/AFTER to the motion
    // recipe above; the third frame is null → the frozen error envelope.
    expect(capture).toEqual({ error: 'Failed to capture frame. Is the camera active?' })
  })

  it('frontendTools applies wrapHandler around every real handler', async () => {
    const s = session()
    const wrappedNames: string[] = []
    const fired: string[] = []
    const fts = s.frontendTools({
      wrapHandler: (name, handler) => {
        wrappedNames.push(name)
        return async (args) => {
          fired.push(name)
          return handler(args)
        }
      },
    })
    expect(wrappedNames).toEqual(fts.map((t) => t.name))
    const capture = fts.find((t) => t.name === 'capture_image')!
    await capture.handler!({}, {} as never)
    expect(fired).toEqual(['capture_image'])
  })

  it('loadAgentInfo sets agentLabel from the injected AG-UI /info response', async () => {
    const { fn } = makeFetch({
      responses: { '/info': { ok: true, status: 200, json: { provider: 'anthropic', model: 'claude' } } },
    })
    const s = session({ fetch: fn as unknown as typeof fetch, agUiUrl: 'http://localhost:3000/agents/default/run' })
    await s.loadAgentInfo()
    expect(s.agentLabel.value).toBe('anthropic claude')
    expect(fn).toHaveBeenCalledWith('http://localhost:3000/info')
  })

  it('loadAgentInfo falls back to /config.json when no build-time URL is set', async () => {
    const { fn } = makeFetch({
      responses: {
        '/config.json': { ok: true, status: 200, json: { agUiUrl: 'http://h:9/agents/x/run' } },
        '/info': { ok: true, status: 200, json: { provider: 'openai', model: 'gpt' } },
      },
    })
    const s = session({ fetch: fn as unknown as typeof fetch })
    await s.loadAgentInfo()
    expect(s.agentLabel.value).toBe('openai gpt')
    expect(fn).toHaveBeenCalledWith('http://h:9/info')
  })
})

// --- sanity: the shipped preset actually carries recipes -------------------

describe('ACEBOTT-QD021 preset carries a recipe on each motion tool (RC-7)', () => {
  it('every client-fulfilled motion tool has a recipe ending in returnImage', () => {
    const motion = ACEBOTT_QD021_PRESET.tools.filter((t) => t.fulfillment === 'client')
    expect(motion.length).toBe(4)
    for (const def of motion) {
      expect(def.recipe, def.name).toBeDefined()
      expect(def.recipe!.at(-1)!.step).toBe('returnImage')
      // the /stop halt is present as DATA
      expect(def.recipe!.some((s) => s.step === 'http' && s.path === '/stop')).toBe(true)
    }
  })
})
