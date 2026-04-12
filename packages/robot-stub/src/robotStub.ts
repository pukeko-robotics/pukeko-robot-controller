import express, { type Express, type Request, type Response } from 'express'

/**
 * Robot command values matching Biped_Robot_Web.py
 * The real robot accepts these at /control?var=robot&val=N
 */
export const ROBOT_COMMANDS: Record<number, string> = {
  1: 'forward',
  2: 'backward',
  3: 'turn_left',
  4: 'turn_right',
  8: 'stop',
  10: 'sprint',
  11: 'left_kick',
  12: 'right_kick',
  13: 'left_tilt',
  14: 'right_tilt',
  15: 'left_stamp',
  16: 'dance',
  17: 'avoid',
  18: 'follow',
  19: 'left_ankles',
  20: 'right_stamp',
  21: 'right_ankles',
}

export interface RobotState {
  lastCommand: number | null
  lastCommandName: string | null
  commandHistory: Array<{ val: number; name: string; timestamp: number }>
  simulatedDistance: number
}

export function createRobotState(): RobotState {
  return {
    lastCommand: null,
    lastCommandName: null,
    commandHistory: [],
    simulatedDistance: 25.0,
  }
}

export function createRobotStubApp(state?: RobotState): { app: Express; state: RobotState } {
  const robotState = state ?? createRobotState()
  const app = express()

  // The real robot serves /control?var=robot&val=N
  // It always returns HTTP 200 with Content-Length: 0 (empty body)
  app.get('/control', (req: Request, res: Response) => {
    const varParam = req.query.var as string | undefined
    const valParam = req.query.val as string | undefined

    if (varParam === 'sensor' && valParam === 'distance') {
      // Ultrasonic distance sensor reading (simulated)
      // Add slight randomness to simulate real sensor noise
      const noise = (Math.random() - 0.5) * 2
      const distance = Math.max(2, robotState.simulatedDistance + noise)
      res.status(200).send(distance.toFixed(1))
      return
    }

    if (!valParam) {
      // Mimic real robot: no validation, just return 200
      res.status(200).end()
      return
    }

    const val = parseInt(valParam, 10)

    if (isNaN(val)) {
      // Real robot would crash on non-integer, we just return 200 like it does before crashing
      res.status(200).end()
      return
    }

    const commandName = ROBOT_COMMANDS[val] ?? `unknown_${val}`
    robotState.lastCommand = val
    robotState.lastCommandName = commandName
    robotState.commandHistory.push({
      val,
      name: commandName,
      timestamp: Date.now(),
    })

    // Real robot returns empty 200 response
    res.status(200).end()
  })

  // Status endpoint (not on real robot, useful for testing)
  app.get('/status', (_req: Request, res: Response) => {
    res.json({
      lastCommand: robotState.lastCommand,
      lastCommandName: robotState.lastCommandName,
      commandCount: robotState.commandHistory.length,
      history: robotState.commandHistory.slice(-10),
    })
  })

  // Reset state (useful for testing)
  app.post('/reset', (_req: Request, res: Response) => {
    robotState.lastCommand = null
    robotState.lastCommandName = null
    robotState.commandHistory = []
    robotState.simulatedDistance = 25.0
    res.status(200).json({ reset: true })
  })

  return { app, state: robotState }
}
