import { describe, it, expect } from 'vitest'
import {
  ACEBOTT_QD021_PRESET,
  DEFAULT_ROBOT_PRESET_ID,
  getClientToolDefs,
  getRobotPreset,
  listPresets,
} from '../src/agent/robotPresets/index.js'
import { createRobotTools } from '../src/agent/robotTools.js'

// The exact tool set that used to be hardcoded in robotTools.ts + App.vue
// before RC-1, captured here so the preset-driven mechanism can be checked
// against it byte-for-byte (names, order, descriptions, fulfillment).
const EXPECTED_SERVER_TOOL_NAMES = [
  'move_forward',
  'move_backward',
  'turn_left',
  'turn_right',
  'stop',
  'read_distance',
  'read_status',
  'finish_task',
]

const EXPECTED_CLIENT_TOOL_NAMES = ['move_forward', 'move_backward', 'turn_left', 'turn_right']

const EXPECTED_DESCRIPTIONS: Record<string, string> = {
  move_forward:
    'Walk the robot forward. Optional `steps` (1-10) for multiple cycles. ~1.5 cm per cycle. Automatically captures Before/After camera frames on every call (no need to call capture_image around it). It does NOT read the distance sensor — call read_distance yourself when you need range.',
  move_backward:
    'Walk the robot backward. Optional `steps` (1-10). ~1.5 cm per cycle. Automatically captures Before/After camera frames on every call (no need to call capture_image around it). It does NOT read the distance sensor — call read_distance yourself when you need range.',
  turn_left:
    'Rotate the robot left in place. Optional `steps` (1-10). ~15° per cycle; 6 ≈ 90°. Automatically captures Before/After camera frames on every call (no need to call capture_image around it). It does NOT read the distance sensor — call read_distance yourself when you need range.',
  turn_right:
    'Rotate the robot right in place. Optional `steps` (1-10). ~15° per cycle; 6 ≈ 90°. Automatically captures Before/After camera frames on every call (no need to call capture_image around it). It does NOT read the distance sensor — call read_distance yourself when you need range.',
  stop: 'Immediately halt all robot motion.',
  read_distance:
    'Read the ultrasonic distance sensor. Returns distance to the nearest obstacle in centimetres ("-1.0" on read failure). Trust this reading: when it disagrees with what the camera shows you (e.g. visually facing a box but reading ~70 cm), the robot is almost certainly mis-aimed — the cone is shooting past the target. Use as an alignment check after every small heading adjustment, not just once at the start of an approach.',
  read_status:
    'Cheap "is the robot alive" probe. Returns JSON {uptimeMs, lastCommand, lastSteps, lastCommandAtMs, lastDistanceCm}. Useful before issuing a longer sequence of moves; null fields mean the matching endpoint hasn\'t been called yet, and uptimeMs resets to 0 on every robot reboot.',
  finish_task:
    'Call this to END the task — it is the ONLY way to finish. ' +
    'status="success" when the objective is met, "failed" when you cannot proceed, ' +
    '"need_input" when you must ask the operator (e.g. robot out of frame or unreachable). ' +
    'Always include a one-line summary. Never end the task by just going silent. ' +
    'Do at least one real action (capture_image / read_distance / a move) before ending ' +
    'with failed or need_input.',
}

// Server callRobot() path per tool — asymmetric (read_ is dropped, move_ is
// dropped, turn_ is kept). NOT derivable from the tool name.
const EXPECTED_SERVER_PATHS: Record<string, string> = {
  stop: '/stop',
  read_distance: '/distance',
  read_status: '/status',
}

// Browser runMotion() endpoint per client tool — also asymmetric.
const EXPECTED_CLIENT_ENDPOINTS: Record<string, string> = {
  move_forward: '/forward',
  move_backward: '/backward',
  turn_left: '/turn_left',
  turn_right: '/turn_right',
}

