/**
 * The world the emulator drives a robot around in.
 *
 * Everything here is pure: a map is data, a state is a plain object, the random
 * source is a seed carried in that state, and every operation returns a new state plus a
 * description of what happened. That is deliberate — it is what makes the behaviours that
 * actually matter (stopping at a wall, dying on the abyss the body's centre reached rather than
 * at the end of the path, two runs from one seed being identical) cheap to assert without
 * booting a server. `Math.random()` anywhere in this module is a defect.
 *
 * ============================ THE UNIT INVARIANT ============================
 *
 * EVERY LENGTH IN THIS MODULE IS IN CENTIMETRES AND EVERY ANGLE IS IN DEGREES.
 *
 * A tile is a MAP-AUTHORING CONVENIENCE and nothing else: it is what lets terrain be a few rows
 * of legend characters that a human can type. The tile's own size is one more setting, in
 * centimetres, and it belongs to the MAP because it is a property of the world rather than of
 * the robot. Outside `WorldMap.rows`, `World.cells` and the `*Tiles` fields that index them,
 * NOTHING is measured in tiles — not the body, not the stride, not the pose, not the sensor.
 *
 * So: how many tiles a body covers is DERIVED, never configured. A 10 cm robot on a 5 cm grid
 * covers 2x2 tiles because the arithmetic says so, and a 20 cm robot on the same grid covers
 * 4x4 without anyone editing a constant. That is what makes a second robot cheap.
 *
 * Where a value's unit is not obvious from its shape, the unit is IN ITS NAME (`xCm`,
 * `headingDeg`, `widthTiles`). A bare number that used to mean tiles and now means centimetres
 * type-checks, looks right, and is wrong by a factor of the tile size; the naming convention is
 * the only thing standing between a reader and that mistake, so do not relax it.
 *
 * Changing a map's tile size RESCALES EVERY MAP ALREADY AUTHORED, because a map's geometry is
 * written in tiles. That is a deliberate act, not a tuning knob.
 *
 * ============================== POSE SEMANTICS ==============================
 *
 * Stated here as loudly as the old cell-anchor semantics were, because every later bug lives in
 * them:
 *
 *   `state.xCm, state.yCm` is the CENTRE of the robot's body, in centimetres from the map's
 *   top-left corner. It is NOT a corner and it is NOT a tile index. A corner anchor stops being
 *   meaningful the moment the body can sit at an angle, which it now can.
 *
 *   `state.headingDeg` is degrees CLOCKWISE FROM NORTH, normalised to [0, 360). North is up the
 *   map, which is -y, so the forward unit vector is `(sin, -cos)` — see `forwardVector`. 0 is
 *   north, 90 is east, 180 south, 270 west. There is no eight-name enum any more: the robot
 *   turns 15 degrees at a time and lands wherever it lands.
 */

import {
  DEFAULT_ROBOT_PHYSICAL_PROFILE,
  type RobotBodyProfile,
  type RobotPhysicalProfile,
} from '../src/agent/robotPresets/physical.js'

/**
 * What a cell is. The names are behavioural, not visual — the colours live in the renderer.
 *
 * - `floor`       drivable
 * - `hard`        an obstacle that cannot be entered at all
 * - `soft`        an obstacle that can be entered but ends the move there; recoverable
 * - `abyss`       fatal; taking the body's centre into it ends the run
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

/**
 * The tile size a map gets when it does not state one, in centimetres.
 *
 * 5 cm is the size that makes the shipped 14x12 arena 70 x 60 cm, which is the arena actually
 * used with the real robot — so the scale is confirmed against hardware rather than merely
 * being self-consistent.
 */
export const DEFAULT_TILE_SIZE_CM = 5

/** Compass names as heading degrees, for map authors. The pose itself is always a number. */
export const NORTH_DEG = 0
export const EAST_DEG = 90
export const SOUTH_DEG = 180
export const WEST_DEG = 270

export interface WorldMap {
  /** Stable identifier, so a response or a log can say which world it is talking about. */
  id: string
  /** Rows of legend characters, top row first. Every row must be the same length. */
  rows: readonly string[]
  /**
   * How many centimetres one tile is worth. Defaults to {@link DEFAULT_TILE_SIZE_CM}.
   *
   * This is the ONE place tiles and centimetres meet. Changing it rescales the whole map, so it
   * is a property of the world, deliberately chosen — never a knob to turn to make a robot fit.
   */
  tileSizeCm?: number
  /**
   * Where the robot starts. `xTiles, yTiles` name a TILE — map geometry is written in tiles —
   * and the robot's body centre is placed at the centre of that tile. `headingDeg` is degrees
   * clockwise from north; the {@link NORTH_DEG} constants above exist so an author need not
   * remember which way 90 points.
   */
  start: { xTiles: number; yTiles: number; headingDeg: number }
}

