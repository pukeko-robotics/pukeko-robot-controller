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
import { CELL_PX, PALETTE } from '../robot-emulator/render.js'
import { CM_PER_CELL, MIN_DISTANCE_CM, type WorldMap } from '../robot-emulator/world.js'

/**
 * A small, fully-known map. Every assertion below is written against these coordinates rather
 * than against the shipped arena, so a later edit to the shipped map cannot quietly make these
 * pass or fail for reasons unrelated to the behaviour under test.
 *
 *      x: 0    1    2    3    4    5
 *  y=0    .    .    #    .    .    .
 *  y=1    .    s    .    ~    .    g
 *  y=2    r    .    .    .    .    .
 *
 * The robot starts at 0,0 facing east.
 */
const TEST_MAP: WorldMap = {
  id: 'emulator-spec-map',
  rows: ['..#...', '.s.~.g', 'r.....'],
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
    expect((await (await fetch(`${baseUrl}/turn_right?steps=999`)).json()).steps).toBe(MAX_STEPS)
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
  it('stops at the hard obstacle rather than passing through it', async () => {
    // Facing east from 0,0 the wall is at 2,0. Five steps must land on 1,0.
    const body = await (await fetch(`${baseUrl}/forward?steps=5`)).json()
    expect(body).toMatchObject({ x: 1, y: 0, stepsTaken: 1, blockedSteps: 4, outcome: 'blocked' })
    expect(body.destroyed).toBe(false)
  })

  it('dies on the abyss cell the path reaches, and stays dead', async () => {
    await fetch(`${baseUrl}/turn_right?steps=1`) // now facing south
    await fetch(`${baseUrl}/forward?steps=1`) // 0,1
    await fetch(`${baseUrl}/turn_left?steps=1`) // facing east again
    const fatal = await (await fetch(`${baseUrl}/forward?steps=5`)).json()

    // 1,1 is the soft obstacle, so this move stops there — not in the abyss yet.
    expect(fatal).toMatchObject({ x: 1, y: 1, outcome: 'partial', destroyed: false })

    const onwards = await (await fetch(`${baseUrl}/forward?steps=4`)).json()
    expect(onwards).toMatchObject({ x: 3, y: 1, outcome: 'destroyed', destroyed: true, runOver: true })
    expect(onwards.stepsTaken).toBe(2)

    const after = await (await fetch(`${baseUrl}/forward?steps=2`)).json()
    expect(after).toMatchObject({ x: 3, y: 1, stepsTaken: 0, outcome: 'run_over', runOver: true })

    const trick = await (await fetch(`${baseUrl}/dance`)).json()
    expect(trick).toMatchObject({ action: 'dance', outcome: 'run_over', runOver: true })

    const status = await (await fetch(`${baseUrl}/status`)).json()
    expect(status).toMatchObject({ x: 3, y: 1, destroyed: true, runOver: true })
  })

  it('reset restarts the run from the start cell, including after death', async () => {
    await fetch(`${baseUrl}/turn_right?steps=1`)
    await fetch(`${baseUrl}/forward?steps=1`)
    await fetch(`${baseUrl}/turn_left?steps=1`)
    await fetch(`${baseUrl}/forward?steps=5`)
    await fetch(`${baseUrl}/forward?steps=4`)
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

  it('agrees with the world in front of the robot', async () => {
    // Facing east from 0,0: one clear cell (1,0) and then the wall at 2,0.
    expect(parseFloat(await (await fetch(`${baseUrl}/distance`)).text())).toBe(CM_PER_CELL)

    // Facing north from 0,0 there is nothing but the edge.
    await fetch(`${baseUrl}/turn_left?steps=1`)
    expect(parseFloat(await (await fetch(`${baseUrl}/distance`)).text())).toBe(MIN_DISTANCE_CM)

    // Facing south: two clear cells (0,1 and 0,2) and then the edge.
    await fetch(`${baseUrl}/turn_left?steps=2`)
    expect(parseFloat(await (await fetch(`${baseUrl}/distance`)).text())).toBe(2 * CM_PER_CELL)
  })

  it('records the reading on /status', async () => {
    await fetch(`${baseUrl}/distance`)
    const status = await (await fetch(`${baseUrl}/status`)).json()
    expect(status.lastDistanceCm).toBe(CM_PER_CELL)
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

  it('serves a decodable JPEG sized to the world', async () => {
    const image = await capture()
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
    expectColourAt(image, 4, 0, [255, 255, 255, 255]) // floor, white
    expectColourAt(image, 2, 0, [128, 0, 192, 255]) // hard obstacle, purple
    expectColourAt(image, 1, 1, [128, 128, 128, 255]) // soft obstacle, grey
    expectColourAt(image, 3, 1, [255, 216, 0, 255]) // abyss, yellow
    expectColourAt(image, 5, 1, [32, 176, 64, 255]) // green target
    expectColourAt(image, 0, 2, [220, 32, 32, 255]) // red target
  })

  it('keeps the palette entries the drawing code uses distinguishable from one another', () => {
    // The companion to the literals above: those pin what is drawn, this pins that no two cell
    // kinds share a colour, which is the property an agent reading the image depends on.
    const terrain = ['floor', 'hard', 'soft', 'abyss', 'targetRed', 'targetGreen'] as const
    const seen = new Set(terrain.map((kind) => PALETTE[kind].slice(0, 3).join(',')))
    expect(seen.size).toBe(terrain.length)
  })

  it('draws the robot on its own cell and moves the marker when the robot moves', async () => {
    // Sample the trailing quarter of the cell: the robot's black body, behind the white
    // heading triangle. The middle of the cell would be white for both a robot facing this way
    // and an empty floor cell, which is exactly the confusion this test exists to rule out.
    const behind = { fx: 0.2, fy: 0.5 }

    const before = await capture()
    expectColourAt(before, 0, 0, PALETTE.robot, behind)
    expectColourAt(before, 1, 0, PALETTE.floor, behind)

    await fetch(`${baseUrl}/forward?steps=1`)

    const after = await capture()
    expectColourAt(after, 1, 0, PALETTE.robot, behind)
    expectColourAt(after, 0, 0, PALETTE.floor, behind)
  })

  it('shows an unambiguous heading indicator that rotates with the robot', async () => {
    /**
     * The triangle's apex sits at the leading edge of the robot's cell, so the light pixels
     * cluster on the side the robot faces. Comparing the two ends of an axis is what makes this
     * a heading test rather than a "something white is present" test.
     */
    async function leadingEdgeBrightness(cellX: number, cellY: number) {
      const image = await capture()
      const read = (px: number, py: number) => image.data[(py * image.width + px) * 4]
      const left = cellX * CELL_PX
      const top = cellY * CELL_PX
      const mid = Math.floor(CELL_PX / 2)
      return {
        north: read(left + mid, top + Math.floor(CELL_PX * 0.3)),
        south: read(left + mid, top + Math.floor(CELL_PX * 0.7)),
        west: read(left + Math.floor(CELL_PX * 0.3), top + mid),
        east: read(left + Math.floor(CELL_PX * 0.7), top + mid),
      }
    }

    // Start facing east at 0,0.
    const east = await leadingEdgeBrightness(0, 0)
    expect(east.east).toBeGreaterThan(east.west + 64)

    await fetch(`${baseUrl}/turn_right?steps=1`) // south
    const south = await leadingEdgeBrightness(0, 0)
    expect(south.south).toBeGreaterThan(south.north + 64)

    await fetch(`${baseUrl}/turn_right?steps=1`) // west
    const west = await leadingEdgeBrightness(0, 0)
    expect(west.west).toBeGreaterThan(west.east + 64)

    await fetch(`${baseUrl}/turn_right?steps=1`) // north
    const north = await leadingEdgeBrightness(0, 0)
    expect(north.north).toBeGreaterThan(north.south + 64)
  })
})
