import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import {
  captureUrlForWorld,
  createWorldCapabilities,
  createWorldSession,
  hostForWorld,
  resolveHost,
  DEFAULT_EMULATOR_HOST,
  DEFAULT_ROBOT_HOST,
  WORLDS,
  type WorldHosts,
  type WorldId,
} from '../src/robotSession/index.js'
import { ACEBOTT_QD021_PRESET } from '../src/agent/robotPresets/index.js'
import { makeSession } from '../src/App.vue'
import WorldPicker from '../src/components/WorldPicker.vue'

// RC-44 acceptance. The choice of world is a robot-TARGET choice: the emulated
// world only advances when the motion endpoints actually reach the emulator, so
// selecting it has to repoint the motion URLs as well as the frames.
//
// Every expected value below is written out by hand — the literal hosts, the
// literal URLs, the literal base64 of the bytes the fake server serves. None of
// them is read back off the module under test, so a helper that starts
// returning the wrong host cannot satisfy them by agreeing with itself.

/**
 * Hosts deliberately UNLIKE the shipped defaults, so a test that passed by
 * accidentally hitting a default would fail here.
 */
const HOSTS: WorldHosts = { robotHost: '10.0.0.7', emulatorHost: '127.0.0.1:9099' }

// 'HI' as bytes; base64 'SEk=' computed independently of the encoder under test.
const FRAME_BYTES = Uint8Array.from([0x48, 0x49])
const FRAME_DATA_URL = 'data:image/jpeg;base64,SEk='

/** A fake `fetch` that serves a JPEG for /capture and 200 OK for anything else. */
function makeFetch(opts?: { captureStatus?: number }) {
  const calls: string[] = []
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    calls.push(url)
    if (url.endsWith('/capture')) {
      const status = opts?.captureStatus ?? 200
      return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'image/jpeg' : null) },
        arrayBuffer: async () => FRAME_BYTES.buffer.slice(0),
      } as unknown as Response
    }
    return { ok: true, status: 200, text: async () => 'ok' } as unknown as Response
  })
  return { fn: fn as unknown as typeof fetch, calls }
}

/** A stand-in for the mounted <PkWebcamPanel>. */
function makePanel() {
  const composeBeforeAfter = vi.fn(
    async (_b: string, _a: string) => 'data:image/jpeg;base64,COMPOSITEBYTES'
  )
  return {
    captureFrame: vi.fn(() => 'data:image/png;base64,LIVEWEBCAMFRAME'),
    composeBeforeAfter,
  }
}

const MOVE_FORWARD = ACEBOTT_QD021_PRESET.tools.find((t) => t.name === 'move_forward')!

// --- host + URL resolution -------------------------------------------------

describe('RC-44 world hosts', () => {
  it('resolves each world to its own host', () => {
    expect(hostForWorld('real', HOSTS)).toBe('10.0.0.7')
    expect(hostForWorld('simulated', HOSTS)).toBe('127.0.0.1:9099')
  })

  it('gives the simulated world a snapshot URL and the real robot none', () => {
    expect(captureUrlForWorld('simulated', HOSTS)).toBe('http://127.0.0.1:9099/capture')
    // The real robot's frames come off the mounted panel's canvas, not HTTP.
    expect(captureUrlForWorld('real', HOSTS)).toBeNull()
  })

  it('ships defaults that match the robot AP and the emulator port', () => {
    // Written out rather than imported-and-compared: these two literals are the
    // contract with VITE_ROBOT_HOST and with ROBOT_EMULATOR_PORT's own default.
    expect(DEFAULT_ROBOT_HOST).toBe('192.168.4.1')
    expect(DEFAULT_EMULATOR_HOST).toBe('localhost:8081')
  })

  it('falls back when the env var is unset or blank, and trims when it is set', () => {
    expect(resolveHost(undefined, 'localhost:8081')).toBe('localhost:8081')
    expect(resolveHost('', 'localhost:8081')).toBe('localhost:8081')
    expect(resolveHost('   ', 'localhost:8081')).toBe('localhost:8081')
    expect(resolveHost(' sim.example:1234 ', 'localhost:8081')).toBe('sim.example:1234')
  })
})

