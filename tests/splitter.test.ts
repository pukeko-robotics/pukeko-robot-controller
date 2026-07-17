import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import Splitter from '../src/components/Splitter.vue'

// EXT-6 acceptance tests for the draggable Cockpit/Tutor splitter. Two
// interactions the brief calls out: (1) dragging past either bound clamps
// rather than overshoots (neither pane can be squeezed to nothing), and
// (2) the ARIA `role="separator"` pattern's keyboard alternative (arrow
// keys) works, clamped the same way.
//
// jsdom implements neither the Pointer Capture API nor real layout
// (`getBoundingClientRect` always returns zeros), so both are stubbed per
// test: `setPointerCapture`/`releasePointerCapture`/`hasPointerCapture` as
// no-ops (the component only uses them for capture semantics, never reads
// their return value meaningfully in a way these tests exercise), and the
// parent row's `getBoundingClientRect` to a fixed 1000px-wide rect at x=0 so
// a `clientX` maps to a predictable percentage.

function stubPointerCapture(el: HTMLElement) {
  ;(el as unknown as { setPointerCapture: (id: number) => void }).setPointerCapture = () => {}
  ;(el as unknown as { releasePointerCapture: (id: number) => void }).releasePointerCapture =
    () => {}
  ;(el as unknown as { hasPointerCapture: (id: number) => boolean }).hasPointerCapture = () =>
    true
}

function stubRowWidth(parent: HTMLElement, width: number, left = 0) {
  parent.getBoundingClientRect = () =>
    ({
      left,
      top: 0,
      right: left + width,
      bottom: 0,
      width,
      height: 0,
      x: left,
      y: 0,
      toJSON() {
        return {}
      },
    }) as DOMRect
}

// Mounts the splitter inside a real parent element (VTU's own mount
// container already is one — `wrapper.element.parentElement` — see App.vue,
// where Splitter's actual DOM parent is `<main class="workspace">`) and
// wires up both jsdom stubs above.
function mountSplitter(props: { modelValue: number; min?: number; max?: number }, rowWidth = 1000) {
  const wrapper = mount(Splitter, { props })
  const handle = wrapper.element as HTMLElement
  stubPointerCapture(handle)
  const parent = handle.parentElement
  if (!parent) throw new Error('test setup: splitter has no parent element')
  stubRowWidth(parent, rowWidth)
  return wrapper
}

async function drag(wrapper: ReturnType<typeof mount>, downClientX: number, moveClientX: number) {
  await wrapper.trigger('pointerdown', { pointerId: 1, clientX: downClientX })
  await wrapper.trigger('pointermove', { pointerId: 1, clientX: moveClientX })
}

describe('Splitter — drag clamps to bounds', () => {
  it('clamps to max when dragged past the right bound', async () => {
    const wrapper = mountSplitter({ modelValue: 50 }) // default min 25 / max 75
    await drag(wrapper, 500, 900) // 900/1000 = 90% — past max
    const emitted = wrapper.emitted('update:modelValue')
    expect(emitted).toBeTruthy()
    expect(emitted!.at(-1)).toEqual([75])
  })

  it('clamps to min when dragged past the left bound', async () => {
    const wrapper = mountSplitter({ modelValue: 50 })
    await drag(wrapper, 500, 50) // 50/1000 = 5% — past min
    const emitted = wrapper.emitted('update:modelValue')
    expect(emitted!.at(-1)).toEqual([25])
  })

  it('reports the exact percentage when within bounds', async () => {
    const wrapper = mountSplitter({ modelValue: 50 })
    await drag(wrapper, 500, 400) // 400/1000 = 40% — within [25,75]
    const emitted = wrapper.emitted('update:modelValue')
    expect(emitted!.at(-1)).toEqual([40])
  })

  it('honours custom min/max props', async () => {
    const wrapper = mountSplitter({ modelValue: 50, min: 30, max: 60 })
    await drag(wrapper, 500, 900) // way past 60
    expect(wrapper.emitted('update:modelValue')!.at(-1)).toEqual([60])
  })

  it('does not emit on pointermove before a pointerdown', async () => {
    const wrapper = mountSplitter({ modelValue: 50 })
    await wrapper.trigger('pointermove', { pointerId: 1, clientX: 900 })
    expect(wrapper.emitted('update:modelValue')).toBeFalsy()
  })

  it('stops emitting after pointerup', async () => {
    const wrapper = mountSplitter({ modelValue: 50 })
    await drag(wrapper, 500, 600)
    const countAfterDrag = wrapper.emitted('update:modelValue')!.length
    await wrapper.trigger('pointerup', { pointerId: 1 })
    await wrapper.trigger('pointermove', { pointerId: 1, clientX: 900 })
    expect(wrapper.emitted('update:modelValue')!.length).toBe(countAfterDrag)
  })
})

describe('Splitter — keyboard resize', () => {
  it('ArrowRight nudges modelValue up by 2, clamped to max', async () => {
    const wrapper = mountSplitter({ modelValue: 74 })
    await wrapper.trigger('keydown', { key: 'ArrowRight' })
    expect(wrapper.emitted('update:modelValue')!.at(-1)).toEqual([75]) // 76 clamped to 75
  })

  it('ArrowLeft nudges modelValue down by 2, clamped to min', async () => {
    const wrapper = mountSplitter({ modelValue: 26 })
    await wrapper.trigger('keydown', { key: 'ArrowLeft' })
    expect(wrapper.emitted('update:modelValue')!.at(-1)).toEqual([25]) // 24 clamped to 25
  })

  it('ArrowRight/ArrowLeft nudge by exactly 2 within bounds', async () => {
    const wrapper = mountSplitter({ modelValue: 50 })
    await wrapper.trigger('keydown', { key: 'ArrowRight' })
    expect(wrapper.emitted('update:modelValue')!.at(-1)).toEqual([52])
    await wrapper.trigger('keydown', { key: 'ArrowLeft' })
    expect(wrapper.emitted('update:modelValue')!.at(-1)).toEqual([48]) // 50 - 2, from the original prop (VTU doesn't re-render modelValue from emits automatically)
  })

  it('ignores other keys', async () => {
    const wrapper = mountSplitter({ modelValue: 50 })
    await wrapper.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('update:modelValue')).toBeFalsy()
  })
})

describe('Splitter — ARIA separator attributes', () => {
  it('exposes role=separator with the current value and bounds', () => {
    const wrapper = mountSplitter({ modelValue: 57, min: 20, max: 80 })
    const el = wrapper.element
    expect(el.getAttribute('role')).toBe('separator')
    expect(el.getAttribute('aria-valuenow')).toBe('57')
    expect(el.getAttribute('aria-valuemin')).toBe('20')
    expect(el.getAttribute('aria-valuemax')).toBe('80')
  })
})
