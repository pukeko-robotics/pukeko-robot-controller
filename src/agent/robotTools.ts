import { tool } from '@langchain/core/tools';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { FINISH_TOOL_NAME } from './robotToolNames.js';
import { DEFAULT_ROBOT_PRESET_ID, getRobotPreset } from './robotPresets/index.js';
import type { RobotToolDef } from './robotPresets/index.js';

const TIMEOUT_MS = 30_000;

async function callRobot(host: string, path: string, query?: string): Promise<string> {
  const url = `http://${host}${path}${query ? `?${query}` : ''}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) {
      return `Robot returned HTTP ${res.status}`;
    }
    return (await res.text()).trim();
  } catch (err) {
    if (err instanceof Error) {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        return `Robot did not respond within ${TIMEOUT_MS}ms — is it powered on and on the same network as ${host}?`;
      }
      return `Failed to reach robot at ${host}: ${err.message}`;
    }
    return `Failed to reach robot at ${host}`;
  }
}

// Re-exported for existing importers (tests, etc.); the source of truth is
// ./robotToolNames to keep this module free of a cycle through motionLog.
export { MOTION_TOOL_NAMES, type MotionToolName } from './robotToolNames.js';

// Builds one server-runtime StructuredTool from a preset's declarative
// RobotToolDef. Preset data describes *what* a tool is (name/description/
// schema/fulfillment/HTTP path); this is the one place that turns that data
// into runnable behaviour.
function buildTool(def: RobotToolDef, host: string): StructuredToolInterface {
  if (def.fulfillment === 'client') {
    // Motion tools are CLIENT-fulfilled: the browser handler captures a
    // Before frame, sends the motion to the robot, captures an After frame,
    // composes them into one image, and returns the envelope. The server
    // body is just a stub — AG-UI routes the call to the browser before it
    // ever reaches the function below.
    const t = tool(async () => 'Client tool stub executed on server', {
      name: def.name,
      description: def.description,
      schema: def.zodSchema,
    }) as StructuredToolInterface;
    (t as unknown as { metadata: Record<string, unknown> }).metadata = { client: true };
    return t;
  }

  if (def.name === FINISH_TOOL_NAME) {
    // The terminal action. Server-fulfilled, no robot side effect: it ENDS
    // the run. `returnDirect: true` is what actually stops the graph —
    // createAgent routes straight to END after a returnDirect tool runs,
    // instead of looping the tool result back to the model (a tool
    // returning Command{goto: END} is NOT honoured by createAgent and just
    // grinds until the recursion limit). The router matches on the
    // ToolMessage's name, which ToolNode stamps from this tool's name
    // automatically when we return a plain string. Special-cased by name
    // (rather than data-driven) because it's the one genuinely non-generic
    // "terminal" tool — every other server tool is a plain GET.
    return tool(
      async ({ status, summary }: { status: string; summary: string }) =>
        `FINISH[${status}]: ${summary}`,
      {
        name: def.name,
        description: def.description,
        schema: def.zodSchema,
        returnDirect: true,
      }
    ) as StructuredToolInterface;
  }

  if (!def.serverPath) {
    throw new Error(`Robot tool '${def.name}' is server-fulfilled but has no serverPath.`);
  }
  return tool(async () => callRobot(host, def.serverPath!), {
    name: def.name,
    description: def.description,
    schema: def.zodSchema,
  }) as StructuredToolInterface;
}

export function createRobotTools(
  host: string,
  presetId: string = DEFAULT_ROBOT_PRESET_ID
): StructuredToolInterface[] {
  const preset = getRobotPreset(presetId);
  return preset.tools.map((def) => buildTool(def, host));
}
