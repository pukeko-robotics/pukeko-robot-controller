// RC-14 shared test fixtures: a genuinely renderable base64 image and a
// ToolCallPart factory shaped exactly like vue-ui's chatService produces
// (kind/toolCallId/toolCallName/args/argsRaw/result/status).
import type { ToolCallPart } from '@galvanized-pukeko/vue-ui'

// A real 1x1 transparent PNG, base64.
export const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

export function toolCallPart(overrides: Partial<ToolCallPart> = {}): ToolCallPart {
  return {
    kind: 'tool-call',
    toolCallId: 'call_1',
    toolCallName: 'capture_image',
    args: {},
    argsRaw: '{}',
    status: 'complete',
    ...overrides,
  }
}
