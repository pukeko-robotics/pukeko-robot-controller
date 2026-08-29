import { createRobotEmulatorApp } from './robotEmulator.js'

/**
 * Serve entry point for the grid-world emulator, mirroring robot-stub/index.ts.
 *
 * The port comes from ROBOT_EMULATOR_PORT so it can be moved without editing code. Worktrees
 * allocate a port block per node into a local .env, and every server here reads its own variable
 * with the trunk default as a fallback, so two lanes can run at once without colliding.
 */
const port = parseInt(process.env.ROBOT_EMULATOR_PORT ?? '8081', 10)
const { app, state } = createRobotEmulatorApp()

const server = app.listen(port, () => {
  console.log(`Robot emulator running on http://localhost:${port}`)
  console.log(`World: ${state.world.id} (${state.world.width} x ${state.world.height} cells)`)
  console.log('Endpoints:')
  console.log(`  GET /forward[?steps=N]       - Walk forward one cell at a time (default 1, max 10)`)
  console.log(`  GET /backward[?steps=N]      - Walk backward`)
  console.log(`  GET /turn_left[?steps=N]     - Rotate left in place`)
  console.log(`  GET /turn_right[?steps=N]    - Rotate right in place`)
  console.log(`  GET /distance                - Range to the first blocking cell ahead, in cm`)
  console.log(`  GET /status                  - JSON heartbeat, including position and heading`)
  console.log(`  GET /capture                 - Overhead view of the world as image/jpeg`)
  console.log(`  POST /reset                  - Restart the run from the map's start cell`)
})

process.on('SIGTERM', () => {
  console.log(`\nShutting down robot emulator (processed ${state.commandHistory.length} commands)`)
  server.close()
})
