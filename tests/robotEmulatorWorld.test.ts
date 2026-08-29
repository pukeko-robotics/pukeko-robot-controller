import { describe, it, expect } from 'vitest'
import {
  CM_PER_CELL,
  MAX_SCAN_CELLS,
  MIN_DISTANCE_CM,
  PHASE_ONE_MAP,
  createWorld,
  distanceCm,
  initialState,
  move,
  rotate,
  turn,
  type Heading,
  type RobotWorldState,
  type WorldMap,
} from '../robot-emulator/world.js'

/**
 * The world model is pure, so the behaviours that actually decide whether the emulator is
 * honest — stopping AT a wall, dying ON the abyss cell that was reached, refusing a move because
 * ONE corner of a two-cell-wide body is in it — can be asserted directly, with no server and no
 * timing.
 *
 * NOTHING IN THIS FILE BUILDS AN EXPECTED VALUE OUT OF THE MODULE UNDER TEST. The eight headings,
 * the eight deltas and the four footprint offsets are all written out by hand below, and no loop
 * is driven by a list imported from `world.ts`. The predecessor of this suite did the opposite
 * and shipped tests that could not fail: an expected value read back from the code being tested
 * agrees with that code no matter what the code says, and a loop over an imported list that has
 * been emptied iterates zero times and passes by checking nothing.
 */

/** The map's own start is used unless a test states otherwise. */
function arena(rows: string[], start: { x: number; y: number; heading: Heading }): WorldMap {
  return { id: 'arena', rows, start }
}

/** A robot placed by hand, so a test can stand it somewhere the map's start is not. */
function at(x: number, y: number, heading: Heading): RobotWorldState {
  return { x, y, heading, destroyed: false }
}

/**
 * The eight headings in clockwise order and the cell each one steps into, WRITTEN OUT BY HAND.
 *
 * This is the specification of the whole coordinate system, and it is the one thing that must
 * not be imported: taking these from `HEADINGS` and `DELTA` would make every assertion below
 * agree with any table at all, including a wrong one. `y` grows downwards, so north is -1.
 */
const EIGHT_HEADINGS = [
  { heading: 'north', dx: 0, dy: -1 },
  { heading: 'northeast', dx: 1, dy: -1 },
  { heading: 'east', dx: 1, dy: 0 },
  { heading: 'southeast', dx: 1, dy: 1 },
  { heading: 'south', dx: 0, dy: 1 },
  { heading: 'southwest', dx: -1, dy: 1 },
  { heading: 'west', dx: -1, dy: 0 },
  { heading: 'northwest', dx: -1, dy: -1 },
] as const satisfies readonly { heading: Heading; dx: number; dy: number }[]

/** The four cells a 2×2 footprint anchored at `x,y` occupies. Written out, not imported. */
function footprintOf(x: number, y: number): string[] {
  return [`${x},${y}`, `${x + 1},${y}`, `${x},${y + 1}`, `${x + 1},${y + 1}`]
}

