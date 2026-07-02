// Types for the robot-preset mechanism (RC-1). A "preset" is a named,
// data-driven tool set tied to one hardware variant (e.g. the Acebott QD021
// biped). It replaces the single hardcoded tool list that used to live only
// in robotTools.ts (server) + App.vue (client, duplicated by hand).
//
// Leaf module by design: depends only on 'zod'. Never import robotTools.ts
// (server-only fetch glue) or any 'node:' builtin here — App.vue pulls this
// registry straight into the browser bundle, so anything reachable from here
// ships to the client.
import type { ZodTypeAny } from 'zod';

export type ToolFulfillment = 'client' | 'server';

// --- Recipe vocabulary (RC-7) --------------------------------------------
// A client-fulfilled tool can carry an ordered `recipe`: a small sequence of
// declarative steps a generic interpreter runs against a browser capability
// context (webcam ref, `fetch`, robotUrl). This is what lets one model-facing
// tool bind *several* API/webcam calls (e.g. move_forward hides Before-frame →
// drive endpoint → /stop → After-frame → compose → return-one-image) while
// keeping that multi-call procedure as preset-owned DATA rather than hardcoded
// in App.vue. A robot whose gait self-terminates simply omits the /stop step;
// no code change. Pure types only — no runtime — so this stays a leaf module.

// Where an `http` step sends its GET. Either a literal robot route ('/stop'),
// or the owning tool's own `clientEndpoint` resolved at run time — the latter
// is what lets the four motion tools share ONE recipe while each hits its own
// endpoint (/forward, /backward, /turn_left, /turn_right).
export type HttpPath = string | { fromDef: 'clientEndpoint' };

// Capture a webcam frame into a named slot. `failMessage` is the exact error
// string returned (with the motion label) when the camera yields no frame —
// carried as data so the historically-different Before/After wording is
// reproduced without hardcoding it in the interpreter.
export interface CaptureFrameStep {
  step: 'captureFrame';
  as: string;
  failMessage: string;
}

// GET a robot endpoint. `withSteps` appends `?steps=N` (only when N > 1, to
// match the original query shaping). `optional` = a best-effort side-effect
// call (the /stop halt): its HTTP status is ignored and a throw is logged and
// stepped over rather than aborting the recipe.
export interface HttpStep {
  step: 'http';
  path: HttpPath;
  withSteps?: boolean;
  optional?: boolean;
}

// Compose two named frame slots into one Before/After image, stored under `as`.
export interface ComposeStep {
  step: 'compose';
  before: string;
  after: string;
  as: string;
}

// Terminal step: turn the named slot into the returned image envelope
// (`{ mimeType, data, motion }`). Errors if the slot holds no valid frame.
export interface ReturnImageStep {
  step: 'returnImage';
  from: string;
}

export type RecipeStep = CaptureFrameStep | HttpStep | ComposeStep | ReturnImageStep;

export interface RobotToolDef {
  name: string;
  // Server-side (LangChain `tool()`) description. For client-fulfilled
  // tools this is NOT what the model sees at runtime — see
  // `clientDescription` below — but it's still the description used if
  // this tool def is ever bound server-side with no client override (e.g.
  // a future non-browser consumer of the same preset).
  description: string;
  // Client-fulfilled tools only: the description registered with the AG-UI
  // run-input `clientTools` — this IS what the model sees for these tools
  // (gaunt-sloth's AG-UI server treats client-declared run-input tools as
  // authoritative, overriding the server's own config.tools entry by name).
  // Optional: falls back to `description` when unset. Only set this when a
  // tool's client and server text have (deliberately or historically)
  // diverged — as move_forward's did, pre-RC-1.
  clientDescription?: string;
  // Drives the LangChain/AG-UI *server* tool (schema passed to `tool()`).
  zodSchema: ZodTypeAny;
  // Registered by the *browser* client as an AG-UI `Tool.parameters` value
  // for client-fulfilled tools. Hand-written side by side with zodSchema
  // above (not derived at runtime) so the two can't silently drift, and so
  // the JSON Schema text stays byte-identical to what App.vue used to write
  // by hand. Required when fulfillment === 'client'; unused otherwise.
  jsonSchema?: Record<string, unknown>;
  fulfillment: ToolFulfillment;
  // Server-fulfilled tools other than the terminal one: the robot HTTP path
  // `callRobot` hits, e.g. 'stop' -> '/stop', 'read_distance' -> '/distance'.
  // NOT derivable from `name` — the mapping is asymmetric per tool.
  serverPath?: string;
  // Client-fulfilled tools: the robot HTTP path the browser's runMotion
  // helper hits, e.g. 'move_forward' -> '/forward', 'turn_left' ->
  // '/turn_left'. Also NOT derivable from `name` (move_/turn_ are stripped
  // inconsistently on the real firmware routes).
  clientEndpoint?: string;
  // Client-fulfilled tools (RC-7): the ordered step recipe the browser's
  // recipe interpreter runs to fulfil this one model-visible tool. When a
  // client tool binds more than a single endpoint (motion tools capture +
  // drive + /stop + capture + compose), that whole procedure lives here as
  // DATA. Optional: a client tool with a single-endpoint behaviour need not
  // declare one. Server-fulfilled tools never carry a recipe.
  recipe?: RecipeStep[];
  // The one structured terminal tool (finish_task): ends the run instead of
  // looping the result back to the model. See robotTools.ts for why.
  returnDirect?: boolean;
}

export interface RobotPreset {
  // Selection key: `robot.preset` config field / ROBOT_PRESET env
  // (server-side), VITE_ROBOT_PRESET (client-side). See RC-1 PROGRESS.md for
  // why those two selection paths are independently configured.
  id: string;
  // Human-readable preset name.
  name: string;
  // Physical hardware/robot model this preset targets.
  hardwareId: string;
  // Tool order matters — it's part of "same tool set" for reproduction
  // purposes (e.g. test assertions, any future preset-authoring UI listing).
  tools: RobotToolDef[];
}
