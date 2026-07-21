<script setup lang="ts">
// RC-14: dependency-free click-to-enlarge overlay for the inline tool-result
// images. A plain fixed-position element (no Teleport, no library): fixed
// positioning escapes the badge's `overflow: hidden` on its own, and keeping
// it in-tree keeps unit tests simple. Click anywhere (the backdrop is the
// zoom-out affordance), the ✕ button, or Escape closes it.
import { onBeforeUnmount, onMounted } from 'vue'

defineProps<{ src: string; alt: string }>()
const emit = defineEmits<{ close: [] }>()

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close')
}
onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div
    class="rc-lightbox"
    role="dialog"
    aria-modal="true"
    :aria-label="alt"
    @click="emit('close')"
  >
    <img class="rc-lightbox-image" :src="src" :alt="alt" />
    <button
      type="button"
      class="rc-lightbox-close"
      aria-label="Close enlarged image"
      @click.stop="emit('close')"
    >
      ✕
    </button>
  </div>
</template>

<style scoped>
.rc-lightbox {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  /* Matches the Cockpit's dark tone (--rc-cockpit-bg) at high opacity. */
  background: rgba(19, 20, 42, 0.88);
  cursor: zoom-out;
  padding: 2rem;
}

.rc-lightbox-image {
  max-width: 100%;
  max-height: 100%;
  border-radius: 0.5rem;
  background: #fff;
  box-shadow: 0 8px 40px rgba(0, 0, 0, 0.55);
}

.rc-lightbox-close {
  position: absolute;
  top: 0.75rem;
  right: 1rem;
  background: none;
  border: none;
  color: #fff;
  font-size: 1.4rem;
  line-height: 1;
  cursor: pointer;
  padding: 0.25rem;
  opacity: 0.85;
}

.rc-lightbox-close:hover {
  opacity: 1;
}
</style>
