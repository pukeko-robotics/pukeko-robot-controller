import { createRobotStubApp } from './robotStub.js'

const port = parseInt(process.env.ROBOT_STUB_PORT ?? '8080', 10)
const { app, state } = createRobotStubApp()

const server = app.listen(port, () => {
  console.log(`Robot stub server running on http://localhost:${port}`)
  console.log('Endpoints:')
  console.log(`  GET /control?var=robot&val=N  - Robot commands (mimics Biped_Robot_Web.py)`)
  console.log(`  GET /control?var=sensor&val=distance - Ultrasonic distance sensor`)
  console.log(`  GET /status                   - View robot state (test only)`)
  console.log(`  POST /reset                   - Reset robot state (test only)`)
})

process.on('SIGTERM', () => {
  console.log(`\nShutting down robot stub (processed ${state.commandHistory.length} commands)`)
  server.close()
})
