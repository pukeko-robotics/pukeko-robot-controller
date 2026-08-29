import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { Server } from 'node:http'
import jpegJs from 'jpeg-js'
import {
  createRobotEmulatorApp,
  type EmulatorState,
} from '../robot-emulator/robotEmulator.js'
import {
  MAX_STEPS,
  MOVEMENT_ENDPOINTS,
  TRICK_ENDPOINTS,
} from '../robot-protocol/robotProtocol.js'
import { CELL_PX, PALETTE, renderRaster } from '../robot-emulator/render.js'
import {
  CM_PER_CELL,
  MIN_DISTANCE_CM,
  createWorld,
  type WorldMap,
} from '../robot-emulator/world.js'

/**
 * A small, fully-known map. Every assertion below is written against these coordinates rather
 * than against the shipped arena, so a later edit to the shipped map cannot quietly make these
 * pass or fail for reasons unrelated to the behaviour under test.
 *
 *      x: 0    1    2    3    4    5    6    7
 *  y=0    .    .    .    .    .    .    .    .
 *  y=1    .    .    .    #    .    .    .    .
 *  y=2    .    .    .    .    .    .    .    .
 *  y=3    .    .    s    .    .    ~    .    .
 *  y=4    .    .    .    .    .    .    .    .
 *  y=5    r    .    .    .    .    .    .    g
 *
 * The robot is TWO CELLS SQUARE, anchored at its top-left cell. It starts anchored at 0,0 facing
 * east, so its body covers 0,0 · 1,0 · 0,1 · 1,1 and the wall at 3,1 is the first thing in its
 * way — under the body's lower-front corner, not under the cell the anchor would land on.
 */
const TEST_MAP: WorldMap = {
  id: 'emulator-spec-map',
  rows: ['........', '...#....', '........', '..s..~..', '........', 'r......g'],
  start: { x: 0, y: 0, heading: 'east' },
}

let server: Server
let state: EmulatorState
let baseUrl: string

beforeAll(async () => {
  const result = createRobotEmulatorApp({ map: TEST_MAP })
  state = result.state

  await new Promise<void>((resolve) => {
    server = result.app.listen(0, () => {
      const addr = server.address()
      if (addr && typeof addr !== 'string') baseUrl = `http://localhost:${addr.port}`
      resolve()
    })
  })
})

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve())
  })
})

