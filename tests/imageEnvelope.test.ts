import { describe, it, expect } from 'vitest'
import { parseImageEnvelope } from '../src/toolDisplays/imageEnvelope.js'
import { frameToEnvelope } from '../src/robotSession/interpreter.js'
import { PNG_1PX } from './helpers/toolDisplayFixtures.js'

// RC-14: the parser must accept exactly the envelope shapes the robot tools
// produce (RobotSession.captureImage / runRecipe's returnImage + error paths —
// see imageEnvelope.ts's header) and classify everything else 'unrecognised'.

describe('parseImageEnvelope — the shapes the robot tools actually produce', () => {
  it('parses the capture_image success envelope { mimeType, data }', () => {
    const result = JSON.stringify({ mimeType: 'image/png', data: PNG_1PX })
    expect(parseImageEnvelope(result)).toEqual({
      kind: 'image',
      src: `data:image/png;base64,${PNG_1PX}`,
      mimeType: 'image/png',
      motion: undefined,
    })
  })

  it('round-trips what frameToEnvelope itself produces from a data URL', () => {
    // Prove the parser is glued to the real producer, not a guessed schema.
    const envelope = frameToEnvelope(`data:image/jpeg;base64,${PNG_1PX}`)
    expect(envelope).not.toBeNull()
    const parsed = parseImageEnvelope(JSON.stringify(envelope))
    expect(parsed.kind).toBe('image')
    if (parsed.kind === 'image') {
      expect(parsed.src).toBe(`data:image/jpeg;base64,${PNG_1PX}`)
    }
  })

  it('parses the motion success envelope { mimeType, data, motion }', () => {
    const result = JSON.stringify({
      mimeType: 'image/jpeg',
      data: PNG_1PX,
      motion: 'turn_left (steps=6)',
    })
    expect(parseImageEnvelope(result)).toEqual({
      kind: 'image',
      src: `data:image/jpeg;base64,${PNG_1PX}`,
      mimeType: 'image/jpeg',
      motion: 'turn_left (steps=6)',
    })
  })

  it('parses the error envelope { error, motion? }', () => {
    expect(parseImageEnvelope(JSON.stringify({ error: 'Webcam not initialized' }))).toEqual({
      kind: 'error',
      message: 'Webcam not initialized',
      motion: undefined,
    })
    expect(
      parseImageEnvelope(
        JSON.stringify({ error: 'Failed to capture After frame.', motion: 'move_forward' }),
      ),
    ).toEqual({
      kind: 'error',
      message: 'Failed to capture After frame.',
      motion: 'move_forward',
    })
  })
})

describe('parseImageEnvelope — everything else is unrecognised (generic fallback)', () => {
  it.each([
    ['undefined result', undefined],
    ['empty string', ''],
    ['plain text (a server tool result)', '12.5'],
    ['non-JSON text', 'not json at all'],
    ['a JSON array', '[1,2,3]'],
    ['JSON null', 'null'],
    ['wrong shape (no mimeType/data/error)', JSON.stringify({ uptimeMs: 12 })],
    ['empty base64 data', JSON.stringify({ mimeType: 'image/png', data: '' })],
    ['non-image mime type', JSON.stringify({ mimeType: 'text/html', data: PNG_1PX })],
    ['mime type with junk', JSON.stringify({ mimeType: 'image/png;evil', data: PNG_1PX })],
    ['non-string data', JSON.stringify({ mimeType: 'image/png', data: 42 })],
  ])('%s → unrecognised', (_label, result) => {
    expect(parseImageEnvelope(result as string | undefined)).toEqual({ kind: 'unrecognised' })
  })

  it('an empty error string is unrecognised, not a blank error note', () => {
    expect(parseImageEnvelope(JSON.stringify({ error: '' }))).toEqual({ kind: 'unrecognised' })
  })
})
