import express, { type Express, type Request, type Response } from 'express'
import {
  MOVEMENT_ENDPOINTS,
  TRICK_ENDPOINTS,
  clampSteps,
  corsMiddleware,
} from '../robot-protocol/robotProtocol.js'
import {
  getPhysicalProfile,
  type RobotPhysicalProfile,
} from '../src/agent/robotPresets/index.js'
import { renderJpeg } from './render.js'
import {
  DEFAULT_SEED,
  createWorld,
  distanceCm,
  initialState,
  move,
  runOverResult,
  turn,
  type MoveResult,
  type RobotWorldState,
  type World,
  type WorldMap,
} from './world.js'

/**
 * A robot emulator: the same HTTP interface as the firmware, backed by a real position and
 * heading on a grid world, plus a /capture endpoint that renders that world as a JPEG.
 *
 * The point of the whole thing is indistinguishability. The control loop, the agent and every
 * piece of middleware between them talk to this exactly as they talk to the hardware — the same
 * endpoints, the same steps clamping (both shared from robot-protocol/), the same CORS, real
 * image bytes on the wire. What is different is that the answers are now true of something: a
 * blocked move is blocked because a wall is there, and /distance is measured rather than faked.
 *
 * Movement responses are a SUPERSET of the firmware's `{ action, steps }`: the spatial fields
 * are added, never substituted, so a client written against the real robot keeps working.
 *
 * On death there is deliberately no hidden field that yanks the control loop. The observation
 * says the robot is destroyed and the run is over; the model reads that and calls its completion
 * tool to declare failure, which is the same tool it calls on success.
 *
 * THE HARDWARE THE EMULATOR SIMULATES COMES FROM THE ROBOT PRESET, and from nowhere else. Body
 * size, stride, turn angle, jitter and the sensor's range are read out of
 * `src/agent/robotPresets/` at construction, so the robot the student drives here and the robot
 * the prompt describes are the same robot by construction rather than by two people remembering
 * to edit two files.
 */

export interface EmulatorState {
  world: World
  /** The simulated hardware, resolved from the active preset. */
  profile: RobotPhysicalProfile
  robot: RobotWorldState
  /** The seed a run restarts from, so `/reset` gives back the same run rather than a new one. */
  initialSeed: number
  lastCommand: string | null
  lastSteps: number | null
  lastCommandAtMs: number | null
  lastDistanceCm: number | null
  lastOutcome: MoveResult['outcome'] | null
  lastDetail: string | null
  bootMs: number
  commandHistory: Array<{ name: string; steps: number; timestamp: number }>
}

export interface EmulatorOptions {
  map?: WorldMap
  /** Which robot to simulate. Defaults to the registry's default preset. */
  presetId?: string
  /** Overrides the resolved preset outright — the seam the tests drive a different robot through. */
  profile?: RobotPhysicalProfile
  /** The jitter seed. The same seed replays the same run, which is what makes a run assertable. */
  seed?: number
}

export function createEmulatorState(options: EmulatorOptions = {}): EmulatorState {
  const profile = options.profile ?? getPhysicalProfile(options.presetId)
  const world = createWorld(options.map, profile.body)
  const initialSeed = options.seed ?? DEFAULT_SEED
  return {
    world,
    profile,
    initialSeed,
    robot: initialState(world, initialSeed),
    lastCommand: null,
    lastSteps: null,
    lastCommandAtMs: null,
    lastDistanceCm: null,
    lastOutcome: null,
    lastDetail: null,
    bootMs: Date.now(),
    commandHistory: [],
  }
}

/** Restore a run to its starting conditions without bouncing the process. */
export function resetEmulatorState(state: EmulatorState): void {
  state.robot = initialState(state.world, state.initialSeed)
  state.lastCommand = null
  state.lastSteps = null
  state.lastCommandAtMs = null
  state.lastDistanceCm = null
  state.lastOutcome = null
  state.lastDetail = null
  state.bootMs = Date.now()
  state.commandHistory = []
}

function recordCommand(state: EmulatorState, name: string, steps: number) {
  state.lastCommand = name
  state.lastSteps = steps
  state.lastCommandAtMs = Date.now() - state.bootMs
  state.commandHistory.push({ name, steps, timestamp: Date.now() })
}

