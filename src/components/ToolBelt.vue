<script setup lang="ts">
// EXT-6: the Tool Belt — the compact LEFT-edge vertical rail of the Cockpit.
// Lists the active preset's tools (built-in robot tools today; the registry
// is where student-authored tools would appear too, once EXT-1/EXT-7 land —
// see the report for why that half isn't wired yet) plus app controls
// (settings, a `>_` console) per the registered EXT-6 mockup.
//
// "Pulse briefly when their tool fires" is wired to REAL state, not a fake
// timer, via two signals depending on how the tool is fulfilled:
//
//  - Client-fulfilled tools (the 4 motion tools + capture_image): App.vue
//    wraps RobotSession's real handlers and passes down the currently-firing
//    tool name as `firingTool` — that's the actual work window (robot
//    fetch + webcam capture/compose), not a guess.
//  - Server-fulfilled tools (stop/read_distance/read_status/finish_task):
//    the browser has no handler for these at all, so there's no equivalent
//    signal to wrap. The best available signal is the SSE announcement
//    window in the AG-UI event stream (TOOL_CALL_START → the next lifecycle
//    event). PLAT-13: on the headless engine App.vue derives that window
//    from the CopilotKit-managed agent's own event subscription (see
//    lib/toolAnnouncementTracker.ts — the same events the retired bespoke
//    `runState`/`statusText` fallback was fed by) and passes the announced
//    tool name down as `announcedTool`. It's a coarser, shorter-lived
//    signal than the client-side one, but it's real reactive state, not
//    invented — and it's the only one the browser has for these four tools.
import { computed } from 'vue'

export interface ToolBeltItem {
  name: string
  label: string
}

const props = defineProps<{
  tools: ToolBeltItem[]
  firingTool?: string | null
  announcedTool?: string | null
}>()

// Glyphs are decorative (aria-hidden); the accessible name is the tool's
// `label`/`name` via the title/aria-label below. Unknown/future tool names
// (e.g. a student-authored tool once EXT-1/EXT-7 exist) fall back to a plain
// dot rather than guessing an icon.
const ICONS: Record<string, string> = {
  move_forward: '↑',
  move_backward: '↓',
  turn_left: '↺',
  turn_right: '↻',
  stop: '■',
  read_distance: '📏',
  read_status: 'ℹ',
  finish_task: '🏁',
}

function iconFor(name: string): string {
  return ICONS[name] ?? '•'
}

function isFiring(name: string): boolean {
  if (props.firingTool === name) return true
  return props.announcedTool === name
}

const items = computed(() =>
  props.tools.map((t) => ({ ...t, icon: iconFor(t.name), active: isFiring(t.name) })),
)
</script>

<template>
  <nav class="tool-belt" aria-label="Tool Belt">
    <div class="tool-belt-controls">
      <!-- App controls (settings, console) per the registered mockup.
           Presentational placeholders — no panel/console is wired up yet;
           see the report's scope notes. -->
      <button type="button" class="tool-belt-control" title="Settings (not yet implemented)" disabled>
        <span aria-hidden="true">⚙</span>
        <span class="sr-only">Settings</span>
      </button>
      <button type="button" class="tool-belt-control" title="Console (not yet implemented)" disabled>
        <span aria-hidden="true">&gt;_</span>
        <span class="sr-only">Console</span>
      </button>
    </div>
    <div class="tool-belt-divider" aria-hidden="true" />
    <ul class="tool-belt-items">
      <li v-for="item in items" :key="item.name">
        <div
          class="tool-belt-item"
          :class="{ active: item.active }"
          :title="item.label"
        >
          <span aria-hidden="true">{{ item.icon }}</span>
          <span class="sr-only">{{ item.label }}</span>
        </div>
      </li>
    </ul>
  </nav>
</template>

<style scoped>
.tool-belt {
  flex: 0 0 auto;
  width: 52px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0;
  background: var(--rc-cockpit-surface, #1a1b34);
  border-right: 1px solid var(--rc-cockpit-border, #252740);
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.tool-belt-controls {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.tool-belt-control {
  width: 32px;
  height: 32px;
  border-radius: 9px;
  border: 1px solid var(--rc-cockpit-border, #252740);
  background: transparent;
  color: var(--rc-cockpit-text-secondary, #9295b8);
  font-size: 0.85rem;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: not-allowed;
}

.tool-belt-divider {
  width: 28px;
  height: 1px;
  background: var(--rc-cockpit-border, #252740);
  margin: 0.15rem 0;
}

.tool-belt-items {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.tool-belt-item {
  width: 32px;
  height: 32px;
  border-radius: 9px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.95rem;
  background: var(--rc-cockpit-bg, #13142a);
  color: var(--rc-cockpit-text-secondary, #9295b8);
  border: 1px solid transparent;
  transition: background 0.15s ease, color 0.15s ease;
}

.tool-belt-item.active {
  color: var(--rc-pilot, #0ea5e9);
  background: rgba(14, 165, 233, 0.15);
  border-color: rgba(14, 165, 233, 0.35);
  animation: tool-belt-pulse 1.1s ease-in-out infinite;
}

@keyframes tool-belt-pulse {
  0%,
  100% {
    box-shadow: 0 0 0 0 rgba(14, 165, 233, 0);
  }
  50% {
    box-shadow: 0 0 10px 2px rgba(14, 165, 233, 0.35);
  }
}
</style>
