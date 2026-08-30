import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { AddressInfo } from 'node:net'
import jpegJs from 'jpeg-js'
import {
  createEmulatorState,
  createRobotEmulatorApp,
  type EmulatorOptions,
  type EmulatorState,
} from '../robot-emulator/robotEmulator.js'
import {
  MAX_STEPS,
  MOVEMENT_ENDPOINTS,
  TRICK_ENDPOINTS,
} from '../robot-protocol/robotProtocol.js'
import { SPRITE_ORIENTATIONS, TILE_PX, PALETTE, renderRaster } from '../robot-emulator/render.js'
import { createWorld, type WorldMap } from '../robot-emulator/world.js'
import type { RobotPhysicalProfile } from '../src/agent/robotPresets/physical.js'

/**
 * A small, fully-known world. Every assertion below is written against these coordinates rather
 * than against the shipped arena, so a later edit to the shipped map cannot quietly make these
 * pass or fail for reasons unrelated to the behaviour under test.
 *
 * Tiles are 5 cm, so the map is 40 x 30 cm — and every number in this file that is not a tile
 * index or a pixel is CENTIMETRES.
 *
 *   tile      0     1     2     3     4     5     6     7      centimetres across
 *   y=0       .     .     .     .     .     .     .     .        0  5 10 15 20 25 30 35
 *   y=1       .     .     .     .     .     #     .     .      hard 25..30 across, 5..10 down
 *   y=2       .     .     .     .     .     #     .     .      hard 25..30 across, 10..15 down
 *   y=3       .     .     s     .     .     .     .     .      soft 10..15 across, 15..20 down
 *   y=4       .     ~     .     .     .     .     .     .      abyss 5..10 across, 20..25 down
 *   y=5       r     .     .     .     .     .     .     g
 *
 * The robot's BODY CENTRE starts at the centre of tile 1,1 — 7.5, 7.5 cm — facing east. Its body
 * is 10 cm square, so it spans 2.5..12.5 cm on both axes: the wall at 25 cm is the first thing in
 * its way, and it stops with its leading EDGE against the wall while its centre is still 5 cm
 * short of it.
 */
const TEST_MAP: WorldMap = {
  id: 'emulator-spec-map',
  rows: ['........', '.....#..', '.....#..', '..s.....', '.~......', 'r......g'],
  tileSizeCm: 5,
  start: { xTiles: 1, yTiles: 1, headingDeg: 90 },
}

/**
 * The robot the HTTP tests drive: the QD021's measurements with JITTER OFF, written out here so
 * that no assertion below depends on the preset registry. Jitter is asserted in its own right in
 * `robotEmulatorWorld.test.ts`; over HTTP it would only make every expected position fuzzy.
 */
const EXACT: RobotPhysicalProfile = {
  body: { widthCm: 10, lengthCm: 10 },
  motion: {
    forwardPerCycleCm: 1.5,
    backwardPerCycleCm: 1.3,
    turnDegreesPerCycle: 15,
    jitterFraction: 0,
  },
  sensor: { minRangeCm: 3, maxRangeCm: 400, beamAngleDegrees: 15 },
}

interface RunningApp {
  state: EmulatorState
  baseUrl: string
  close: () => Promise<void>
}