// --- motion URLs follow the world -----------------------------------------

describe('RC-44 selecting a world repoints the MOTION urls', () => {
  async function runForwardIn(worldId: WorldId) {
    const panel = makePanel()
    const { fn, calls } = makeFetch()
    const capabilities = createWorldCapabilities({
      getWorldId: () => worldId,
      hosts: HOSTS,
      getWebcamPanel: () => panel,
      fetch: fn,
    })
    const session = createWorldSession({
      worldId,
      hosts: HOSTS,
      presetId: ACEBOTT_QD021_PRESET.id,
      capabilities,
    })
    const result = JSON.parse(await session.runMotion(MOVE_FORWARD, { steps: 2 }))
    return { calls, result, session }
  }

  it('sends the simulated world to the emulator host', async () => {
    const { calls, result } = await runForwardIn('simulated')

    // The exact wire calls, in order: Before frame, drive, halt, After frame.
    expect(calls).toEqual([
      'http://127.0.0.1:9099/capture',
      'http://127.0.0.1:9099/forward?steps=2',
      'http://127.0.0.1:9099/stop',
      'http://127.0.0.1:9099/capture',
    ])
    expect(result.motion).toBe('move_forward (steps=2)')
    // Nothing leaked to the real robot's address.
    expect(calls.some((url) => url.includes('10.0.0.7'))).toBe(false)
  })

  it('sends the real robot to the robot host and never fetches a frame', async () => {
    const { calls, result } = await runForwardIn('real')

    expect(calls).toEqual(['http://10.0.0.7/forward?steps=2', 'http://10.0.0.7/stop'])
    expect(result.motion).toBe('move_forward (steps=2)')
    // The webcam path takes no HTTP frame fetch at all.
    expect(calls.some((url) => url.endsWith('/capture'))).toBe(false)
  })

  it('exposes the selected world in robotUrl and robotHost', () => {
    const panel = makePanel()
    const { fn } = makeFetch()
    const capabilities = createWorldCapabilities({
      getWorldId: () => 'simulated',
      hosts: HOSTS,
      getWebcamPanel: () => panel,
      fetch: fn,
    })
    const sim = createWorldSession({ worldId: 'simulated', hosts: HOSTS, capabilities })
    const real = createWorldSession({ worldId: 'real', hosts: HOSTS, capabilities })

    expect(sim.robotHost).toBe('127.0.0.1:9099')
    expect(sim.robotUrl('/turn_left')).toBe('http://127.0.0.1:9099/turn_left')
    expect(real.robotHost).toBe('10.0.0.7')
    expect(real.robotUrl('/turn_left')).toBe('http://10.0.0.7/turn_left')
  })
})

// --- frames follow the world ----------------------------------------------

