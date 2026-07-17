import { describe, it, expect, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import ToolBelt from '../src/components/ToolBelt.vue'
import { runState, statusText } from '@galvanized-pukeko/vue-ui'

// EXT-6 acceptance tests for the Tool Belt's pulse-active state — the two
// signals `isFiring()` combines (see ToolBelt.vue's header comment):
// (1) the precise `firingTool` prop App.vue derives from wrapping
// RobotSession's real client-tool handlers (see toolFiringTracker.test.ts
// for that mechanism's own regression coverage), and (2) the coarser
// vue-ui `runState`/`statusText` fallback used for the four server-fulfilled
// tools the browser has no handler for at all.
//
// `runState`/`statusText` are real module-level singletons exported by
// @galvanized-pukeko/vue-ui (chatService.ts) — the same ones ToolBelt.vue
// itself imports, not a mock — so every test resets them afterward to avoid
// leaking state across tests.

const TOOLS = [
  { name: 'move_forward', label: 'move forward' },
  { name: 'turn_left', label: 'turn left' },
  { name: 'read_status', label: 'read status' },
]

afterEach(() => {
  runState.value = 'idle'
  statusText.value = ''
})

describe('ToolBelt — rendering', () => {
  it('renders one item per tool, with its label as the title', () => {
    const wrapper = mount(ToolBelt, { props: { tools: TOOLS } })
    const items = wrapper.findAll('.tool-belt-item')
    expect(items).toHaveLength(TOOLS.length)
    expect(items.map((i) => i.attributes('title'))).toEqual(TOOLS.map((t) => t.label))
  })

  it('shows a known icon for a recognised tool and a fallback dot for an unknown one', () => {
    const wrapper = mount(ToolBelt, {
      props: { tools: [...TOOLS, { name: 'student_custom_tool', label: 'student custom tool' }] },
    })
    const items = wrapper.findAll('.tool-belt-item')
    expect(items[0].text()).toContain('↑') // move_forward
    expect(items.at(-1)!.text()).toContain('•') // unknown tool — no invented icon
  })

  it('renders the settings and console app-control placeholders, disabled', () => {
    const wrapper = mount(ToolBelt, { props: { tools: TOOLS } })
    const controls = wrapper.findAll('.tool-belt-control')
    expect(controls).toHaveLength(2)
    for (const c of controls) {
      expect(c.attributes('disabled')).toBeDefined()
    }
  })
})

describe('ToolBelt — pulse-active state (firingTool prop)', () => {
  it('marks the item matching firingTool as active; no other item is active', () => {
    const wrapper = mount(ToolBelt, { props: { tools: TOOLS, firingTool: 'turn_left' } })
    const items = wrapper.findAll('.tool-belt-item')
    const activeFlags = items.map((i) => i.classes('active'))
    expect(activeFlags).toEqual([false, true, false])
  })

  it('marks no item active when firingTool is null', () => {
    const wrapper = mount(ToolBelt, { props: { tools: TOOLS, firingTool: null } })
    expect(wrapper.findAll('.tool-belt-item.active')).toHaveLength(0)
  })

  it('marks no item active when firingTool matches nothing in the list', () => {
    const wrapper = mount(ToolBelt, { props: { tools: TOOLS, firingTool: 'capture_image' } })
    expect(wrapper.findAll('.tool-belt-item.active')).toHaveLength(0)
  })

  it('reacts live when firingTool changes (App.vue rebinds it per tool call)', async () => {
    const wrapper = mount(ToolBelt, { props: { tools: TOOLS, firingTool: null } })
    expect(wrapper.findAll('.tool-belt-item.active')).toHaveLength(0)

    await wrapper.setProps({ firingTool: 'move_forward' })
    let active = wrapper.findAll('.tool-belt-item.active')
    expect(active).toHaveLength(1)
    expect(active[0].attributes('title')).toBe('move forward')

    await wrapper.setProps({ firingTool: null })
    expect(wrapper.findAll('.tool-belt-item.active')).toHaveLength(0)
  })
})

describe('ToolBelt — pulse-active state (runState/statusText fallback, for server-fulfilled tools)', () => {
  it('marks the named tool active when runState is running-tool and statusText names it', async () => {
    const wrapper = mount(ToolBelt, { props: { tools: TOOLS } }) // no firingTool prop at all
    runState.value = 'running-tool'
    statusText.value = 'Running read_status…'
    await nextTick()

    const items = wrapper.findAll('.tool-belt-item')
    const activeFlags = items.map((i) => i.classes('active'))
    expect(activeFlags).toEqual([false, false, true])
  })

  it('does not mark anything active when runState is idle, even if statusText still names a tool', async () => {
    const wrapper = mount(ToolBelt, { props: { tools: TOOLS } })
    runState.value = 'idle'
    statusText.value = 'Running read_status…' // stale text from a just-finished run
    await nextTick()
    expect(wrapper.findAll('.tool-belt-item.active')).toHaveLength(0)
  })

  it('does not mark anything active when running but statusText names a different tool', async () => {
    const wrapper = mount(ToolBelt, { props: { tools: TOOLS } })
    runState.value = 'running-tool'
    statusText.value = 'Running some_other_tool…'
    await nextTick()
    expect(wrapper.findAll('.tool-belt-item.active')).toHaveLength(0)
  })

  it('the firingTool prop takes effect independently of the runState fallback', async () => {
    const wrapper = mount(ToolBelt, { props: { tools: TOOLS, firingTool: 'move_forward' } })
    runState.value = 'idle' // fallback signal says nothing is running
    statusText.value = ''
    await nextTick()

    const items = wrapper.findAll('.tool-belt-item')
    expect(items.map((i) => i.classes('active'))).toEqual([true, false, false])
  })
})
