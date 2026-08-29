<script setup lang="ts">
// RC-44: the in-app surface for choosing which world the student is driving —
// the real robot, or the simulated grid world. Shaped exactly like
// PresetPicker: prop-driven, no registry import, no layout assumptions, so it
// stays relocatable. It renders whatever list of worlds it is handed and
// reports the chosen id via `update:modelValue`; deciding what a switch *does*
// (re-instantiating the session so the motion URLs follow the choice too) is
// the parent's job.
import type { WorldId, WorldOption } from '../robotSession/index.js'

defineProps<{
  worlds: readonly WorldOption[]
  modelValue: WorldId
}>()

defineEmits<{
  (e: 'update:modelValue', id: WorldId): void
}>()
</script>

<template>
  <label class="world-picker">
    <span class="world-picker__label">World</span>
    <select
      class="world-picker__select"
      :value="modelValue"
      aria-label="Robot world"
      @change="$emit('update:modelValue', ($event.target as HTMLSelectElement).value as WorldId)"
    >
      <option v-for="world in worlds" :key="world.id" :value="world.id">
        {{ world.name }}
      </option>
    </select>
  </label>
</template>

<style scoped>
.world-picker {
  display: flex;
  align-items: center;
  gap: var(--padding-third);
  margin-right: 1rem;
  font-size: 1.1rem;
  color: var(--main-text-color);
  white-space: nowrap;
}

.world-picker__label {
  font-weight: 500;
  opacity: 0.85;
}

.world-picker__select {
  padding: 0.25rem 0.5rem;
  font-size: 1rem;
  color: var(--main-text-color);
  background: var(--bg-input-idle);
  border: var(--line-separator-subtle);
  border-radius: var(--border-radius-small-box);
}
</style>