describe('RC-44 selecting a world repoints the CAPTURE source', () => {
  it('fetches the emulator snapshot and returns it as a data URL', async () => {
    const panel = makePanel()
    const { fn, calls } = makeFetch()
    const frames: (string | null)[] = []
    const capabilities = createWorldCapabilities({
      getWorldId: () => 'simulated',
      hosts: HOSTS,
      getWebcamPanel: () => panel,
      fetch: fn,
      onSimulatedFrame: (frame) => frames.push(frame),
    })

    const frame = await capabilities.captureFrame()

    expect(calls).toEqual(['http://127.0.0.1:9099/capture'])
    expect(frame).toBe(FRAME_DATA_URL)
    // The viewport is refreshed with the same frame the agent just received —
    // event-driven, off a capture the app was making anyway.
    expect(frames).toEqual([FRAME_DATA_URL])
    expect(panel.captureFrame).not.toHaveBeenCalled()
  })

  it('reads the real robot off the mounted webcam panel, with no fetch', async () => {
    const panel = makePanel()
    const { fn, calls } = makeFetch()
    const frames: (string | null)[] = []
    const capabilities = createWorldCapabilities({
      getWorldId: () => 'real',
      hosts: HOSTS,
      getWebcamPanel: () => panel,
      fetch: fn,
      onSimulatedFrame: (frame) => frames.push(frame),
    })

    const frame = await capabilities.captureFrame()

    expect(frame).toBe('data:image/png;base64,LIVEWEBCAMFRAME')
    expect(calls).toEqual([])
    expect(frames).toEqual([])
  })

  it('reports an unreachable emulator as a null frame, not a thrown error', async () => {
    const panel = makePanel()
    const { fn } = makeFetch({ captureStatus: 503 })
    const frames: (string | null)[] = []
    const capabilities = createWorldCapabilities({
      getWorldId: () => 'simulated',
      hosts: HOSTS,
      getWebcamPanel: () => panel,
      fetch: fn,
      onSimulatedFrame: (frame) => frames.push(frame),
    })

    expect(await capabilities.captureFrame()).toBeNull()
    // null is what the UI keys on to say "the simulator is not running" rather
    // than blaming the camera. The frozen envelope text is untouched.
    expect(frames).toEqual([null])
  })

  it('the capture URL follows the CURRENT world, not the one at construction', async () => {
    // One capabilities object for the app's lifetime, as App.vue builds it: the
    // snapshot source is constructed once and must still address whichever
    // world is selected now.
    const panel = makePanel()
    const { fn, calls } = makeFetch()
    let worldId: WorldId = 'real'
    const capabilities = createWorldCapabilities({
      getWorldId: () => worldId,
      hosts: HOSTS,
      getWebcamPanel: () => panel,
      fetch: fn,
    })

    // Constructed while 'real' is selected — and 'real' has no snapshot target.
    expect(capabilities.isReady()).toBe(true)
    expect(await capabilities.captureFrame()).toBe('data:image/png;base64,LIVEWEBCAMFRAME')
    expect(calls).toEqual([])

    worldId = 'simulated'
    expect(await capabilities.captureFrame()).toBe(FRAME_DATA_URL)
    expect(calls).toEqual(['http://127.0.0.1:9099/capture'])

    // ...and back again, on the same object.
    worldId = 'real'
    expect(await capabilities.captureFrame()).toBe('data:image/png;base64,LIVEWEBCAMFRAME')
    expect(calls).toEqual(['http://127.0.0.1:9099/capture'])
  })

  it('is not ready in either world while the webcam panel is unmounted', () => {
    // composeBeforeAfter lives on the panel and is needed for the motion
    // composite in BOTH worlds, so an unmounted panel is not ready even when
    // the frames would come from the emulator.
    const { fn } = makeFetch()
    for (const worldId of ['real', 'simulated'] as const) {
      const capabilities = createWorldCapabilities({
        getWorldId: () => worldId,
        hosts: HOSTS,
        getWebcamPanel: () => null,
        fetch: fn,
      })
      expect(capabilities.isReady()).toBe(false)
    }
  })

  it('composes simulated frames through the still-mounted webcam panel', async () => {
    // Trap 1: the panel is kept mounted precisely so this keeps working when
    // the frames are simulated and the camera is stopped.
    const panel = makePanel()
    const { fn } = makeFetch()
    const capabilities = createWorldCapabilities({
      getWorldId: () => 'simulated',
      hosts: HOSTS,
      getWebcamPanel: () => panel,
      fetch: fn,
    })

    const composite = await capabilities.composeBeforeAfter(
      'data:image/jpeg;base64,SIMBEFORE',
      'data:image/jpeg;base64,SIMAFTER'
    )

    expect(panel.composeBeforeAfter).toHaveBeenCalledWith(
      'data:image/jpeg;base64,SIMBEFORE',
      'data:image/jpeg;base64,SIMAFTER'
    )
    expect(composite).toBe('data:image/jpeg;base64,COMPOSITEBYTES')
  })
})

// --- the App.vue wiring seam ----------------------------------------------