describe('heading arithmetic — eight points, 45 degrees per step', () => {
  it('turns right one step at a time through all eight points and wraps', () => {
    expect(rotate('north', 1)).toBe('northeast')
    expect(rotate('northeast', 1)).toBe('east')
    expect(rotate('east', 1)).toBe('southeast')
    expect(rotate('southeast', 1)).toBe('south')
    expect(rotate('south', 1)).toBe('southwest')
    expect(rotate('southwest', 1)).toBe('west')
    expect(rotate('west', 1)).toBe('northwest')
    expect(rotate('northwest', 1)).toBe('north')
  })

  it('turns left one step at a time through all eight points and wraps', () => {
    expect(rotate('north', -1)).toBe('northwest')
    expect(rotate('northwest', -1)).toBe('west')
    expect(rotate('west', -1)).toBe('southwest')
    expect(rotate('southwest', -1)).toBe('south')
    expect(rotate('south', -1)).toBe('southeast')
    expect(rotate('southeast', -1)).toBe('east')
    expect(rotate('east', -1)).toBe('northeast')
    expect(rotate('northeast', -1)).toBe('north')
  })

  it('makes a right angle out of exactly two steps', () => {
    // The headline consequence of the change: one command step is 45 degrees, so the old
    // quarter-turn is now two of them. An implementation still stepping 90 degrees fails here.
    expect(rotate('north', 2)).toBe('east')
    expect(rotate('east', 2)).toBe('south')
    expect(rotate('north', -2)).toBe('west')
    expect(rotate('north', 4)).toBe('south')
  })

  it('is the identity after eight steps in either direction, from every point', () => {
    // The driver is the hand-written list above, so emptying anything in `world.ts` cannot make
    // this loop iterate zero times and pass by scanning nothing.
    for (const { heading } of EIGHT_HEADINGS) {
      expect(rotate(heading, 8)).toBe(heading)
      expect(rotate(heading, -8)).toBe(heading)
      expect(rotate(heading, 16)).toBe(heading)
    }
  })

  it('makes left and right exact inverses, from every point and at every size', () => {
    for (const { heading } of EIGHT_HEADINGS) {
      for (const steps of [1, 2, 3, 5, 7, 10]) {
        expect(rotate(rotate(heading, steps), -steps)).toBe(heading)
        expect(rotate(rotate(heading, -steps), steps)).toBe(heading)
      }
    }
  })

  it('wraps a multi-step command past the end of the cycle', () => {
    // A naive index bump without the modulo goes out of range on each of these.
    expect(rotate('west', 3)).toBe('northeast')
    expect(rotate('north', -3)).toBe('southwest')
    expect(rotate('south', 7)).toBe('southeast')
    expect(rotate('northwest', 10)).toBe('northeast')
  })

  it('turn() applies the requested 45-degree steps without moving the robot', () => {
    const world = createWorld(arena(['....', '....'], { x: 0, y: 0, heading: 'north' }))
    const start = initialState(world)

    const right = turn(start, 'right', 3)
    expect(right.state.heading).toBe('southeast')
    expect(right.state.x).toBe(start.x)
    expect(right.state.y).toBe(start.y)

    expect(turn(start, 'left', 3).state.heading).toBe('southwest')
    expect(turn(start, 'right', 2).state.heading).toBe('east')
  })

  it('tells the model the turn is in 45-degree steps, and never calls it a quarter-turn', () => {
    // The `detail` string is the entire interface to the agent. A model told a step is a
    // quarter-turn will over-rotate by double, so this asserts the words, not just the heading.
    const world = createWorld(arena(['....', '....'], { x: 0, y: 0, heading: 'north' }))
    const detail = turn(initialState(world), 'right', 3).detail

    expect(detail).toContain('45 degrees')
    expect(detail).toContain('135 degrees')
    expect(detail).toContain('southeast')
    expect(detail).not.toMatch(/quarter/i)
  })
})

