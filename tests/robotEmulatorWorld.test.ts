import { describe, it, expect } from 'vitest'
import {
  CM_PER_CELL,
  HEADINGS,
  MAX_SCAN_CELLS,
  MIN_DISTANCE_CM,
  PHASE_ONE_MAP,
  createWorld,
  distanceCm,
  initialState,
  move,
  rotate,
  turn,
  type RobotWorldState,
  type WorldMap,
} from '../robot-emulator/world.js'

/**
 * The world model is pure, so the behaviours that actually decide whether the emulator is
 * honest — stopping AT a wall, dying ON the abyss cell that was reached — can be asserted
 * directly, with no server and no timing.
 */

/** A one-row corridor, so "the cell it reaches" is unambiguous in every case below. */
function corridor(rows: string[], start: RobotWorldState['heading'] = 'east'): WorldMap {
  return { id: 'corridor', rows, start: { x: 0, y: 0, heading: start } }
}

describe('heading arithmetic', () => {
  it('turns right through all four cardinals and wraps', () => {
    expect(rotate('north', 1)).toBe('east')
    expect(rotate('east', 1)).toBe('south')
    expect(rotate('south', 1)).toBe('west')
    expect(rotate('west', 1)).toBe('north')
  })

  it('turns left through all four cardinals and wraps', () => {
    expect(rotate('north', -1)).toBe('west')
    expect(rotate('west', -1)).toBe('south')
    expect(rotate('south', -1)).toBe('east')
    expect(rotate('east', -1)).toBe('north')
  })

  it('is the identity after four quarter-turns in either direction, from any start', () => {
    // Pin the loop's driver first. HEADINGS comes from the module under test, so an empty or
    // shortened list would make every assertion below run zero times and pass by scanning nothing.
    expect([...HEADINGS]).toEqual(['north', 'east', 'south', 'west'])

    for (const heading of HEADINGS) {
      expect(rotate(heading, 4)).toBe(heading)
      expect(rotate(heading, -4)).toBe(heading)
      expect(rotate(heading, 8)).toBe(heading)
    }
  })

  it('wraps a multi-turn command past the end of the cycle', () => {
    // The discriminating case: a naive index bump without the modulo goes out of range here.
    expect(rotate('west', 3)).toBe('south')
    expect(rotate('north', -3)).toBe('east')
    expect(rotate('south', 7)).toBe('east')
  })

  it('turn() applies the requested number of quarter-turns without moving the robot', () => {
    const world = createWorld(corridor(['....']))
    const start = initialState(world)
    const right = turn(start, 'right', 3)
    expect(right.state.heading).toBe('north')
    expect(right.state.x).toBe(start.x)
    expect(right.state.y).toBe(start.y)

    expect(turn(start, 'left', 1).state.heading).toBe('north')
  })
})

describe('stepwise movement', () => {
  it('stops AT a wall two cells away rather than teleporting past it', () => {
    // Robot at x=0 facing east; hard obstacle at x=3. A five-step move must end at x=2.
    const world = createWorld(corridor(['...#..']))
    const result = move(world, initialState(world), 'forward', 5)

    expect(result.state.x).toBe(2)
    expect(result.stepsTaken).toBe(2)
    expect(result.blockedSteps).toBe(3)
    expect(result.outcome).toBe('blocked')
    expect(result.state.destroyed).toBe(false)
  })

  it('reports a block that happens on the very first step without moving at all', () => {
    const world = createWorld(corridor(['.#....']))
    const result = move(world, initialState(world), 'forward', 4)

    expect(result.state.x).toBe(0)
    expect(result.stepsTaken).toBe(0)
    expect(result.blockedSteps).toBe(4)
    expect(result.outcome).toBe('blocked')
  })

  it('treats the edge of the world as a hard block and not a crash', () => {
    const world = createWorld(corridor(['...']))
    const atEdge: RobotWorldState = { x: 2, y: 0, heading: 'east', destroyed: false }
    const result = move(world, atEdge, 'forward', 3)

    expect(result.state).toMatchObject({ x: 2, y: 0, destroyed: false })
    expect(result.stepsTaken).toBe(0)
    expect(result.blockedSteps).toBe(3)
    expect(result.outcome).toBe('blocked')
    expect(result.detail).toContain('edge of the world')
  })

  it('walks backward along the heading axis without turning', () => {
    const world = createWorld(corridor(['.....']))
    const middle: RobotWorldState = { x: 3, y: 0, heading: 'east', destroyed: false }
    const result = move(world, middle, 'backward', 2)

    expect(result.state).toMatchObject({ x: 1, y: 0, heading: 'east' })
    expect(result.outcome).toBe('moved')
  })

  it('takes every step when the path is clear', () => {
    const world = createWorld(corridor(['......']))
    const result = move(world, initialState(world), 'forward', 4)
    expect(result).toMatchObject({ stepsTaken: 4, blockedSteps: 0, outcome: 'moved' })
    expect(result.state.x).toBe(4)
  })
})

