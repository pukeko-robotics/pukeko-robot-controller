<script setup lang="ts">
// RC-14: motion-tool result renderer — the Before/After composite the recipe
// already composes, shown inline in the expanded call so the displacement is
// legible at a glance. Registered on the PLAT-17 registry (see ./index.ts);
// this thin wrapper bakes in the 'diff' variant of the shared implementation.
import type { ToolCallPart } from '@galvanized-pukeko/vue-ui'
import RobotImageResult from './RobotImageResult.vue'

defineProps<{ part: ToolCallPart }>()
</script>

<template>
  <RobotImageResult :part="part" variant="diff" />
</template>