export interface World {
  id: string
  /** Grid extent, in tiles. The only quantity in this module legitimately counted in tiles. */
  widthTiles: number
  heightTiles: number
  tileSizeCm: number
  /** The same extent as a physical size — `widthTiles * tileSizeCm`. */
  widthCm: number
  heightCm: number
  /** Row-major, `cells[yTiles][xTiles]`. */
  cells: readonly (readonly CellKind[])[]
  /** The start as authored, in tiles. */
  start: { xTiles: number; yTiles: number; headingDeg: number }
  /** The same start as a pose, in centimetres: the centre of the start tile. */
  startCm: { xCm: number; yCm: number; headingDeg: number }
}

/**
 * Phase one ships exactly one map, and it ships as data so that adding more is a data change.
 *
 * The layout exercises the things a control loop has to cope with: an open floor to calibrate
 * on, a walled pocket holding the green target (reachable, but only from below), an abyss
 * running down the middle that a careless multi-cycle move will fall into, a soft obstacle on
 * the left approach, and a red target in the open at the bottom.
 *
 * At 5 cm a tile this is 70 x 60 cm, which is the size of the arena actually used with the real
 * robot.
 *
 * EVERY OPENING IS SIZED AGAINST THE BODY'S DIAGONAL, not its width. A 10 cm body is 14.1 cm
 * across its diagonal, so a body that can sit at an angle does NOT fit through the two-tile
 * (10 cm) mouth that was enough when the robot was axis-aligned and 2x2 cells. The pocket mouth
 * is therefore THREE tiles — 15 cm — which the diagonal clears. Narrow it again and the green
 * target becomes unreachable at most headings while every test stays green, which is precisely
 * how "reachable, but only from below" quietly stopped being true once before.
 *
 *      xTiles: 0    1    2    3    4    5    6    7    8    9   10   11   12   13
 *  yTiles=0    .    #    #    #    #    #    .    .    .    .    .    .    .    .
 *  yTiles=1    .    #    g    g    g    #    .    .    .    .    .    .    .    .
 *  yTiles=2    .    #    .    .    .    #    .    .    .    .    .    .    .    .
 *  yTiles=3    .    #    .    .    .    #    .    .    .    .    .    .    .    .
 *  yTiles=4    .    .    .    .    .    .    .    ~    ~    .    .    .    .    .
 *  ...
 *
 * The pocket's mouth is the three-tile gap at xTiles=2..4, yTiles=4: the walls at xTiles=1 and
 * xTiles=5 run from yTiles=0 to yTiles=3 and the roof at yTiles=0 closes the top, so the only
 * body that reaches the green tiles is one that came up the mouth.
 */
export const PHASE_ONE_MAP: WorldMap = {
  id: 'phase-one-arena',
  rows: [
    '.#####........',
    '.#ggg#........',
    '.#...#........',
    '.#...#........',
    '.......~~.....',
    '.......~~.....',
    '.......~~.....',
    '..............',
    '.ss...........',
    '..............',
    '.........##...',
    '....rr........',
  ],
  tileSizeCm: DEFAULT_TILE_SIZE_CM,
  start: { xTiles: 5, yTiles: 8, headingDeg: NORTH_DEG },
}

// ---------------------------------------------------------------------------
// Geometry. All of it in centimetres; the only tile arithmetic is the division
// by `tileSizeCm` that turns a physical extent into the range of tiles it covers.
// ---------------------------------------------------------------------------

export interface PointCm {
  xCm: number
  yCm: number
}

/**
 * How much two shapes must actually overlap before it counts, in centimetres.
 *
 * Not a fudge factor: "any overlap blocks" is meaningless in floating point without a
 * threshold, because a body driven flush against a wall touches it by a few times 1e-15 and
 * would then be unable to move at all. A micrometre is far below anything the simulation
 * models and far above the arithmetic's noise floor.
 */
export const OVERLAP_EPSILON_CM = 1e-4

/** Degrees, normalised to [0, 360). */
export function normaliseDegrees(degrees: number): number {
  return ((degrees % 360) + 360) % 360
}

/**
 * The unit vector the robot faces. North (0 degrees) is UP the map, and y grows downwards, so
 * north is `(0, -1)` and the general form is `(sin, -cos)`.
 */
export function forwardVector(headingDeg: number): PointCm {
  const radians = (headingDeg * Math.PI) / 180
  return { xCm: Math.sin(radians), yCm: -Math.cos(radians) }
}

/** The unit vector 90 degrees clockwise of `forwardVector` — the robot's right-hand side. */
function rightVector(headingDeg: number): PointCm {
  const radians = (headingDeg * Math.PI) / 180
  return { xCm: Math.cos(radians), yCm: Math.sin(radians) }
}

/**
 * The four corners of the body: a `widthCm` x `lengthCm` rectangle centred on `centre`, with
 * `lengthCm` running along the heading and `widthCm` across it.
 */