describe('the robot steps one cell in any of eight directions, like a king', () => {
  /** Nine by nine of open floor, so a single step in any direction is legal from the middle. */
  const OPEN = ['.'.repeat(9), '.'.repeat(9), '.'.repeat(9), '.'.repeat(9), '.'.repeat(9), '.'.repeat(9), '.'.repeat(9), '.'.repeat(9), '.'.repeat(9)]

  it('moves forward exactly one cell along each of the eight headings', () => {
    const world = createWorld(arena(OPEN, { x: 4, y: 4, heading: 'north' }))

    for (const { heading, dx, dy } of EIGHT_HEADINGS) {
      const result = move(world, at(4, 4, heading), 'forward', 1)
      expect(result.outcome, heading).toBe('moved')
      expect(result.stepsTaken, heading).toBe(1)
      expect({ x: result.state.x, y: result.state.y }, heading).toEqual({ x: 4 + dx, y: 4 + dy })
    }
  })

  it('moves backward exactly one cell against each of the eight headings', () => {
    const world = createWorld(arena(OPEN, { x: 4, y: 4, heading: 'north' }))

    for (const { heading, dx, dy } of EIGHT_HEADINGS) {
      const result = move(world, at(4, 4, heading), 'backward', 1)
      expect(result.outcome, heading).toBe('moved')
      expect({ x: result.state.x, y: result.state.y }, heading).toEqual({ x: 4 - dx, y: 4 - dy })
      // Facing is never changed by walking backwards.
      expect(result.state.heading, heading).toBe(heading)
    }
  })

  it('reverses a diagonal step exactly', () => {
    const world = createWorld(arena(OPEN, { x: 4, y: 4, heading: 'north' }))

    for (const heading of ['northeast', 'southeast', 'southwest', 'northwest'] as const) {
      const forward = move(world, at(4, 4, heading), 'forward', 3)
      expect(forward.stepsTaken, heading).toBe(3)
      const back = move(world, forward.state, 'backward', 3)
      expect({ x: back.state.x, y: back.state.y }, heading).toEqual({ x: 4, y: 4 })
    }
  })

  it('takes a diagonal one cell at a time rather than sliding', () => {
    // Three steps southeast from 1,1 is 4,4 — a king three times over, not a bishop's slide and
    // not a knight's jump. The per-step landing points are pinned by the wall test below.
    const world = createWorld(arena(OPEN, { x: 1, y: 1, heading: 'southeast' }))
    const result = move(world, initialState(world), 'forward', 3)
    expect({ x: result.state.x, y: result.state.y }).toEqual({ x: 4, y: 4 })
    expect(result.stepsTaken).toBe(3)
  })

  it('overlaps the old footprint in exactly one cell on a diagonal step', () => {
    // The node asserts this rather than assuming it, because it is what makes a plain
    // destination-footprint test sufficient: the two cells that flank the shared corner are
    // themselves part of the destination footprint, so there is no corner to cut.
    const world = createWorld(arena(OPEN, { x: 2, y: 2, heading: 'southeast' }))
    const before = footprintOf(2, 2)
    const after = footprintOf(3, 3)
    expect(after.filter((cell) => before.includes(cell))).toEqual(['3,3'])

    const result = move(world, initialState(world), 'forward', 1)
    expect({ x: result.state.x, y: result.state.y }).toEqual({ x: 3, y: 3 })
  })

  it('refuses a diagonal step between two walls that touch only at a corner', () => {
    // Walls at 2,1 and 1,2. The destination footprint of a southeast step from 0,0 is
    // {1,1  2,1  1,2  2,2}, which contains both of them, so the step is refused.
    const world = createWorld(arena(['....', '..#.', '.#..', '....'], { x: 0, y: 0, heading: 'southeast' }))
    const blocked = move(world, initialState(world), 'forward', 1)
    expect(blocked.outcome).toBe('blocked')
    expect(blocked.stepsTaken).toBe(0)

    // And with the walls gone the same step succeeds, so the refusal above is due to them.
    const open = createWorld(arena(['....', '....', '....', '....'], { x: 0, y: 0, heading: 'southeast' }))
    expect(move(open, initialState(open), 'forward', 1).outcome).toBe('moved')
  })
})

/**
 * THE FOOTPRINT TESTS.
 *
 * Every case here is arranged so that the anchor cell the robot would move onto is clear and a
 * DIFFERENT corner of the 2×2 body is the one in trouble. That is what makes them worth writing:
 * a single-cell implementation looks only at the anchor, finds ordinary floor, and takes the step
 * — so each of these fails against the code this node replaced.
 */
