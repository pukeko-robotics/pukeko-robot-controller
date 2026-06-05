import { describe, it, expect, beforeEach } from 'vitest'
import { AIMessage } from '@langchain/core/messages'
import {
  recordMotion,
  formatMotionLog,
  formatPinnedState,
  recordCalibration,
  getCalibration,
  markRealTool,
  hasRunRealTool,
  observeAssistantMessage,
  __resetMotionLogForTest,
} from '../src/agent/motionLog.js'

const T = 'thread-A'

beforeEach(() => {
  __resetMotionLogForTest()
})

describe('motionLog recent-motion list', () => {
  it('marks the previous motion done and the newest pending', () => {
    recordMotion(T, 'turn_right (steps=3)')
    recordMotion(T, 'move_forward (steps=2)')
    const out = formatMotionLog(T)
    expect(out).toContain('Recent motions (newest last):')
    expect(out).toContain('- turn_right (steps=3)')
    expect(out).toContain('- move_forward (steps=2) (pending')
  })

  it('surfaces an elided count once the cap is exceeded', () => {
    for (let i = 0; i < 7; i++) recordMotion(T, `move_forward #${i}`)
    const out = formatMotionLog(T)
    // 7 recorded, cap 5 → 2 elided.
    expect(out).toContain('2 earlier motions elided')
    expect(out).not.toContain('#0')
    expect(out).not.toContain('#1')
    expect(out).toContain('#6 (pending')
  })

  it('uses singular wording for a single elided motion', () => {
    for (let i = 0; i < 6; i++) recordMotion(T, `m#${i}`)
    expect(formatMotionLog(T)).toContain('1 earlier motion elided')
  })
})

describe('motionLog calibration pin', () => {
  it('extracts a Calibration: line from assistant prose', () => {
    recordCalibration(
      T,
      'Body (x0.4, y0.5).\nCalibration: turn_right rotates CCW on screen. Face at 9 o\'clock. Conf H.'
    )
    expect(getCalibration(T)).toBe(
      "turn_right rotates CCW on screen. Face at 9 o'clock. Conf H."
    )
  })

  it('tolerates list-marker / blockquote prefixes', () => {
    recordCalibration(T, '- Calibration: forward = leftward in frame.')
    expect(getCalibration(T)).toBe('forward = leftward in frame.')
  })

  it('ignores text without a calibration line', () => {
    recordCalibration(T, 'Just a normal position report, no calibration here.')
    expect(getCalibration(T)).toBeUndefined()
  })
})

describe('motionLog give-up gate', () => {
  it('flips only after a real tool is marked', () => {
    expect(hasRunRealTool(T)).toBe(false)
    markRealTool(T)
    expect(hasRunRealTool(T)).toBe(true)
  })
})

describe('observeAssistantMessage', () => {
  it('records a motion, flags a real tool, and pins calibration from one turn', () => {
    const msg = new AIMessage({
      content: 'Calibration: turn_right rotates clockwise. Conf M.',
      tool_calls: [{ name: 'turn_right', args: { steps: 2 }, id: 'a' }],
    })
    observeAssistantMessage(T, msg)
    expect(hasRunRealTool(T)).toBe(true)
    expect(getCalibration(T)).toBe('turn_right rotates clockwise. Conf M.')
    expect(formatMotionLog(T)).toContain('- turn_right (steps=2) (pending')
  })

  it('does NOT count finish_task as a real tool', () => {
    const msg = new AIMessage({
      content: '',
      tool_calls: [{ name: 'finish_task', args: { status: 'failed', summary: 'x' }, id: 'f' }],
    })
    observeAssistantMessage(T, msg)
    expect(hasRunRealTool(T)).toBe(false)
  })

  it('counts a non-motion real tool (capture_image) for the gate', () => {
    const msg = new AIMessage({
      content: '',
      tool_calls: [{ name: 'capture_image', args: {}, id: 'c' }],
    })
    observeAssistantMessage(T, msg)
    expect(hasRunRealTool(T)).toBe(true)
    expect(formatMotionLog(T)).toBe('') // capture_image is not a motion
  })
})

describe('formatPinnedState', () => {
  it('combines calibration and the motion log', () => {
    recordCalibration(T, 'Calibration: mapping inverted. Conf H.')
    recordMotion(T, 'move_forward (steps=1)')
    const out = formatPinnedState(T)
    expect(out).toContain('Calibration (pinned): mapping inverted. Conf H.')
    expect(out).toContain('Recent motions (newest last):')
  })

  it('is empty when nothing has been recorded', () => {
    expect(formatPinnedState(T)).toBe('')
  })
})