export function bodyCorners(
  body: RobotBodyProfile,
  centre: PointCm,
  headingDeg: number,
): PointCm[] {
  const forward = forwardVector(headingDeg)
  const right = rightVector(headingDeg)
  const halfLength = body.lengthCm / 2
  const halfWidth = body.widthCm / 2
  return [
    [1, 1],
    [1, -1],
    [-1, -1],
    [-1, 1],
  ].map(([alongSign, acrossSign]) => ({
    xCm: centre.xCm + forward.xCm * halfLength * alongSign + right.xCm * halfWidth * acrossSign,
    yCm: centre.yCm + forward.yCm * halfLength * alongSign + right.yCm * halfWidth * acrossSign,
  }))
}

/** Monotone-chain convex hull. Returns the hull in order; duplicate points are harmless. */
function convexHull(points: readonly PointCm[]): PointCm[] {
  if (points.length <= 2) return [...points]
  const sorted = [...points].sort((a, b) => a.xCm - b.xCm || a.yCm - b.yCm)
  const cross = (o: PointCm, a: PointCm, b: PointCm) =>
    (a.xCm - o.xCm) * (b.yCm - o.yCm) - (a.yCm - o.yCm) * (b.xCm - o.xCm)

  const build = (input: readonly PointCm[]) => {
    const chain: PointCm[] = []
    for (const point of input) {
      while (chain.length >= 2 && cross(chain[chain.length - 2], chain[chain.length - 1], point) <= 0) {
        chain.pop()
      }
      chain.push(point)
    }
    chain.pop()
    return chain
  }

  return [...build(sorted), ...build([...sorted].reverse())]
}

/**
 * The region the body passes THROUGH while translating from `from` to `to` at a fixed heading.
 *
 * A translated convex shape sweeps its own convex hull with the translated copy of itself, so
 * this is the hull of the eight corners. Sweeping is the whole point (see `move`): a 1.5 cm
 * stride is smaller than a 5 cm tile, which makes endpoint sampling look safe when it is not —
 * the body is 10 cm across and its swept rectangle crosses tiles that neither endpoint touches.
 */
export function sweptBodyPolygon(
  body: RobotBodyProfile,
  from: PointCm,
  to: PointCm,
  headingDeg: number,
): PointCm[] {
  return convexHull([
    ...bodyCorners(body, from, headingDeg),
    ...bodyCorners(body, to, headingDeg),
  ])
}

function projectionRange(points: readonly PointCm[], axis: PointCm): { min: number; max: number } {
  let min = Infinity
  let max = -Infinity
  for (const point of points) {
    const value = point.xCm * axis.xCm + point.yCm * axis.yCm
    if (value < min) min = value
    if (value > max) max = value
  }
  return { min, max }
}

/**
 * Do a convex point set and an axis-aligned rectangle overlap by more than
 * {@link OVERLAP_EPSILON_CM}? Separating-axis test.
 *
 * This measures AREA overlap and so is only meaningful for a shape that has area. A line segment
 * has none — its projection onto its own normal is a single point, so the overlap on that axis is
 * always zero and SAT would call every segment separate from every rectangle. The centre-path
 * rule below therefore uses {@link segmentEntersRect} instead; do not "simplify" it back to this.
 */
function overlapsRect(
  polygon: readonly PointCm[],
  rect: { leftCm: number; topCm: number; rightCm: number; bottomCm: number },
): boolean {
  const rectCorners: PointCm[] = [
    { xCm: rect.leftCm, yCm: rect.topCm },
    { xCm: rect.rightCm, yCm: rect.topCm },
    { xCm: rect.rightCm, yCm: rect.bottomCm },
    { xCm: rect.leftCm, yCm: rect.bottomCm },
  ]

  const axes: PointCm[] = [
    { xCm: 1, yCm: 0 },
    { xCm: 0, yCm: 1 },
  ]
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i]
    const b = polygon[(i + 1) % polygon.length]
    const edgeX = b.xCm - a.xCm
    const edgeY = b.yCm - a.yCm
    const length = Math.hypot(edgeX, edgeY)
    if (length < OVERLAP_EPSILON_CM) continue
    axes.push({ xCm: -edgeY / length, yCm: edgeX / length })
  }

  for (const axis of axes) {
    const a = projectionRange(polygon, axis)
    const b = projectionRange(rectCorners, axis)
    const overlap = Math.min(a.max, b.max) - Math.max(a.min, b.min)
    if (overlap <= OVERLAP_EPSILON_CM) return false
  }
  return true
}

/**
 * Does a line segment reach the INTERIOR of an axis-aligned rectangle?
 *
 * Liang-Barsky clipping against the rectangle shrunk by {@link OVERLAP_EPSILON_CM}, so a segment
 * that merely runs along a tile's boundary is outside it — the same "must actually overlap"
 * convention the body test uses. A degenerate segment (`from` equal to `to`) is handled by the
 * same arithmetic and answers "is this point strictly inside", which is what a stationary body's
 * centre needs.
 */
