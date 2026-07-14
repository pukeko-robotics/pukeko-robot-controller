<script lang="ts">
import { DEFAULT_ROBOT_PRESET_ID } from './agent/robotPresets/index.js'

// Robot preset (RC-1): which named tool set this hardware variant exposes.
// VITE_ROBOT_PRESET / DEFAULT_ROBOT_PRESET_ID still *seed* the initial value.
// Lives in a module-scope <script> (not <script setup>, which forbids exports)
// so the seed rule is unit-testable without mounting the app. An empty env
// string counts as unset (falls back to the default), matching the `?? host`
// convention below for a blank-but-present var.
export function resolveSeedPreset(raw: string | undefined): string {
  return raw && raw.length > 0 ? raw : DEFAULT_ROBOT_PRESET_ID
}
</script>

<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, watch } from 'vue'
import {
  ChatInterface,
  PkLogo,
  PkNavHeader,
  PkWebcamPanel,
} from '@galvanized-pukeko/vue-ui'
import { listPresets } from './agent/robotPresets/index.js'
import { RobotSession } from './robotSession/index.js'
import PresetPicker from './components/PresetPicker.vue'

const webcamPanelRef = ref<InstanceType<typeof PkWebcamPanel> | null>(null)

const ROBOT_HOST = import.meta.env.VITE_ROBOT_HOST ?? '192.168.4.1'

// RC-8: the active preset, seeded from env/default and switchable at runtime via
// the <PresetPicker> in the nav header. The registry drives the option list, so
// custom presets (RC-2/RC-7) appear automatically once registered.
const presets = listPresets()
const activePresetId = ref(resolveSeedPreset(import.meta.env.VITE_ROBOT_PRESET))

// RC-7: all robot behaviour (robotUrl, the recipe interpreter that fulfils the
// motion tools, capture_image, the AG-UI clientTools + handlers, and the live
// agent-label fetch) lives in the unit-testable RobotSession service. App.vue
// only instantiates it, supplies the browser-side capabilities backed by the
// mounted <PkWebcamPanel>, and renders. The webcam methods are read lazily
// through the ref so the panel need not exist yet at construction time.
function makeSession(presetId: string): RobotSession {
  return new RobotSession({
    robotHost: ROBOT_HOST,
    presetId,
    agUiUrl: typeof __AGUI_URL__ !== 'undefined' ? __AGUI_URL__ : '',
    capabilities: {
      isReady: () => webcamPanelRef.value != null,
      captureFrame: () => webcamPanelRef.value?.captureFrame() ?? null,
      composeBeforeAfter: (before, after) =>
        webcamPanelRef.value?.composeBeforeAfter(before, after) ?? Promise.resolve(null),
      fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
    },
  })
}

// RC-8: switching preset re-initialises the RobotSession (presetId/motionToolDefs
// are readonly by design), so the new preset's client-fulfilled motion tools
// take effect without a page reload. A mid-conversation switch resets the robot
// session — the brief sanctions that; the paired `:key` on <ChatInterface> below
// remounts it with the fresh tools and a clean conversation. The provider/model
// label is preset-independent, so re-fetch it after each re-init.
const session = shallowRef(makeSession(activePresetId.value))
watch(activePresetId, (id) => {
  session.value = makeSession(id)
  session.value.loadAgentInfo()
})

const clientTools = computed(() => session.value.clientTools)
const clientToolHandlers = computed(() => session.value.clientToolHandlers)
// agentLabel is a Ref *inside* the session; unwrap it explicitly (Vue only
// auto-unwraps one level, so a computed-wrapping-a-ref would render an object).
const agentLabel = computed(() => session.value.agentLabel.value)

onMounted(() => session.value.loadAgentInfo())
</script>

<template>
  <div class="robot-controller">
    <PkNavHeader>
      <template #logo>
        <PkLogo />
        <span class="app-title">Pukeko Robot Controller</span>
      </template>
      <template #nav-controls>
        <PresetPicker :presets="presets" v-model="activePresetId" />
        <span v-if="agentLabel" class="agent-label">Model: {{ agentLabel }}</span>
      </template>
    </PkNavHeader>
    <main class="robot-panels">
      <section class="panel webcam-section">
        <h2>Camera Feed</h2>
        <PkWebcamPanel ref="webcamPanelRef" />
      </section>
      <section class="panel chat-section">
        <ChatInterface
          :key="activePresetId"
          :clientTools="clientTools"
          :clientToolHandlers="clientToolHandlers"
        />
      </section>
    </main>
  </div>
</template>

<style scoped>
.robot-controller {
  display: flex;
  flex-direction: column;
  height: 100vh;
}

.app-title {
  font-size: 1.1rem;
  font-weight: 600;
  color: var(--main-text-color);
  margin-left: var(--padding-third);
}

.agent-label {
  /* Noticeable gap between the model label and the action buttons. */
  display: flex;
  align-items: center;
  margin-right: 2rem;
  font-size: 1.1rem;
  font-weight: 500;
  color: var(--main-text-color);
  white-space: nowrap;
  opacity: 0.85;
}

.robot-panels {
  flex: 1;
  display: flex;
  gap: var(--padding-twothird);
  padding: var(--padding-twothird);
  overflow: hidden;
}

.panel {
  flex: 1;
  min-width: 0;
  background: var(--bg-input-idle);
  border-radius: var(--border-radius-small-box);
  border: var(--line-separator-subtle);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.panel h2 {
  margin: 0;
  padding: var(--padding-third) var(--padding-twothird);
  font-size: 0.9rem;
  font-weight: 600;
  border-bottom: var(--line-separator-subtle);
}
</style>
