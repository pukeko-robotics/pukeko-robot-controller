import express, { type Express, type Request, type Response } from 'express'
import {
  MOVEMENT_ENDPOINTS,
  TRICK_ENDPOINTS,
  clampSteps,
  corsMiddleware,
} from '../robot-protocol/robotProtocol.js'
import { renderJpeg } from './render.js'
import {
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
 */

export interface EmulatorState {
  world: World
  robot: RobotWorldState
  lastCommand: string | null
  lastSteps: number | null
  lastCommandAtMs: number | null
  lastDistanceCm: number | null
  lastOutcome: MoveResult['outcome'] | null
  lastDetail: string | null
  bootMs: number
  commandHistory: Array<{ name: string; steps: number; timestamp: number }>
}

export function createEmulatorState(map?: WorldMap): EmulatorState {
  const world = createWorld(map)
  return {
    world,
    robot: initialState(world),
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
  state.robot = initialState(state.world)
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

/** The spatial fields every JSON response carries, so the run's status is never only implied. */
function situation(state: EmulatorState) {
  return {
    x: state.robot.x,
    y: state.robot.y,
    heading: state.robot.heading,
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

export function createRobotEmulatorApp(options: { map?: WorldMap; state?: EmulatorState } = {}): {
  app: Express
  state: EmulatorState
} {
  const state = options.state ?? createEmulatorState(options.map)
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
    const distance = distanceCm(state.world, state.robot)
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
        result = move(state.world, state.robot, name, steps)
      } else {
        result = turn(state.robot, name === 'turn_left' ? 'left' : 'right', steps)
      }
      applyResult(state, result)

      res.json({
        action: name,
        steps,
        stepsTaken: result.stepsTaken,
        blockedSteps: result.blockedSteps,
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
    const jpeg = renderJpeg(state.world, state.robot)
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