function segmentEntersRect(
  from: PointCm,
  to: PointCm,
  rect: { leftCm: number; topCm: number; rightCm: number; bottomCm: number },
): boolean {
  const leftCm = rect.leftCm + OVERLAP_EPSILON_CM
  const rightCm = rect.rightCm - OVERLAP_EPSILON_CM
  const topCm = rect.topCm + OVERLAP_EPSILON_CM
  const bottomCm = rect.bottomCm - OVERLAP_EPSILON_CM
  if (leftCm >= rightCm || topCm >= bottomCm) return false

  let enter = 0
  let leave = 1
  const clip = (denominator: number, numerator: number): boolean => {
    if (denominator === 0) return numerator >= 0
    const crossing = numerator / denominator
    if (denominator < 0) {
      if (crossing > leave) return false
      if (crossing > enter) enter = crossing
    } else {
      if (crossing < enter) return false
      if (crossing < leave) leave = crossing
    }
    return true
  }

  const runCm = to.xCm - from.xCm
  const riseCm = to.yCm - from.yCm
  return (
    clip(-runCm, from.xCm - leftCm) &&
    clip(runCm, rightCm - from.xCm) &&
    clip(-riseCm, from.yCm - topCm) &&
    clip(riseCm, bottomCm - from.yCm)
  )
}

/** The physical extent of one tile, in centimetres. */
function tileRect(world: World, xTiles: number, yTiles: number) {
  return {
    leftCm: xTiles * world.tileSizeCm,
    topCm: yTiles * world.tileSizeCm,
    rightCm: (xTiles + 1) * world.tileSizeCm,
    bottomCm: (yTiles + 1) * world.tileSizeCm,
  }
}

function boundsOf(points: readonly PointCm[]) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const point of points) {
    if (point.xCm < minX) minX = point.xCm
    if (point.yCm < minY) minY = point.yCm
    if (point.xCm > maxX) maxX = point.xCm
    if (point.yCm > maxY) maxY = point.yCm
  }
  return { minX, minY, maxX, maxY }
}

/** The tiles a shape's bounding box could possibly touch, clipped to the grid. */
function candidateTiles(world: World, points: readonly PointCm[]) {
  const bounds = boundsOf(points)
  return {
    fromX: Math.max(0, Math.floor((bounds.minX + OVERLAP_EPSILON_CM) / world.tileSizeCm)),
    toX: Math.min(world.widthTiles - 1, Math.floor((bounds.maxX - OVERLAP_EPSILON_CM) / world.tileSizeCm)),
    fromY: Math.max(0, Math.floor((bounds.minY + OVERLAP_EPSILON_CM) / world.tileSizeCm)),
    toY: Math.min(world.heightTiles - 1, Math.floor((bounds.maxY - OVERLAP_EPSILON_CM) / world.tileSizeCm)),
    bounds,
  }
}

/** The tile at a tile coordinate, or `null` when the coordinate is off the grid. */
export function tileAt(world: World, xTiles: number, yTiles: number): CellKind | null {
  if (xTiles < 0 || yTiles < 0 || xTiles >= world.widthTiles || yTiles >= world.heightTiles) {
    return null
  }
  return world.cells[yTiles][xTiles]
}

/** The tile a point in centimetres falls in, or `null` when the point is outside the world. */
export function tileAtPoint(world: World, point: PointCm): CellKind | null {
  return tileAt(
    world,
    Math.floor(point.xCm / world.tileSizeCm),
    Math.floor(point.yCm / world.tileSizeCm),
  )
}

// ---------------------------------------------------------------------------
// Collision
// ---------------------------------------------------------------------------

/** What a swept body ran into, worst case first. Coordinates are the offending TILE. */
export type CollisionVerdict =
  | { kind: 'clear' }
  | { kind: 'blocked'; xTiles: number; yTiles: number; reason: 'edge' | 'obstacle' }
  | { kind: 'fatal'; xTiles: number; yTiles: number }
  | { kind: 'snag'; xTiles: number; yTiles: number }

/**
 * THE COLLISION RULE, in one named place so that it is one rule and it is testable on its own.
 *
 * "Under any corner" meant something when the body covered exactly four cells; it means nothing
 * once the body sits at an angle and overlaps tiles fractionally. So the rule is stated in terms
 * of AREA OVERLAP, with the old precedence preserved:
 *
 *  - ANY overlap with a `hard` tile, or with anything outside the world, BLOCKS. Conservative on
 *    purpose: keeping the robot out of walls entirely is worth more than modelling a scrape.
 *  - The abyss is FATAL when the body's CENTRE crosses into it — not on a millimetre of
 *    overhang. A wheel over the lip should not end the run, and a body 10 cm across would
 *    otherwise die two tiles before it looked like it should.
 *  - ANY overlap with a `soft` tile SNAGS: the body enters and the move ends there.
 *
 * Precedence is blocked > fatal > snag, and it is deliberate: a wall refuses the move outright,
 * so a sweep that straddles both a wall and an abyss is blocked rather than fatal — the robot
 * never gets to enter it. Getting that backwards kills a robot that never moved.
 *
 * `from`/`to` are body CENTRES; the shape tested is the whole swept body between them, and the
 * abyss test is the centre's own path.
 */