describe('ACEBOTT-QD021 preset — byte-for-byte reproduction of the pre-RC-1 tool set', () => {
  it('is the default preset', () => {
    expect(DEFAULT_ROBOT_PRESET_ID).toBe('ACEBOTT-QD021')
    expect(getRobotPreset()).toBe(ACEBOTT_QD021_PRESET)
  })

  it('has hardwareId ACEBOTT-QD021', () => {
    expect(ACEBOTT_QD021_PRESET.hardwareId).toBe('ACEBOTT-QD021')
  })

  it('declares exactly the original 8 tools, in the original order', () => {
    expect(ACEBOTT_QD021_PRESET.tools.map((t) => t.name)).toEqual(EXPECTED_SERVER_TOOL_NAMES)
  })

  it('reproduces every tool description verbatim', () => {
    for (const def of ACEBOTT_QD021_PRESET.tools) {
      expect(def.description).toBe(EXPECTED_DESCRIPTIONS[def.name])
    }
  })

  it('marks exactly the 4 motion tools as client-fulfilled, the rest server-fulfilled', () => {
    const fulfillmentByName = Object.fromEntries(
      ACEBOTT_QD021_PRESET.tools.map((t) => [t.name, t.fulfillment])
    )
    for (const name of EXPECTED_CLIENT_TOOL_NAMES) {
      expect(fulfillmentByName[name]).toBe('client')
    }
    for (const name of ['stop', 'read_distance', 'read_status', 'finish_task']) {
      expect(fulfillmentByName[name]).toBe('server')
    }
  })

  it('encodes the exact (asymmetric) server HTTP paths', () => {
    for (const def of ACEBOTT_QD021_PRESET.tools) {
      if (def.name in EXPECTED_SERVER_PATHS) {
        expect(def.serverPath).toBe(EXPECTED_SERVER_PATHS[def.name])
      }
    }
  })

  it('marks finish_task as returnDirect and no other tool', () => {
    for (const def of ACEBOTT_QD021_PRESET.tools) {
      expect(def.returnDirect ?? false).toBe(def.name === 'finish_task')
    }
  })

  it('validates steps 1-10 optional via the zod schema, matching the original stepsSchema', () => {
    const move = ACEBOTT_QD021_PRESET.tools.find((t) => t.name === 'move_forward')!
    expect(move.zodSchema.safeParse({}).success).toBe(true)
    expect(move.zodSchema.safeParse({ steps: 1 }).success).toBe(true)
    expect(move.zodSchema.safeParse({ steps: 10 }).success).toBe(true)
    expect(move.zodSchema.safeParse({ steps: 11 }).success).toBe(false)
    expect(move.zodSchema.safeParse({ steps: 0 }).success).toBe(false)
    expect(move.zodSchema.safeParse({ steps: 1.5 }).success).toBe(false)
  })

  it('validates finish_task status enum + required summary via the zod schema', () => {
    const finish = ACEBOTT_QD021_PRESET.tools.find((t) => t.name === 'finish_task')!
    expect(finish.zodSchema.safeParse({ status: 'success', summary: 'done' }).success).toBe(true)
    expect(finish.zodSchema.safeParse({ status: 'bogus', summary: 'done' }).success).toBe(false)
    expect(finish.zodSchema.safeParse({ status: 'success', summary: '' }).success).toBe(false)
  })

  it('rejects an unknown preset id', () => {
    expect(() => getRobotPreset('NO-SUCH-PRESET')).toThrow(/Unknown robot preset/)
  })
})

describe('listPresets — what the RC-8 picker enumerates', () => {
  it('returns { id, name } for each registered preset, in registry order', () => {
    expect(listPresets()).toEqual([{ id: 'ACEBOTT-QD021', name: 'Acebott QD021 (biped)' }])
  })

  it('includes the default preset id', () => {
    expect(listPresets().map((p) => p.id)).toContain(DEFAULT_ROBOT_PRESET_ID)
  })
})

describe('createRobotTools — server-runtime tools built from the default preset', () => {
  it('produces exactly the original 8 tool names, in order', () => {
    const tools = createRobotTools('localhost:8080')
    expect(tools.map((t) => t.name)).toEqual(EXPECTED_SERVER_TOOL_NAMES)
  })

  it('marks the 4 motion tools client-fulfilled via metadata.client', () => {
    const tools = createRobotTools('localhost:8080')
    for (const t of tools) {
      const metadata = (t as unknown as { metadata?: Record<string, unknown> }).metadata
      const isClientTool = EXPECTED_CLIENT_TOOL_NAMES.includes(t.name)
      expect(Boolean(metadata?.client)).toBe(isClientTool)
    }
  })

  it('marks finish_task returnDirect', () => {
    const tools = createRobotTools('localhost:8080')
    const finish = tools.find((t) => t.name === 'finish_task')!
    expect((finish as unknown as { returnDirect?: boolean }).returnDirect).toBe(true)
  })

  it('accepts an explicit preset id equal to the default (same result)', () => {
    const a = createRobotTools('localhost:8080').map((t) => t.name)
    const b = createRobotTools('localhost:8080', DEFAULT_ROBOT_PRESET_ID).map((t) => t.name)
    expect(b).toEqual(a)
  })

  it('throws on an unknown preset id', () => {
    expect(() => createRobotTools('localhost:8080', 'NO-SUCH-PRESET')).toThrow(
      /Unknown robot preset/
    )
  })
})

