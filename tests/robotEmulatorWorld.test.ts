import { describe, it, expect } from 'vitest'
import {
  DEFAULT_TILE_SIZE_CM,
  PHASE_ONE_MAP,
  bodyCorners,
  createWorld,
  distanceCm,
  initialState,
  move,
  nextRandom,
  probeSweptBody,
  tileAt,
  tileAtPoint,
  turn,
  type RobotWorldState,
  type World,
  type WorldMap,
} from '../robot-emulator/world.js'
import type { RobotPhysicalProfile } from '../src/agent/robotPresets/physical.js'

/**
 * The world model is pure, so the behaviours that actually decide whether the emulator is
 * honest — stopping AT a wall, dying when the CENTRE reaches the abyss, refusing a move because
 * a corner of a 10 cm body is in a wall the centre is nowhere near — can be asserted directly,
 * with no server and no timing.
 *
 * NOTHING IN THIS FILE BUILDS AN EXPECTED VALUE OUT OF THE MODULE UNDER TEST. Every profile is
 * written out here by hand rather than read from the preset registry, every heading vector is
 * written out, and every expected coordinate is arithmetic a reader can redo on paper from the
 * map drawn above it. An expected value read back from the code being tested agrees with that
 * code no matter what the code says.
 *
 * EVERY NUMBER HERE IS CENTIMETRES OR DEGREES unless its name ends in `Tiles`. The maps are
 * drawn in tiles because that is how a map is authored; nothing else is.
 */

/**
 * The robot the tests drive: the QD021's measurements, WITH JITTER OFF.
 *
 * Jitter is switched off in every test that asserts a position, and that is the point of having
 * it as a setting: exact motion is what makes a scripted sequence checkable on paper. The jitter
 * block further down is where it is turned back on and asserted in its own right.
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

function withProfile(patch: {
  body?: Partial<RobotPhysicalProfile['body']>
  motion?: Partial<RobotPhysicalProfile['motion']>
  sensor?: Partial<RobotPhysicalProfile['sensor']>
}): RobotPhysicalProfile {
  return {
    body: { ...EXACT.body, ...patch.body },
    motion: { ...EXACT.motion, ...patch.motion },
    sensor: { ...EXACT.sensor, ...patch.sensor },
  }
}

/** A map, with the tile size stated explicitly so no test depends on the default by accident. */
function arena(
  rows: string[],
  start: { xTiles: number; yTiles: number; headingDeg: number },
  tileSizeCm = 5,
): WorldMap {
  return { id: 'arena', rows, tileSizeCm, start }
}

/** A robot placed by hand, in centimetres, so a test can stand it where the map's start is not. */
function at(xCm: number, yCm: number, headingDeg: number, seed = 1): RobotWorldState {
  return { xCm, yCm, headingDeg, destroyed: false, seed }
}

/**
 * The eight compass headings as degrees and unit vectors, WRITTEN OUT BY HAND.
 *
 * This is the specification of the whole coordinate system and it is the one thing that must not
 * be imported: taking these from `forwardVector` would make every assertion below agree with any
 * convention at all, including a wrong one. `y` grows downwards, so north is `(0, -1)`.
 */
const HALF_ROOT_TWO = 0.7071067811865476
const EIGHT_HEADINGS = [
  { name: 'north', headingDeg: 0, dx: 0, dy: -1 },
  { name: 'northeast', headingDeg: 45, dx: HALF_ROOT_TWO, dy: -HALF_ROOT_TWO },
  { name: 'east', headingDeg: 90, dx: 1, dy: 0 },
  { name: 'southeast', headingDeg: 135, dx: HALF_ROOT_TWO, dy: HALF_ROOT_TWO },
  { name: 'south', headingDeg: 180, dx: 0, dy: 1 },
  { name: 'southwest', headingDeg: 225, dx: -HALF_ROOT_TWO, dy: HALF_ROOT_TWO },
  { name: 'west', headingDeg: 270, dx: -1, dy: 0 },
  { name: 'northwest', headingDeg: 315, dx: -HALF_ROOT_TWO, dy: -HALF_ROOT_TWO },
] as const

/** Nine tiles of open floor each way — 45 x 45 cm at a 5 cm tile. */
const OPEN_9x9 = Array.from({ length: 9 }, () => '.'.repeat(9))

/**
 * A corridor 80 x 20 cm (16 x 4 tiles), with whatever is put at tiles `(5,1)` and `(5,2)`.
 *
 * Every "drive east into something" test below uses it, because the arithmetic is the same each
 * time and worth stating once: the robot's centre is put at 10,12 cm; the body is 10 cm square,
 * so it spans 5..15 cm across and 7..17 cm down; the thing at tile column 5 has its near face at
 * 25 cm across and covers 5..15 cm down.
 *
 * The centre line is 12 rather than 10 deliberately. 10 is exactly a tile boundary, and a centre
 * travelling along a boundary is in NEITHER of the tiles it separates — correct, deterministic,
 * and a poor line to reason about, since the abyss rule reads the centre alone.
 */
function corridor(obstacle: string): WorldMap {
  return arena(
    [
      '................',
      `.....${obstacle}..........`,
      `.....${obstacle}..........`,
      '................',
    ],
    { xTiles: 1, yTiles: 2, headingDeg: 90 },
  )
}

/** Where the corridor tests stand the robot, written out rather than taken from the map. */
const CORRIDOR_START = { xCm: 10, yCm: 12 }