export function probeSweptBody(
  world: World,
  body: RobotBodyProfile,
  from: PointCm,
  to: PointCm,
  headingDeg: number,
): CollisionVerdict {
  const polygon = sweptBodyPolygon(body, from, to, headingDeg)
  const { fromX, toX, fromY, toY, bounds } = candidateTiles(world, polygon)

  // Outside the world is a hard block, exactly as a wall is. Reported as the tile just past the
  // edge that the body reached into, so the message names a place rather than a bound.
  if (bounds.minX < -OVERLAP_EPSILON_CM) {
    return { kind: 'blocked', xTiles: -1, yTiles: Math.floor(from.yCm / world.tileSizeCm), reason: 'edge' }
  }
  if (bounds.minY < -OVERLAP_EPSILON_CM) {
    return { kind: 'blocked', xTiles: Math.floor(from.xCm / world.tileSizeCm), yTiles: -1, reason: 'edge' }
  }
  if (bounds.maxX > world.widthCm + OVERLAP_EPSILON_CM) {
    return {
      kind: 'blocked',
      xTiles: world.widthTiles,
      yTiles: Math.floor(from.yCm / world.tileSizeCm),
      reason: 'edge',
    }
  }
  if (bounds.maxY > world.heightCm + OVERLAP_EPSILON_CM) {
    return {
      kind: 'blocked',
      xTiles: Math.floor(from.xCm / world.tileSizeCm),
      yTiles: world.heightTiles,
      reason: 'edge',
    }
  }

  let snag: { xTiles: number; yTiles: number } | null = null
  for (let yTiles = fromY; yTiles <= toY; yTiles++) {
    for (let xTiles = fromX; xTiles <= toX; xTiles++) {
      const kind = world.cells[yTiles][xTiles]
      if (kind !== 'hard' && kind !== 'soft') continue
      if (!overlapsRect(polygon, tileRect(world, xTiles, yTiles))) continue
      if (kind === 'hard') return { kind: 'blocked', xTiles, yTiles, reason: 'obstacle' }
      if (snag === null) snag = { xTiles, yTiles }
    }
  }

  // The abyss, judged on the centre's path only. A segment, not a rectangle: the centre is a
  // point, and testing the segment rather than sampling its endpoints means no stride can ever
  // step over a hole, however the tile size and the stride are later configured.
  const centrePath: PointCm[] = [from, to]
  const centreTiles = candidateTiles(world, centrePath)
  for (let yTiles = centreTiles.fromY; yTiles <= centreTiles.toY; yTiles++) {
    for (let xTiles = centreTiles.fromX; xTiles <= centreTiles.toX; xTiles++) {
      if (world.cells[yTiles][xTiles] !== 'abyss') continue
      if (segmentEntersRect(from, to, tileRect(world, xTiles, yTiles))) {
        return { kind: 'fatal', xTiles, yTiles }
      }
    }
  }

  if (snag !== null) return { kind: 'snag', ...snag }
  return { kind: 'clear' }
}

// ---------------------------------------------------------------------------
// World construction
// ---------------------------------------------------------------------------

export function createWorld(
  map: WorldMap = PHASE_ONE_MAP,
  body: RobotBodyProfile = DEFAULT_ROBOT_PHYSICAL_PROFILE.body,
): World {
  if (map.rows.length === 0) throw new Error(`world "${map.id}": map has no rows`)
  const widthTiles = map.rows[0].length
  const tileSizeCm = map.tileSizeCm ?? DEFAULT_TILE_SIZE_CM
  if (!(tileSizeCm > 0)) {
    throw new Error(`world "${map.id}": tileSizeCm must be positive, got ${tileSizeCm}`)
  }

  const cells = map.rows.map((row, yTiles) => {
    if (row.length !== widthTiles) {
      throw new Error(
        `world "${map.id}": row ${yTiles} is ${row.length} tiles wide, expected ${widthTiles} — a ragged map silently shifts every coordinate below it`,
      )
    }
    return [...row].map((char, xTiles) => {
      const kind = CELL_LEGEND[char]
      if (!kind) {
        throw new Error(`world "${map.id}": unknown map character "${char}" at ${xTiles},${yTiles}`)
      }
      return kind
    })
  })

  const heightTiles = map.rows.length
  const startCm = {
    xCm: (map.start.xTiles + 0.5) * tileSizeCm,
    yCm: (map.start.yTiles + 0.5) * tileSizeCm,
    headingDeg: normaliseDegrees(map.start.headingDeg),
  }
  const world: World = {
    id: map.id,
    widthTiles,
    heightTiles,
    tileSizeCm,
    widthCm: widthTiles * tileSizeCm,
    heightCm: heightTiles * tileSizeCm,
    cells,
    start: map.start,
    startCm,
  }

  // The WHOLE BODY is validated, not the centre tile. A body whose centre is on clear floor can
  // still have a corner in a wall or over the edge, and a start like that puts the robot inside
  // geometry it could never have driven into. A zero-length sweep is exactly the body itself.
  const centre = { xCm: startCm.xCm, yCm: startCm.yCm }
  const verdict = probeSweptBody(world, body, centre, centre, startCm.headingDeg)
  if (verdict.kind === 'blocked') {
    throw new Error(
      `world "${map.id}": start tile ${map.start.xTiles},${map.start.yTiles} puts the ${body.widthCm}x${body.lengthCm} cm body on tile ${verdict.xTiles},${verdict.yTiles}, which is ${verdict.reason === 'edge' ? 'out of bounds' : 'hard'}`,
    )
  }
  if (verdict.kind === 'fatal') {
    throw new Error(
      `world "${map.id}": start tile ${map.start.xTiles},${map.start.yTiles} puts the body centre on tile ${verdict.xTiles},${verdict.yTiles}, which is abyss`,
    )
  }
  return world
}

