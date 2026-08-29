/**
 * The grid world the emulator drives a robot around in.
 *
 * Everything here is pure: a map is data, a state is a plain object, and every operation returns
 * a new state plus a description of what happened. That is deliberate — it is what makes the
 * behaviours that actually matter (stopping at a wall, dying on the abyss cell you reached
 * rather than at the end of the path) cheap to assert without booting a server.
 */

/** The four cardinals, in clockwise order, which is what makes the turn arithmetic a modulo. */
export const HEADINGS = ['north', 'east', 'south', 'west'] as const
export type Heading = (typeof HEADINGS)[number]

/**
 * What a cell is. The names are behavioural, not visual — the colours live in the renderer.
 *
 * - `floor`       drivable
 * - `hard`        an obstacle that cannot be entered at all
 * - `soft`        an obstacle that can be entered but ends the move there; recoverable
 * - `abyss`       fatal; entering it ends the run
 * - `targetRed`   drivable, and a thing the agent may be asked to seek
 * - `targetGreen` drivable, likewise
 */
export type CellKind = 'floor' | 'hard' | 'soft' | 'abyss' | 'targetRed' | 'targetGreen'

/** The character legend a map's rows are written in. */
export const CELL_LEGEND: Readonly<Record<string, CellKind>> = {
  '.': 'floor',
  '#': 'hard',
  s: 'soft',
  '~': 'abyss',
  r: 'targetRed',
  g: 'targetGreen',
}

export interface WorldMap {
  /** Stable identifier, so a response or a log can say which world it is talking about. */
  id: string
  /** Rows of legend characters, top row first. Every row must be the same length. */
  rows: readonly string[]
  start: { x: number; y: number; heading: Heading }
}

export interface World {
  id: string
  width: number
  height: number
  /** Row-major, `cells[y][x]`. */
  cells: readonly (readonly CellKind[])[]
  start: { x: number; y: number; heading: Heading }
}

/**
 * Phase one ships exactly one map, and it ships as data so that adding more is a data change.
 *
 * The layout is chosen to exercise the things a control loop has to cope with: an open floor to
 * calibrate on, a walled pocket holding the green target (reachable, but only from below), a
 * three-cell-wide abyss running down the middle that a careless multi-step move will fall into,
 * a soft obstacle on the left approach, and a red target in the open at the bottom.
 */
export const PHASE_ONE_MAP: WorldMap = {
  id: 'phase-one-arena',
  rows: [
    '............',
    '.###....###.',
    '.#g#......#.',
    '.#.#..~~..#.',
    '......~~....',
    '.s....~~..#.',
    '..........#.',
    '.....##...#.',
    '....r.......',
  ],
  start: { x: 1, y: 8, heading: 'north' },
}

export function createWorld(map: WorldMap = PHASE_ONE_MAP): World {
  if (map.rows.length === 0) throw new Error(`world "${map.id}": map has no rows`)
  const width = map.rows[0].length
  const cells = map.rows.map((row, y) => {
    if (row.length !== width) {
      throw new Error(
        `world "${map.id}": row ${y} is ${row.length} cells wide, expected ${width} — a ragged map silently shifts every coordinate below it`,
      )
    }
    return [...row].map((char, x) => {
      const kind = CELL_LEGEND[char]
      if (!kind) throw new Error(`world "${map.id}": unknown map character "${char}" at ${x},${y}`)
      return kind
    })
  })
  const world: World = { id: map.id, width, height: map.rows.length, cells, start: map.start }
  const startKind = cellAt(world, map.start.x, map.start.y)
  if (startKind === null || startKind === 'hard' || startKind === 'abyss') {
    throw new Error(
      `world "${map.id}": start ${map.start.x},${map.start.y} is ${startKind ?? 'out of bounds'}`,
    )
  }
  return world
}

/** The cell at a coordinate, or `null` when the coordinate is off the grid. */
export function cellAt(world: World, x: number, y: number): CellKind | null {
  if (x < 0 || y < 0 || x >= world.width || y >= world.height) return null
  return world.cells[y][x]
}

export interface RobotWorldState {
  x: number
  y: number
  heading: Heading
  /** Once true, the run is over: no further movement, and every response keeps saying so. */
  destroyed: boolean
}

export function initialState(world: World): RobotWorldState {
  return { x: world.start.x, y: world.start.y, heading: world.start.heading, destroyed: false }
}

const DELTA: Readonly<Record<Heading, { dx: number; dy: number }>> = {
  north: { dx: 0, dy: -1 },
  east: { dx: 1, dy: 0 },
  south: { dx: 0, dy: 1 },
  west: { dx: -1, dy: 0 },
}

/** Rotate a heading by `quarterTurns` (positive is clockwise), wrapping in both directions. */
export function rotate(heading: Heading, quarterTurns: number): Heading {
  const from = HEADINGS.indexOf(heading)
  const to = (((from + quarterTurns) % 4) + 4) % 4
  return HEADINGS[to]
}

export type MoveOutcome =
  /** Every requested step was taken. */
  | 'moved'
  /** At least one step was refused by bounds or a hard obstacle; the robot is intact. */
  | 'blocked'
  /** A soft obstacle was entered and ended the move early. */
  | 'partial'
  /** An abyss was entered. The run is over. */
  | 'destroyed'
  /** The run was already over before the command arrived. */
  | 'run_over'

