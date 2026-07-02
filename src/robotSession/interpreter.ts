// The recipe interpreter (RC-7). A single generic runner that fulfils a
// client-side robot tool by executing its declarative `recipe` (see
// robotPresets/types.ts) against a browser capability context. This is the
// piece that used to be App.vue's hardcoded `runMotion`: the multi-call
// procedure (Before frame → drive endpoint → /stop → After frame → compose →
// return one image) is now DATA on the preset, and this interpreter is the one
// place that turns that data into behaviour. It's a plain module function with
// no Vue/DOM dependency of its own — every side-effecting capability is
// injected via `RobotCapabilities` — so it is unit-testable without mounting
// the SFC (the whole point of the node).
import type { RobotToolDef, RecipeStep, HttpPath } from './../agent/robotPresets/types.js';

// The browser-side capabilities the interpreter needs. App.vue supplies these
// backed by the mounted <PkWebcamPanel> ref and the real `fetch`; tests supply
// fakes. `robotUrl` + `robotHost` are added by RobotSession from its config.
export interface RobotCapabilities {
  // Whether the webcam panel is mounted/usable yet. Guards the pre-motion
  // "Webcam not initialized" case exactly as the old runMotion did.
  isReady(): boolean;
  captureFrame(): string | null;
  composeBeforeAfter(before: string, after: string): Promise<string | null>;
  fetch: typeof fetch;
  robotUrl(path: string): string;
  robotHost: string;
}

// The subset App.vue actually provides; RobotSession fills in robotUrl/robotHost.
export type BrowserCapabilities = Omit<RobotCapabilities, 'robotUrl' | 'robotHost'>;

// Parse a `{ mimeType, data }` image envelope out of a `data:` URL, or null if
// the string isn't a well-formed base64 image data URL. Pure; moved here from
// App.vue verbatim so both the interpreter and RobotSession can reuse it.
export function frameToEnvelope(
  frame: string | null
): { mimeType: string; data: string } | null {
  if (!frame) return null;
  const match = frame.match(/^data:(image\/[a-zA-Z0-9+.-]+);base64,([^"]*)$/);
  if (!match) return null;
  return { mimeType: match[1], data: match[2] };
}

// Clamp a tool's `steps` argument to the firmware-supported 1..10 integer
// range, defaulting to 1. Pure; moved here from App.vue verbatim.
export function coerceSteps(args: unknown): number {
  if (args && typeof args === 'object' && 'steps' in args) {
    const raw = (args as { steps?: unknown }).steps;
    if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 1) {
      return Math.min(10, Math.floor(raw));
    }
  }
  return 1;
}

// The label echoed back to the model as the `motion` field: bare tool name for
// a single cycle, `name (steps=N)` for a multi-cycle call. Matches old runMotion.
function motionLabelFor(toolName: string, steps: number): string {
  return steps === 1 ? toolName : `${toolName} (steps=${steps})`;
}

function resolveHttpPath(path: HttpPath, def: RobotToolDef): string {
  if (typeof path === 'string') return path;
  // path.fromDef === 'clientEndpoint'
  const endpoint = def.clientEndpoint;
  if (!endpoint) {
    throw new Error(
      `Recipe for '${def.name}' references clientEndpoint but the tool has none.`
    );
  }
  return endpoint;
}

// Run a client tool's recipe, returning the JSON string the AG-UI client hands
// back to the model — either the success image envelope
// (`{ mimeType, data, motion }`) or a `{ error, motion? }` object. Byte-for-byte
// equivalent to the pre-RC-7 App.vue runMotion for the QD021 MOTION_RECIPE.
export async function runRecipe(
  def: RobotToolDef,
  args: unknown,
  caps: RobotCapabilities
): Promise<string> {
  if (!def.recipe) {
    return JSON.stringify({ error: `Tool '${def.name}' has no recipe to run.` });
  }
  if (!caps.isReady()) {
    // No motion label here — matches the original guard, which fired before
    // the label was computed.
    return JSON.stringify({ error: 'Webcam not initialized' });
  }

  const steps = coerceSteps(args);
  const motion = motionLabelFor(def.name, steps);
  const slots: Record<string, string | null> = {};

  for (const raw of def.recipe) {
    const step: RecipeStep = raw;
    switch (step.step) {
      case 'captureFrame': {
        const frame = caps.captureFrame();
        if (!frame) {
          return JSON.stringify({ error: step.failMessage, motion });
        }
        slots[step.as] = frame;
        break;
      }
      case 'http': {
        const path = resolveHttpPath(step.path, def);
        const query = step.withSteps && steps > 1 ? `?steps=${steps}` : '';
        const url = caps.robotUrl(`${path}${query}`);
        if (step.optional) {
          // Best-effort side effect (the /stop halt). Its HTTP status is
          // ignored and a throw is logged and stepped over — exactly the old
          // fire-and-forget `await fetch(robotUrl('/stop'))` behaviour.
          try {
            await caps.fetch(url);
          } catch (err) {
            console.warn(`[RobotSession] optional step ${path} failed after ${motion}:`, err);
          }
          break;
        }
        try {
          const res = await caps.fetch(url);
          if (!res.ok) {
            return JSON.stringify({
              error: `Robot returned HTTP ${res.status} for ${path}`,
              motion,
            });
          }
          await res.text();
        } catch (err) {
          const message = err instanceof Error ? err.message : 'unknown error';
          return JSON.stringify({
            error: `Failed to reach robot at ${caps.robotHost}: ${message}`,
            motion,
          });
        }
        break;
      }
      case 'compose': {
        try {
          slots[step.as] = await caps.composeBeforeAfter(
            slots[step.before] ?? '',
            slots[step.after] ?? ''
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : 'compose error';
          return JSON.stringify({
            error: `Failed to compose Before/After image: ${message}`,
            motion,
          });
        }
        break;
      }
      case 'returnImage': {
        const envelope = frameToEnvelope(slots[step.from] ?? null);
        if (!envelope) {
          return JSON.stringify({ error: 'Invalid composite frame format', motion });
        }
        return JSON.stringify({ ...envelope, motion });
      }
    }
  }

  // A well-formed recipe ends with a returnImage step; reaching here means it
  // didn't produce a return value.
  return JSON.stringify({ error: `Recipe for '${def.name}' produced no result.`, motion });
}
