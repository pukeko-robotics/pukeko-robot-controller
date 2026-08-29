/**
 * The grid world the emulator drives a robot around in.
 *
 * Everything here is pure: a map is data, a state is a plain object, and every operation returns
 * a new state plus a description of what happened. That is deliberate — it is what makes the
 * behaviours that actually matter (stopping at a wall, dying on the abyss cell you reached
 * rather than at the end of the path) cheap to assert without booting a server.
 */

/**
 * The eight compass points, in clockwise order, which is what makes the turn arithmetic a modulo.
 *
 * One turn command step is 45°, so a right angle is two of them and `turn(state, 'right', 2)` is
 * the old quarter-turn. Forward and backward then move the robot one cell in any of eight
 * directions — like a king in chess: one cell per step, never a slide.
 */
export const HEADINGS = [
  'north',
  'northeast',
  'east',
  'southeast',
  'south',
  'southwest',
  'west',
  'northwest',
] as const
export type Heading = (typeof HEADINGS)[number]

/** Degrees of rotation one turn step is worth. Eight headings around the circle. */
export const DEGREES_PER_TURN_STEP = 45

/**
 * THE ROBOT IS TWO CELLS SQUARE AND STILL MOVES ONE CELL PER STEP.
 *
 * Half its own body length per step is the point: it makes the motion granular relative to the
 * robot, the way real calibration feels.
 *
 * POSITION SEMANTICS, stated here because every later bug lives in them: `state.x, state.y` is
 * the **top-left cell** of the footprint, and the occupied set is
 * `(x,y), (x+1,y), (x,y+1), (x+1,y+1)`. So the anchor is a corner, not a centre, and a bounds or
 * terrain question is never about one cell — it is about all four.
 *
 * A 2×2 square is rotationally symmetric, so a turn never re-anchors the footprint. Only the
 * drawn sprite changes.
 */
export const FOOTPRINT_CELLS = 2

/** The four cells a footprint occupies, as offsets from the top-left anchor. */
export const FOOTPRINT_OFFSETS: readonly (readonly [number, number])[] = [
  [0, 0],
  [1, 0],
  [0, 1],
  [1, 1],
]

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
 * The layout exercises the things a control loop has to cope with: an open floor to calibrate on,
 * a walled pocket holding the green target (reachable, but only from below), an abyss running
 * down the middle that a careless multi-step move will fall into, a soft obstacle on the left
 * approach, and a red target in the open at the bottom.
 *
 * EVERY OPENING IS TWO CELLS WIDE, because the robot is two cells wide. The arena the 1×1 robot
 * drove had a one-cell pocket mouth and a one-cell rim around the walls; a 2×2 body cannot enter
 * either, so the green target would have been unreachable and "reachable, but only from below"
 * would have quietly become "not reachable at all" with every test still green. Widening the
 * pocket is what keeps the map's stated purposes true of the body that now drives it.
 *
 *      x: 0    1    2    3    4    5    6    7    8    9   10   11   12   13
 *  y=0    .    #    #    #    #    .    .    .    .    .    .    .    .    .
 *  y=1    .    #    g    g    #    .    .    .    .    .    .    .    .    .
 *  y=2    .    #    .    .    #    .    .    .    .    .    .    .    .    .
 *  y=3    .    #    .    .    #    .    .    .    .    .    .    .    .    .
 *  y=4    .    .    .    .    .    .    .    ~    ~    .    .    .    .    .
 *  ...
 *
 * The pocket's mouth is the two-cell gap at x=2..3, y=4: the walls at x=1 and x=4 run from y=0
 * to y=3 and the roof at y=0 closes the top, so the only footprint that reaches the two green
 * cells is one that came up the mouth.
 */