export interface MoveResult {
  state: RobotWorldState
  requestedSteps: number
  stepsTaken: number
  /** Steps refused by bounds or a hard obstacle. These are no-ops; the run continues. */
  blockedSteps: number
  outcome: MoveOutcome
  /** A sentence for the model to read. The observation is the whole interface to the agent. */
  detail: string
}

/**
 * Walk `steps` cells, ONE CELL AT A TIME.
 *
 * The stepwise loop is the single most important thing in this module. A `?steps=5` into a wall
 * two cells away has to stop at the wall, and a path that crosses the abyss has to end on the
 * abyss cell rather than wherever the fifth step would have landed. Resolving the move as one
 * jump and then testing only the destination looks entirely plausible and gets both wrong.
 *
 * Per cell entered:
 *  - bounds or a hard obstacle → that step is a no-op and the run continues, so a model that
 *    keeps pushing forward gets a truthful "you did not move" rather than a silent failure;
 *  - an abyss → the robot is destroyed on that cell and the loop stops;
 *  - a soft obstacle → the robot enters it and the move stops there: a partial, recoverable move.
 */
export function move(
  world: World,
  state: RobotWorldState,
  direction: 'forward' | 'backward',
  steps: number,
): MoveResult {
  if (state.destroyed) return runOverResult(state, steps)

  const sign = direction === 'forward' ? 1 : -1
  const { dx, dy } = DELTA[state.heading]
  let { x, y } = state
  let stepsTaken = 0
  let blockedSteps = 0
  let outcome: MoveOutcome = 'moved'
  let destroyed = false
  let detail = `Moved ${direction} ${steps} cell(s).`

  for (let i = 0; i < steps; i++) {
    const nextX = x + dx * sign
    const nextY = y + dy * sign
    const kind = cellAt(world, nextX, nextY)

    if (kind === null || kind === 'hard') {
      blockedSteps++
      outcome = 'blocked'
      detail =
        kind === null
          ? `Blocked by the edge of the world at ${nextX},${nextY}. Moved ${stepsTaken} of ${steps} cell(s).`
          : `Blocked by an obstacle at ${nextX},${nextY}. Moved ${stepsTaken} of ${steps} cell(s).`
      continue
    }

    x = nextX
    y = nextY
    stepsTaken++

    if (kind === 'abyss') {
      destroyed = true
      outcome = 'destroyed'
      detail = `Fell into the abyss at ${x},${y} after ${stepsTaken} of ${steps} cell(s). The robot is destroyed and the run is over.`
      break
    }

    if (kind === 'soft') {
      outcome = 'partial'
      detail = `Snagged on a soft obstacle at ${x},${y}; the move stopped there after ${stepsTaken} of ${steps} cell(s).`
      break
    }
  }

  return {
    state: { x, y, heading: state.heading, destroyed },
    requestedSteps: steps,
    stepsTaken,
    blockedSteps,
    outcome,
    detail,
  }
}

/** Turning is always possible while the robot is alive, and never moves it. */
export function turn(
  state: RobotWorldState,
  direction: 'left' | 'right',
  steps: number,
): MoveResult {
  if (state.destroyed) return runOverResult(state, steps)

  const heading = rotate(state.heading, direction === 'right' ? steps : -steps)
  return {
    state: { ...state, heading },
    requestedSteps: steps,
    stepsTaken: steps,
    blockedSteps: 0,
    outcome: 'moved',
    detail: `Turned ${direction} ${steps} quarter-turn(s); now facing ${heading}.`,
  }
}

/**
 * The answer every endpoint gives once the robot is destroyed.
 *
 * There is deliberately no hidden status field that yanks the control loop out of the run. The
 * observation goes back to the model and the model responds by calling its completion tool to
 * declare failure — the same tool it uses for success.
 */
export function runOverResult(state: RobotWorldState, steps: number): MoveResult {
  return {
    state,
    requestedSteps: steps,
    stepsTaken: 0,
    blockedSteps: 0,
    outcome: 'run_over',
    detail: `The robot was destroyed at ${state.x},${state.y}. The run is over and it cannot move.`,
  }
}

/** Cells the ultrasonic scans before it gives up, which sets the maximum reportable range. */
export const MAX_SCAN_CELLS = 8
/** How many centimetres one cell is worth on the scale the stub's fake reading used. */
export const CM_PER_CELL = 25
/** The firmware never reports below this, so neither does the emulator. */
export const MIN_DISTANCE_CM = 2

/**
 * Distance to the first blocking cell ahead, on the same centimetre-ish scale the stub faked,
 * so the ultrasonic tool keeps meaning what it meant.
 *
 * An abyss is transparent here, and that is a modelling choice worth knowing about: a downward
 * hole reflects nothing back to a forward-facing ultrasonic, so the sensor cannot warn about it.
 * A soft obstacle is solid enough to echo, so it blocks the beam even though it can be driven
 * into.
 */
export function distanceCm(world: World, state: RobotWorldState): number {
  const { dx, dy } = DELTA[state.heading]
  let x = state.x
  let y = state.y
  let free = 0

  while (free < MAX_SCAN_CELLS) {
    x += dx
    y += dy
    const kind = cellAt(world, x, y)
    if (kind === null || kind === 'hard' || kind === 'soft') break
    free++
  }

  return Math.max(MIN_DISTANCE_CM, free * CM_PER_CELL)
}
