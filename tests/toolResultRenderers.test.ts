import { describe, it, expect, afterEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import { ToolCallBadge, resetToolDisplays } from '@galvanized-pukeko/vue-ui'
import CaptureImageResult from '../src/toolDisplays/CaptureImageResult.vue'
import MotionResult from '../src/toolDisplays/MotionResult.vue'
import { registerRobotToolDisplays } from '../src/toolDisplays/index.js'
import { PNG_1PX, toolCallPart } from './helpers/toolDisplayFixtures.js'

// RC-14 renderer acceptance: expanding the robot's vision/motion tool calls
// shows the actual pictures, not a base64 blob or a bare params line — and
// everything that is not a well-formed image envelope degrades gracefully
// (textual note or the generic view, never a broken <img>).

const CAPTURE_ENVELOPE = JSON.stringify({ mimeType: 'image/png', data: PNG_1PX })
const MOTION_ENVELOPE = JSON.stringify({
  mimeType: 'image/jpeg',
  data: PNG_1PX,
  motion: 'turn_left (steps=6)',
})

afterEach(() => resetToolDisplays())

describe('CaptureImageResult — inline thumbnail', () => {
  it('renders an <img> thumbnail from a real-shaped capture envelope', () => {
    const wrapper = mount(CaptureImageResult, {
      props: { part: toolCallPart({ result: CAPTURE_ENVELOPE }) },
    })
    const img = wrapper.find('img.rc-tool-image')
    expect(img.exists()).toBe(true)
    expect(img.attributes('src')).toBe(`data:image/png;base64,${PNG_1PX}`)
    expect(wrapper.find('.rc-image-result--thumbnail').exists()).toBe(true)
    // No lightbox until the thumbnail is clicked.
    expect(wrapper.find('.rc-lightbox').exists()).toBe(false)
  })

  it('enlarges on click and closes via Escape', async () => {
    const wrapper = mount(CaptureImageResult, {
      props: { part: toolCallPart({ result: CAPTURE_ENVELOPE }) },
    })
    await wrapper.find('button.rc-image-button').trigger('click')
    const lightbox = wrapper.find('.rc-lightbox')
    expect(lightbox.exists()).toBe(true)
    expect(lightbox.find('img').attributes('src')).toBe(`data:image/png;base64,${PNG_1PX}`)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await nextTick()
    expect(wrapper.find('.rc-lightbox').exists()).toBe(false)
  })

  it('closes the enlarged view by clicking the overlay', async () => {
    const wrapper = mount(CaptureImageResult, {
      props: { part: toolCallPart({ result: CAPTURE_ENVELOPE }) },
    })
    await wrapper.find('button.rc-image-button').trigger('click')
    await wrapper.find('.rc-lightbox').trigger('click')
    expect(wrapper.find('.rc-lightbox').exists()).toBe(false)
  })

  it('renders the error envelope as a textual note, never a broken img', () => {
    const wrapper = mount(CaptureImageResult, {
      props: { part: toolCallPart({ result: JSON.stringify({ error: 'Webcam not initialized' }) }) },
    })
    expect(wrapper.find('img').exists()).toBe(false)
    const note = wrapper.find('[data-testid="rc-image-error"]')
    expect(note.exists()).toBe(true)
    expect(note.text()).toContain('Webcam not initialized')
  })

  it('falls back to the generic view for an unrecognised result', () => {
    const wrapper = mount(CaptureImageResult, {
      props: { part: toolCallPart({ result: 'not an envelope' }) },
    })
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.find('[data-testid="tool-result-generic"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('not an envelope')
  })
})

describe('MotionResult — before/after diff picture', () => {
  it('renders the composed before/after image full-width with the motion caption', () => {
    const wrapper = mount(MotionResult, {
      props: {
        part: toolCallPart({
          toolCallName: 'turn_left',
          args: { steps: 6 },
          argsRaw: '{"steps":6}',
          result: MOTION_ENVELOPE,
        }),
      },
    })
    const img = wrapper.find('img.rc-tool-image')
    expect(img.exists()).toBe(true)
    expect(img.attributes('src')).toBe(`data:image/jpeg;base64,${PNG_1PX}`)
    expect(wrapper.find('.rc-image-result--diff').exists()).toBe(true)
    expect(wrapper.find('.rc-image-caption').text()).toBe('turn_left (steps=6)')
    expect(img.attributes('alt')).toContain('turn_left (steps=6)')
  })

  it('also enlarges on click (shared lightbox)', async () => {
    const wrapper = mount(MotionResult, {
      props: { part: toolCallPart({ toolCallName: 'turn_left', result: MOTION_ENVELOPE }) },
    })
    await wrapper.find('button.rc-image-button').trigger('click')
    expect(wrapper.find('.rc-lightbox img').exists()).toBe(true)
  })

  it('renders a single confirming snapshot identically when there is no composite (RC-5 first-person shape: same envelope, one frame)', () => {
    // A source that skips composeBeforeAfter returns the SAME envelope shape
    // with a single frame — the renderer cannot (and must not) care.
    const single = JSON.stringify({ mimeType: 'image/png', data: PNG_1PX, motion: 'move_forward' })
    const wrapper = mount(MotionResult, {
      props: { part: toolCallPart({ toolCallName: 'move_forward', result: single }) },
    })
    expect(wrapper.find('img.rc-tool-image').exists()).toBe(true)
    expect(wrapper.find('.rc-image-caption').text()).toBe('move_forward')
  })

  it('degrades gracefully on a failed motion: textual note with the motion label, no img', () => {
    const wrapper = mount(MotionResult, {
      props: {
        part: toolCallPart({
          toolCallName: 'move_forward',
          result: JSON.stringify({
            error: 'Failed to capture After frame.',
            motion: 'move_forward (steps=2)',
          }),
        }),
      },
    })
    expect(wrapper.find('img').exists()).toBe(false)
    const note = wrapper.find('[data-testid="rc-image-error"]')
    expect(note.text()).toContain('Failed to capture After frame.')
    expect(note.text()).toContain('move_forward (steps=2)')
  })

  it('falls back to the generic view for a malformed/absent image envelope', () => {
    const wrapper = mount(MotionResult, {
      props: {
        part: toolCallPart({
          toolCallName: 'move_forward',
          result: JSON.stringify({ mimeType: 'image/png', data: '' }),
        }),
      },
    })
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.find('[data-testid="tool-result-generic"]').exists()).toBe(true)
  })
})

// Integration through vue-ui's real ToolCallBadge: the registry dispatch that
// the acceptance criteria describe ("expanding a call shows…").
describe('ToolCallBadge integration (PLAT-17 dispatch)', () => {
  async function expand(wrapper: VueWrapper): Promise<void> {
    await wrapper.find('.tool-call-header').trigger('click')
  }

  it('an expanded capture_image badge shows the inline thumbnail once registered', async () => {
    registerRobotToolDisplays()
    const wrapper = mount(ToolCallBadge, {
      props: { part: toolCallPart({ result: CAPTURE_ENVELOPE }) },
    })
    await expand(wrapper)
    expect(wrapper.find('img.rc-tool-image').exists()).toBe(true)
    expect(wrapper.find('[data-testid="tool-result-generic"]').exists()).toBe(false)
  })

  it('an expanded motion badge shows the before/after image once registered', async () => {
    registerRobotToolDisplays()
    const wrapper = mount(ToolCallBadge, {
      props: {
        part: toolCallPart({ toolCallName: 'turn_left', args: { steps: 6 }, result: MOTION_ENVELOPE }),
      },
    })
    await expand(wrapper)
    expect(wrapper.find('img.rc-tool-image').exists()).toBe(true)
    // The summariser surfaces the steps arg in the collapsed header.
    expect(wrapper.find('.tool-call-summary').text()).toBe('steps=6')
  })

  it('an unregistered tool still hits the generic view (fallback intact)', async () => {
    registerRobotToolDisplays()
    const wrapper = mount(ToolCallBadge, {
      props: {
        part: toolCallPart({ toolCallName: 'read_distance', args: null, argsRaw: '', result: '12.5' }),
      },
    })
    await expand(wrapper)
    expect(wrapper.find('[data-testid="tool-result-generic"]').exists()).toBe(true)
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.text()).toContain('12.5')
  })
})
