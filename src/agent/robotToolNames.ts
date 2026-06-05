// Tool-name constants shared between the tool definitions (robotTools.ts) and the
// loop-state bookkeeping (motionLog.ts) / middlewares. Kept in its own leaf
// module — importing nothing — so robotTools can depend on motionLog (for the
// finish_task give-up gate) without a circular import back through these names.

export const MOTION_TOOL_NAMES = [
  'move_forward',
  'move_backward',
  'turn_left',
  'turn_right',
] as const;

export type MotionToolName = (typeof MOTION_TOOL_NAMES)[number];

// The terminal tool: not a "real action" for the give-up gate, never a motion.
export const FINISH_TOOL_NAME = 'finish_task';
