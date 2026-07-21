<script setup lang="ts">
// RC-14: `capture_image` result renderer — an inline thumbnail of the frame
// the robot saw for that turn, click to enlarge. Registered on the PLAT-17
// registry (see ./index.ts); the badge passes only `{ part }`, so this thin
// wrapper bakes in the 'thumbnail' variant of the shared implementation.
import type { ToolCallPart } from '@galvanized-pukeko/vue-ui'
import RobotImageResult from './RobotImageResult.vue'

defineProps<{ part: ToolCallPart }>()
</script>

<template>
  <RobotImageResult :part="part" variant="thumbnail" />
</template>
