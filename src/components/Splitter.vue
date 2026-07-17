<script setup lang="ts">
// EXT-6: the draggable splitter between the Cockpit (left) and the Tutor chat
// (right). Presentational + self-contained — it only knows "I'm a handle
// between two panes sized by a percentage"; it doesn't know what's on either
// side. `modelValue` is the left pane's width as a percentage of the row
// (0-100), clamped to [min, max] so neither pane can be dragged to nothing.
//
// Pointer Events (not separate mouse/touch listeners) so drag works with
// mouse, touch and pen through one code path.
import { ref } from 'vue'

const props = withDefaults(
  defineProps<{
    modelValue: number
    min?: number
    max?: number
  }>(),
  { min: 25, max: 75 },
)

const emit = defineEmits<{
  (e: 'update:modelValue', value: number): void
}>()

const dragging = ref(false)
let rowEl: HTMLElement | null = null

function clamp(value: number): number {
  return Math.min(props.max, Math.max(props.min, value))
}

function onPointerDown(event: PointerEvent) {
  const handle = event.currentTarget as HTMLElement
  rowEl = handle.parentElement
  if (!rowEl) return
  dragging.value = true
  handle.setPointerCapture(event.pointerId)
  event.preventDefault()
}

function onPointerMove(event: PointerEvent) {
  if (!dragging.value || !rowEl) return
  const rect = rowEl.getBoundingClientRect()
  if (rect.width <= 0) return
  const pct = ((event.clientX - rect.left) / rect.width) * 100
  emit('update:modelValue', clamp(pct))
}

function onPointerUp(event: PointerEvent) {
  if (!dragging.value) return
  dragging.value = false
  const handle = event.currentTarget as HTMLElement
  if (handle.hasPointerCapture(event.pointerId)) {
    handle.releasePointerCapture(event.pointerId)
  }
  rowEl = null
}

// Keyboard support: left/right arrow nudges the split, matching the
// role="separator" ARIA pattern for a resizable pane divider.
function onKeydown(event: KeyboardEvent) {
  if (event.key === 'ArrowLeft') {
    emit('update:modelValue', clamp(props.modelValue - 2))
    event.preventDefault()
  } else if (event.key === 'ArrowRight') {
    emit('update:modelValue', clamp(props.modelValue + 2))
    event.preventDefault()
  }
}
</script>

<template>
  <div
    class="splitter"
    role="separator"
    aria-orientation="vertical"
    aria-label="Resize Cockpit and Tutor panels"
    :aria-valuenow="Math.round(modelValue)"
    :aria-valuemin="min"
    :aria-valuemax="max"
    tabindex="0"
    :class="{ dragging }"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
    @keydown="onKeydown"
  >
    <span class="splitter-grip" aria-hidden="true" />
  </div>
</template>

<style scoped>
.splitter {
  flex: 0 0 6px;
  width: 6px;
  background: var(--rc-cockpit-border, #252740);
  cursor: col-resize;
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  touch-action: none;
  outline: none;
}

.splitter:hover,
.splitter.dragging,
.splitter:focus-visible {
  background: var(--rc-pilot, #0ea5e9);
}

.splitter-grip {
  width: 3px;
  height: 36px;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.28);
  pointer-events: none;
}
</style>