describe('the whole 2x2 footprint is what gets tested', () => {
  it('is blocked when one corner hits a wall and the other three are clear', () => {
    // Facing east from 0,0, the destination footprint is {1,0  2,0  1,1  2,1}. Only 2,1 is a
    // wall — and 1,0, where a single-cell robot would be standing, is plain floor.
    const world = createWorld(arena(['.....', '..#..'], { x: 0, y: 0, heading: 'east' }))
    const result = move(world, initialState(world), 'forward', 4)

    expect({ x: result.state.x, y: result.state.y }).toEqual({ x: 0, y: 0 })
    expect(result.stepsTaken).toBe(0)
    expect(result.blockedSteps).toBe(4)
    expect(result.outcome).toBe('blocked')
    expect(result.state.destroyed).toBe(false)
    // The detail names the offending CELL, not the anchor, so the model can see what stopped it.
    expect(result.detail).toContain('2,1')
  })

  it('is destroyed when one corner reaches the abyss and the other three are clear', () => {
    // Same geometry, abyss at 2,1. The anchor 1,0 is floor, so a single-cell robot walks past.
    const world = createWorld(arena(['.....', '..~..'], { x: 0, y: 0, heading: 'east' }))
    const result = move(world, initialState(world), 'forward', 4)

    expect({ x: result.state.x, y: result.state.y }).toEqual({ x: 1, y: 0 })
    expect(result.stepsTaken).toBe(1)
    expect(result.state.destroyed).toBe(true)
    expect(result.outcome).toBe('destroyed')
    expect(result.detail).toContain('2,1')
    expect(result.detail).toContain('run is over')
  })

  it('stops partially when one corner reaches a soft obstacle and the other three are clear', () => {
    const world = createWorld(arena(['.....', '..s..'], { x: 0, y: 0, heading: 'east' }))
    const result = move(world, initialState(world), 'forward', 4)

    expect({ x: result.state.x, y: result.state.y }).toEqual({ x: 1, y: 0 })
    expect(result.stepsTaken).toBe(1)
    expect(result.outcome).toBe('partial')
    expect(result.state.destroyed).toBe(false)
    expect(result.detail).toContain('2,1')
  })

  it('is blocked, not destroyed, when a footprint straddles both a wall and an abyss', () => {
    // A wall under any corner refuses the move outright, so the robot never enters the cell that
    // would have killed it. Getting this precedence backwards kills a robot that never moved.
    const world = createWorld(arena(['..~..', '..#..'], { x: 0, y: 0, heading: 'east' }))
    const result = move(world, initialState(world), 'forward', 2)

    expect(result.outcome).toBe('blocked')
    expect(result.state.destroyed).toBe(false)
    expect({ x: result.state.x, y: result.state.y }).toEqual({ x: 0, y: 0 })
  })

  it('treats the edge of the world under any corner as a hard block', () => {
    // Anchored at 0,0 on a two-row map, a step north puts the top two corners off the grid even
    // though the body is entirely inside it now.
    const world = createWorld(arena(['....', '....'], { x: 0, y: 0, heading: 'north' }))
    const result = move(world, initialState(world), 'forward', 3)

    expect({ x: result.state.x, y: result.state.y }).toEqual({ x: 0, y: 0 })
    expect(result.blockedSteps).toBe(3)
    expect(result.outcome).toBe('blocked')
    expect(result.detail).toContain('edge of the world')
  })

  it('stops the body AT a wall two cells away rather than teleporting past it', () => {
    // The stepwise loop, which stays the module's most important property. Wall at 4,0 and 4,1;
    // facing east from 0,0 a five-step move must end anchored at 2,0.
    const world = createWorld(arena(['....#..', '....#..'], { x: 0, y: 0, heading: 'east' }))
    const result = move(world, initialState(world), 'forward', 5)

    expect({ x: result.state.x, y: result.state.y }).toEqual({ x: 2, y: 0 })
    expect(result.stepsTaken).toBe(2)
    expect(result.blockedSteps).toBe(3)
    expect(result.outcome).toBe('blocked')
  })

  it('dies on the abyss cell the body reaches, not at the end of the requested path', () => {
    // A single-jump implementation would look only at the final footprint — ordinary floor — and
    // report a clean four-cell move.
    const world = createWorld(arena(['...~....', '...~....'], { x: 0, y: 0, heading: 'east' }))
    const result = move(world, initialState(world), 'forward', 4)

    expect({ x: result.state.x, y: result.state.y }).toEqual({ x: 2, y: 0 })
    expect(result.stepsTaken).toBe(2)
    expect(result.state.destroyed).toBe(true)
    expect(result.outcome).toBe('destroyed')
  })

  it('keeps reporting the run as over and does not move afterwards', () => {
    const world = createWorld(arena(['..~....', '..~....'], { x: 0, y: 0, heading: 'east' }))
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

  it('lets the robot drive off a soft obstacle, which takes two steps for a two-cell body', () => {
    // The soft cell is at 2,1. A two-cell-wide body snags on it from 1,0 AND again from 2,0,
    // because the cell is still under its trailing corner; only the third step is clear of it.
    // A one-cell body would have been past it in one.
    const world = createWorld(arena(['.......', '..s....'], { x: 0, y: 0, heading: 'east' }))

    const first = move(world, initialState(world), 'forward', 4)
    expect({ x: first.state.x, y: first.state.y }).toEqual({ x: 1, y: 0 })
    expect(first.outcome).toBe('partial')

    const second = move(world, first.state, 'forward', 4)
    expect({ x: second.state.x, y: second.state.y }).toEqual({ x: 2, y: 0 })
    expect(second.outcome).toBe('partial')

    const onwards = move(world, second.state, 'forward', 3)
    expect({ x: onwards.state.x, y: onwards.state.y }).toEqual({ x: 5, y: 0 })
    expect(onwards.outcome).toBe('moved')
  })
})

describe('/distance casts from the leading edge of a two-cell-wide body', () => {
  it('reports the stub centimetre scale in absolute numbers', () => {
    // Absolute centimetres, not multiples of a constant imported from the module under test:
    // those would pin the ratio between readings and nothing else, and the requirement is about
    // specific numbers — the scale the ultrasonic tool was calibrated against.
    //
    // Anchored at 0,0 facing east on a five-wide map, both leading cells (1,0 and 1,1) see three
    // clear cells and then the edge.
    const open = createWorld(arena(['.....', '.....'], { x: 0, y: 0, heading: 'east' }))
    expect(distanceCm(open, initialState(open))).toBe(75)

    // A blocking cell immediately in front of a leading cell reads 2.0 — the firmware's floor.
    const blocked = createWorld(arena(['.....', '..#..'], { x: 0, y: 0, heading: 'east' }))
    expect(distanceCm(blocked, initialState(blocked))).toBe(2)

    // Open ground reads the eight-cell scan cap, 200 cm, and never more.
    const wide = createWorld(arena(['.'.repeat(30), '.'.repeat(30)], { x: 0, y: 0, heading: 'east' }))
    expect(distanceCm(wide, initialState(wide))).toBe(200)
    expect(MAX_SCAN_CELLS).toBe(8)
    expect(CM_PER_CELL).toBe(25)
    expect(MIN_DISTANCE_CM).toBe(2)
  })

  it('reports the NEARER of the two front cells, not the anchor cell alone', () => {
    // THE DISCRIMINATING CASE for the cast origin. Facing east from 0,0: the ray from the anchor
    // row runs three clear cells to the edge (75 cm), the ray from the row below meets a wall at
    // 3,1 after one (25 cm). A sensor modelled on the anchor cell alone reports 75 and drives a
    // two-cell-wide body straight into that wall.
    const world = createWorld(arena(['.....', '...#.'], { x: 0, y: 0, heading: 'east' }))
    expect(distanceCm(world, initialState(world))).toBe(25)
  })

  it('includes the diagonal leading corner when the robot faces a diagonal', () => {
    // Facing northeast the leading face is three cells, not two: the corner cell and the two
    // beside it. The wall at 5,1 is only ever seen by the ray from 3,3 — the third of them.
    const rows = ['......', '.....#', '......', '......', '......', '......']
    const world = createWorld(arena(rows, { x: 0, y: 4, heading: 'north' }))
    expect(distanceCm(world, at(2, 2, 'northeast'))).toBe(25)

    const clear = createWorld(
      arena(['......', '......', '......', '......', '......', '......'], { x: 0, y: 4, heading: 'north' }),
    )
    expect(distanceCm(clear, at(2, 2, 'northeast'))).toBe(50)
  })

  it('sees a soft obstacle but sees straight over an abyss', () => {
    // A forward-facing ultrasonic gets an echo from something standing up and nothing at all from
    // a hole in the floor. The sensor cannot warn about the fatal terrain, by design.
    const soft = createWorld(arena(['...s#....', '...s#....'], { x: 0, y: 0, heading: 'east' }))
    expect(distanceCm(soft, initialState(soft))).toBe(25)

    const overAbyss = createWorld(arena(['...~#....', '...~#....'], { x: 0, y: 0, heading: 'east' }))
    expect(distanceCm(overAbyss, initialState(overAbyss))).toBe(50)
  })

  it('agrees with the world in every direction from one spot', () => {
    //      x: 0  1  2  3  4  5  6
    //  y=0     .  .  .  .  .  .  .
    //  y=1     .  .  .  .  .  #  .
    //  y=2     #  .  .  .  .  .  .
    //  y=3     .  .  .  .  .  .  .
    //  y=4     .  .  #  .  .  .  .
    //  y=5     .  .  .  .  .  .  .
    const rows = ['.......', '.....#.', '#......', '.......', '..#....', '.......']
    const world = createWorld(arena(rows, { x: 0, y: 0, heading: 'north' }))
    const anchor = { x: 2, y: 2 }

    // North: leading cells 2,2 and 3,2. The 2,2 ray hits nothing until it leaves the grid two
    // cells up; the 3,2 ray likewise. Two clear cells each.
    expect(distanceCm(world, at(anchor.x, anchor.y, 'north'))).toBe(50)
    // South: leading cells 2,3 and 3,3. The 2,3 ray meets the wall at 2,4 immediately.
    expect(distanceCm(world, at(anchor.x, anchor.y, 'south'))).toBe(2)
    // West: leading cells 2,2 and 2,3. The 2,2 ray meets the wall at 0,2 after one clear cell.
    expect(distanceCm(world, at(anchor.x, anchor.y, 'west'))).toBe(25)
    // East: leading cells 3,2 and 3,3. Both run to the edge at x=7, three clear cells.
    expect(distanceCm(world, at(anchor.x, anchor.y, 'east'))).toBe(75)
  })
})

describe('maps are data, and a start must fit the body that stands on it', () => {
  it('parses the shipped phase-one map and stands the whole footprint on drivable floor', () => {
    const world = createWorld(PHASE_ONE_MAP)
    expect(world.width).toBe(14)
    expect(world.height).toBe(12)

    for (const cell of footprintOf(world.start.x, world.start.y)) {
      const [x, y] = cell.split(',').map(Number)
      expect(world.cells[y][x], cell).toBe('floor')
    }

    expect(world.cells.flat()).toContain('abyss')
    expect(world.cells.flat()).toContain('targetRed')
    expect(world.cells.flat()).toContain('targetGreen')
  })

  it('defaults to the shipped map', () => {
    expect(createWorld().id).toBe('phase-one-arena')
    expect(PHASE_ONE_MAP.id).toBe('phase-one-arena')
  })

  it('refuses a ragged map rather than shifting every coordinate below the short row', () => {
    expect(() =>
      createWorld({ id: 'ragged', rows: ['....', '..'], start: { x: 0, y: 0, heading: 'north' } }),
    ).toThrow(/row 1 is 2 cells wide/)
  })

  it('refuses an unknown map character', () => {
    expect(() =>
      createWorld({ id: 'bad', rows: ['..?.', '....'], start: { x: 0, y: 0, heading: 'north' } }),
    ).toThrow(/unknown map character/)
  })

  it('refuses a start whose ANCHOR is clear but whose far corner is in a wall', () => {
    // The case a single-cell check waves through: 0,0 is ordinary floor, and the body standing on
    // it has a corner inside the obstacle at 1,1.
    expect(() =>
      createWorld({ id: 'corner-in-wall', rows: ['....', '.#..'], start: { x: 0, y: 0, heading: 'north' } }),
    ).toThrow(/1,1, which is hard/)
  })

  it('refuses a start whose body hangs off the edge of the map', () => {
    expect(() =>
      createWorld({ id: 'off-edge', rows: ['....', '....'], start: { x: 0, y: 1, heading: 'north' } }),
    ).toThrow(/0,2, which is out of bounds/)
  })

  it('refuses a start whose far corner is over the abyss', () => {
    expect(() =>
      createWorld({ id: 'corner-in-abyss', rows: ['....', '.~..'], start: { x: 0, y: 0, heading: 'north' } }),
    ).toThrow(/1,1, which is abyss/)
  })
})

/**
 * The shipped arena's comment claims it exercises four specific things. A 2×2 body invalidated
 * two of them silently — a one-cell pocket mouth is not "reachable only from below", it is not
 * reachable at all — so each claim is re-verified here against the body that now drives it.
 */
describe('the phase-one arena still exercises what it says it does', () => {
  const world = createWorld(PHASE_ONE_MAP)

  it('gives the robot open floor around the start to calibrate on', () => {
    const start = initialState(world)
    // A full step in every one of the eight directions is legal from the start, which is what
    // "open floor to calibrate on" has to mean for a body that can face eight ways.
    for (const { heading } of EIGHT_HEADINGS) {
      const result = move(world, { ...start, heading }, 'forward', 1)
      expect(result.outcome, heading).toBe('moved')
    }
  })

  it('lets the two-cell-wide body into the green pocket, and only from below', () => {
    // Up the mouth at x=2..3 and the body reaches both green cells.
    const approach = at(2, 4, 'north')
    const arrived = move(world, approach, 'forward', 3)
    expect(arrived.outcome).toBe('moved')
    expect({ x: arrived.state.x, y: arrived.state.y }).toEqual({ x: 2, y: 1 })
    for (const cell of footprintOf(2, 1)) {
      const [x, y] = cell.split(',').map(Number)
      expect([world.cells[y][x]], cell).toContain(y === 1 ? 'targetGreen' : 'floor')
    }

    // The roof stops it going any further, and there is no way in from either side.
    expect(move(world, at(2, 1, 'north'), 'forward', 1).outcome).toBe('blocked')
    expect(move(world, at(2, 4, 'east'), 'forward', 1).outcome).toBe('moved')
    expect(move(world, at(3, 4, 'north'), 'forward', 1).outcome).toBe('blocked')
    expect(move(world, at(1, 4, 'north'), 'forward', 1).outcome).toBe('blocked')
  })

  it('drops a careless multi-step move into the abyss', () => {
    const fatal = move(world, at(4, 7, 'northeast'), 'forward', 5)
    expect(fatal.outcome).toBe('destroyed')
    expect(fatal.state.destroyed).toBe(true)
    // It dies on the cell it reached, part-way through the requested run.
    expect(fatal.stepsTaken).toBeLessThan(5)
  })

  it('puts a soft obstacle on the left approach', () => {
    const snag = move(world, at(3, 8, 'west'), 'forward', 3)
    expect(snag.outcome).toBe('partial')
    expect(snag.state.destroyed).toBe(false)
  })

  it('leaves the red target in the open at the bottom', () => {
    const arrival = move(world, at(4, 8, 'south'), 'forward', 2)
    expect(arrival.outcome).toBe('moved')
    expect({ x: arrival.state.x, y: arrival.state.y }).toEqual({ x: 4, y: 10 })
    expect(world.cells[11][4]).toBe('targetRed')
    expect(world.cells[11][5]).toBe('targetRed')
  })
})
