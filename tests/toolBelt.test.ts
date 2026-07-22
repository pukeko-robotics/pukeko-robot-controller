import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ToolBelt from '../src/components/ToolBelt.vue'

// EXT-6 acceptance tests for the Tool Belt's pulse-active state — the two
// signals `isFiring()` combines (see ToolBelt.vue's header comment):
// (1) the precise `firingTool` prop App.vue derives from wrapping
// RobotSession's real client-tool handlers (see toolFiringTracker.test.ts
// for that mechanism's own regression coverage), and (2) the coarser
// `announcedTool` prop for the four server-fulfilled tools the browser has
// no handler for at all — the SSE announcement window App.vue derives from
// the agent's event subscription (PLAT-13; see
// toolAnnouncementTracker.test.ts for that mechanism's own coverage).

const TOOLS = [
  { name: 'move_forward', label: 'move forward' },
  { name: 'turn_left', label: 'turn left' },
  { name: 'read_status', label: 'read status' },
]

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

describe('ToolBelt — pulse-active state (announcedTool prop, for server-fulfilled tools)', () => {
  it('marks the named tool active while its SSE announcement window is open', () => {
    // no firingTool prop at all — the server-tool signal stands alone
    const wrapper = mount(ToolBelt, { props: { tools: TOOLS, announcedTool: 'read_status' } })
    const items = wrapper.findAll('.tool-belt-item')
    const activeFlags = items.map((i) => i.classes('active'))
    expect(activeFlags).toEqual([false, false, true])
  })

  it('marks nothing active once the window closes (announcedTool back to null)', async () => {
    const wrapper = mount(ToolBelt, { props: { tools: TOOLS, announcedTool: 'read_status' } })
    await wrapper.setProps({ announcedTool: null })
    expect(wrapper.findAll('.tool-belt-item.active')).toHaveLength(0)
  })

  it('marks nothing active when the announced tool matches nothing in the list', () => {
    const wrapper = mount(ToolBelt, {
      props: { tools: TOOLS, announcedTool: 'some_other_tool' },
    })
    expect(wrapper.findAll('.tool-belt-item.active')).toHaveLength(0)
  })

  it('the firingTool prop takes effect independently of the announcedTool signal', () => {
    const wrapper = mount(ToolBelt, {
      props: { tools: TOOLS, firingTool: 'move_forward', announcedTool: null },
    })
    const items = wrapper.findAll('.tool-belt-item')
    expect(items.map((i) => i.classes('active'))).toEqual([true, false, false])
  })

  it('both signals can be active at once (client handler + a later announcement)', () => {
    const wrapper = mount(ToolBelt, {
      props: { tools: TOOLS, firingTool: 'move_forward', announcedTool: 'read_status' },
    })
    const items = wrapper.findAll('.tool-belt-item')
    expect(items.map((i) => i.classes('active'))).toEqual([true, false, true])
  })
})
