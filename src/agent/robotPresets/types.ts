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