describe('turning is degrees, taken a configured number at a time', () => {
  const world = createWorld(arena(OPEN_9x9, { xTiles: 4, yTiles: 4, headingDeg: 0 }), EXACT.body)
  const start = initialState(world)

  it('turns right by the profile angle, one cycle at a time', () => {
    expect(turn(EXACT, start, 'right', 1).state.headingDeg).toBeCloseTo(15, 9)
    expect(turn(EXACT, start, 'right', 2).state.headingDeg).toBeCloseTo(30, 9)
    expect(turn(EXACT, start, 'right', 3).state.headingDeg).toBeCloseTo(45, 9)
  })

  it('turns left by the same angle, wrapping below zero rather than going negative', () => {
    expect(turn(EXACT, start, 'left', 1).state.headingDeg).toBeCloseTo(345, 9)
    expect(turn(EXACT, start, 'left', 3).state.headingDeg).toBeCloseTo(315, 9)
  })

  it('makes a right angle out of exactly six cycles, not two', () => {
    // The headline consequence of the change, and the one the prompt has always claimed: a turn
    // cycle is 15 degrees, so a right angle is six of them. An implementation still turning 45
    // degrees a cycle fails here, and so does one still turning 90.
    expect(turn(EXACT, start, 'right', 6).state.headingDeg).toBeCloseTo(90, 9)
    expect(turn(EXACT, start, 'left', 6).state.headingDeg).toBeCloseTo(270, 9)
    expect(turn(EXACT, start, 'right', 12).state.headingDeg).toBeCloseTo(180, 9)
  })

  it('is the identity after a full circle in either direction, from every heading', () => {
    // Driven by the hand-written list, so nothing in `world.ts` can make this loop iterate zero
    // times and pass by checking nothing.
    for (const { name, headingDeg } of EIGHT_HEADINGS) {
      expect(turn(EXACT, at(22.5, 22.5, headingDeg), 'right', 24).state.headingDeg, name).toBeCloseTo(
        headingDeg,
        9,
      )
      expect(turn(EXACT, at(22.5, 22.5, headingDeg), 'left', 24).state.headingDeg, name).toBeCloseTo(
        headingDeg,
        9,
      )
    }
  })

  it('makes left and right exact inverses, from every heading and at every size', () => {
    for (const { name, headingDeg } of EIGHT_HEADINGS) {
      for (const cycles of [1, 2, 3, 5, 7, 10]) {
        const there = turn(EXACT, at(22.5, 22.5, headingDeg), 'right', cycles).state
        expect(turn(EXACT, there, 'left', cycles).state.headingDeg, `${name} x${cycles}`).toBeCloseTo(
          headingDeg,
          9,
        )
      }
    }
  })

  it('wraps a multi-cycle command past the top of the circle', () => {
    // 30 cycles is 450 degrees; an implementation without the normalisation reports 450.
    expect(turn(EXACT, start, 'right', 30).state.headingDeg).toBeCloseTo(90, 9)
    expect(turn(EXACT, at(22.5, 22.5, 10), 'left', 30).state.headingDeg).toBeCloseTo(280, 9)
  })

  it('never moves the robot', () => {
    const turned = turn(EXACT, start, 'right', 7)
    expect(turned.state.xCm).toBe(start.xCm)
    expect(turned.state.yCm).toBe(start.yCm)
    expect(turned.outcome).toBe('moved')
    expect(turned.cyclesTaken).toBe(7)
  })

  it('takes a turn while jammed against a wall, because the real robot does', () => {
    // Deliberate: the hardware has no idea what is beside it. Refusing the command would teach an
    // agent that a failed turn means an obstacle, which is a signal the robot cannot give.
    const world = createWorld(corridor('#'), EXACT.body)
    const jammed = at(19, 12, 90)
    expect(move(world, EXACT, jammed, 'forward', 1).outcome).toBe('blocked')
    expect(turn(EXACT, jammed, 'right', 6).outcome).toBe('moved')
    expect(turn(EXACT, jammed, 'right', 6).state.headingDeg).toBeCloseTo(180, 9)
  })

  it('tells the model the cycle size and the total, and never calls it a quarter-turn', () => {
    // The `detail` string is the entire interface to the agent. A model told a cycle is a
    // quarter-turn over-rotates by six times, so this asserts the words, not just the heading.
    const detail = turn(EXACT, start, 'right', 6).detail
    expect(detail).toContain('15 degrees')
    expect(detail).toContain('90 degrees')
    expect(detail).not.toMatch(/quarter/i)
  })
})

describe('the robot moves continuously, in centimetres, along its heading', () => {
  const world = createWorld(arena(OPEN_9x9, { xTiles: 4, yTiles: 4, headingDeg: 0 }), EXACT.body)

  it('moves forward the profile stride along each of the eight compass headings', () => {
    for (const { name, headingDeg, dx, dy } of EIGHT_HEADINGS) {
      const result = move(world, EXACT, at(22.5, 22.5, headingDeg), 'forward', 1)
      expect(result.outcome, name).toBe('moved')
      expect(result.cyclesTaken, name).toBe(1)
      expect(result.state.xCm, name).toBeCloseTo(22.5 + dx * 1.5, 9)
      expect(result.state.yCm, name).toBeCloseTo(22.5 + dy * 1.5, 9)
    }
  })

  it('moves backward its own, shorter stride, and never changes the facing', () => {
    // 1.3 rather than 1.5: the gait is asymmetric, and that asymmetry is a hardware fact the
    // emulator adopts rather than a tidiness to iron out.
    for (const { name, headingDeg, dx, dy } of EIGHT_HEADINGS) {
      const result = move(world, EXACT, at(22.5, 22.5, headingDeg), 'backward', 1)
      expect(result.outcome, name).toBe('moved')
      expect(result.state.xCm, name).toBeCloseTo(22.5 - dx * 1.3, 9)
      expect(result.state.yCm, name).toBeCloseTo(22.5 - dy * 1.3, 9)
      expect(result.state.headingDeg, name).toBeCloseTo(headingDeg, 9)
    }
  })

  it('does NOT return to where it started when a move is reversed cycle for cycle', () => {
    // The consequence of the asymmetry, stated as a property because it is exactly the thing a
    // control loop must not assume. Three cycles out is 4.5 cm; three back is 3.9.
    const out = move(world, EXACT, at(22.5, 22.5, 90), 'forward', 3)
    expect(out.state.xCm).toBeCloseTo(27, 9)
    const back = move(world, EXACT, out.state, 'backward', 3)
    expect(back.state.xCm).toBeCloseTo(23.1, 9)

    // ...and a robot whose gait IS symmetric does return, which is what shows the difference is
    // the profile's and not the arithmetic's.
    const symmetric = withProfile({ motion: { backwardPerCycleCm: 1.5 } })
    const there = move(world, symmetric, at(22.5, 22.5, 90), 'forward', 3)
    const home = move(world, symmetric, there.state, 'backward', 3)
    expect(home.state.xCm).toBeCloseTo(22.5, 9)
  })

  it('travels a multiple of the stride, at any angle, without snapping to a tile', () => {
    // Six cycles at 45 degrees is 9 cm along the diagonal — 6.36 cm on each axis, which is not a
    // whole tile of anything. A model that quantised the pose would land on 5 or 10.
    const result = move(world, EXACT, at(22.5, 22.5, 45), 'forward', 6)
    expect(result.cyclesTaken).toBe(6)
    expect(result.state.xCm).toBeCloseTo(22.5 + 9 * HALF_ROOT_TWO, 9)
    expect(result.state.yCm).toBeCloseTo(22.5 - 9 * HALF_ROOT_TWO, 9)
  })

  it('drives the stride from the profile, so a different robot covers different ground', () => {
    // Proves the setting is WIRED, not merely accepted: same world, same command, twice the
    // stride, twice the ground.
    const strider = withProfile({ motion: { forwardPerCycleCm: 3 } })
    const result = move(world, strider, at(22.5, 22.5, 90), 'forward', 4)
    expect(result.state.xCm).toBeCloseTo(34.5, 9)
    expect(move(world, EXACT, at(22.5, 22.5, 90), 'forward', 4).state.xCm).toBeCloseTo(28.5, 9)
  })

  it('drives the turn angle from the profile too', () => {
    const quick = withProfile({ motion: { turnDegreesPerCycle: 30 } })
    expect(turn(quick, at(22.5, 22.5, 0), 'right', 1).state.headingDeg).toBeCloseTo(30, 9)
    expect(turn(quick, at(22.5, 22.5, 0), 'right', 3).state.headingDeg).toBeCloseTo(90, 9)
  })
})

