import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  getToolDisplay,
  hasToolDisplay,
  resetToolDisplays,
} from '@galvanized-pukeko/vue-ui'
import {
  imageRecipeToolNames,
  registerRobotToolDisplays,
  summariseSteps,
} from '../src/toolDisplays/index.js'
import CaptureImageResult from '../src/toolDisplays/CaptureImageResult.vue'
import MotionResult from '../src/toolDisplays/MotionResult.vue'
import { MOTION_TOOL_NAMES } from '../src/agent/robotToolNames.js'
import { toolCallPart } from './helpers/toolDisplayFixtures.js'

// RC-14 registration acceptance: the right names get the right renderers on
// vue-ui's PLAT-17 registry at init, everything else stays unregistered (the
// generic fallback is the contract for those). The registry is the REAL
// globalThis-anchored map exported by @galvanized-pukeko/vue-ui — the same one
// ToolCallBadge consults — so every test resets it afterward.

afterEach(() => resetToolDisplays())

describe('imageRecipeToolNames — derived from preset data, not a name list', () => {
  it('is exactly the preset tools whose recipe returns an image (the 4 QD021 motions)', () => {
    expect(imageRecipeToolNames().sort()).toEqual([...MOTION_TOOL_NAMES].sort())
  })
})

describe('registerRobotToolDisplays', () => {
  it('registers capture_image with the thumbnail renderer and a camera glyph', () => {
    registerRobotToolDisplays()
    const entry = getToolDisplay('capture_image')
    expect(entry?.renderResult).toBe(CaptureImageResult)
    expect(entry?.glyph).toBe('📷')
  })

  it('registers every motion tool with the before/after diff renderer', () => {
    registerRobotToolDisplays()
    for (const name of MOTION_TOOL_NAMES) {
      const entry = getToolDisplay(name)
      expect(entry?.renderResult, name).toBe(MotionResult)
      expect(entry?.summariseParams, name).toBe(summariseSteps)
    }
  })

  it('leaves non-image tools unregistered — the generic fallback is their contract', () => {
    registerRobotToolDisplays()
    for (const name of ['stop', 'read_distance', 'read_status', 'finish_task', 'some_future_tool']) {
      expect(hasToolDisplay(name), name).toBe(false)
    }
  })

  it('returns an unregister-all function that removes every entry it added', () => {
    const undo = registerRobotToolDisplays()
    expect(hasToolDisplay('capture_image')).toBe(true)
    undo()
    expect(hasToolDisplay('capture_image')).toBe(false)
    for (const name of MOTION_TOOL_NAMES) {
      expect(hasToolDisplay(name), name).toBe(false)
    }
  })

  it('is idempotent — re-registering replaces rather than duplicates', () => {
    registerRobotToolDisplays()
    registerRobotToolDisplays()
    expect(getToolDisplay('capture_image')?.renderResult).toBe(CaptureImageResult)
  })
})

describe('summariseSteps', () => {
  it('summarises a numeric steps arg', () => {
    expect(summariseSteps(toolCallPart({ args: { steps: 3 } }))).toBe('steps=3')
  })
  it('returns empty for absent or non-numeric steps', () => {
    expect(summariseSteps(toolCallPart({ args: {} }))).toBe('')
    expect(summariseSteps(toolCallPart({ args: { steps: 'many' } }))).toBe('')
    expect(summariseSteps(toolCallPart({ args: null }))).toBe('')
  })
})

describe('app-init wiring', () => {
  it('importing App.vue registers the robot tool displays (module-load = app init)', async () => {
    // Fresh module registry so App.vue's module-scope side effect re-runs even
    // if another test file already imported it; the display registry itself is
    // globalThis-anchored, so the statically-imported reset/lookup helpers see
    // the same map as the freshly-imported App module.
    vi.resetModules()
    resetToolDisplays()
    expect(hasToolDisplay('capture_image')).toBe(false)
    await import('../src/App.vue')
    expect(hasToolDisplay('capture_image')).toBe(true)
    for (const name of MOTION_TOOL_NAMES) {
      expect(hasToolDisplay(name), name).toBe(true)
    }
  })
})
