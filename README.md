# Pukeko Robot Controller

AI-driven control of an Acebott biped robot via the Pukeko web UI and `@gaunt-sloth/api` backend.

A webcam is mounted above a table, pointing down at the robot. The user issues high-level goals
(e.g. "move the robot to the center of the table") and the LLM agent iterates autonomously:
observe (capture a camera frame), reason about the robot's position, act (issue locomotion commands
and/or read the ultrasonic sensor), then repeat until the goal is met.

## Prerequisites

- Node.js >= 22
- An `ANTHROPIC_API_KEY` environment variable (or configure a different LLM provider in `.gsloth.config.json`)
- A webcam accessible to the browser

## Install

```sh
npm install
```

The `@galvanized-pukeko/vue-ui` library is resolved from `_refs/` during development.
Clone the reference repos if they're not already present:

```sh
git clone https://github.com/Galvanized-Pukeko/gaunt-sloth-assistant _refs/gaunt-sloth-assistant
git clone https://github.com/Galvanized-Pukeko/galvanized-pukeko-ai-ui _refs/galvanized-pukeko-ai-ui
```

## Running with the robot stub (development / no hardware)

Start three processes in separate terminals:

```sh
# Terminal 1 — robot stub (mimics Biped_Robot_Web.py on port 8080)
npm run stub

# Terminal 2 — AG-UI backend (port 3000), pointing tools at the stub
ROBOT_HOST=localhost:8080 npm run server

# Terminal 3 — web UI (port 5173)
npm run dev:ag-ui
```

Open http://localhost:5173 in a browser, allow camera access, and chat with the agent.
The stub logs every command it receives and exposes `GET /status` for inspection.

## Running with the real robot

The Acebott biped robot creates its own Wi-Fi AP. Connect your machine's Wi-Fi interface
to the robot's network (default IP `192.168.4.1`). Use a wired ethernet connection for
internet access to reach the Anthropic API.

Start two processes in separate terminals:

```sh
# Terminal 1 — AG-UI backend (port 3000), using the real robot's default IP
npm run server

# Terminal 2 — web UI (port 5173)
npm run dev:ag-ui
```

If the robot is on a different IP, override it:

```sh
ROBOT_HOST=192.168.4.1 npm run server
```

## Scripts

| Script | Description |
|---|---|
| `npm run dev` | Vite dev server (UI only, no backend) |
| `npm run dev:ag-ui` | Vite dev server pre-configured to connect to AG-UI on port 3000 |
| `npm run server` | Start `@gaunt-sloth/api` AG-UI backend on port 3000 |
| `npm run stub` | Start robot HTTP stub on port 8080 |
| `npm test` | Run all unit tests |
| `npm run build` | Type-check and build for production |

## Tests

```sh
npm test
```

36 tests across robot stub (HTTP API behaviour, command mapping, sensor simulation)
and web client (WebcamPanel component, useRobotChat composable).

## Project structure

```
├── src/                    Vue 3 frontend
│   ├── main.ts             Entry: loads config, mounts app
│   ├── App.vue             Layout: camera feed + chat side-by-side
│   ├── components/
│   │   └── WebcamPanel.vue getUserMedia camera with captureFrame()
│   └── composables/
│       └── useRobotChat.ts AG-UI streaming + capture_image UI tool
├── robot-stub/             Test double for Biped_Robot_Web.py
│   ├── robotStub.ts        Express app: /control, /status, /reset
│   └── index.ts            Server entry (port 8080)
├── tests/                  Unit tests (Vitest)
├── .gsloth.config.json     AG-UI server config (LLM, robot tools, CORS)
├── vite.config.ts          Vite build + aliases
└── vitest.config.ts        Test runner config
```

## Robot HTTP API

The robot (or stub) accepts commands at `GET /control?var=robot&val=N`:

| val | Action |
|---|---|
| 1 | Forward (single step) |
| 2 | Backward (single step) |
| 3 | Turn left |
| 4 | Turn right |
| 8 | Stop |

The response is always an empty HTTP 200. The stub also supports
`GET /control?var=sensor&val=distance` for ultrasonic distance readings.