/**
 * THE COLLISION RULE.
 *
 * Every case here is arranged so the robot's CENTRE is on ordinary floor and a different part of
 * the body is the part in trouble — which is what makes them worth writing, because a model that
 * tested the centre tile alone passes right through all of them.
 */
describe('collision is the whole body against the tiles it overlaps', () => {
  it('is blocked when any part of the body would overlap a wall', () => {
    // The corridor: centre starts at 10,10, body spans 5..15, wall face at 25. The body may
    // advance until its leading edge touches 25, i.e. centre 20 — and 10 + 1.5 x 6 = 19 is the
    // last cycle that fits. The seventh would put the centre at 20.5 and the edge at 25.5.
    const world = createWorld(corridor('#'), EXACT.body)
    const result = move(world, EXACT, at(CORRIDOR_START.xCm, CORRIDOR_START.yCm, 90), 'forward', 10)

    expect(result.state.xCm).toBeCloseTo(19, 9)
    expect(result.cyclesTaken).toBe(6)
    expect(result.blockedCycles).toBe(4)
    expect(result.outcome).toBe('blocked')
    expect(result.state.destroyed).toBe(false)
    // The detail names the offending TILE so a reader can find it on the map.
    expect(result.detail).toContain('tile 5,1')
  })

  it('keeps a blocked cycle a truthful no-op the run survives', () => {
    // Ten more cycles into the same wall: still no movement, still not destroyed, still able to
    // move away. A model that keeps pushing is told "you did not move", not failed silently.
    const world = createWorld(corridor('#'), EXACT.body)
    const jammed = move(world, EXACT, at(10, 12, 90), 'forward', 10).state
    const again = move(world, EXACT, jammed, 'forward', 10)
    expect(again.cyclesTaken).toBe(0)
    expect(again.blockedCycles).toBe(10)
    expect(again.state.xCm).toBeCloseTo(19, 9)
    expect(again.state.destroyed).toBe(false)

    const away = move(world, EXACT, again.state, 'backward', 2)
    expect(away.outcome).toBe('moved')
    expect(away.state.xCm).toBeCloseTo(16.4, 9)
  })

  it('treats the edge of the world exactly as it treats a wall', () => {
    const world = createWorld(corridor('.'), EXACT.body)
    const result = move(world, EXACT, at(10, 12, 270), 'forward', 10)

    // Westward from 10: the body's left edge is centre - 5, so the centre may reach 5. From 10,
    // 1.5 at a time, 5.5 fits and 4.0 does not.
    expect(result.state.xCm).toBeCloseTo(5.5, 9)
    expect(result.cyclesTaken).toBe(3)
    expect(result.blockedCycles).toBe(7)
    expect(result.outcome).toBe('blocked')
    expect(result.detail).toContain('edge of the world')
  })

  it('SWEEPS the body rather than sampling the endpoints', () => {
    // THE DISCRIMINATING CASE, built so endpoint sampling passes it and the truth is that the
    // robot cannot make the move. A profile with a 20 cm stride, a 10 cm body and a 5 cm wall:
    // the body starts at 5..15, ends at 25..35, and the wall occupies 20..25. Neither end
    // rectangle overlaps it — the far one only touches — and the path straight through does.
    const leaper = withProfile({ motion: { forwardPerCycleCm: 20 } })
    const world = createWorld(
      arena(
        ['..........', '....#.....', '....#.....', '..........'],
        { xTiles: 1, yTiles: 2, headingDeg: 90 },
      ),
      EXACT.body,
    )
    const from = { xCm: 10, yCm: 10 }
    const to = { xCm: 30, yCm: 10 }

    // Endpoint-only sampling: both ends are clear. This is the assertion that makes the one
    // below mean something rather than merely being true.
    expect(probeSweptBody(world, EXACT.body, from, from, 90).kind).toBe('clear')
    expect(probeSweptBody(world, EXACT.body, to, to, 90).kind).toBe('clear')
    // The sweep between them is not.
    expect(probeSweptBody(world, EXACT.body, from, to, 90)).toMatchObject({
      kind: 'blocked',
      xTiles: 4,
      yTiles: 1,
      reason: 'obstacle',
    })

    const result = move(world, leaper, at(10, 10, 90), 'forward', 1)
    expect(result.outcome).toBe('blocked')
    expect(result.state.xCm).toBeCloseTo(10, 9)
  })

  it('stops a multi-cycle move AT the wall rather than teleporting past it', () => {
    // The same property one level up, at the real stride: the whole ten-cycle move would end at
    // centre 25, whose body (20..30) only touches the wall at 15..20. The per-cycle loop is what
    // makes the robot stop at 10 instead of arriving at a destination that "looks" legal.
    const world = createWorld(
      arena(
        ['..........', '...#......', '...#......', '..........'],
        { xTiles: 1, yTiles: 2, headingDeg: 90 },
      ),
      EXACT.body,
    )
    expect(probeSweptBody(world, EXACT.body, { xCm: 25, yCm: 10 }, { xCm: 25, yCm: 10 }, 90).kind)
      .toBe('clear')

    const result = move(world, EXACT, at(10, 10, 90), 'forward', 10)
    expect(result.cyclesTaken).toBe(0)
    expect(result.blockedCycles).toBe(10)
    expect(result.state.xCm).toBeCloseTo(10, 9)
    expect(result.outcome).toBe('blocked')
  })

  it('is fatal when the CENTRE crosses into the abyss', () => {
    // The abyss occupies 25..30. The centre starts at 10 and steps 1.5 at a time, so 25.0 is the
    // last cycle outside it and 26.5 is inside.
    const world = createWorld(corridor('~'), EXACT.body)
    const result = move(world, EXACT, at(10, 12, 90), 'forward', 20)

    expect(result.cyclesTaken).toBe(11)
    expect(result.state.xCm).toBeCloseTo(26.5, 9)
    expect(result.state.destroyed).toBe(true)
    expect(result.outcome).toBe('destroyed')
    // Tile 5,2 rather than 5,1: the abyss is judged on the CENTRE, which travels along y = 12.
    expect(result.detail).toContain('tile 5,2')
    expect(result.detail).toContain('run is over')
  })

  it('is NOT fatal for a wheel over the lip — an overhang is survivable', () => {
    // Ten cycles puts the centre at 25.0, exactly on the abyss's near edge, with HALF THE BODY
    // (20..30) hanging over the hole. A body-overlap rule kills the robot here; the centre rule
    // is what makes "a wheel over the lip should not end the run" true.
    const world = createWorld(corridor('~'), EXACT.body)
    const result = move(world, EXACT, at(10, 12, 90), 'forward', 10)

    expect(result.cyclesTaken).toBe(10)
    expect(result.state.xCm).toBeCloseTo(25, 9)
    expect(result.outcome).toBe('moved')
    expect(result.state.destroyed).toBe(false)
    // ...and the body really is over the hole, so the assertion above is about the RULE and not
    // about the robot having stopped short. The abyss's near face is at 25 cm.
    const corners = bodyCorners(EXACT.body, { xCm: 25, yCm: 12 }, 90)
    expect(Math.max(...corners.map((corner) => corner.xCm))).toBeCloseTo(30, 9)
  })

  it('snags on a soft obstacle and ends the move there, recoverably', () => {
    // Soft at 25..30. The body's leading edge reaches it once the centre passes 20, so the
    // seventh cycle (20.5) is the one that snags.
    const world = createWorld(corridor('s'), EXACT.body)
    const result = move(world, EXACT, at(10, 12, 90), 'forward', 10)

    expect(result.cyclesTaken).toBe(7)
    expect(result.state.xCm).toBeCloseTo(20.5, 9)
    expect(result.outcome).toBe('partial')
    expect(result.state.destroyed).toBe(false)
    expect(result.detail).toContain('tile 5,1')
  })

  it('takes many commands to drive clear of a soft obstacle, and does get clear', () => {
    // The continuous form of the old "a two-cell body is still on the soft cell one step later".
    // A 10 cm body overlapping a 5 cm soft tile is stuck to it for 10 cm of travel, which at
    // 1.5 cm a cycle is one snagged cycle per command for several commands running.
    const world = createWorld(corridor('s'), EXACT.body)
    let state = move(world, EXACT, at(10, 12, 90), 'forward', 10).state

    const outcomes: string[] = []
    for (let command = 0; command < 30; command++) {
      const result = move(world, EXACT, state, 'forward', 10)
      state = result.state
      outcomes.push(result.outcome)
      if (result.outcome !== 'partial') break
    }

    expect(outcomes.filter((outcome) => outcome === 'partial').length).toBeGreaterThan(3)
    expect(outcomes[outcomes.length - 1]).toBe('moved')
    expect(state.destroyed).toBe(false)
  })

  it('is blocked, not destroyed, when the same cycle meets both a wall and the abyss', () => {
    // Precedence. The abyss at tile 4,2 spans 20..25 across and 10..15 down; the wall at tile 5,1
    // spans 25..30 across and 5..10 down. From centre 10,12 heading east the seventh cycle would
    // put the centre at 20.5 — inside the abyss — while the body (15.5..25.5 across, 7..17 down)
    // reaches into the wall. A wall refuses the move outright, so the robot never gets there.
    const world = createWorld(
      arena(
        ['..........', '.....#....', '....~.....', '..........'],
        { xTiles: 1, yTiles: 2, headingDeg: 90 },
      ),
      EXACT.body,
    )
    const result = move(world, EXACT, at(10, 12, 90), 'forward', 10)

    expect(result.outcome).toBe('blocked')
    expect(result.state.destroyed).toBe(false)
    expect(result.state.xCm).toBeCloseTo(19, 9)

    // ...and the cycle really would have been fatal on its own, which is what makes this a test
    // of the precedence rather than of the geometry.
    expect(probeSweptBody(world, EXACT.body, { xCm: 19, yCm: 12 }, { xCm: 20.5, yCm: 12 }, 90).kind)
      .toBe('blocked')
    const noWall = createWorld(
      arena(
        ['..........', '..........', '....~.....', '..........'],
        { xTiles: 1, yTiles: 2, headingDeg: 90 },
      ),
      EXACT.body,
    )
    expect(probeSweptBody(noWall, EXACT.body, { xCm: 19, yCm: 12 }, { xCm: 20.5, yCm: 12 }, 90).kind)
      .toBe('fatal')
  })

  it('keeps reporting the run as over and does not move afterwards', () => {
    const world = createWorld(corridor('~'), EXACT.body)
    const dead = move(world, EXACT, at(10, 12, 90), 'forward', 20).state
    expect(dead.destroyed).toBe(true)

    const again = move(world, EXACT, dead, 'forward', 3)
    expect(again.outcome).toBe('run_over')
    expect(again.cyclesTaken).toBe(0)
    expect(again.state.xCm).toBeCloseTo(26.5, 9)

    const backwards = move(world, EXACT, again.state, 'backward', 1)
    expect(backwards.outcome).toBe('run_over')
    expect(backwards.state.xCm).toBeCloseTo(26.5, 9)

    const rotated = turn(EXACT, again.state, 'left', 1)
    expect(rotated.outcome).toBe('run_over')
    expect(rotated.state.headingDeg).toBeCloseTo(90, 9)
  })

  it('lets a body sit at an angle, and refuses the gaps its diagonal cannot clear', () => {
    // The property that only exists once the body can be off-axis: a 10 cm body needs 14.15 cm
    // of gap at 45 degrees, not 10. A three-tile mouth (15 cm) takes it and a two-tile mouth
    // (10 cm) does not, while BOTH take the same body pointing straight up.
    const wide = createWorld(
      arena(
        ['.#...#....', '.#...#....', '.#...#....', '..........', '..........', '..........'],
        { xTiles: 3, yTiles: 4, headingDeg: 0 },
      ),
      EXACT.body,
    )
    const narrow = createWorld(
      arena(
        ['.#..#.....', '.#..#.....', '.#..#.....', '..........', '..........', '..........'],
        { xTiles: 3, yTiles: 4, headingDeg: 0 },
      ),
      EXACT.body,
    )

    // Mouth centres: 17.5 cm between walls at 10 and 25; 15 cm between walls at 10 and 20.
    const inWide = { xCm: 17.5, yCm: 7.5 }
    const inNarrow = { xCm: 15, yCm: 7.5 }
    expect(probeSweptBody(wide, EXACT.body, inWide, inWide, 0).kind).toBe('clear')
    expect(probeSweptBody(narrow, EXACT.body, inNarrow, inNarrow, 0).kind).toBe('clear')

    expect(probeSweptBody(wide, EXACT.body, inWide, inWide, 45).kind).toBe('clear')
    expect(probeSweptBody(narrow, EXACT.body, inNarrow, inNarrow, 45).kind).toBe('blocked')
  })

  it('lets a bigger body be stopped by a wall a smaller one clears', () => {
    // The body size is wired, not decorative: a 20 cm robot in the corridor is stopped 5 cm
    // earlier than a 10 cm one, because its leading edge is 5 cm further forward.
    // 50 x 40 cm, with a wall from 25 to 30 cm across covering 10..30 cm down. Both bodies are
    // centred at 15,20; the 10 cm body's leading edge is at 20 and the 20 cm body's at 25, so the
    // wall is already touching the big one and is 5 cm off the small one.
    const big = withProfile({ body: { widthCm: 20, lengthCm: 20 } })
    const map = arena(
      [
        '..........',
        '..........',
        '.....#....',
        '.....#....',
        '.....#....',
        '.....#....',
        '..........',
        '..........',
      ],
      { xTiles: 2, yTiles: 4, headingDeg: 90 },
    )
    const world = createWorld(map, big.body)

    const small = move(world, EXACT, at(15, 20, 90), 'forward', 10)
    expect(small.state.xCm).toBeCloseTo(19.5, 9)
    expect(small.outcome).toBe('blocked')

    const large = move(world, big, at(15, 20, 90), 'forward', 10)
    expect(large.state.xCm).toBeCloseTo(15, 9)
    expect(large.outcome).toBe('blocked')
  })
})

