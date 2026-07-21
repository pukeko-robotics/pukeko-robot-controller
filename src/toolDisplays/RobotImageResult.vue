<script setup lang="ts">
// RC-14: the shared implementation behind both robot tool-result renderers
// (CaptureImageResult / MotionResult are thin variant wrappers — the PLAT-17
// registry hands a renderer only `{ part }`, so the variant is baked in by the
// wrapper, not passed by the badge).
//
//   variant 'thumbnail' — capture_image: a compact inline thumbnail of the
//     frame the robot saw, click to enlarge.
//   variant 'diff' — motion tools: the Before/After composite the recipe
//     already composed (labels + divider are baked into the image by
//     composeBeforeAfter), full badge width so the displacement is legible at
//     a glance, captioned with the envelope's `motion` label. An RC-5-style
//     first-person source that skips composeBeforeAfter returns the same
//     envelope shape with a single confirming snapshot — rendered identically.
//
// Graceful degradation (never a broken <img>):
//   - `{ error, motion? }` envelope → a clear textual note;
//   - anything unrecognised (plain text, wrong shape, empty data) → vue-ui's
//     generic JSON/text fallback, same as an unregistered tool.
//
// The base64 image data is rendered straight into the <img> src and never
// logged (brief: secrets/size).
import { computed, ref } from 'vue'
import { ToolResultGeneric, type ToolCallPart } from '@galvanized-pukeko/vue-ui'
import { parseImageEnvelope } from './imageEnvelope.js'
import ImageLightbox from './ImageLightbox.vue'

const props = defineProps<{
  part: ToolCallPart
  variant: 'thumbnail' | 'diff'
}>()

const parsed = computed(() => parseImageEnvelope(props.part.result))
// Discrete narrowed views so the template needs no union narrowing.
const image = computed(() => (parsed.value.kind === 'image' ? parsed.value : null))
const error = computed(() => (parsed.value.kind === 'error' ? parsed.value : null))

const enlarged = ref(false)

const alt = computed(() => {
  if (props.variant === 'diff') {
    const motion = image.value?.motion ?? props.part.toolCallName
    return `Camera frames for ${motion}`
  }
  return 'Robot camera frame'
})
</script>

<template>
  <div v-if="image" class="rc-image-result" :class="`rc-image-result--${variant}`">
    <button
      type="button"
      class="rc-image-button"
      title="Click to enlarge"
      @click="enlarged = true"
    >
      <img class="rc-tool-image" :src="image.src" :alt="alt" />
    </button>
    <div v-if="variant === 'diff' && image.motion" class="rc-image-caption">
      {{ image.motion }}
    </div>
    <ImageLightbox v-if="enlarged" :src="image.src" :alt="alt" @close="enlarged = false" />
  </div>
  <div v-else-if="error" class="rc-image-error" data-testid="rc-image-error">
    ⚠ {{ error.message }}<template v-if="error.motion"> ({{ error.motion }})</template>
  </div>
  <ToolResultGeneric v-else :part="part" />
</template>

<style scoped>
.rc-image-result {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.rc-image-button {
  display: block;
  padding: 0;
  margin: 0;
  background: none;
  border: 1px solid var(--pk-color-code-border, #cbd5e1);
  border-radius: 0.375rem;
  overflow: hidden;
  cursor: zoom-in;
  line-height: 0;
  width: fit-content;
  max-width: 100%;
}

.rc-image-button:hover {
  border-color: var(--pk-color-primary, #4338ca);
}

.rc-tool-image {
  display: block;
  max-width: 100%;
}

/* Thumbnail (capture_image): compact — what the robot saw this turn. */
.rc-image-result--thumbnail .rc-tool-image {
  max-height: 9rem;
  width: auto;
}

/* Diff (motion tools): full badge width so Before/After is legible inline. */
.rc-image-result--diff .rc-image-button {
  width: 100%;
}

.rc-image-result--diff .rc-tool-image {
  width: 100%;
  max-height: 18rem;
  object-fit: contain;
  background: var(--pk-color-code-surface, #f8fafc);
}

.rc-image-caption {
  font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', 'Consolas', monospace;
  font-size: 0.72rem;
  color: var(--pk-color-text-secondary, #64748b);
}

.rc-image-error {
  font-size: 0.78rem;
  color: var(--pk-color-danger, #b91c1c);
  background: var(--pk-color-code-surface, #f8fafc);
  border: 1px solid var(--pk-color-code-border, #cbd5e1);
  border-radius: 0.375rem;
  padding: 0.4rem 0.5rem;
  word-break: break-word;
}
</style>
