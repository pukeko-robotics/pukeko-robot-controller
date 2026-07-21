// RC-14: parse the robot tools' JSON image envelope out of a tool-call result
// string, producing a render-ready view for the inline image renderers.
//
// The exact producer shapes (do not widen this beyond them — anything else is
// 'unrecognised' so the badge falls back to the generic JSON view, never a
// broken <img>):
//   - RobotSession.captureImage()  → `{ mimeType, data }` via frameToEnvelope
//     (src/robotSession/RobotSession.ts), or `{ error }` when the webcam isn't
//     ready / the capture failed.
//   - runRecipe()'s `returnImage` step → `{ mimeType, data, motion }`
//     (src/robotSession/interpreter.ts), or `{ error, motion? }` when any
//     recipe step failed. `motion` is the human label echoed to the model,
//     e.g. `turn_left (steps=6)`.
//
// Pure module (no Vue/DOM) so the parsing rules are unit-testable directly.

export type ParsedToolResult =
  | { kind: 'image'; src: string; mimeType: string; motion?: string }
  | { kind: 'error'; message: string; motion?: string }
  | { kind: 'unrecognised' };

// Mirrors frameToEnvelope's `data:` URL mime pattern (interpreter.ts) so we
// only re-assemble a data URL from a mime type that grammar produced.
const IMAGE_MIME_RE = /^image\/[a-zA-Z0-9+.-]+$/;

export function parseImageEnvelope(result: string | undefined | null): ParsedToolResult {
  if (typeof result !== 'string' || result.length === 0) return { kind: 'unrecognised' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    return { kind: 'unrecognised' };
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'unrecognised' };
  }
  const obj = parsed as Record<string, unknown>;
  const motion = typeof obj.motion === 'string' && obj.motion.length > 0 ? obj.motion : undefined;
  if (typeof obj.error === 'string' && obj.error.length > 0) {
    return { kind: 'error', message: obj.error, motion };
  }
  if (
    typeof obj.mimeType === 'string' &&
    IMAGE_MIME_RE.test(obj.mimeType) &&
    typeof obj.data === 'string' &&
    obj.data.length > 0
  ) {
    return {
      kind: 'image',
      src: `data:${obj.mimeType};base64,${obj.data}`,
      mimeType: obj.mimeType,
      motion,
    };
  }
  return { kind: 'unrecognised' };
}