describe('the abyss', () => {
  it('kills the robot on the abyss cell it reaches, not at the end of the requested path', () => {
    // This is the case a single-jump implementation gets wrong: it would look only at x=5,
    // an ordinary floor cell, and report a clean five-cell move.
    const world = createWorld(corridor(['..~...']))
    const result = move(world, initialState(world), 'forward', 5)

    expect(result.state.x).toBe(2)
    expect(result.state.y).toBe(0)
    expect(result.stepsTaken).toBe(2)
    expect(result.state.destroyed).toBe(true)
    expect(result.outcome).toBe('destroyed')
    expect(result.detail).toContain('run is over')
  })

  it('keeps reporting the run as over and does not move afterwards', () => {
    const world = createWorld(corridor(['.~....']))
    const dead = move(world, initialState(world), 'forward', 2).state
    expect(dead.destroyed).toBe(true)

    const again = move(world, dead, 'forward', 3)
    expect(again.outcome).toBe('run_over')
    expect(again.stepsTaken).toBe(0)
    expect(again.state).toMatchObject({ x: 1, y: 0, destroyed: true })

    const backwards = move(world, again.state, 'backward', 1)
    expect(backwards.outcome).toBe('run_over')
    expect(backwards.state.x).toBe(1)

    const rotated = turn(again.state, 'left', 1)
    expect(rotated.outcome).toBe('run_over')
    expect(rotated.state.heading).toBe('east')
  })
})

describe('soft obstacles', () => {
  it('produces a partial move: the robot enters the cell and stops there', () => {
    const world = createWorld(corridor(['..s...']))
    const result = move(world, initialState(world), 'forward', 5)

    expect(result.state.x).toBe(2)
    expect(result.stepsTaken).toBe(2)
    expect(result.outcome).toBe('partial')
    expect(result.state.destroyed).toBe(false)
  })

  it('is recoverable — the robot can move off it again', () => {
    const world = createWorld(corridor(['..s...']))
    const snagged = move(world, initialState(world), 'forward', 5).state
    const onwards = move(world, snagged, 'forward', 2)

    expect(onwards.state.x).toBe(4)
    expect(onwards.outcome).toBe('moved')
  })
})