describe('jitter is seeded, and a seed is the whole of a run', () => {
  const JITTERY: RobotPhysicalProfile = {
    body: { widthCm: 10, lengthCm: 10 },
    motion: {
      forwardPerCycleCm: 1.5,
      backwardPerCycleCm: 1.3,
      turnDegreesPerCycle: 15,
      jitterFraction: 0.015,
    },
    sensor: { minRangeCm: 3, maxRangeCm: 400, beamAngleDegrees: 15 },
  }
  const world = createWorld(arena(OPEN_9x9, { xTiles: 4, yTiles: 4, headingDeg: 0 }), EXACT.body)

  /** The same scripted sequence every time: drive, turn, drive, reverse. */
  function script(profile: RobotPhysicalProfile, seed: number) {
    let state = initialState(world, seed)
    state = move(world, profile, state, 'forward', 3).state
    state = turn(profile, state, 'right', 4).state
    state = move(world, profile, state, 'forward', 2).state
    state = move(world, profile, state, 'backward', 1).state
    return state
  }

  it('gives back exact motion at jitter 0', () => {
    // 22.5 is the centre of tile 4,4 at a 5 cm tile. Three cycles north is 4.5 cm, then a
    // 60-degree turn, then 3 cm along it, then 1.3 cm back — all written out.
    const state = script(EXACT, 7)
    expect(state.headingDeg).toBeCloseTo(60, 9)
    const alongX = Math.sin((60 * Math.PI) / 180)
    const alongY = -Math.cos((60 * Math.PI) / 180)
    expect(state.xCm).toBeCloseTo(22.5 + alongX * (3 - 1.3), 9)
    expect(state.yCm).toBeCloseTo(22.5 - 4.5 + alongY * (3 - 1.3), 9)
  })

  it('replays identically from one seed and differently from another', () => {
    const first = script(JITTERY, 12345)
    const second = script(JITTERY, 12345)
    expect(second.xCm).toBe(first.xCm)
    expect(second.yCm).toBe(first.yCm)
    expect(second.headingDeg).toBe(first.headingDeg)

    const other = script(JITTERY, 54321)
    expect(other.xCm).not.toBe(first.xCm)
    expect(other.headingDeg).not.toBe(first.headingDeg)
  })

  it('perturbs every motion, and only within the profile fraction', () => {
    // 1.5% of 1.5 cm is 0.0225 cm, and 1.5% of 15 degrees is 0.225. So a jittered cycle is never
    // exact and never far off — which is what makes dead reckoning almost work, which is what
    // makes it a trap worth practising against.
    const forward = move(world, JITTERY, at(22.5, 22.5, 0, 99), 'forward', 1)
    expect(forward.state.yCm).not.toBe(21)
    expect(Math.abs(forward.state.yCm - 21)).toBeLessThanOrEqual(0.0225)

    const turned = turn(JITTERY, at(22.5, 22.5, 0, 99), 'right', 1)
    expect(turned.state.headingDeg).not.toBe(15)
    expect(Math.abs(turned.state.headingDeg - 15)).toBeLessThanOrEqual(0.225)
  })

  it('reports the command, never the distance actually achieved', () => {
    // The observation is the whole interface to the agent, and a real robot has no odometry. The
    // emulator knows it travelled 1.4938... cm and must not say so; the nominal 1.5 is what a
    // model can legitimately reason from.
    const result = move(world, JITTERY, at(22.5, 22.5, 0, 99), 'forward', 4)
    const achievedCm = 22.5 - result.state.yCm
    expect(achievedCm).not.toBe(6)
    expect(result.detail).toContain('1.5 cm')
    // The achieved figure at any precision a sentence would plausibly round it to. Comparing
    // against the raw `String(achievedCm)` would be vacuous: that is a 16-digit float no message
    // could contain, so it would pass against a `detail` that leaked the distance to 2 dp.
    for (const digits of [2, 3]) {
      expect(result.detail, `${digits} dp`).not.toContain(achievedCm.toFixed(digits))
    }
  })

  it('reports the commanded rotation, never the rotation actually achieved', () => {
    // Turning is the other half of the motion interface, and it jitters too: 1.5% of 15 degrees
    // is 0.225 a cycle, so six cycles land near 90 and never on it. A `detail` that stated the
    // achieved angle would be handing a dead-reckoning agent precisely the odometry the hardware
    // cannot give it. Jitter is ON here on purpose — at `jitterFraction: 0` the nominal and the
    // achieved figure are equal and no assertion can tell the two apart.
    const result = turn(JITTERY, at(22.5, 22.5, 0, 99), 'right', 6)
    const achievedDeg = result.state.headingDeg
    expect(achievedDeg).not.toBe(90)
    expect(result.detail).toContain('15 degrees')
    expect(result.detail).toContain('90 degrees')
    for (const digits of [2, 3]) {
      expect(result.detail, `${digits} dp`).not.toContain(achievedDeg.toFixed(digits))
    }
  })

  it('keeps the sentence in step with the cycles when a blocked cycle is followed by a good one', () => {
    // A blocked cycle is a no-op the run survives, so a shorter jittered draw can fit where the
    // last one overran. The sentence is therefore composed AFTER the loop: written inside it, the
    // block's wording would be frozen at the count of that moment and the agent would be told
    // "0 of 10" after genuinely travelling. Corridor wall face at 25 cm, body 10 cm wide, centre
    // at 18.5 — 1.5 cm of clearance, which the shipped 1.5% jitter straddles.
    const world = createWorld(corridor('#'), EXACT.body)
    const result = move(world, JITTERY, at(18.5, 12, 90, 545), 'forward', 10)
    expect(result.blockedCycles).toBeGreaterThan(0)
    expect(result.cyclesTaken).toBeGreaterThan(0)
    expect(result.state.xCm).toBeGreaterThan(18.5)
    expect(result.detail).toContain(`Moved forward ${result.cyclesTaken} of 10 cycle(s)`)
    expect(result.detail).not.toContain('Moved forward 0 of 10 cycle(s)')
    // Still nominal only: the cycle size on paper, never the centimetres actually covered.
    expect(result.detail).toContain('1.5 cm')
    const achievedCm = result.state.xCm - 18.5
    for (const digits of [2, 3]) {
      expect(result.detail, `${digits} dp`).not.toContain(achievedCm.toFixed(digits))
    }
  })

  it('advances the seed on a blocked cycle too, because the gait still ran', () => {
    const world = createWorld(corridor('#'), EXACT.body)
    const jammed = move(world, JITTERY, at(10, 12, 90), 'forward', 10)
    expect(jammed.blockedCycles).toBeGreaterThan(0)
    expect(jammed.state.seed).not.toBe(10)
  })

  it('has a pure generator that never consults Math.random', () => {
    const first = nextRandom(42)
    expect(nextRandom(42)).toEqual(first)
    expect(first.value).toBeGreaterThanOrEqual(0)
    expect(first.value).toBeLessThan(1)
    expect(nextRandom(first.seed).value).not.toBe(first.value)
  })
})