describe('RC-44 App.vue makeSession passes the selection through', () => {
  // The world layer below this is covered thoroughly; these six lines of
  // pass-through were not. A single wrong identifier here — a hardcoded world
  // id, the wrong host set — would build every session for the real robot
  // however the picker is set, and leave the whole suite green. So each field
  // is asserted where it lands, against hand-written literals.

  function fixture(worldId: WorldId) {
    const panel = makePanel()
    const { fn, calls } = makeFetch()
    const capabilities = createWorldCapabilities({
      getWorldId: () => worldId,
      hosts: HOSTS,
      getWebcamPanel: () => panel,
      fetch: fn,
    })
    return { calls, capabilities, panel }
  }

  it('builds a simulated session against the emulator host', () => {
    const { capabilities } = fixture('simulated')

    const session = makeSession({
      worldId: 'simulated',
      presetId: ACEBOTT_QD021_PRESET.id,
      hosts: HOSTS,
      capabilities,
    })

    expect(session.robotHost).toBe('127.0.0.1:9099')
    expect(session.robotUrl('/forward')).toBe('http://127.0.0.1:9099/forward')
  })

  it('builds a real-robot session against the robot host', () => {
    const { capabilities } = fixture('real')

    const session = makeSession({
      worldId: 'real',
      presetId: ACEBOTT_QD021_PRESET.id,
      hosts: HOSTS,
      capabilities,
    })

    expect(session.robotHost).toBe('10.0.0.7')
    expect(session.robotUrl('/forward')).toBe('http://10.0.0.7/forward')
  })

  it('drives the emulator end to end for a simulated selection', async () => {
    // The pass-through proved on the wire rather than on a property: the
    // capabilities and the world both have to arrive for these URLs to appear.
    const { capabilities, calls } = fixture('simulated')

    const session = makeSession({
      worldId: 'simulated',
      presetId: ACEBOTT_QD021_PRESET.id,
      hosts: HOSTS,
      capabilities,
    })
    await session.runMotion(MOVE_FORWARD, { steps: 2 })

    expect(calls).toEqual([
      'http://127.0.0.1:9099/capture',
      'http://127.0.0.1:9099/forward?steps=2',
      'http://127.0.0.1:9099/stop',
      'http://127.0.0.1:9099/capture',
    ])
  })

  it('passes the preset id through to the session tool list', () => {
    const { capabilities } = fixture('real')

    const session = makeSession({
      worldId: 'real',
      presetId: ACEBOTT_QD021_PRESET.id,
      hosts: HOSTS,
      capabilities,
    })

    expect(session.presetId).toBe('ACEBOTT-QD021')
    expect(session.clientTools.map((t) => t.name)).toEqual([
      'capture_image',
      'move_forward',
      'move_backward',
      'turn_left',
      'turn_right',
    ])
  })

  it('passes the AG-UI url through, so the agent label is fetched from it', async () => {
    const { capabilities, calls } = fixture('real')

    const session = makeSession({
      worldId: 'real',
      presetId: ACEBOTT_QD021_PRESET.id,
      hosts: HOSTS,
      capabilities,
      agUiUrl: 'http://agui.example:4321/agents/default/run',
    })
    await session.loadAgentInfo()

    // /info is derived from the url that was handed in; a dropped agUiUrl would
    // instead fall back to fetching '/config.json'.
    expect(calls).toEqual(['http://agui.example:4321/info'])
  })
})

// --- the picker ------------------------------------------------------------

describe('WorldPicker', () => {
  it('offers both worlds, with the real robot first and selected by default', () => {
    const wrapper = mount(WorldPicker, { props: { worlds: WORLDS, modelValue: 'real' } })
    const options = wrapper.findAll('option')
    expect(options.map((o) => o.attributes('value'))).toEqual(['real', 'simulated'])
    expect(options.map((o) => o.text())).toEqual(['Real robot', 'Simulated world'])
    expect((wrapper.find('select').element as HTMLSelectElement).value).toBe('real')
  })

  it('emits the chosen world id on change', async () => {
    const wrapper = mount(WorldPicker, { props: { worlds: WORLDS, modelValue: 'real' } })
    await wrapper.find('select').setValue('simulated')
    expect(wrapper.emitted('update:modelValue')).toEqual([['simulated']])
  })
})