describe('/distance in world terms', () => {
  /**
   * THE SCALE ITSELF, IN ABSOLUTE CENTIMETRES.
   *
   * Every other assertion in this block is written as a multiple of `CM_PER_CELL`, which pins the
   * ratio between readings and nothing else: those constants could be any number at all and the
   * arithmetic would still agree with itself. The brief's actual requirement is that the reading
   * is "converted to the same centimetre-ish scale the stub currently fakes, so the ultrasonic
   * tool keeps meaning what it meant" — a statement about specific numbers, which can only be
   * tested against numbers written out independently of the module under test.
   */
  it('reports the stub centimetre scale in absolute numbers', () => {
    // One clear cell ahead reads 25.0 — the nominal value the stub's fake reading centred on.
    const oneClear = createWorld(corridor(['..#...']))
    expect(distanceCm(oneClear, initialState(oneClear))).toBe(25)

    // Two clear cells, so twice that.
    const twoClear = createWorld(corridor(['...#..']))
    expect(distanceCm(twoClear, initialState(twoClear))).toBe(50)

    // A blocking cell immediately ahead reads 2.0 — the firmware's own floor, which the stub
    // reproduces as Math.max(2, ...).
    const blocked = createWorld(corridor(['.#....']))
    expect(distanceCm(blocked, initialState(blocked))).toBe(2)

    // Open ground reads the 8-cell scan cap, 200 cm, and never more.
    const open = createWorld(corridor(['.'.repeat(30)]))
    expect(distanceCm(open, initialState(open))).toBe(200)
  })

  it('counts the clear cells ahead up to the first blocking cell', () => {
    const world = createWorld(corridor(['...#..']))
    expect(distanceCm(world, initialState(world))).toBe(2 * CM_PER_CELL)
  })

  it('reports the floor value when a blocking cell is immediately ahead', () => {
    const world = createWorld(corridor(['.#....']))
    expect(distanceCm(world, initialState(world))).toBe(MIN_DISTANCE_CM)
  })

  it('treats the edge of the world as blocking', () => {
    const world = createWorld(corridor(['..']))
    const atEdge: RobotWorldState = { x: 1, y: 0, heading: 'east', destroyed: false }
    expect(distanceCm(world, atEdge)).toBe(MIN_DISTANCE_CM)
    expect(distanceCm(world, { ...atEdge, heading: 'west' })).toBe(CM_PER_CELL)
  })

  it('sees a soft obstacle but sees straight over an abyss', () => {
    // A forward-facing ultrasonic gets an echo from something standing up, and nothing at all
    // from a hole in the floor. The sensor cannot warn about the fatal terrain, by design.
    const soft = createWorld(corridor(['..s#..']))
    expect(distanceCm(soft, initialState(soft))).toBe(1 * CM_PER_CELL)

    const overAbyss = createWorld(corridor(['..~#..']))
    expect(distanceCm(overAbyss, initialState(overAbyss))).toBe(2 * CM_PER_CELL)
  })

  it('agrees with the world in every direction from one spot', () => {
    const world = createWorld({
      id: 'cross',
      rows: ['..#..', '.....', '#....', '.....', '..#..'],
      start: { x: 2, y: 2, heading: 'north' },
    })
    const at: RobotWorldState = { x: 2, y: 2, heading: 'north', destroyed: false }
    expect(distanceCm(world, at)).toBe(1 * CM_PER_CELL)
    expect(distanceCm(world, { ...at, heading: 'south' })).toBe(1 * CM_PER_CELL)
    expect(distanceCm(world, { ...at, heading: 'west' })).toBe(1 * CM_PER_CELL)
    // Nothing ahead to the east but two clear cells and then the edge.
    expect(distanceCm(world, { ...at, heading: 'east' })).toBe(2 * CM_PER_CELL)
  })

  it('caps the reportable range rather than scanning the whole world', () => {
    const world = createWorld(corridor(['.'.repeat(30)]))
    // 200 cm written out, not MAX_SCAN_CELLS * CM_PER_CELL: both of those come from the module
    // under test, so that form would hold for any pair of values.
    expect(distanceCm(world, initialState(world))).toBe(200)
    expect(MAX_SCAN_CELLS).toBe(8)
  })
})

describe('maps are data', () => {
  it('parses the shipped phase-one map and starts the robot on a drivable cell', () => {
    const world = createWorld(PHASE_ONE_MAP)
    expect(world.width).toBe(12)
    expect(world.height).toBe(9)
    expect(world.cells[world.start.y][world.start.x]).toBe('floor')
    expect(world.cells.flat()).toContain('abyss')
    expect(world.cells.flat()).toContain('targetRed')
    expect(world.cells.flat()).toContain('targetGreen')
  })

  it('defaults to the shipped map', () => {
    expect(createWorld().id).toBe('phase-one-arena')
    expect(PHASE_ONE_MAP.id).toBe('phase-one-arena')
  })

  it('refuses a ragged map rather than shifting every coordinate below the short row', () => {
    expect(() => createWorld({ id: 'ragged', rows: ['....', '..'], start: { x: 0, y: 0, heading: 'north' } })).toThrow(
      /row 1 is 2 cells wide/,
    )
  })

  it('refuses an unknown map character', () => {
    expect(() => createWorld({ id: 'bad', rows: ['..?.'], start: { x: 0, y: 0, heading: 'north' } })).toThrow(
      /unknown map character/,
    )
  })

  it('refuses a start cell the robot could not stand on', () => {
    expect(() => createWorld({ id: 'in-wall', rows: ['#...'], start: { x: 0, y: 0, heading: 'north' } })).toThrow(
      /start 0,0 is hard/,
    )
  })
})