describe('the distance sensor is centimetres end to end', () => {
  /**
   * A 50 x 25 cm hall (10 x 5 tiles) with the robot's centre at 12.5, 12.5 — the centre of tile
   * 2,2. The sensor sits at the centre of the leading face, half a body length ahead, so facing
   * east it casts from x = 17.5.
   */
  function hall(rows: string[]): World {
    return createWorld(arena(rows, { xTiles: 2, yTiles: 2, headingDeg: 90 }), EXACT.body)
  }
  const OPEN_HALL = ['..........', '..........', '..........', '..........', '..........']
  const here = () => at(12.5, 12.5, 90)

  it('reports the actual distance to the face of the thing ahead', () => {
    // Wall at tile column 4, whose near face is at 20 cm; the sensor is at 17.5. 2.5 cm — below
    // the 3 cm bumper — so it reports the bumper. Column 5 is at 25, giving 7.5 cm.
    const near = hall(['..........', '..........', '....#.....', '..........', '..........'])
    expect(distanceCm(near, EXACT, here())).toBeCloseTo(3, 9)

    const further = hall(['..........', '..........', '.....#....', '..........', '..........'])
    expect(distanceCm(further, EXACT, here())).toBeCloseTo(7.5, 9)

    const furthest = hall(['..........', '..........', '........#.', '..........', '..........'])
    expect(distanceCm(furthest, EXACT, here())).toBeCloseTo(22.5, 9)
  })

  it('reports a distance that is not a multiple of the tile, which is the whole point', () => {
    // The old sensor could only ever say 2, 25, 50 ... 200. Two of those fell in the 3-50 cm band
    // the prompt tells the model to trust. Here the reading is whatever the geometry is: from
    // 17.5 cm to a face at 45 cm is 27.5.
    const world = hall(['..........', '..........', '.........#', '..........', '..........'])
    expect(distanceCm(world, EXACT, here())).toBeCloseTo(27.5, 9)
    expect(distanceCm(world, EXACT, at(11.3, 12.5, 90))).toBeCloseTo(28.7, 9)
  })

  it('takes its floor and its ceiling from the profile, not from constants in the module', () => {
    const world = hall(['..........', '..........', '.....#....', '..........', '..........'])
    // The true geometry is 7.5 cm. A robot with a taller bumper cannot report it.
    expect(distanceCm(world, withProfile({ sensor: { minRangeCm: 12 } }), here())).toBeCloseTo(12, 9)
    // ...and one whose reach stops short reports its own cap rather than the open ground beyond.
    const open = hall(OPEN_HALL)
    expect(distanceCm(open, EXACT, here())).toBeCloseTo(32.5, 9)
    expect(distanceCm(open, withProfile({ sensor: { maxRangeCm: 20 } }), here())).toBeCloseTo(20, 9)
  })

  it('casts ONE ray from the centre of the leading face, and misses what is beside it', () => {
    // A real HC-SR04 has a narrow cone and does not see an obstacle off to one side, which is
    // exactly why `system-prompt.md` tells the model to sweep a cycle at a time and take the
    // smallest reading. The wall at tile 4,1 (20..25 across, 5..10 down) is beside the ray at
    // y = 12.5, so the sensor reports open ground — while the body, which spans 7.5..17.5 down,
    // walks straight into it.
    const world = hall(['..........', '....#.....', '..........', '..........', '..........'])
    expect(distanceCm(world, EXACT, here())).toBeCloseTo(32.5, 9)
    expect(move(world, EXACT, here(), 'forward', 10).outcome).toBe('blocked')
  })

  it('sees a soft obstacle and sees straight over an abyss', () => {
    // A forward-facing ultrasonic gets an echo from something standing up and nothing at all from
    // a hole in the floor, so the sensor cannot warn about the fatal terrain. By design.
    // The soft tile's near face is at 20 cm and the sensor is at 17.5, so the true 2.5 cm is
    // below the bumper and comes back as the 3 cm floor.
    const soft = hall(['..........', '..........', '....s#....', '..........', '..........'])
    expect(distanceCm(soft, EXACT, here())).toBeCloseTo(3, 9)

    const overAbyss = hall(['..........', '..........', '....~#....', '..........', '..........'])
    expect(distanceCm(overAbyss, EXACT, here())).toBeCloseTo(7.5, 9)
  })

  it('answers in every direction from one spot', () => {
    //  tiles     0    1    2    3    4    5    6    7    8    9
    //  y=0       .    .    .    .    .    .    .    .    .    .
    //  y=1       .    .    .    .    .    .    .    .    .    .
    //  y=2       #    .    .    .    .    .    #    .    .    .
    //  y=3       .    .    .    .    .    .    .    .    .    .
    //  y=4       .    .    #    .    .    .    .    .    .    .
    const world = hall([
      '..........',
      '..........',
      '#.....#...',
      '..........',
      '..#.......',
    ])
    // East: sensor at 17.5, wall face at 30. West: sensor at 7.5, wall face at 5.
    expect(distanceCm(world, EXACT, at(12.5, 12.5, 90))).toBeCloseTo(12.5, 9)
    expect(distanceCm(world, EXACT, at(12.5, 12.5, 270))).toBeCloseTo(3, 9)
    // North: sensor at y 7.5, nothing above, so it exits the world at y 0 — 7.5 cm.
    expect(distanceCm(world, EXACT, at(12.5, 12.5, 0))).toBeCloseTo(7.5, 9)
    // South: sensor at y 17.5, wall at tile 2,4 whose top face is 20 — 2.5 cm, under the bumper.
    expect(distanceCm(world, EXACT, at(12.5, 12.5, 180))).toBeCloseTo(3, 9)
  })
})

