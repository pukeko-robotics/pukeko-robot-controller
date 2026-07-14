import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import PresetPicker from '../src/components/PresetPicker.vue'
import { resolveSeedPreset } from '../src/App.vue'
import {
  listPresets,
  DEFAULT_ROBOT_PRESET_ID,
} from '../src/agent/robotPresets/index.js'

// RC-8 acceptance tests for the runtime preset picker. Three behaviours the
// brief calls out: (1) the picker lists one option per registry preset with
// the env/default selected, (2) selecting a different preset applies — the
// picker emits the new id AND re-initialising the session rebuilds the
// preset-derived motion tool defs, (3) with no explicit selection the active
// preset is the env/default (no regression).

const SYNTHETIC_PRESETS = [
  { id: 'ALPHA', name: 'Alpha bot' },
  { id: 'BETA', name: 'Beta bot' },
]

// --- (1) lists presets -----------------------------------------------------

describe('PresetPicker — lists presets', () => {
  it('renders one option per registry preset, labelled by name, default selected', () => {
    // Driven by the real registry so it grows automatically as presets are added.
    const presets = listPresets()
    const wrapper = mount(PresetPicker, {
      props: { presets, modelValue: DEFAULT_ROBOT_PRESET_ID },
    })
    const options = wrapper.findAll('option')
    expect(options).toHaveLength(presets.length)
    expect(options.map((o) => o.attributes('value'))).toEqual(presets.map((p) => p.id))
    expect(options.map((o) => o.text())).toEqual(presets.map((p) => p.name))
    // the control's value reflects the seeded (env/default) preset
    expect((wrapper.find('select').element as HTMLSelectElement).value).toBe(
      DEFAULT_ROBOT_PRESET_ID
    )
  })

  it('renders every preset it is handed and starts on the given modelValue', () => {
    // Prop-driven: proves N>1 rendering without needing a second real preset.
    const wrapper = mount(PresetPicker, {
      props: { presets: SYNTHETIC_PRESETS, modelValue: 'BETA' },
    })
    const options = wrapper.findAll('option')
    expect(options.map((o) => o.text())).toEqual(['Alpha bot', 'Beta bot'])
    expect((wrapper.find('select').element as HTMLSelectElement).value).toBe('BETA')
  })
})

// --- (2) switch applies (picker side) --------------------------------------

describe('PresetPicker — selecting a preset emits the new id', () => {
  it('emits update:modelValue with the chosen preset id on change', async () => {
    const wrapper = mount(PresetPicker, {
      props: { presets: SYNTHETIC_PRESETS, modelValue: 'ALPHA' },
    })
    await wrapper.find('select').setValue('BETA')
    expect(wrapper.emitted('update:modelValue')).toEqual([['BETA']])
  })
})

// --- (2) switch applies (session side) -------------------------------------
// Only one real preset ships this increment and getClientToolDefs/getRobotPreset
// throw on any unknown id, so the *only* honest way to assert "re-init reflects
// the new preset" is to partial-mock the registry with two distinct presets and
// prove the rebuilt session's clientTools follow the id.

vi.mock('../src/agent/robotPresets/index.js', async (importActual) => {
  const actual = await importActual<typeof import('../src/agent/robotPresets/index.js')>()
  const defsById: Record<string, ReturnType<typeof actual.getClientToolDefs>> = {
    ALPHA: [
      {
        name: 'alpha_move',
        description: 'alpha',
        zodSchema: {} as never,
        jsonSchema: { type: 'object', properties: {}, required: [] },
        fulfillment: 'client',
        clientEndpoint: '/alpha',
        recipe: [{ step: 'captureFrame', as: 'f', failMessage: 'x' }],
      },
    ],
    BETA: [
      {
        name: 'beta_move',
        description: 'beta',
        zodSchema: {} as never,
        jsonSchema: { type: 'object', properties: {}, required: [] },
        fulfillment: 'client',
        clientEndpoint: '/beta',
        recipe: [{ step: 'captureFrame', as: 'f', failMessage: 'x' }],
      },
    ],
  }
  return {
    ...actual,
    getClientToolDefs: (id = 'ALPHA') => defsById[id] ?? [],
  }
})

describe('runtime switch — re-initialising the session rebuilds the motion tool defs', () => {
  it('a session built for a different preset exposes that preset\'s motion tools', async () => {
    const { RobotSession } = await import('../src/robotSession/index.js')
    const caps = {
      isReady: () => true,
      captureFrame: () => null,
      composeBeforeAfter: async () => null,
      fetch: vi.fn(),
    }
    const alpha = new RobotSession({ robotHost: 'h', presetId: 'ALPHA', capabilities: caps })
    const beta = new RobotSession({ robotHost: 'h', presetId: 'BETA', capabilities: caps })

    // capture_image is always present; the preset-derived motion tool differs.
    expect(alpha.clientTools.map((t) => t.name)).toEqual(['capture_image', 'alpha_move'])
    expect(beta.clientTools.map((t) => t.name)).toEqual(['capture_image', 'beta_move'])
    // the handler map is keyed by the new preset's tool, proving the rebuild
    expect(Object.keys(beta.clientToolHandlers).sort()).toEqual(['beta_move', 'capture_image'])
  })
})

// --- (3) default seed ------------------------------------------------------

describe('resolveSeedPreset — env/default seeding (no regression)', () => {
  it('uses DEFAULT_ROBOT_PRESET_ID when VITE_ROBOT_PRESET is unset or empty', () => {
    expect(resolveSeedPreset(undefined)).toBe(DEFAULT_ROBOT_PRESET_ID)
    expect(resolveSeedPreset('')).toBe(DEFAULT_ROBOT_PRESET_ID)
  })

  it('uses the env value when VITE_ROBOT_PRESET is set', () => {
    expect(resolveSeedPreset('SOME-OTHER-PRESET')).toBe('SOME-OTHER-PRESET')
  })
})
