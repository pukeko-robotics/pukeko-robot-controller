// Robot-preset registry (RC-1). A robot model selects its own named preset —
// not one global tool list. This increment ships exactly one preset
// (ACEBOTT-QD021); a second preset is a follow-up, not required to prove the
// mechanism.
//
// Leaf-safe: only re-exports leaf modules (types.ts, acebottQd021.ts). Safe
// to import from the browser bundle as well as the server — see those files'
// header comments for the dependency-direction rule.
import type { RobotPreset, RobotToolDef } from './types.js';
import { ACEBOTT_QD021_PRESET } from './acebottQd021.js';
import { resolvePhysicalProfile, type RobotPhysicalProfile } from './physical.js';

export const ROBOT_PRESETS: Readonly<Record<string, RobotPreset>> = Object.freeze({
  [ACEBOTT_QD021_PRESET.id]: ACEBOTT_QD021_PRESET,
});

export const DEFAULT_ROBOT_PRESET_ID: string = ACEBOTT_QD021_PRESET.id;

// The presets available to pick from, in registry order — each as its
// selection `id` plus the human `name` a UI (RC-8's picker) labels it with.
// Kept as a tiny accessor so the picker never reaches into ROBOT_PRESETS'
// shape directly: it renders whatever this enumerates, so custom presets
// (RC-2/RC-7) show up automatically once registered.
export function listPresets(): { id: string; name: string }[] {
  return Object.values(ROBOT_PRESETS).map((p) => ({ id: p.id, name: p.name }));
}

export function getRobotPreset(id: string = DEFAULT_ROBOT_PRESET_ID): RobotPreset {
  const preset = ROBOT_PRESETS[id];
  if (!preset) {
    const available = Object.keys(ROBOT_PRESETS).join(', ');
    throw new Error(`Unknown robot preset '${id}'. Available presets: ${available}`);
  }
  return preset;
}

// Client-fulfilled tool defs for a preset, in preset order — the browser
// side (App.vue) derives its `clientTools` / `clientToolHandlers` from this
// instead of hand-duplicating tool metadata. Pulled out as a plain function
// (rather than left inline in the .vue SFC) so it's unit-testable.
export function getClientToolDefs(id: string = DEFAULT_ROBOT_PRESET_ID): RobotToolDef[] {
  return getRobotPreset(id).tools.filter((t) => t.fulfillment === 'client');
}

// RC-51: the physical robot behind a preset — body, motion and sensor, fully
// resolved so no field can arrive at a caller as `undefined`. This is the ONE
// place the emulator (and, from RC-49, the prompt) reads the hardware from.
export function getPhysicalProfile(
  id: string = DEFAULT_ROBOT_PRESET_ID
): RobotPhysicalProfile {
  return resolvePhysicalProfile(getRobotPreset(id).physical);
}

export type {
  RobotPreset,
  RobotToolDef,
  ToolFulfillment,
  RecipeStep,
  HttpPath,
  CaptureFrameStep,
  HttpStep,
  ComposeStep,
  ReturnImageStep,
} from './types.js';
export type {
  RobotBodyProfile,
  RobotMotionProfile,
  RobotSensorProfile,
  RobotPhysicalProfile,
  RobotPhysicalProfileOverrides,
} from './physical.js';
export {
  DEFAULT_ROBOT_PHYSICAL_PROFILE,
  resolvePhysicalProfile,
} from './physical.js';
export { ACEBOTT_QD021_PRESET } from './acebottQd021.js';