/**
 * The spatial fields every JSON response carries, so the run's status is never only implied.
 *
 * POSITION IS CENTIMETRES AND HEADING IS DEGREES, both named so. They stopped being integer
 * cells and one of eight compass names when the motion model became continuous, and every
 * consumer of `/status` follows that. `tileSizeCm` rides along because a reader that wants to
 * relate a position back to the authored map needs the one number that bridges the two units.
 */
function situation(state: EmulatorState) {
  return {
    xCm: state.robot.xCm,
    yCm: state.robot.yCm,
    headingDeg: state.robot.headingDeg,
    tileSizeCm: state.world.tileSizeCm,
    destroyed: state.robot.destroyed,
    runOver: state.robot.destroyed,
    world: state.world.id,
  }
}

function applyResult(state: EmulatorState, result: MoveResult) {
  state.robot = result.state
  state.lastOutcome = result.outcome
  state.lastDetail = result.detail
}

export function createRobotEmulatorApp(
  options: EmulatorOptions & { state?: EmulatorState } = {},
): {
  app: Express
  state: EmulatorState
} {
  const state = options.state ?? createEmulatorState(options)
  const app = express()

  app.use(corsMiddleware)

  app.get('/', (_req, res) => {
    res.type('text/plain').send('Acebott biped robot - agent API (grid-world emulator).\n')
  })

  app.get('/status', (_req, res) => {
    res.json({
      uptimeMs: Date.now() - state.bootMs,
      lastCommand: state.lastCommand,
      lastSteps: state.lastSteps,
      lastCommandAtMs: state.lastCommandAtMs,
      lastDistanceCm: state.lastDistanceCm,
      lastOutcome: state.lastOutcome,
      detail: state.lastDetail,
      ...situation(state),
    })
  })

  app.get('/distance', (_req, res) => {
    const distance = distanceCm(state.world, state.profile, state.robot)
    state.lastDistanceCm = distance
    // The firmware answers /distance with a bare number, so this one stays text/plain rather
    // than growing a body the real robot would never send. The run-over fact rides along as a
    // header, which no existing client reads and none of them break on.
    res.setHeader('X-Robot-Run-Over', String(state.robot.destroyed))
    res.type('text/plain').send(distance.toFixed(1))
  })

  for (const path of MOVEMENT_ENDPOINTS) {
    app.get(path, (req: Request, res: Response) => {
      const name = path.slice(1)
      const steps = clampSteps(req.query.steps)
      recordCommand(state, name, steps)

      let result: MoveResult
      if (name === 'forward' || name === 'backward') {
        result = move(state.world, state.profile, state.robot, name, steps)
      } else {
        result = turn(state.profile, state.robot, name === 'turn_left' ? 'left' : 'right', steps)
      }
      applyResult(state, result)

      res.json({
        action: name,
        steps,
        cyclesTaken: result.cyclesTaken,
        blockedCycles: result.blockedCycles,
        outcome: result.outcome,
        detail: result.detail,
        ...situation(state),
      })
    })
  }

  for (const path of TRICK_ENDPOINTS) {
    app.get(path, (_req, res) => {
      const name = path.slice(1)
      recordCommand(state, name, 1)
      // Tricks are showmanship: they cost a servo cycle and change nothing on the grid. A
      // destroyed robot cannot perform them either, and says so like everything else.
      if (state.robot.destroyed) {
        const result = runOverResult(state.robot, 1)
        applyResult(state, result)
        res.json({ action: name, outcome: result.outcome, detail: result.detail, ...situation(state) })
        return
      }
      state.lastOutcome = 'moved'
      state.lastDetail = `Performed ${name} in place.`
      res.json({
        action: name,
        outcome: 'moved',
        detail: state.lastDetail,
        ...situation(state),
      })
    })
  }

  app.get('/capture', (_req, res) => {
    const jpeg = renderJpeg(state.world, state.profile, state.robot)
    res.setHeader('Content-Type', 'image/jpeg')
    res.setHeader('Content-Length', String(jpeg.length))
    res.setHeader('Cache-Control', 'no-store')
    res.send(jpeg)
  })

  app.post('/reset', (_req, res) => {
    resetEmulatorState(state)
    res.status(200).json({ reset: true, ...situation(state) })
  })

  return { app, state }
}

export { MAX_STEPS } from '../robot-protocol/robotProtocol.js'