// ---------------------------------------------------------------------------
// State and the seeded random source
// ---------------------------------------------------------------------------

export interface RobotWorldState {
  /** Body CENTRE, centimetres from the map's top-left corner. */
  xCm: number
  yCm: number
  /** Degrees clockwise from north, in [0, 360). */
  headingDeg: number
  /** Once true, the run is over: no further movement, and every response keeps saying so. */
  destroyed: boolean
  /**
   * The jitter source, carried in the state so the module stays pure and a run is reproducible
   * from its starting seed. Every jittered cycle advances it, whether or not the cycle was
   * allowed — a blocked cycle still asked the gait for a motion.
   */
  seed: number
}

/** The seed a run starts from when nobody chooses one. Any value works; this one is arbitrary. */
export const DEFAULT_SEED = 0x51ac0de

/** One draw from the seeded generator: a value in [0, 1) and the seed to carry forward. */
export function nextRandom(seed: number): { value: number; seed: number } {
  const next = (seed + 0x6d2b79f5) >>> 0
  let x = next
  x = Math.imul(x ^ (x >>> 15), x | 1)
  x ^= x + Math.imul(x ^ (x >>> 7), x | 61)
  return { value: ((x ^ (x >>> 14)) >>> 0) / 4294967296, seed: next }
}

/**
 * One jittered magnitude, plus the advanced seed.
 *
 * The draw happens even when `jitterFraction` is 0, so that turning jitter off changes the
 * numbers a run produces but not the STRUCTURE of the seed sequence. With `jitterFraction: 0`
 * the factor is exactly 1 and motion is exact, which is what makes a scripted sequence
 * reproducible to the digit.
 */
function jittered(nominal: number, jitterFraction: number, seed: number) {
  const draw = nextRandom(seed)
  return { value: nominal * (1 + (draw.value * 2 - 1) * jitterFraction), seed: draw.seed }
}

export function initialState(world: World, seed: number = DEFAULT_SEED): RobotWorldState {
  return {
    xCm: world.startCm.xCm,
    yCm: world.startCm.yCm,
    headingDeg: world.startCm.headingDeg,
    destroyed: false,
    seed,
  }
}

// ---------------------------------------------------------------------------
// Motion
// ---------------------------------------------------------------------------

export type MoveOutcome =
  /** Every requested cycle was taken. */
  | 'moved'
  /** At least one cycle was refused by bounds or a hard obstacle; the robot is intact. */
  | 'blocked'
  /** A soft obstacle was entered and ended the move early. */
  | 'partial'
  /** An abyss was entered. The run is over. */
  | 'destroyed'
  /** The run was already over before the command arrived. */
  | 'run_over'

export interface MoveResult {
  state: RobotWorldState
  requestedCycles: number
  cyclesTaken: number
  /** Cycles refused by bounds or a hard obstacle. These are no-ops; the run continues. */
  blockedCycles: number
  outcome: MoveOutcome
  /**
   * A sentence for the model to read. The observation is the whole interface to the agent.
   *
   * IT REPORTS AT THE COMMAND LEVEL AND NEVER THE ACHIEVED DISTANCE, AND THAT IS DELIBERATE.
   * With jitter on, the 1.5 cm asked for is not the 1.5 cm travelled, and it is tempting to
   * report the true figure because the emulator knows it. Do not. A real robot has no odometry:
   * it does not know how far it actually went, and living with that ignorance is the skill the
   * simulated world exists to let a student practise. Ground truth stays available to the
   * renderer and to the tests through `state`, which is where it belongs.
   */
  detail: string
}