describe('changing the tile size rescales the map and nothing else', () => {
  /**
   * THE PROPERTY THAT MAKES THE NEXT ROBOT CHEAP, and the one this whole node is about.
   *
   * The two maps below are the SAME PHYSICAL ARENA drawn at two scales: 10 tiles of 5 cm and 20
   * tiles of 2.5 cm, both 50 cm across, both with a wall from 20 to 25 cm. The robot's body, its
   * stride and its sensor range are stated once, in centimetres, and are not touched. Every
   * measured quantity must come out identical.
   */
  const coarse = createWorld(
    arena(
      ['..........', '....#.....', '....#.....', '..........'],
      { xTiles: 2, yTiles: 2, headingDeg: 90 },
      5,
    ),
    EXACT.body,
  )
  const fine = createWorld(
    arena(
      [
        '....................',
        '....................',
        '........##..........',
        '........##..........',
        '........##..........',
        '........##..........',
        '....................',
        '....................',
      ],
      { xTiles: 4, yTiles: 4, headingDeg: 90 },
      2.5,
    ),
    EXACT.body,
  )

  it('describes the same arena at both scales', () => {
    expect(coarse.widthCm).toBe(50)
    expect(coarse.heightCm).toBe(20)
    expect(fine.widthCm).toBe(50)
    expect(fine.heightCm).toBe(20)
    expect(coarse.widthTiles).toBe(10)
    expect(fine.widthTiles).toBe(20)
  })

  it('leaves the stride, and so the distance travelled, unchanged in centimetres', () => {
    // Two cycles is 3 cm on either map, and the wall is not reached yet.
    const onCoarse = move(coarse, EXACT, at(10, 10, 90), 'forward', 2)
    const onFine = move(fine, EXACT, at(10, 10, 90), 'forward', 2)
    expect(onCoarse.state.xCm).toBeCloseTo(13, 9)
    expect(onFine.state.xCm).toBeCloseTo(13, 9)
  })

  it('leaves the body size, and so where the wall stops it, unchanged in centimetres', () => {
    const onCoarse = move(coarse, EXACT, at(10, 10, 90), 'forward', 10)
    const onFine = move(fine, EXACT, at(10, 10, 90), 'forward', 10)
    expect(onCoarse.state.xCm).toBeCloseTo(14.5, 9)
    expect(onFine.state.xCm).toBeCloseTo(14.5, 9)
    expect(onCoarse.outcome).toBe('blocked')
    expect(onFine.outcome).toBe('blocked')
  })

  it('leaves the sensor reading unchanged in centimetres', () => {
    // Sensor at 15 cm, wall face at 20 cm, on both maps.
    expect(distanceCm(coarse, EXACT, at(10, 10, 90))).toBeCloseTo(5, 9)
    expect(distanceCm(fine, EXACT, at(10, 10, 90))).toBeCloseTo(5, 9)
  })

  it('derives how many tiles the body covers rather than being told', () => {
    // 10 cm of body is two 5 cm tiles and four 2.5 cm ones, and nobody wrote either number.
    const onCoarse = probeSweptBody(coarse, EXACT.body, { xCm: 12.5, yCm: 10 }, { xCm: 12.5, yCm: 10 }, 0)
    expect(onCoarse.kind).toBe('clear')
    expect(tileAtPoint(coarse, { xCm: 8, yCm: 10 })).toBe('floor')
    expect(tileAtPoint(fine, { xCm: 8, yCm: 10 })).toBe('floor')
    expect(tileAt(coarse, 4, 1)).toBe('hard')
    expect(tileAt(fine, 8, 2)).toBe('hard')
  })
})