describe('getClientToolDefs — what the browser client (App.vue) derives its tools from', () => {
  it('returns exactly the 4 motion tools, in order', () => {
    const defs = getClientToolDefs()
    expect(defs.map((d) => d.name)).toEqual(EXPECTED_CLIENT_TOOL_NAMES)
  })

  it('carries the exact (asymmetric) client endpoints', () => {
    const defs = getClientToolDefs()
    for (const def of defs) {
      expect(def.clientEndpoint).toBe(EXPECTED_CLIENT_ENDPOINTS[def.name])
    }
  })

  it('resolves the exact original App.vue top-level description per tool (client-authoritative)', () => {
    // Same class of gap as the steps-description test above, one level up:
    // gaunt-sloth's AG-UI server also passes the client's top-level
    // `description` straight through for client-fulfilled tools. Pre-RC-1,
    // move_forward's App.vue text and robotTools.ts text had already
    // drifted (only the server copy said "for multiple cycles") — the
    // other three motion tools matched byte-for-byte between client and
    // server. This asserts what App.vue derives via
    // `def.clientDescription ?? def.description`, i.e. the true
    // model-facing text, for all 4.
    const ORIGINAL_APP_VUE_DESCRIPTIONS: Record<string, string> = {
      move_forward:
        'Walk the robot forward. Optional `steps` (1-10). ~1.5 cm per cycle. Automatically captures Before/After camera frames on every call (no need to call capture_image around it). It does NOT read the distance sensor — call read_distance yourself when you need range.',
      move_backward:
        'Walk the robot backward. Optional `steps` (1-10). ~1.5 cm per cycle. Automatically captures Before/After camera frames on every call (no need to call capture_image around it). It does NOT read the distance sensor — call read_distance yourself when you need range.',
      turn_left:
        'Rotate the robot left in place. Optional `steps` (1-10). ~15° per cycle; 6 ≈ 90°. Automatically captures Before/After camera frames on every call (no need to call capture_image around it). It does NOT read the distance sensor — call read_distance yourself when you need range.',
      turn_right:
        'Rotate the robot right in place. Optional `steps` (1-10). ~15° per cycle; 6 ≈ 90°. Automatically captures Before/After camera frames on every call (no need to call capture_image around it). It does NOT read the distance sensor — call read_distance yourself when you need range.',
    }
    const defs = getClientToolDefs()
    for (const def of defs) {
      const resolved = def.clientDescription ?? def.description
      expect(resolved).toBe(ORIGINAL_APP_VUE_DESCRIPTIONS[def.name])
    }
  })

  it('only move_forward needed a clientDescription override; the other 3 already matched server text', () => {
    const defs = getClientToolDefs()
    const withOverride = defs.filter((d) => d.clientDescription !== undefined).map((d) => d.name)
    expect(withOverride).toEqual(['move_forward'])
  })

  it('carries a JSON Schema matching the original hand-written stepsParameter shape, verbatim', () => {
    // This is the description the MODEL actually sees for these tools:
    // gaunt-sloth's AG-UI server treats client-declared run-input tools as
    // authoritative for client-fulfilled tools (buildClientToolStub passes
    // the run-input `parameters` straight through), overriding the
    // server-side zod schema entirely whenever the browser client declares
    // its own tools — which App.vue always does. So this exact string,
    // not the server's zod description, is what "byte-for-byte" must match.
    const ORIGINAL_APP_VUE_STEPS_DESCRIPTION =
      'Number of cycles to run (1-10, defaults to 1). 1 forward/backward cycle ≈ 1.5 cm; 1 turn cycle ≈ 15°; 6 turn cycles ≈ 90°.'
    const defs = getClientToolDefs()
    for (const def of defs) {
      expect(def.jsonSchema).toEqual({
        type: 'object',
        properties: {
          steps: {
            type: 'integer',
            minimum: 1,
            maximum: 10,
            description: ORIGINAL_APP_VUE_STEPS_DESCRIPTION,
          },
        },
        required: [],
      })
    }
  })

  it('deliberately keeps a different (pre-existing) steps description on the server-side zodSchema', () => {
    // Pre-RC-1, robotTools.ts's zod description and App.vue's JSON Schema
    // description for `steps` had already drifted apart. Preserving that
    // split (rather than silently consolidating) is what makes this a true
    // reproduction of prior behaviour, not a cosmetic tidy-up with a side
    // effect on client-tool prompting.
    const preset = getRobotPreset()
    const move = preset.tools.find((t) => t.name === 'move_forward')!
    const clientDescription = (
      move.jsonSchema as { properties: { steps: { description: string } } }
    ).properties.steps.description
    const serverDescription = (move.zodSchema as unknown as { shape: { steps: { description?: string } } })
      .shape.steps.description
    expect(serverDescription).not.toBe(clientDescription)
    expect(serverDescription).toBe(
      'Number of cycles to run. Defaults to 1; capped at 10 by the firmware. Calibration: 1 forward/backward cycle ≈ 1.5 cm; 6 turn cycles ≈ 90° (~15° per turn cycle).'
    )
  })
})
