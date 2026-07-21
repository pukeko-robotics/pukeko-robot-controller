// RC-14: register the robot's bespoke tool-result renderers on vue-ui's
// PLAT-17 per-tool display registry (`registerToolDisplay` from
// `@galvanized-pukeko/vue-ui` — globalThis-anchored, so it reaches the badge
// whichever vue-ui bundle renders it).
//
//   capture_image        → CaptureImageResult (inline thumbnail, click to enlarge)
//   image-recipe tools   → MotionResult (the composed Before/After diff picture)
//
// Which tools get the motion renderer is DERIVED from the preset data, not a
// hardcoded name list: any preset tool whose RC-7 recipe ends by returning an
// image (`returnImage` step) renders as a picture. A future preset's motion
// tools therefore pick the renderer up automatically, exactly like they pick
// up their recipe. Everything else (read_distance, finish_task, a
// student-authored tool…) stays UNREGISTERED on purpose — the generic
// JSON/text fallback is the contract for those.
//
// Timing: the registry is not reactive — call this at app init (module load /
// app setup) before any chat badge mounts. App.vue does so at module scope.
import { registerToolDisplay, type ToolCallPart } from '@galvanized-pukeko/vue-ui';
import { getRobotPreset, listPresets } from '../agent/robotPresets/index.js';
import type { RobotToolDef } from '../agent/robotPresets/index.js';
import CaptureImageResult from './CaptureImageResult.vue';
import MotionResult from './MotionResult.vue';

// Same decorative glyphs the Tool Belt uses for these tools (ToolBelt.vue).
// Unknown future image tools simply get no glyph rather than a guessed one.
const MOTION_GLYPHS: Record<string, string> = {
  move_forward: '↑',
  move_backward: '↓',
  turn_left: '↺',
  turn_right: '↻',
};

// Collapsed-header arg summary for motion tools: surface `steps` when present.
export function summariseSteps(part: ToolCallPart): string {
  const args = part.args;
  if (args && typeof args === 'object' && 'steps' in args) {
    const steps = (args as { steps?: unknown }).steps;
    if (typeof steps === 'number' && Number.isFinite(steps)) return `steps=${steps}`;
  }
  return '';
}

function returnsImage(def: RobotToolDef): boolean {
  return def.recipe?.some((step) => step.step === 'returnImage') ?? false;
}

// Every registered preset tool whose recipe returns an image — the set that
// gets the MotionResult renderer. Exported for the registration unit tests.
export function imageRecipeToolNames(): string[] {
  const names = new Set<string>();
  for (const { id } of listPresets()) {
    for (const def of getRobotPreset(id).tools) {
      if (returnsImage(def)) names.add(def.name);
    }
  }
  return [...names];
}

// Register all robot tool displays. Idempotent (re-registering a name replaces
// the entry). Returns an unregister-all function, used by tests.
export function registerRobotToolDisplays(): () => void {
  const undos: Array<() => void> = [
    registerToolDisplay('capture_image', {
      glyph: '📷',
      renderResult: CaptureImageResult,
    }),
    ...imageRecipeToolNames().map((name) =>
      registerToolDisplay(name, {
        glyph: MOTION_GLYPHS[name],
        summariseParams: summariseSteps,
        renderResult: MotionResult,
      })
    ),
  ];
  return () => undos.forEach((undo) => undo());
}
