import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createRobotStubApp, createRobotState, ROBOT_COMMANDS, type RobotState } from '../src/robotStub.js'
import type { Server } from 'node:http'

let server: Server
let state: RobotState
let baseUrl: string

beforeAll(async () => {
  const result = createRobotStubApp()
  state = result.state

  await new Promise<void>((resolve) => {
    server = result.app.listen(0, () => {
      const addr = server.address()
      if (addr && typeof addr !== 'string') {
        baseUrl = `http://localhost:${addr.port}`
      }
      resolve()
    })
  })
})

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve())
  })
})

beforeEach(() => {
  state.lastCommand = null
  state.lastCommandName = null
  state.commandHistory = []
  state.simulatedDistance = 25.0
})

describe('Robot Stub - /control endpoint', () => {
  it('should accept forward command (val=1) and return empty 200', async () => {
    const res = await fetch(`${baseUrl}/control?var=robot&val=1`)
    expect(res.status).toBe(200)

    const body = await res.text()
    expect(body).toBe('')

    expect(state.lastCommand).toBe(1)
    expect(state.lastCommandName).toBe('forward')
  })

  it('should accept backward command (val=2)', async () => {
    const res = await fetch(`${baseUrl}/control?var=robot&val=2`)
    expect(res.status).toBe(200)
    expect(state.lastCommand).toBe(2)
    expect(state.lastCommandName).toBe('backward')
  })

  it('should accept turn_left command (val=3)', async () => {
    const res = await fetch(`${baseUrl}/control?var=robot&val=3`)
    expect(res.status).toBe(200)
    expect(state.lastCommand).toBe(3)
    expect(state.lastCommandName).toBe('turn_left')
  })

  it('should accept turn_right command (val=4)', async () => {
    const res = await fetch(`${baseUrl}/control?var=robot&val=4`)
    expect(res.status).toBe(200)
    expect(state.lastCommand).toBe(4)
    expect(state.lastCommandName).toBe('turn_right')
  })

  it('should accept stop command (val=8)', async () => {
    const res = await fetch(`${baseUrl}/control?var=robot&val=8`)
    expect(res.status).toBe(200)
    expect(state.lastCommand).toBe(8)
    expect(state.lastCommandName).toBe('stop')
  })

  it('should accept dance command (val=16)', async () => {
    const res = await fetch(`${baseUrl}/control?var=robot&val=16`)
    expect(res.status).toBe(200)
    expect(state.lastCommand).toBe(16)
    expect(state.lastCommandName).toBe('dance')
  })

  it('should record command history in order', async () => {
    await fetch(`${baseUrl}/control?var=robot&val=1`)
    await fetch(`${baseUrl}/control?var=robot&val=3`)
    await fetch(`${baseUrl}/control?var=robot&val=1`)
    await fetch(`${baseUrl}/control?var=robot&val=8`)

    expect(state.commandHistory).toHaveLength(4)
    expect(state.commandHistory[0].name).toBe('forward')
    expect(state.commandHistory[1].name).toBe('turn_left')
    expect(state.commandHistory[2].name).toBe('forward')
    expect(state.commandHistory[3].name).toBe('stop')
  })

  it('should handle unknown command values gracefully', async () => {
    const res = await fetch(`${baseUrl}/control?var=robot&val=99`)
    expect(res.status).toBe(200)
    expect(state.lastCommandName).toBe('unknown_99')
  })

  it('should return 200 with empty body when val is missing', async () => {
    const res = await fetch(`${baseUrl}/control?var=robot`)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('')
    expect(state.lastCommand).toBeNull()
  })

  it('should return 200 for non-integer val (mimics real robot pre-crash)', async () => {
    const res = await fetch(`${baseUrl}/control?var=robot&val=abc`)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('')
  })
})

describe('Robot Stub - sensor endpoint', () => {
  it('should return distance reading for ultrasonic sensor', async () => {
    const res = await fetch(`${baseUrl}/control?var=sensor&val=distance`)
    expect(res.status).toBe(200)

    const body = await res.text()
    const distance = parseFloat(body)
    expect(distance).toBeGreaterThan(0)
    // Default simulated distance is 25.0 +/- 1.0 noise
    expect(distance).toBeGreaterThan(20)
    expect(distance).toBeLessThan(30)
  })

  it('should return distance as a numeric string with one decimal', async () => {
    const res = await fetch(`${baseUrl}/control?var=sensor&val=distance`)
    const body = await res.text()
    expect(body).toMatch(/^\d+\.\d$/)
  })
})

describe('Robot Stub - /status endpoint', () => {
  it('should return current robot state', async () => {
    await fetch(`${baseUrl}/control?var=robot&val=1`)

    const res = await fetch(`${baseUrl}/status`)
    expect(res.status).toBe(200)

    const data = await res.json()
    expect(data.lastCommand).toBe(1)
    expect(data.lastCommandName).toBe('forward')
    expect(data.commandCount).toBe(1)
    expect(data.history).toHaveLength(1)
  })
})

describe('Robot Stub - /reset endpoint', () => {
  it('should reset robot state', async () => {
    await fetch(`${baseUrl}/control?var=robot&val=1`)
    expect(state.lastCommand).toBe(1)

    const res = await fetch(`${baseUrl}/reset`, { method: 'POST' })
    expect(res.status).toBe(200)

    const data = await res.json()
    expect(data.reset).toBe(true)
    expect(state.lastCommand).toBeNull()
    expect(state.commandHistory).toHaveLength(0)
  })
})

describe('ROBOT_COMMANDS mapping', () => {
  it('should contain all documented command values', () => {
    expect(ROBOT_COMMANDS[1]).toBe('forward')
    expect(ROBOT_COMMANDS[2]).toBe('backward')
    expect(ROBOT_COMMANDS[3]).toBe('turn_left')
    expect(ROBOT_COMMANDS[4]).toBe('turn_right')
    expect(ROBOT_COMMANDS[8]).toBe('stop')
    expect(ROBOT_COMMANDS[10]).toBe('sprint')
    expect(ROBOT_COMMANDS[11]).toBe('left_kick')
    expect(ROBOT_COMMANDS[12]).toBe('right_kick')
    expect(ROBOT_COMMANDS[13]).toBe('left_tilt')
    expect(ROBOT_COMMANDS[14]).toBe('right_tilt')
    expect(ROBOT_COMMANDS[15]).toBe('left_stamp')
    expect(ROBOT_COMMANDS[16]).toBe('dance')
    expect(ROBOT_COMMANDS[17]).toBe('avoid')
    expect(ROBOT_COMMANDS[18]).toBe('follow')
    expect(ROBOT_COMMANDS[19]).toBe('left_ankles')
    expect(ROBOT_COMMANDS[20]).toBe('right_stamp')
    expect(ROBOT_COMMANDS[21]).toBe('right_ankles')
  })
})

describe('createRobotState', () => {
  it('should create clean initial state', () => {
    const fresh = createRobotState()
    expect(fresh.lastCommand).toBeNull()
    expect(fresh.lastCommandName).toBeNull()
    expect(fresh.commandHistory).toHaveLength(0)
    expect(fresh.simulatedDistance).toBe(25.0)
  })
})