/**
 * Walk `cycles` gait cycles, ONE CYCLE AT A TIME.
 *
 * The per-cycle loop is the single most important thing in this module, and a smaller stride
 * makes it MORE necessary rather than less. A `?steps=5` into a wall has to stop at the wall,
 * and a path across the abyss has to end on the abyss. A 1.5 cm cycle is smaller than a 5 cm
 * tile, which makes endpoint sampling look safe — it is not: the body is 10 cm across and its
 * swept rectangle crosses tiles that neither endpoint touches. So each cycle tests the SWEPT
 * BODY (see `probeSweptBody`), and:
 *
 *  - blocked  -> the cycle is a truthful no-op and the run continues, so a model that keeps
 *                pushing forward is told "you did not move" rather than failing silently;
 *  - fatal    -> the body moves there and the run is over;
 *  - snag     -> the body moves there and the move stops: partial, recoverable.
 */
export function move(
  world: World,
  profile: RobotPhysicalProfile,
  state: RobotWorldState,
  direction: 'forward' | 'backward',
  cycles: number,
): MoveResult {
  if (state.destroyed) return runOverResult(state, cycles)

  const nominalCm =
    direction === 'forward'
      ? profile.motion.forwardPerCycleCm
      : profile.motion.backwardPerCycleCm
  const sign = direction === 'forward' ? 1 : -1
  const forward = forwardVector(state.headingDeg)

  let xCm = state.xCm
  let yCm = state.yCm
  let seed = state.seed
  let cyclesTaken = 0
  let blockedCycles = 0
  let outcome: MoveOutcome = 'moved'
  let destroyed = false
  let detail = `Moved ${direction} ${cycles} cycle(s) of about ${nominalCm} cm each.`

  for (let cycle = 0; cycle < cycles; cycle++) {
    const step = jittered(nominalCm, profile.motion.jitterFraction, seed)
    seed = step.seed
    const travelCm = step.value * sign
    const to = { xCm: xCm + forward.xCm * travelCm, yCm: yCm + forward.yCm * travelCm }
    const verdict = probeSweptBody(world, profile.body, { xCm, yCm }, to, state.headingDeg)

    if (verdict.kind === 'blocked') {
      blockedCycles++
      outcome = 'blocked'
      detail =
        verdict.reason === 'edge'
          ? `Blocked by the edge of the world at tile ${verdict.xTiles},${verdict.yTiles}. Moved ${cyclesTaken} of ${cycles} cycle(s).`
          : `Blocked by an obstacle at tile ${verdict.xTiles},${verdict.yTiles}. Moved ${cyclesTaken} of ${cycles} cycle(s).`
      continue
    }

    xCm = to.xCm
    yCm = to.yCm
    cyclesTaken++

    if (verdict.kind === 'fatal') {
      destroyed = true
      outcome = 'destroyed'
      detail = `Fell into the abyss at tile ${verdict.xTiles},${verdict.yTiles} after ${cyclesTaken} of ${cycles} cycle(s). The robot is destroyed and the run is over.`
      break
    }

    if (verdict.kind === 'snag') {
      outcome = 'partial'
      detail = `Snagged on a soft obstacle at tile ${verdict.xTiles},${verdict.yTiles}; the move stopped there after ${cyclesTaken} of ${cycles} cycle(s).`
      break
    }
  }

  return {
    state: { xCm, yCm, headingDeg: state.headingDeg, destroyed, seed },
    requestedCycles: cycles,
    cyclesTaken,
    blockedCycles,
    outcome,
    detail,
  }
}

/**
 * Turning is always possible while the robot is alive, and never moves it.
 *
 * There is deliberately NO collision test on a turn. The real robot has no idea what is beside
 * it and will happily grind its shell along a wall while its feet shuffle in place; refusing the
 * command would teach an agent that a failed turn means an obstacle, which is a signal the
 * hardware does not give. What a turn costs is the same as on the bench: a servo cycle and some
 * heading error.
 *
 * The `detail` string is the whole interface to the agent, so it states the arithmetic the model
 * has to do: how many cycles, and how many degrees that adds up to at the profile's turn size.
 * It reports the NOMINAL angle, never the jittered one — see `MoveResult.detail`.
 */
export function turn(
  profile: RobotPhysicalProfile,
  state: RobotWorldState,
  direction: 'left' | 'right',
  cycles: number,
): MoveResult {
  if (state.destroyed) return runOverResult(state, cycles)

  const perCycleDeg = profile.motion.turnDegreesPerCycle
  const sign = direction === 'right' ? 1 : -1
  let headingDeg = state.headingDeg
  let seed = state.seed
  for (let cycle = 0; cycle < cycles; cycle++) {
    const step = jittered(perCycleDeg, profile.motion.jitterFraction, seed)
    seed = step.seed
    headingDeg = normaliseDegrees(headingDeg + step.value * sign)
  }

  const nominalTotalDeg = cycles * perCycleDeg
  return {
    state: { ...state, headingDeg, seed },
    requestedCycles: cycles,
    cyclesTaken: cycles,
    blockedCycles: 0,
    outcome: 'moved',
    detail: `Turned ${direction} ${cycles} cycle(s) of ${perCycleDeg} degrees, which is about ${nominalTotalDeg} degrees in total.`,
  }
}

