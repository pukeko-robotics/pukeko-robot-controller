<script setup lang="ts">
// RC-8: the minimal in-app surface for switching the active robot preset at
// runtime. Deliberately self-contained and prop-driven (no registry import, no
// layout assumptions) so it stays relocatable when EXT-6's full config-UX
// layout lands — today it sits in App.vue's `#nav-controls` slot. It renders
// whatever list of presets it is handed (one `<option>` each) and reports the
// chosen id via `update:modelValue`; deciding what a switch *does* is the
// parent's job.
defineProps<{
  presets: { id: string; name: string }[]
  modelValue: string
}>()

defineEmits<{
  (e: 'update:modelValue', id: string): void
}>()
</script>

<template>
  <label class="preset-picker">
    <span class="preset-picker__label">Robot</span>
    <select
      class="preset-picker__select"
      :value="modelValue"
      aria-label="Robot preset"
      @change="$emit('update:modelValue', ($event.target as HTMLSelectElement).value)"
    >
      <option v-for="preset in presets" :key="preset.id" :value="preset.id">
        {{ preset.name }}
      </option>
    </select>
  </label>
</template>

<style scoped>
.preset-picker {
  display: flex;
  align-items: center;
  gap: var(--padding-third);
  margin-right: 1rem;
  font-size: 1.1rem;
  color: var(--main-text-color);
  white-space: nowrap;
}

.preset-picker__label {
  font-weight: 500;
  opacity: 0.85;
}

.preset-picker__select {
  padding: 0.25rem 0.5rem;
  font-size: 1rem;
  color: var(--main-text-color);
  background: var(--bg-input-idle);
  border: var(--line-separator-subtle);
  border-radius: var(--border-radius-small-box);
}
</style>