async function startApp(options: EmulatorOptions): Promise<RunningApp> {
  const { app, state } = createRobotEmulatorApp(options)
  const server = await new Promise<import('node:http').Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening))
  })
  const address = server.address() as AddressInfo
  return {
    state,
    baseUrl: `http://localhost:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

let running: RunningApp
let state: EmulatorState
let baseUrl: string

beforeAll(async () => {
  running = await startApp({ map: TEST_MAP, profile: EXACT })
  state = running.state
  baseUrl = running.baseUrl
})

afterAll(async () => {
  await running.close()
})

beforeEach(async () => {
  await fetch(`${baseUrl}/reset`, { method: 'POST' })
})

const json = async (path: string, init?: RequestInit) =>
  (await fetch(`${baseUrl}${path}`, init)).json()

describe('protocol compatibility with the firmware', () => {
  it('speaks the firmware endpoint set, written out', () => {
    // The two lists below drive the loops in this block, and they come from the module under
    // test — so an emptied or shortened list would make those loops iterate zero times and the
    // tests pass by checking nothing. Writing the endpoints out also states the protocol this
    // emulator claims to speak, which is the thing that must not drift from the firmware.
    expect([...MOVEMENT_ENDPOINTS]).toEqual(['/forward', '/backward', '/turn_left', '/turn_right'])
    expect([...TRICK_ENDPOINTS]).toEqual([
      '/sprint',
      '/dance',
      '/avoid',
      '/follow',
      '/kick_left',
      '/kick_right',
      '/tilt_left',
      '/tilt_right',
      '/stamp_left',
      '/stamp_right',
      '/ankles_left',
      '/ankles_right',
    ])
  })

  it('answers every movement endpoint with the firmware fields plus the spatial ones', async () => {
    for (const path of MOVEMENT_ENDPOINTS) {
      await fetch(`${baseUrl}/reset`, { method: 'POST' })
      const res = await fetch(`${baseUrl}${path}?steps=1`)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.action).toBe(path.slice(1))
      expect(body.steps).toBe(1)
      // Centimetres and degrees, named so. Integer cells and compass names are gone.
      expect(typeof body.xCm).toBe('number')
      expect(typeof body.yCm).toBe('number')
      expect(typeof body.headingDeg).toBe('number')
      expect(body.x).toBeUndefined()
      expect(body.heading).toBeUndefined()
      expect(body.runOver).toBe(false)
    }
  })

  it('clamps steps exactly as the firmware does', async () => {
    // 10 written out: MAX_STEPS is the constant under test, and the firmware's cap is 10.
    expect((await json('/turn_right?steps=999')).steps).toBe(10)
    expect(MAX_STEPS).toBe(10)
    expect((await json('/turn_right?steps=0')).steps).toBe(1)
    expect((await json('/turn_right?steps=abc')).steps).toBe(1)
    expect((await json('/turn_right')).steps).toBe(1)
  })

  it('answers every trick endpoint in place', async () => {
    for (const path of TRICK_ENDPOINTS) {
      const res = await fetch(`${baseUrl}${path}`)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.action).toBe(path.slice(1))
      expect(body).toMatchObject({ xCm: 7.5, yCm: 7.5 })
    }
  })

  it('sends the same CORS headers as the stub and answers a preflight with 204', async () => {
    const res = await fetch(`${baseUrl}/status`)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect(res.headers.get('access-control-allow-methods')).toBe('GET, POST, OPTIONS')
    expect(res.headers.get('access-control-allow-headers')).toBe('Content-Type')

    const preflight = await fetch(`${baseUrl}/forward`, { method: 'OPTIONS' })
    expect(preflight.status).toBe(204)
  })

  it('404s an unknown endpoint', async () => {
    const res = await fetch(`${baseUrl}/control?var=robot&val=1`)
    expect(res.status).toBe(404)
  })
})

describe('the emulator simulates the robot the PRESET describes', () => {
  it('takes its hardware from the default preset when nobody supplies one', () => {
    // The literals are the measured QD021 and are written out here rather than imported, so a
    // preset edited to say something else fails this rather than agreeing with itself.
    const fromRegistry = createEmulatorState()
    expect(fromRegistry.profile.body).toEqual({ widthCm: 10, lengthCm: 10 })
    expect(fromRegistry.profile.motion).toEqual({
      forwardPerCycleCm: 1.5,
      backwardPerCycleCm: 1.3,
      turnDegreesPerCycle: 15,
      jitterFraction: 0.015,
    })
    expect(fromRegistry.profile.sensor).toEqual({
      minRangeCm: 3,
      maxRangeCm: 400,
      beamAngleDegrees: 15,
    })
  })

  it('drives a different robot when handed one', async () => {
    // Same map, same commands, a robot with twice the stride and twice the turn: proof that the
    // preset is wired through the HTTP surface and not merely stored.
    const brisk = await startApp({
      map: TEST_MAP,
      profile: {
        ...EXACT,
        motion: { ...EXACT.motion, forwardPerCycleCm: 3, turnDegreesPerCycle: 30 },
      },
    })
    try {
      const moved = await (await fetch(`${brisk.baseUrl}/forward?steps=2`)).json()
      expect(moved.xCm).toBeCloseTo(13.5, 9)
      const turned = await (await fetch(`${brisk.baseUrl}/turn_right?steps=3`)).json()
      expect(turned.headingDeg).toBeCloseTo(180, 9)
    } finally {
      await brisk.close()
    }
    // ...and the standard robot covers 3 cm and turns 45 degrees on the same commands.
    expect((await json('/forward?steps=2')).xCm).toBeCloseTo(10.5, 9)
    expect((await json('/turn_right?steps=3')).headingDeg).toBeCloseTo(135, 9)
  })
})

describe('movement over HTTP', () => {
  it('stops when the BODY meets the wall, not when the centre does', async () => {
    // Facing east from 7.5, the leading edge is 5 cm ahead of the centre and the wall's near face
    // is at 25 cm, so the centre may reach 20. 7.5 + 1.5 x 8 = 19.5 is the last cycle that fits;
    // the ninth would put the edge at 26. A model that tested the centre tile walks to 25.5.
    const body = await json('/forward?steps=10')
    expect(body).toMatchObject({ cyclesTaken: 8, blockedCycles: 2, outcome: 'blocked' })
    expect(body.xCm).toBeCloseTo(19.5, 9)
    expect(body.destroyed).toBe(false)
    expect(body.detail).toContain('tile 5,1')
  })

  it('turns 15 degrees a cycle, so a right angle costs six of them', async () => {
    expect((await json('/turn_right?steps=1')).headingDeg).toBeCloseTo(105, 9)
    expect((await json('/turn_right?steps=5')).headingDeg).toBeCloseTo(180, 9)
    expect((await json('/turn_left?steps=6')).headingDeg).toBeCloseTo(90, 9)

    // Twenty-four cycles is a full circle, so the robot ends up exactly where it started.
    expect((await json('/turn_right?steps=10')).headingDeg).toBeCloseTo(240, 9)
    expect((await json('/turn_right?steps=10')).headingDeg).toBeCloseTo(30, 9)
    expect((await json('/turn_right?steps=4')).headingDeg).toBeCloseTo(90, 9)
  })

  it('reports the command, and never the distance actually achieved', async () => {
    const body = await json('/forward?steps=3')
    expect(body.detail).toContain('1.5 cm')
    expect(body.detail).not.toMatch(/4\.5 cm|travelled|actually/i)
  })

  it('moves at an angle, landing where no tile boundary is', async () => {
    // Three turn cycles is 45 degrees. Two forward cycles is 3 cm along it — 2.12 cm on each
    // axis, which is a position no cell-based model could hold.
    await fetch(`${baseUrl}/turn_right?steps=3`)
    const body = await json('/forward?steps=2')
    expect(body.headingDeg).toBeCloseTo(135, 9)
    expect(body.xCm).toBeCloseTo(7.5 + 3 * 0.7071067811865476, 9)
    expect(body.yCm).toBeCloseTo(7.5 + 3 * 0.7071067811865476, 9)
  })

  it('snags on the soft obstacle, and then falls into the abyss below it', async () => {
    // Facing south from 7.5, 7.5. The soft tile covers 10..15 cm across and 15..20 down; the
    // body spans 2.5..12.5 across, so its trailing edge catches the soft tile once the body's
    // lower edge passes 15 — at a centre of 10.5, the second cycle.
    await fetch(`${baseUrl}/turn_right?steps=6`)
    const snagged = await json('/forward?steps=10')
    expect(snagged).toMatchObject({ cyclesTaken: 2, outcome: 'partial', destroyed: false })
    expect(snagged.yCm).toBeCloseTo(10.5, 9)
    expect(snagged.detail).toContain('tile 2,3')

    // A 10 cm body overlapping a 5 cm soft tile is held by it for 10 cm of travel, so the next
    // several commands each manage exactly one cycle. It is recoverable, not fatal — until the
    // abyss at 20..25 cm down, which the CENTRE reaches at 21.
    const outcomes: string[] = []
    let last = snagged
    for (let command = 0; command < 12 && last.outcome === 'partial'; command++) {
      last = await json('/forward?steps=10')
      outcomes.push(last.outcome)
    }
    expect(outcomes.filter((outcome) => outcome === 'partial').length).toBeGreaterThan(3)
    expect(last).toMatchObject({ outcome: 'destroyed', destroyed: true, runOver: true })
    expect(last.yCm).toBeCloseTo(21, 9)
    expect(last.detail).toContain('tile 1,4')

    const after = await json('/forward?steps=2')
    expect(after).toMatchObject({ cyclesTaken: 0, outcome: 'run_over', runOver: true })
    expect(after.yCm).toBeCloseTo(21, 9)

    const trick = await json('/dance')
    expect(trick).toMatchObject({ action: 'dance', outcome: 'run_over', runOver: true })

    const status = await json('/status')
    expect(status).toMatchObject({ destroyed: true, runOver: true })
    expect(status.yCm).toBeCloseTo(21, 9)
  })

  it('reset restarts the run from the start pose, including after death', async () => {
    await fetch(`${baseUrl}/turn_right?steps=6`)
    for (let command = 0; command < 12; command++) await fetch(`${baseUrl}/forward?steps=10`)
    expect(state.robot.destroyed).toBe(true)

    const reset = await json('/reset', { method: 'POST' })
    expect(reset).toMatchObject({ reset: true, xCm: 7.5, yCm: 7.5, headingDeg: 90, runOver: false })
    expect(state.commandHistory).toHaveLength(0)
  })

  it('replays a run exactly from its seed, jitter and all', async () => {
    // The seed is part of the emulator's state, so two emulators built alike answer alike — which
    // is what makes a jittered run reproducible without turning jitter off.
    const jittery = { ...EXACT, motion: { ...EXACT.motion, jitterFraction: 0.015 } }
    const script = async (app: RunningApp) => {
      await fetch(`${app.baseUrl}/forward?steps=4`)
      await fetch(`${app.baseUrl}/turn_right?steps=3`)
      return (await (await fetch(`${app.baseUrl}/forward?steps=3`)).json()) as {
        xCm: number
        yCm: number
        headingDeg: number
      }
    }

    const first = await startApp({ map: TEST_MAP, profile: jittery, seed: 4242 })
    const same = await startApp({ map: TEST_MAP, profile: jittery, seed: 4242 })
    const other = await startApp({ map: TEST_MAP, profile: jittery, seed: 9999 })
    try {
      const a = await script(first)
      const b = await script(same)
      const c = await script(other)
      expect(b).toEqual(a)
      expect(c.xCm).not.toBe(a.xCm)
      // ...and jitter really was on, so the agreement above is not just exact arithmetic.
      expect(a.headingDeg).not.toBe(135)
    } finally {
      await Promise.all([first.close(), same.close(), other.close()])
    }
  })
})

describe('/distance over HTTP', () => {
  it('keeps the firmware content type and one-decimal format', async () => {
    const res = await fetch(`${baseUrl}/distance`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/plain/)
    expect(await res.text()).toMatch(/^\d+\.\d$/)
  })

  it('serves real centimetres, not multiples of a tile', async () => {
    // The sensor sits at the centre of the leading face, half a body length ahead of the centre:
    // 12.5 cm across, 7.5 down, facing east. The wall's near face is at 25, so the reading is
    // 12.5 — a number the old tile-denominated sensor could not produce at all.
    expect(await (await fetch(`${baseUrl}/distance`)).text()).toBe('12.5')

    // Facing north the sensor is 2.5 cm from the top of the world, which is inside the 3 cm
    // bumper, so the robot reports the closest thing it physically can.
    await fetch(`${baseUrl}/turn_left?steps=6`)
    expect(await (await fetch(`${baseUrl}/distance`)).text()).toBe('3.0')

    // Facing south the beam passes straight over the abyss — a hole reflects nothing back to a
    // forward-facing ultrasonic — and runs out of world 17.5 cm away. Two commands, because the
    // firmware caps `steps` at 10 and the emulator caps it identically.
    await fetch(`${baseUrl}/turn_right?steps=6`)
    await fetch(`${baseUrl}/turn_right?steps=6`)
    expect(await (await fetch(`${baseUrl}/distance`)).text()).toBe('17.5')
  })

  it('takes its floor and its ceiling from the robot, not from the map', async () => {
    const shortSighted = await startApp({
      map: TEST_MAP,
      profile: { ...EXACT, sensor: { minRangeCm: 3, maxRangeCm: 8, beamAngleDegrees: 15 } },
    })
    try {
      // The same 12.5 cm of open ground, seen by a sensor that cannot reach past 8 cm.
      expect(await (await fetch(`${shortSighted.baseUrl}/distance`)).text()).toBe('8.0')
    } finally {
      await shortSighted.close()
    }
  })

  it('records the reading on /status', async () => {
    await fetch(`${baseUrl}/distance`)
    const status = await json('/status')
    expect(status.lastDistanceCm).toBe(12.5)
    expect(status.tileSizeCm).toBe(5)
  })
})

/**
 * The renderer is asserted on DECODED PIXELS at coordinates the map above fixes, never on a
 * stored golden image. A byte comparison against a checked-in JPEG breaks on any encoder version
 * bump for no behavioural reason, and the lesson the next person draws from that is to delete
 * the test.
 *
 * The robot is drawn from CENTIMETRES: at 32 px to a 5 cm tile the scale is 6.4 px/cm, so the
 * 10 cm body is 64 px across and its centre at 7.5, 7.5 cm lands at pixel 48, 48. The pre-rotated
 * sprite lives on a 91 px square (the body's diagonal), so it is blitted at pixel 3, 3.
 */
describe('/capture', () => {
  /** JPEG is lossy; a flat block of colour survives comfortably inside this tolerance. */
  function expectColourAt(
    image: { width: number; data: Uint8Array },
    xTiles: number,
    yTiles: number,
    expected: readonly [number, number, number, number],
    tolerance = 16,
  ) {
    // Sample the middle of the tile, away from the separator lines at its edges.
    const px = xTiles * TILE_PX + TILE_PX / 2
    const py = yTiles * TILE_PX + TILE_PX / 2
    const offset = (py * image.width + px) * 4
    const actual = [image.data[offset], image.data[offset + 1], image.data[offset + 2]]
    for (let channel = 0; channel < 3; channel++) {
      expect(
        Math.abs(actual[channel] - expected[channel]),
        `tile ${xTiles},${yTiles} channel ${channel}: got ${actual.join(',')}, expected ${expected.slice(0, 3).join(',')}`,
      ).toBeLessThanOrEqual(tolerance)
    }
  }

  async function capture() {
    const res = await fetch(`${baseUrl}/capture`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/jpeg')
    const bytes = new Uint8Array(await res.arrayBuffer())
    // The JPEG start-of-image marker, so a body that is not a JPEG at all fails by name here
    // rather than somewhere inside the decoder.
    expect([bytes[0], bytes[1]]).toEqual([0xff, 0xd8])
    return jpegJs.decode(bytes, { useTArray: true })
  }

  /** Blue minus red at one pixel. The photographed chassis is blue-shelled; the terrain is not. */
  function blueness(image: { width: number; data: Uint8Array }, px: number, py: number): number {
    const offset = (py * image.width + px) * 4
    return image.data[offset + 2] - image.data[offset]
  }

  it('serves a decodable JPEG sized to the world', async () => {
    const image = await capture()

    // Absolute pixels: the spec map is 8 tiles across and 6 down, drawn at 32 px per tile.
    // Expressed as `rows.length * TILE_PX` this would hold for any tile size, so the rendered
    // scale would have no coverage at all.
    expect(image.width).toBe(256)
    expect(image.height).toBe(192)
    expect(TILE_PX).toBe(32)

    // ...and the relationship, which is the property that must survive a change of map.
    expect(image.width).toBe(TEST_MAP.rows[0].length * TILE_PX)
    expect(image.height).toBe(TEST_MAP.rows.length * TILE_PX)
  })

  it('paints each kind of tile in its own colour', async () => {
    // The expected values are written out rather than read back from PALETTE on purpose. Taking
    // both sides of the comparison from the same constant makes the assertion a tautology: it
    // would go on passing through any recolouring, including one that made two kinds of tile
    // indistinguishable. Written out, this says what a reader can check against the map above —
    // the tile we know is the obstacle is purple.
    const image = await capture()
    expectColourAt(image, 6, 0, [255, 255, 255, 255]) // floor, white
    expectColourAt(image, 5, 1, [128, 0, 192, 255]) // hard obstacle, purple
    expectColourAt(image, 2, 3, [128, 128, 128, 255]) // soft obstacle, grey
    expectColourAt(image, 1, 4, [255, 216, 0, 255]) // abyss, yellow
    expectColourAt(image, 7, 5, [32, 176, 64, 255]) // green target
    expectColourAt(image, 0, 5, [220, 32, 32, 255]) // red target
  })

  it('keeps every terrain colour distinguishable from every other', () => {
    // The companion to the literals above: those pin what is drawn, this pins that no two things
    // an agent has to tell apart share a colour. The robot is not in this list because it is not
    // a colour — it is a photograph, and the tests below are what pin it.
    const drawn = ['floor', 'hard', 'soft', 'abyss', 'targetRed', 'targetGreen'] as const
    const seen = new Set(drawn.map((kind) => PALETTE[kind].slice(0, 3).join(',')))
    expect(seen.size).toBe(drawn.length)
  })

  it('draws a PHOTOGRAPH of the robot, not a flat marker', async () => {
    // A vision model does not recognise a flat black square as a robot. The photographed chassis
    // has a blue shell, so somewhere on the body there are strongly blue pixels. A flat black,
    // grey or white marker has blue-minus-red of zero everywhere, and so does every terrain
    // colour except the purple obstacle — which is why this samples the robot's own pixels only.
    const image = await capture()

    let bluest = -255
    for (let py = 16; py < 80; py++) {
      for (let px = 16; px < 80; px++) bluest = Math.max(bluest, blueness(image, px, py))
    }
    // Measured at ~155 on the real photograph; 60 is a floor with room for encoder drift.
    expect(bluest).toBeGreaterThan(60)

    // ...and it is not a flat fill of any one colour either: the body has to show structure.
    const samples = new Set<string>()
    for (let py = 24; py < 72; py += 4) {
      for (let px = 24; px < 72; px += 4) {
        const offset = (py * image.width + px) * 4
        samples.add([image.data[offset], image.data[offset + 1], image.data[offset + 2]].join(','))
      }
    }
    expect(samples.size).toBeGreaterThan(20)
  })

  it('leaves the ground well clear of the body untouched', async () => {
    // The body is 10 cm on a 5 cm tile at 32 px, so 64 px, centred on pixel 48 — pixels 16..80.
    // Nothing wrote that 64 down: it is the body size divided by the tile size.
    const image = await capture()
    const floorWhite = [255, 255, 255, 255] as const
    expectColourAt(image, 3, 3, floorWhite)
    expectColourAt(image, 4, 0, floorWhite)
    expectColourAt(image, 0, 3, floorWhite)
  })

  it('draws the robot at the size its BODY says, in centimetres', () => {
    // The drawn size is derived — body centimetres divided by tile centimetres, times pixels per
    // tile — so doubling the body must quadruple the area it covers. Asserted on the raw raster
    // over an all-floor map, counting dark pixels: the floor is 255 and the separators are 200,
    // so only the chassis is dark. A renderer that drew a fixed 2x2-tile sprite gives one number
    // three times over.
    const open = createWorld(
      {
        id: 'open',
        rows: Array.from({ length: 10 }, () => '.'.repeat(10)),
        tileSizeCm: 5,
        start: { xTiles: 5, yTiles: 5, headingDeg: 0 },
      },
      EXACT.body,
    )
    const robot = { xCm: 27.5, yCm: 27.5, headingDeg: 0, destroyed: false, seed: 1 }
    const darkPixels = (bodyCm: number) => {
      const raster = renderRaster(
        open,
        { ...EXACT, body: { widthCm: bodyCm, lengthCm: bodyCm } },
        robot,
      )
      let dark = 0
      for (let offset = 0; offset < raster.data.length; offset += 4) {
        if (
          raster.data[offset] < 150 &&
          raster.data[offset + 1] < 150 &&
          raster.data[offset + 2] < 150
        ) {
          dark++
        }
      }
      return dark
    }

    const small = darkPixels(5)
    const standard = darkPixels(10)
    const large = darkPixels(20)
    expect(small).toBeGreaterThan(100)
    expect(standard / small).toBeGreaterThan(3.4)
    expect(standard / small).toBeLessThan(4.6)
    expect(large / standard).toBeGreaterThan(3.4)
    expect(large / standard).toBeLessThan(4.6)
  })

  it('moves the drawing by a SUB-TILE amount when the robot takes one cycle', async () => {
    // 1.5 cm at 6.4 px/cm is 9.6 px — plainly visible, and not a tile. A renderer that rounded
    // the pose to a tile would produce two identical frames here.
    const before = await capture()
    await fetch(`${baseUrl}/forward?steps=1`)
    const after = await capture()

    let changed = 0
    for (let py = 0; py < 96; py++) {
      for (let px = 0; px < 128; px++) {
        const offset = (py * before.width + px) * 4
        if (Math.abs(before.data[offset] - after.data[offset]) > 24) changed++
      }
    }
    expect(changed).toBeGreaterThan(200)
  })

  it('rotates the photograph to follow a continuous heading', async () => {
    /**
     * There is no painted triangle — the photograph carries the heading, because the real chassis
     * is visibly asymmetric front to back: the blue shell is the front and the bare board and
     * cable are the back. So this measures exactly that asymmetry, comparing the leading half of
     * the body against the trailing half along a forward vector WRITTEN OUT BY HAND. A test that
     * read the vector back out of `forwardVector` would agree with any rotation table, including
     * one that pointed every heading the same way.
     */
    const FORWARD = [
      { headingDeg: 90, fx: 1, fy: 0 },
      { headingDeg: 135, fx: 0.7071, fy: 0.7071 },
      { headingDeg: 180, fx: 0, fy: 1 },
      { headingDeg: 225, fx: -0.7071, fy: 0.7071 },
      { headingDeg: 270, fx: -1, fy: 0 },
      { headingDeg: 315, fx: -0.7071, fy: -0.7071 },
      { headingDeg: 0, fx: 0, fy: -1 },
      { headingDeg: 45, fx: 0.7071, fy: -0.7071 },
    ] as const

    /** Mean blue-minus-red ahead of the body's centre, minus the same behind it. */
    function frontMinusBack(
      image: { width: number; data: Uint8Array },
      fx: number,
      fy: number,
    ): number {
      let lead = 0
      let leadCount = 0
      let trail = 0
      let trailCount = 0
      for (let py = 16; py < 80; py++) {
        for (let px = 16; px < 80; px++) {
          const projection = (px - 48 + 0.5) * fx + (py - 48 + 0.5) * fy
          if (projection > 8) {
            lead += blueness(image, px, py)
            leadCount++
          } else if (projection < -8) {
            trail += blueness(image, px, py)
            trailCount++
          }
        }
      }
      return lead / leadCount - trail / trailCount
    }

    // The robot starts facing east, and three turn cycles is 45 degrees, so the hand-written list
    // above is walked in order by eight three-cycle turns — a full circle.
    for (const { headingDeg, fx, fy } of FORWARD) {
      const status = await json('/status')
      expect(status.headingDeg, 'the turn sequence and the expected headings must stay in step')
        .toBeCloseTo(headingDeg, 9)

      const image = await capture()
      // Measured at 41-47 on the real photograph, and it is 0 for a rotation-blind renderer.
      expect(frontMinusBack(image, fx, fy), `blue shell should lead at ${headingDeg} degrees`)
        .toBeGreaterThan(30)
      // The perpendicular axis carries no such signal, which is what makes the number above a
      // heading measurement rather than "the robot is somewhere in this square".
      expect(Math.abs(frontMinusBack(image, -fy, fx)), `no false signal across ${headingDeg}`)
        .toBeLessThan(20)

      await fetch(`${baseUrl}/turn_right?steps=3`)
    }
  })

  it('keeps twenty-four orientations, one per turn cycle', () => {
    // 360 / 24 is 15 degrees, which is the QD021's turn cycle — so a robot that has only ever
    // been turned is drawn exactly, and one carrying jitter is drawn at most 7.5 degrees out.
    // Raising this improves the picture and changes no behaviour; it is not a pose resolution.
    expect(SPRITE_ORIENTATIONS).toBe(24)
    expect(360 / SPRITE_ORIENTATIONS).toBe(15)
  })
})

/**
 * Alpha compositing, asserted on the RAW raster rather than through the JPEG, because the
 * property is a few units of colour wide and the encoder is not.
 *
 * The sprite canvas's outer corners are FULLY transparent, so a renderer that merely skipped
 * zero-alpha pixels and stamped everything else opaquely would still leave the floor showing
 * there — which means a corner sample cannot tell real compositing from a stamp. The fringe
 * around the chassis, where alpha is partial, is what distinguishes them: those pixels must take
 * their colour partly from the terrain underneath.
 */
describe('the robot sprite is composited with alpha, not stamped', () => {
  it('blends its semi-transparent fringe with whatever terrain is underneath', () => {
    const start = { xTiles: 2, yTiles: 2, headingDeg: 0 }
    const onFloor = createWorld(
      { id: 'on-floor', rows: ['......', '......', '......', '......', '......', '......'], tileSizeCm: 5, start },
      EXACT.body,
    )
    const onGreen = createWorld(
      { id: 'on-green', rows: ['......', '.gggg.', '.gggg.', '.gggg.', '.gggg.', '......'], tileSizeCm: 5, start },
      EXACT.body,
    )
    // Centre 15,15 cm is pixel 96,96, and the 91 px sprite canvas covers pixels 51..141.
    const robot = { xCm: 15, yCm: 15, headingDeg: 0, destroyed: false, seed: 1 }

    const overFloor = renderRaster(onFloor, EXACT, robot)
    const overGreen = renderRaster(onGreen, EXACT, robot)

    // Red channel only: white floor is 255 and the green target is 32, so the two terrains are
    // 223 apart and a pixel's blend fraction reads straight off the difference.
    let opaque = 0
    let terrain = 0
    let blended = 0
    for (let py = 64; py < 128; py++) {
      for (let px = 64; px < 128; px++) {
        const offset = (py * overFloor.width + px) * 4
        const difference = Math.abs(overFloor.data[offset] - overGreen.data[offset])
        if (difference <= 4) opaque++
        else if (difference >= 200) terrain++
        else blended++
      }
    }

    // All three populations must be non-trivial: solid chassis, bare terrain, and a real fringe
    // between them.
    expect(opaque).toBeGreaterThan(500)
    expect(terrain).toBeGreaterThan(200)
    expect(blended, 'the sprite fringe must take colour from the terrain beneath it').toBeGreaterThan(100)
  })
})