describe('maps are data, and a start must fit the body that stands on it', () => {
  it('defaults the tile size to five centimetres', () => {
    const world = createWorld(
      { id: 'no-tile-size', rows: ['....', '....', '....', '....'], start: { xTiles: 1, yTiles: 1, headingDeg: 0 } },
      EXACT.body,
    )
    expect(world.tileSizeCm).toBe(5)
    expect(DEFAULT_TILE_SIZE_CM).toBe(5)
    expect(world.widthCm).toBe(20)
  })

  it('places the body centre at the centre of the start tile', () => {
    const world = createWorld(arena(OPEN_9x9, { xTiles: 4, yTiles: 6, headingDeg: 90 }), EXACT.body)
    const start = initialState(world)
    expect(start.xCm).toBe(22.5)
    expect(start.yCm).toBe(32.5)
    expect(start.headingDeg).toBe(90)
  })

  it('refuses a ragged map rather than shifting every coordinate below the short row', () => {
    expect(() =>
      createWorld({ id: 'ragged', rows: ['....', '..'], start: { xTiles: 0, yTiles: 0, headingDeg: 0 } }),
    ).toThrow(/row 1 is 2 tiles wide/)
  })

  it('refuses an unknown map character', () => {
    expect(() =>
      createWorld({ id: 'bad', rows: ['..?.', '....'], start: { xTiles: 0, yTiles: 0, headingDeg: 0 } }),
    ).toThrow(/unknown map character/)
  })

  it('refuses a nonsensical tile size', () => {
    expect(() =>
      createWorld({
        id: 'zero-tile',
        rows: ['....', '....'],
        tileSizeCm: 0,
        start: { xTiles: 0, yTiles: 0, headingDeg: 0 },
      }),
    ).toThrow(/tileSizeCm must be positive/)
  })

  it('refuses a start whose CENTRE is clear but whose body corner is in a wall', () => {
    // The case a centre-tile check waves through: tile 1,1 is ordinary floor, its centre is
    // 7.5,7.5, and the 10 cm body standing there reaches 2.5..12.5 — into the wall at tile 2,2.
    expect(() =>
      createWorld(
        arena(['......', '......', '..#...', '......', '......', '......'], {
          xTiles: 1,
          yTiles: 1,
          headingDeg: 0,
        }),
        EXACT.body,
      ),
    ).toThrow(/tile 2,2, which is hard/)
  })

  it('refuses a start whose body hangs off the edge of the map', () => {
    expect(() =>
      createWorld(arena(OPEN_9x9, { xTiles: 0, yTiles: 0, headingDeg: 0 }), EXACT.body),
    ).toThrow(/out of bounds/)
  })

  it('refuses a start whose centre is over the abyss', () => {
    expect(() =>
      createWorld(
        arena(['......', '......', '..~...', '......', '......', '......'], {
          xTiles: 2,
          yTiles: 2,
          headingDeg: 0,
        }),
        EXACT.body,
      ),
    ).toThrow(/tile 2,2, which is abyss/)
  })

  it('accepts a start a smaller body fits and a larger one does not', () => {
    // Same map, same start, two robots: proof that the validation reads the body it is given.
    const map = arena(['......', '......', '..#...', '......', '......', '......'], {
      xTiles: 3,
      yTiles: 3,
      headingDeg: 0,
    })
    expect(() => createWorld(map, { widthCm: 4, lengthCm: 4 })).not.toThrow()
    expect(() => createWorld(map, { widthCm: 16, lengthCm: 16 })).toThrow(/which is hard/)
  })
})