beforeEach(async () => {
  await fetch(`${baseUrl}/reset`, { method: 'POST' })
})

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
      expect(typeof body.x).toBe('number')
      expect(typeof body.y).toBe('number')
      expect(body.runOver).toBe(false)
    }
  })

  it('clamps steps exactly as the firmware does', async () => {
    // 10 written out: MAX_STEPS is the constant under test, and the firmware's cap is 10.
    expect((await (await fetch(`${baseUrl}/turn_right?steps=999`)).json()).steps).toBe(10)
    expect(MAX_STEPS).toBe(10)
    expect((await (await fetch(`${baseUrl}/turn_right?steps=0`)).json()).steps).toBe(1)
    expect((await (await fetch(`${baseUrl}/turn_right?steps=abc`)).json()).steps).toBe(1)
    expect((await (await fetch(`${baseUrl}/turn_right`)).json()).steps).toBe(1)
  })

  it('answers every trick endpoint in place', async () => {
    for (const path of TRICK_ENDPOINTS) {
      const res = await fetch(`${baseUrl}${path}`)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.action).toBe(path.slice(1))
      expect(body).toMatchObject({ x: 0, y: 0 })
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

describe('movement over HTTP', () => {
  it('stops when ONE corner of the body meets the wall, not when the anchor does', async () => {
    // Facing east from 0,0 the second step would anchor at 2,0 — plain floor — while putting the
    // body's lower-front corner into the wall at 3,1. So the move ends anchored at 1,0. A
    // single-cell robot would have walked on to 2,0 and reported a clean two-step move.
    const body = await (await fetch(`${baseUrl}/forward?steps=5`)).json()
    expect(body).toMatchObject({ x: 1, y: 0, stepsTaken: 1, blockedSteps: 4, outcome: 'blocked' })
    expect(body.destroyed).toBe(false)
    expect(body.detail).toContain('3,1')
  })

  it('turns in 45-degree steps, so a right angle costs two of them', async () => {
    const one = await (await fetch(`${baseUrl}/turn_right?steps=1`)).json()
    expect(one.heading).toBe('southeast')
    expect(one.detail).toContain('45 degrees')
    expect(one.detail).not.toMatch(/quarter/i)

    const two = await (await fetch(`${baseUrl}/turn_right?steps=1`)).json()
    expect(two.heading).toBe('south')

    const back = await (await fetch(`${baseUrl}/turn_left?steps=2`)).json()
    expect(back.heading).toBe('east')

    // Eight steps is a full circle, so the robot ends up exactly where it started.
    const circle = await (await fetch(`${baseUrl}/turn_right?steps=8`)).json()
    expect(circle.heading).toBe('east')
  })

  it('walks the diagonals like a king, one cell on both axes per step', async () => {
    await fetch(`${baseUrl}/turn_right?steps=1`) // east -> southeast
    const downRight = await (await fetch(`${baseUrl}/forward?steps=1`)).json()
    expect(downRight).toMatchObject({ x: 1, y: 1, stepsTaken: 1, outcome: 'moved' })

    await fetch(`${baseUrl}/turn_right?steps=2`) // southeast -> southwest
    const downLeft = await (await fetch(`${baseUrl}/forward?steps=1`)).json()
    expect(downLeft).toMatchObject({ x: 0, y: 2, stepsTaken: 1, outcome: 'moved' })

    // Backward on a diagonal reverses it exactly, both axes at once.
    const back = await (await fetch(`${baseUrl}/backward?steps=1`)).json()
    expect(back).toMatchObject({ x: 1, y: 1, stepsTaken: 1, outcome: 'moved' })
  })

  it('snags on the soft cell under one corner, then dies on the abyss under another', async () => {
    await fetch(`${baseUrl}/turn_right?steps=2`) // facing south
    const down = await (await fetch(`${baseUrl}/forward?steps=2`)).json()
    expect(down).toMatchObject({ x: 0, y: 2, outcome: 'moved' })

    await fetch(`${baseUrl}/turn_left?steps=2`) // facing east again

    // The soft cell is at 2,3 — under the body's lower-front corner when the anchor is at 1,2.
    const snagged = await (await fetch(`${baseUrl}/forward?steps=5`)).json()
    expect(snagged).toMatchObject({ x: 1, y: 2, outcome: 'partial', destroyed: false })
    expect(snagged.stepsTaken).toBe(1)

    // Two cells wide, so it is still on that soft cell one step later.
    const stillSnagged = await (await fetch(`${baseUrl}/forward?steps=1`)).json()
    expect(stillSnagged).toMatchObject({ x: 2, y: 2, outcome: 'partial' })

    const clear = await (await fetch(`${baseUrl}/forward?steps=1`)).json()
    expect(clear).toMatchObject({ x: 3, y: 2, outcome: 'moved' })

    // The abyss at 5,3 catches the body's lower-front corner when the anchor reaches 4,2.
    const fatal = await (await fetch(`${baseUrl}/forward?steps=3`)).json()
    expect(fatal).toMatchObject({ x: 4, y: 2, outcome: 'destroyed', destroyed: true, runOver: true })
    expect(fatal.stepsTaken).toBe(1)
    expect(fatal.detail).toContain('5,3')

    const after = await (await fetch(`${baseUrl}/forward?steps=2`)).json()
    expect(after).toMatchObject({ x: 4, y: 2, stepsTaken: 0, outcome: 'run_over', runOver: true })

    const trick = await (await fetch(`${baseUrl}/dance`)).json()
    expect(trick).toMatchObject({ action: 'dance', outcome: 'run_over', runOver: true })

    const status = await (await fetch(`${baseUrl}/status`)).json()
    expect(status).toMatchObject({ x: 4, y: 2, destroyed: true, runOver: true })
  })

  it('reset restarts the run from the start cell, including after death', async () => {
    await fetch(`${baseUrl}/turn_right?steps=2`)
    await fetch(`${baseUrl}/forward?steps=2`)
    await fetch(`${baseUrl}/turn_left?steps=2`)
    await fetch(`${baseUrl}/forward?steps=5`)
    await fetch(`${baseUrl}/forward?steps=1`)
    await fetch(`${baseUrl}/forward?steps=1`)
    await fetch(`${baseUrl}/forward?steps=3`)
    expect(state.robot.destroyed).toBe(true)

    const reset = await (await fetch(`${baseUrl}/reset`, { method: 'POST' })).json()
    expect(reset).toMatchObject({ reset: true, x: 0, y: 0, heading: 'east', runOver: false })
    expect(state.commandHistory).toHaveLength(0)
  })
})

describe('/distance over HTTP', () => {
  it('keeps the firmware content type and one-decimal format', async () => {
    const res = await fetch(`${baseUrl}/distance`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/plain/)
    expect(await res.text()).toMatch(/^\d+\.\d$/)
  })

  it('serves the stub centimetre scale on the wire, in absolute numbers', async () => {
    // The exact bytes, not a multiple of a constant imported from the code being tested. This is
    // what pins the emulator to the scale the ultrasonic tool was calibrated against.
    //
    // Facing east the two front cells are 1,0 and 1,1. The upper one sees six clear cells to the
    // edge; the lower one meets the wall at 3,1 after one. The sensor reports the nearer, so a
    // two-cell-wide body is warned about the wall it would actually hit: 25.0, not 150.0.
    expect(await (await fetch(`${baseUrl}/distance`)).text()).toBe('25.0')

    await fetch(`${baseUrl}/turn_left?steps=2`) // facing north, straight at the edge
    expect(await (await fetch(`${baseUrl}/distance`)).text()).toBe('2.0')

    await fetch(`${baseUrl}/turn_right?steps=4`) // facing south: four clear cells, then the edge
    expect(await (await fetch(`${baseUrl}/distance`)).text()).toBe('100.0')
  })

  it('agrees with the world in front of the robot', async () => {
    expect(parseFloat(await (await fetch(`${baseUrl}/distance`)).text())).toBe(CM_PER_CELL)

    await fetch(`${baseUrl}/turn_left?steps=2`)
    expect(parseFloat(await (await fetch(`${baseUrl}/distance`)).text())).toBe(MIN_DISTANCE_CM)

    await fetch(`${baseUrl}/turn_right?steps=4`)
    expect(parseFloat(await (await fetch(`${baseUrl}/distance`)).text())).toBe(4 * CM_PER_CELL)
  })

  it('records the reading on /status', async () => {
    await fetch(`${baseUrl}/distance`)
    const status = await (await fetch(`${baseUrl}/status`)).json()
    expect(status.lastDistanceCm).toBe(25)
  })
})

/**
 * The renderer is asserted on DECODED PIXELS at coordinates the map above fixes, never on a
 * stored golden image. A byte comparison against a checked-in JPEG breaks on any encoder version
 * bump for no behavioural reason, and the lesson the next person draws from that is to delete
 * the test.
 */
describe('/capture', () => {
  /** JPEG is lossy; a flat block of colour survives comfortably inside this tolerance. */
  function expectColourAt(
    image: { width: number; data: Uint8Array },
    cellX: number,
    cellY: number,
    expected: readonly [number, number, number, number],
    /** Where inside the cell to sample, as a fraction. Defaults to the middle. */
    within: { fx: number; fy: number } = { fx: 0.5, fy: 0.5 },
    tolerance = 16,
  ) {
    // Sample inside the cell, away from the separator lines at its edges.
    const px = cellX * CELL_PX + Math.floor(CELL_PX * within.fx)
    const py = cellY * CELL_PX + Math.floor(CELL_PX * within.fy)
    const offset = (py * image.width + px) * 4
    const actual = [image.data[offset], image.data[offset + 1], image.data[offset + 2]]
    for (let channel = 0; channel < 3; channel++) {
      expect(
        Math.abs(actual[channel] - expected[channel]),
        `cell ${cellX},${cellY} channel ${channel}: got ${actual.join(',')}, expected ${expected.slice(0, 3).join(',')}`,
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

    // Absolute pixels: the spec map is 8 cells across and 6 down, drawn at 32 px per cell.
    // Expressed as `rows.length * CELL_PX` this would hold for any cell size, so the rendered
    // scale would have no coverage at all.
    expect(image.width).toBe(256)
    expect(image.height).toBe(192)
    expect(CELL_PX).toBe(32)

    // ...and the relationship, which is the property that must survive a change of map.
    expect(image.width).toBe(TEST_MAP.rows[0].length * CELL_PX)
    expect(image.height).toBe(TEST_MAP.rows.length * CELL_PX)
  })

  it('paints each kind of cell in its own colour', async () => {
    // The expected values are written out rather than read back from PALETTE on purpose. Taking
    // both sides of the comparison from the same constant makes the assertion a tautology: it
    // would go on passing through any recolouring, including one that made two kinds of cell
    // indistinguishable. Written out, this says what a reader can check against the map above —
    // the cell we know is the obstacle is purple.
    const image = await capture()
    expectColourAt(image, 5, 0, [255, 255, 255, 255]) // floor, white
    expectColourAt(image, 3, 1, [128, 0, 192, 255]) // hard obstacle, purple
    expectColourAt(image, 2, 3, [128, 128, 128, 255]) // soft obstacle, grey
    expectColourAt(image, 5, 3, [255, 216, 0, 255]) // abyss, yellow
    expectColourAt(image, 7, 5, [32, 176, 64, 255]) // green target
    expectColourAt(image, 0, 5, [220, 32, 32, 255]) // red target
  })

  it('keeps every terrain colour distinguishable from every other', () => {
    // The companion to the literals above: those pin what is drawn, this pins that no two things
    // an agent has to tell apart share a colour. The robot is not in this list any more because
    // it is not a colour — it is a photograph, and the tests below are what pin it.
    const drawn = ['floor', 'hard', 'soft', 'abyss', 'targetRed', 'targetGreen'] as const
    const seen = new Set(drawn.map((kind) => PALETTE[kind].slice(0, 3).join(',')))
    expect(seen.size).toBe(drawn.length)
  })

  it('draws a PHOTOGRAPH of the robot, not a flat marker', async () => {
    // The whole point of the node: a vision model does not recognise a flat black square as a
    // robot. The photographed chassis has a blue shell, so somewhere on the body there are
    // strongly blue pixels. A flat black, grey or white marker has blue-minus-red of zero
    // everywhere, and so does every terrain colour except the purple obstacle — which is why
    // this samples the robot's own cells and nothing else.
    const image = await capture()

    let bluest = -255
    for (let py = 0; py < CELL_PX * 2; py++) {
      for (let px = 0; px < CELL_PX * 2; px++) bluest = Math.max(bluest, blueness(image, px, py))
    }
    // Measured at ~155 on the real photograph; 60 is a floor with room for encoder drift.
    expect(bluest).toBeGreaterThan(60)

    // ...and it is not a flat fill of any one colour either: the body has to show structure.
    const samples = new Set<string>()
    for (let py = 8; py < CELL_PX * 2 - 8; py += 4) {
      for (let px = 8; px < CELL_PX * 2 - 8; px += 4) {
        const offset = (py * image.width + px) * 4
        samples.add([image.data[offset], image.data[offset + 1], image.data[offset + 2]].join(','))
      }
    }
    expect(samples.size).toBeGreaterThan(20)
  })

  it('covers a 2x2 footprint and leaves the cells beside it alone', async () => {
    // Anchored at 0,0, the body occupies 0,0 · 1,0 · 0,1 · 1,1. The far corner of that block is
    // the discriminating sample: on a one-cell robot 1,1 is plain white floor.
    const image = await capture()
    const floorWhite = [255, 255, 255, 255] as const

    const farCorner = (1 * CELL_PX + 16) * 1
    const offset = ((1 * CELL_PX + 16) * image.width + farCorner) * 4
    const atFarCorner = [image.data[offset], image.data[offset + 1], image.data[offset + 2]]
    // Every channel well away from white: the chassis is dark, the floor is 255,255,255.
    for (const channel of atFarCorner) expect(channel).toBeLessThan(160)

    // ...and the body stops there. The cells one step beyond it on both axes are untouched floor.
    expectColourAt(image, 2, 0, floorWhite)
    expectColourAt(image, 0, 2, floorWhite)
    expectColourAt(image, 2, 2, floorWhite)
  })

  it('composites the sprite over the terrain with alpha rather than punching a hole', async () => {
    // The photograph's corners are transparent. If they were blitted opaquely they would paint
    // the black they are stored as, which is exactly the black block this node exists to remove.
    // So the floor underneath must still be showing through at the corners of the footprint.
    const image = await capture()
    const floorWhite = [255, 255, 255, 255] as const

    for (const [px, py] of [
      [2, 2],
      [CELL_PX * 2 - 3, 2],
      [2, CELL_PX * 2 - 3],
      [CELL_PX * 2 - 3, CELL_PX * 2 - 3],
    ]) {
      const offset = (py * image.width + px) * 4
      const actual = [image.data[offset], image.data[offset + 1], image.data[offset + 2]]
      for (let channel = 0; channel < 3; channel++) {
        expect(
          Math.abs(actual[channel] - floorWhite[channel]),
          `footprint pixel ${px},${py}: got ${actual.join(',')}`,
        ).toBeLessThanOrEqual(16)
      }
    }
  })

  it('rotates the photograph to face each of the eight headings', async () => {
    /**
     * There is no painted triangle any more — the photograph carries the heading, because the
     * real chassis is visibly asymmetric front to back: the blue shell is the front and the bare
     * board and cable are the back. So the test measures exactly that asymmetry, comparing the
     * leading half of the body against the trailing half along a forward vector WRITTEN OUT BY
     * HAND. A test that read the vector back out of `DELTA` would agree with any rotation table,
     * including one that pointed every heading the same way.
     */
    const FORWARD = [
      { heading: 'east', fx: 1, fy: 0 },
      { heading: 'southeast', fx: 0.7071, fy: 0.7071 },
      { heading: 'south', fx: 0, fy: 1 },
      { heading: 'southwest', fx: -0.7071, fy: 0.7071 },
      { heading: 'west', fx: -1, fy: 0 },
      { heading: 'northwest', fx: -0.7071, fy: -0.7071 },
      { heading: 'north', fx: 0, fy: -1 },
      { heading: 'northeast', fx: 0.7071, fy: -0.7071 },
    ] as const

    /** Mean blue-minus-red ahead of the body's centre, minus the same behind it. */
    function frontMinusBack(
      image: { width: number; data: Uint8Array },
      fx: number,
      fy: number,
    ): number {
      const size = CELL_PX * 2
      let lead = 0
      let leadCount = 0
      let trail = 0
      let trailCount = 0
      for (let py = 0; py < size; py++) {
        for (let px = 0; px < size; px++) {
          const projection = (px - size / 2 + 0.5) * fx + (py - size / 2 + 0.5) * fy
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

    // The robot starts facing east, and each turn_right of one step advances 45 degrees, so the
    // hand-written list above is walked in order by eight single steps — a full circle.
    for (const { heading, fx, fy } of FORWARD) {
      const status = await (await fetch(`${baseUrl}/status`)).json()
      expect(status.heading, 'the turn sequence and the expected headings must stay in step').toBe(
        heading,
      )

      const image = await capture()
      // Measured at 42–46 on the real photograph, and it is 0 for a rotation-blind renderer.
      expect(frontMinusBack(image, fx, fy), `blue shell should lead when facing ${heading}`)
        .toBeGreaterThan(20)
      // The perpendicular axis carries no such signal, which is what makes the number above a
      // heading measurement rather than "the robot is somewhere in this square".
      expect(Math.abs(frontMinusBack(image, -fy, fx)), `no false signal across ${heading}`)
        .toBeLessThan(20)

      await fetch(`${baseUrl}/turn_right?steps=1`)
    }
  })
})

/**
 * Alpha compositing, asserted on the RAW raster rather than through the JPEG, because the
 * property is a few units of colour wide and the encoder is not.
 *
 * The footprint's outer corners are FULLY transparent, so a renderer that merely skipped
 * zero-alpha pixels and stamped everything else opaquely would still leave the floor showing
 * there — which means a corner sample cannot tell real compositing from a stamp. The fringe
 * around the chassis, where alpha is partial, is what distinguishes them: those pixels must take
 * their colour partly from the terrain underneath.
 */
describe('the robot sprite is composited with alpha, not stamped', () => {
  it('blends its semi-transparent fringe with whatever terrain is underneath', () => {
    const start = { x: 1, y: 1, heading: 'north' } as const
    const onFloor = createWorld({ id: 'on-floor', rows: ['....', '....', '....', '....'], start })
    const onGreen = createWorld({ id: 'on-green', rows: ['....', '.gg.', '.gg.', '....'], start })
    const robot = { x: 1, y: 1, heading: 'north' as const, destroyed: false }

    const overFloor = renderRaster(onFloor, robot)
    const overGreen = renderRaster(onGreen, robot)

    // Red channel only: white floor is 255 and the green target is 32, so the two terrains are
    // 223 apart and a pixel's blend fraction reads straight off the difference.
    let opaque = 0
    let terrain = 0
    let blended = 0
    for (let py = CELL_PX; py < CELL_PX * 3; py++) {
      for (let px = CELL_PX; px < CELL_PX * 3; px++) {
        const offset = (py * overFloor.width + px) * 4
        const difference = Math.abs(overFloor.data[offset] - overGreen.data[offset])
        if (difference <= 4) opaque++
        else if (difference >= 200) terrain++
        else blended++
      }
    }

    // All three populations must be non-trivial: solid chassis, bare terrain, and a real fringe
    // between them. Measured at roughly 2400 / 1400 / 270 of the footprint's 4096 pixels.
    expect(opaque).toBeGreaterThan(500)
    expect(terrain).toBeGreaterThan(500)
    expect(blended, 'the sprite fringe must take colour from the terrain beneath it').toBeGreaterThan(100)
  })
})