/**
 * The answer every endpoint gives once the robot is destroyed.
 *
 * There is deliberately no hidden status field that yanks the control loop out of the run. The
 * observation goes back to the model and the model responds by calling its completion tool to
 * declare failure — the same tool it uses for success.
 */
export function runOverResult(state: RobotWorldState, cycles: number): MoveResult {
  return {
    state,
    requestedCycles: cycles,
    cyclesTaken: 0,
    blockedCycles: 0,
    outcome: 'run_over',
    detail: `The robot was destroyed and the run is over. It cannot move.`,
  }
}

// ---------------------------------------------------------------------------
// The distance sensor
// ---------------------------------------------------------------------------

/**
 * Distance to the first thing that echoes ahead, in centimetres.
 *
 * THE ARITHMETIC HERE IS DISTANCES, NOT TILE COUNTS, AND THERE IS NO CONVERSION HELPER. Every
 * number the sensor uses comes from the robot's own profile: its minimum range (the bumper — the
 * robot physically cannot report closer), its maximum range, and nothing else. The tile size is
 * the map's business and the sensor never asks for it; changing the map's scale must not change
 * what this sensor can see. A conversion at the edges is exactly where a tile-denominated length
 * survives a refactor like this one, so there isn't one.
 *
 * CAST ORIGIN: the sensor sits at the CENTRE OF THE LEADING FACE of the chassis, which is where
 * a forward-facing ultrasonic actually sits, and with a continuous pose that is a real point
 * rather than something to discretise. ONE ray, from that point, along the heading. This is
 * narrower than the old lattice model, which took the minimum over rays from each front cell and
 * so warned about walls beside the body's path; a real HC-SR04 does no such thing. That is the
 * whole basis of the aiming procedure in `system-prompt.md` — sweep a cycle at a time and take
 * the smallest reading — and `profile.sensor.beamAngleDegrees` is the characteristic a
 * cone-aware cast should later read rather than reinvent.
 *
 * An abyss is TRANSPARENT here, and that is a modelling choice worth knowing about: a hole in
 * the floor reflects nothing back to a forward-facing ultrasonic, so the sensor cannot warn
 * about the fatal terrain. A soft obstacle stands up and echoes, so it blocks the beam even
 * though it can be driven into.
 */
export function distanceCm(
  world: World,
  profile: RobotPhysicalProfile,
  state: RobotWorldState,
): number {
  const forward = forwardVector(state.headingDeg)
  const originXCm = state.xCm + forward.xCm * (profile.body.lengthCm / 2)
  const originYCm = state.yCm + forward.yCm * (profile.body.lengthCm / 2)
  const clamp = (distance: number) =>
    Math.min(profile.sensor.maxRangeCm, Math.max(profile.sensor.minRangeCm, distance))

  // Amanatides & Woo: walk the tiles the ray crosses in order, so the returned distance is the
  // exact distance to the face of the first tile that echoes — never a multiple of anything.
  const tileSizeCm = world.tileSizeCm
  let xTiles = Math.floor(originXCm / tileSizeCm)
  let yTiles = Math.floor(originYCm / tileSizeCm)
  const stepX = forward.xCm > 0 ? 1 : forward.xCm < 0 ? -1 : 0
  const stepY = forward.yCm > 0 ? 1 : forward.yCm < 0 ? -1 : 0
  const nextBoundary = (position: number, tile: number, step: number) =>
    step > 0 ? (tile + 1) * tileSizeCm - position : position - tile * tileSizeCm
  let travelToNextX =
    stepX === 0 ? Infinity : nextBoundary(originXCm, xTiles, stepX) / Math.abs(forward.xCm)
  let travelToNextY =
    stepY === 0 ? Infinity : nextBoundary(originYCm, yTiles, stepY) / Math.abs(forward.yCm)
  const travelPerTileX = stepX === 0 ? Infinity : tileSizeCm / Math.abs(forward.xCm)
  const travelPerTileY = stepY === 0 ? Infinity : tileSizeCm / Math.abs(forward.yCm)

  let travelledCm = 0
  // The ray can cross at most one tile per grid line in each axis before it leaves the world.
  const maxCrossings = world.widthTiles + world.heightTiles + 2
  for (let crossing = 0; crossing <= maxCrossings; crossing++) {
    const kind = tileAt(world, xTiles, yTiles)
    // Off the grid, or something solid: either way the beam ends here.
    if (kind === null || kind === 'hard' || kind === 'soft') return clamp(travelledCm)
    if (travelToNextX < travelToNextY) {
      travelledCm = travelToNextX
      xTiles += stepX
      travelToNextX += travelPerTileX
    } else {
      travelledCm = travelToNextY
      yTiles += stepY
      travelToNextY += travelPerTileY
    }
    if (travelledCm >= profile.sensor.maxRangeCm) return profile.sensor.maxRangeCm
  }
  return profile.sensor.maxRangeCm
}