/**
 * The shipped arena's comment claims it exercises five specific things. Widening every opening to
 * two cells was enough for a body that could only sit square to the grid; a body that can sit at
 * ANY angle needs its diagonal to fit, and the mouth was quietly too narrow again. Each claim is
 * re-verified here against the body that now drives it.
 */
describe('the phase-one arena still exercises what it says it does', () => {
  const world = createWorld(PHASE_ONE_MAP, EXACT.body)

  it('is 70 by 60 cm — the size of the arena actually used with the real robot', () => {
    expect(world.widthTiles).toBe(14)
    expect(world.heightTiles).toBe(12)
    expect(world.tileSizeCm).toBe(5)
    expect(world.widthCm).toBe(70)
    expect(world.heightCm).toBe(60)
  })

  it('defaults to the shipped map', () => {
    expect(createWorld().id).toBe('phase-one-arena')
    expect(PHASE_ONE_MAP.id).toBe('phase-one-arena')
  })

  it('gives the robot open floor around the start to calibrate on', () => {
    // A full cycle in every one of the eight compass directions is clear from the start, which is
    // what "open floor to calibrate on" has to mean for a body that can face any way at all.
    const start = initialState(world)
    for (const { name, headingDeg } of EIGHT_HEADINGS) {
      const result = move(world, EXACT, { ...start, headingDeg }, 'forward', 1)
      expect(result.outcome, name).toBe('moved')
    }
  })

  it('has a pocket mouth the body clears at an angle, not merely square-on', () => {
    // The mouth is tiles 2..4 of row 4 — 10 cm to 25 cm, so 15 cm wide, against a body diagonal
    // of 14.15 cm. Two tiles would be 10 cm and would not take the body at 45 degrees at all.
    const inMouth = { xCm: 17.5, yCm: 22.5 }
    for (const headingDeg of [0, 15, 30, 45, 60, 75, 90]) {
      expect(probeSweptBody(world, EXACT.body, inMouth, inMouth, headingDeg).kind, `${headingDeg}`)
        .toBe('clear')
    }
  })

  it('lets the body up the mouth to the green target, and stops it at the roof', () => {
    // From 17.5, 32.5 straight north: the body may rise until its leading edge touches the roof
    // at 5 cm, i.e. its centre reaches 10 — and 32.5 - 1.5 x 15 is exactly 10.
    const arrived = move(world, EXACT, at(17.5, 32.5, 0), 'forward', 20)
    expect(arrived.state.yCm).toBeCloseTo(10, 9)
    expect(arrived.cyclesTaken).toBe(15)
    expect(arrived.outcome).toBe('blocked')

    // The body (12.5..22.5 across, 5..15 down) is standing on the green row: 17.5,6 is inside it.
    expect(tileAtPoint(world, { xCm: 17.5, yCm: 6 })).toBe('targetGreen')
    expect(tileAt(world, 2, 1)).toBe('targetGreen')
    expect(tileAt(world, 4, 1)).toBe('targetGreen')
  })

  it('leaves the pocket reachable only from below', () => {
    // The walls run from the roof down to 20 cm, and the strip outside each of them is 5 cm — half
    // a body — so there is nowhere alongside the pocket a 10 cm robot can even stand.
    expect(() => createWorld({ ...PHASE_ONE_MAP, start: { xTiles: 0, yTiles: 2, headingDeg: 0 } }, EXACT.body))
      .toThrow(/out of bounds/)
    // ...and from inside, every way out but the mouth is refused.
    expect(move(world, EXACT, at(17.5, 10, 0), 'forward', 1).outcome).toBe('blocked')
    // Sideways there is 5 cm of play between the 10 cm body and the 15 cm pocket, so the walls
    // show up as a move that runs out rather than one refused outright.
    expect(move(world, EXACT, at(17.5, 10, 90), 'forward', 10).outcome).toBe('blocked')
    expect(move(world, EXACT, at(17.5, 10, 90), 'forward', 10).state.xCm).toBeCloseTo(19, 9)
    expect(move(world, EXACT, at(17.5, 10, 270), 'forward', 10).outcome).toBe('blocked')
    expect(move(world, EXACT, at(17.5, 10, 270), 'forward', 10).state.xCm).toBeCloseTo(16, 9)
    expect(move(world, EXACT, at(17.5, 10, 180), 'forward', 1).outcome).toBe('moved')
  })

  it('drops a careless multi-cycle move into the abyss', () => {
    // The abyss runs from 35 to 45 cm across. From 27.5 the centre crosses 35 on the sixth cycle.
    const fatal = move(world, EXACT, at(27.5, 27.5, 90), 'forward', 10)
    expect(fatal.outcome).toBe('destroyed')
    expect(fatal.state.destroyed).toBe(true)
    expect(fatal.cyclesTaken).toBe(6)
    expect(fatal.state.xCm).toBeCloseTo(36.5, 9)
  })

  it('puts a soft obstacle on the left approach', () => {
    // Soft tiles 1 and 2 of row 8 span 5..15 cm across. Heading west from the start the body's
    // leading edge reaches 15 once the centre drops below 20.
    const snag = move(world, EXACT, at(27.5, 42.5, 270), 'forward', 10)
    expect(snag.outcome).toBe('partial')
    expect(snag.cyclesTaken).toBe(6)
    expect(snag.state.xCm).toBeCloseTo(18.5, 9)
    expect(snag.state.destroyed).toBe(false)
  })

  it('leaves the red target in the open at the bottom', () => {
    const arrival = move(world, EXACT, at(27.5, 42.5, 180), 'forward', 12)
    expect(arrival.cyclesTaken).toBe(8)
    expect(arrival.state.yCm).toBeCloseTo(54.5, 9)
    // 27.5, 57.5 is inside the body (22.5..32.5 across, 49.5..59.5 down) and on the red target.
    expect(tileAtPoint(world, { xCm: 27.5, yCm: 57.5 })).toBe('targetRed')
    expect(tileAt(world, 5, 11)).toBe('targetRed')
  })
})