export const PHASE_ONE_MAP: WorldMap = {
  id: 'phase-one-arena',
  rows: [
    '.####.........',
    '.#gg#.........',
    '.#..#.........',
    '.#..#.........',
    '.......~~.....',
    '.......~~.....',
    '.......~~.....',
    '..............',
    '.ss...........',
    '..............',
    '.........##...',
    '....rr........',
  ],
  start: { x: 4, y: 8, heading: 'north' },
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
  // The WHOLE footprint is validated, not just the anchor cell. A 2×2 body whose anchor is on
  // clear floor can still have a corner in a wall or over the edge, and a start like that puts
  // the robot inside geometry it could never have driven into.
  for (const [offsetX, offsetY] of FOOTPRINT_OFFSETS) {
    const x = map.start.x + offsetX
    const y = map.start.y + offsetY
    const kind = cellAt(world, x, y)
    if (kind === null || kind === 'hard' || kind === 'abyss') {
      throw new Error(
        `world "${map.id}": start ${map.start.x},${map.start.y} puts a ${FOOTPRINT_CELLS}x${FOOTPRINT_CELLS} footprint corner on ${x},${y}, which is ${kind ?? 'out of bounds'}`,
      )
    }
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

/**
 * One cell of travel per heading. A diagonal moves BOTH axes by one — a king's step, not a
 * queen's slide, and not a knight's.
 *
 * A diagonal step therefore leaves the destination footprint overlapping the source footprint in
 * exactly one cell, so the robot never squeezes between two diagonally-touching walls: those two
 * walls are themselves cells of the destination footprint and refuse it. That is why a plain
 * destination-footprint test is sufficient here and no separate corner-cutting rule is needed.
 */
const DELTA: Readonly<Record<Heading, { dx: number; dy: number }>> = {
  north: { dx: 0, dy: -1 },
  northeast: { dx: 1, dy: -1 },
  east: { dx: 1, dy: 0 },
  southeast: { dx: 1, dy: 1 },
  south: { dx: 0, dy: 1 },
  southwest: { dx: -1, dy: 1 },
  west: { dx: -1, dy: 0 },
  northwest: { dx: -1, dy: -1 },
}

/** Rotate a heading by `turnSteps` of 45° (positive is clockwise), wrapping in both directions. */
export function rotate(heading: Heading, turnSteps: number): Heading {
  const from = HEADINGS.indexOf(heading)
  const to = (((from + turnSteps) % HEADINGS.length) + HEADINGS.length) % HEADINGS.length
  return HEADINGS[to]
}

/** What a whole 2×2 footprint anchored at `x,y` would run into, worst case first. */
type FootprintVerdict =
  | { kind: 'clear' }
  | { kind: 'blocked'; x: number; y: number; reason: 'edge' | 'obstacle' }
  | { kind: 'fatal'; x: number; y: number }
  | { kind: 'snag'; x: number; y: number }

/**
 * Judge a destination footprint as a whole.
 *
 * Precedence is deliberate and is the thing a single-cell implementation cannot express: a wall
 * under ANY corner refuses the move outright, so a footprint straddling both a wall and an abyss
 * is blocked rather than fatal — the robot never gets to enter it. Below that, an abyss under any
 * corner is fatal, and a soft cell under any corner ends the move there.
 */
function probeFootprint(world: World, x: number, y: number): FootprintVerdict {
  let fatal: { x: number; y: number } | null = null
  let snag: { x: number; y: number } | null = null

  for (const [offsetX, offsetY] of FOOTPRINT_OFFSETS) {
    const cellX = x + offsetX
    const cellY = y + offsetY
    const kind = cellAt(world, cellX, cellY)
    if (kind === null) return { kind: 'blocked', x: cellX, y: cellY, reason: 'edge' }
    if (kind === 'hard') return { kind: 'blocked', x: cellX, y: cellY, reason: 'obstacle' }
    if (kind === 'abyss' && fatal === null) fatal = { x: cellX, y: cellY }
    if (kind === 'soft' && snag === null) snag = { x: cellX, y: cellY }
  }

  if (fatal !== null) return { kind: 'fatal', ...fatal }
  if (snag !== null) return { kind: 'snag', ...snag }
  return { kind: 'clear' }
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
 * Per step, the destination FOOTPRINT is what is tested — all four cells, never just the anchor:
 *  - bounds or a hard obstacle under any corner → that step is a no-op and the run continues, so
 *    a model that keeps pushing forward gets a truthful "you did not move" rather than a silent
 *    failure;
 *  - an abyss under any corner → the robot is destroyed there and the loop stops;
 *  - a soft obstacle under any corner → the robot enters and the move stops there: a partial,
 *    recoverable move.
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
    const verdict = probeFootprint(world, nextX, nextY)

    if (verdict.kind === 'blocked') {
      blockedSteps++
      outcome = 'blocked'
      detail =
        verdict.reason === 'edge'
          ? `Blocked by the edge of the world at ${verdict.x},${verdict.y}. Moved ${stepsTaken} of ${steps} cell(s).`
          : `Blocked by an obstacle at ${verdict.x},${verdict.y}. Moved ${stepsTaken} of ${steps} cell(s).`
      continue
    }

    x = nextX
    y = nextY
    stepsTaken++

    if (verdict.kind === 'fatal') {
      destroyed = true
      outcome = 'destroyed'
      detail = `Fell into the abyss at ${verdict.x},${verdict.y} after ${stepsTaken} of ${steps} cell(s). The robot is destroyed and the run is over.`
      break
    }

    if (verdict.kind === 'snag') {
      outcome = 'partial'
      detail = `Snagged on a soft obstacle at ${verdict.x},${verdict.y}; the move stopped there after ${stepsTaken} of ${steps} cell(s).`
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

/**
 * Turning is always possible while the robot is alive, and never moves it.
 *
 * The `detail` string is the whole interface to the agent — the observation is what the model
 * reasons from — so it states the arithmetic the model has to do: how many 45° steps, and how
 * many degrees that adds up to. It must never say "quarter-turn": one step has not been 90°
 * since the robot gained eight headings, and a model told otherwise will over-rotate by double.
 */
export function turn(
  state: RobotWorldState,
  direction: 'left' | 'right',
  steps: number,
): MoveResult {
  if (state.destroyed) return runOverResult(state, steps)

  const heading = rotate(state.heading, direction === 'right' ? steps : -steps)
  const degrees = steps * DEGREES_PER_TURN_STEP
  return {
    state: { ...state, heading },
    requestedSteps: steps,
    stepsTaken: steps,
    blockedSteps: 0,
    outcome: 'moved',
    detail: `Turned ${direction} ${steps} step(s) of ${DEGREES_PER_TURN_STEP} degrees, which is ${degrees} degrees in total; now facing ${heading}.`,
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
 * The footprint cells that have open world in front of them — the robot's leading face.
 *
 * A cell is on the leading face when the cell one step along the heading is NOT part of the same
 * footprint. For a cardinal heading that is the two cells of the front edge; for a diagonal it is
 * the three cells of the leading corner's L. Defining it this way rather than by a per-heading
 * table means no ray ever starts by passing through the robot's own body, which is the property
 * that actually has to hold.
 */
function leadingCells(state: RobotWorldState): Array<{ x: number; y: number }> {
  const { dx, dy } = DELTA[state.heading]
  const inFootprint = (offsetX: number, offsetY: number) =>
    offsetX >= 0 && offsetX < FOOTPRINT_CELLS && offsetY >= 0 && offsetY < FOOTPRINT_CELLS
  return FOOTPRINT_OFFSETS.filter(
    ([offsetX, offsetY]) => !inFootprint(offsetX + dx, offsetY + dy),
  ).map(([offsetX, offsetY]) => ({ x: state.x + offsetX, y: state.y + offsetY }))
}

/** Clear cells between one leading cell and the first thing that echoes, capped at the scan range. */
function clearCellsAhead(world: World, from: { x: number; y: number }, heading: Heading): number {
  const { dx, dy } = DELTA[heading]
  let x = from.x
  let y = from.y
  let free = 0

  while (free < MAX_SCAN_CELLS) {
    x += dx
    y += dy
    const kind = cellAt(world, x, y)
    if (kind === null || kind === 'hard' || kind === 'soft') break
    free++
  }

  return free
}

/**
 * Distance to the first blocking cell ahead, on the same centimetre-ish scale the stub faked,
 * so the ultrasonic tool keeps meaning what it meant.
 *
 * CAST ORIGIN — the choice this needed once the body stopped being a single cell. The sensor is
 * modelled as sitting at the CENTRE OF THE LEADING EDGE of the 2×2 chassis, which is where a
 * forward-facing ultrasonic actually sits. That centre is a lattice point, not a cell: on a
 * cardinal heading the beam runs exactly along the boundary between the two front cells' columns
 * (or rows), grazing both. The faithful discretisation of a ray that grazes two cells is to take
 * whichever returns first, so the reading is the MINIMUM over rays cast from each cell of the
 * leading face. A single arbitrarily-chosen front corner would have been the alternative, and it
 * is the wrong one: it reports open ground while the other half of a two-cell-wide body drives
 * into a wall.
 *
 * An abyss is transparent here, and that is a modelling choice worth knowing about: a downward
 * hole reflects nothing back to a forward-facing ultrasonic, so the sensor cannot warn about it.
 * A soft obstacle is solid enough to echo, so it blocks the beam even though it can be driven
 * into.
 */
export function distanceCm(world: World, state: RobotWorldState): number {
  const free = Math.min(
    ...leadingCells(state).map((cell) => clearCellsAhead(world, cell, state.heading)),
  )
  return Math.max(MIN_DISTANCE_CM, free * CM_PER_CELL)
}
