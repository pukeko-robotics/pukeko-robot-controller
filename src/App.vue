<script setup lang="ts">
import { onMounted, ref } from 'vue'
import {
  ChatInterface,
  PkLogo,
  PkNavHeader,
  PkWebcamPanel,
} from '@galvanized-pukeko/vue-ui'
import { DEFAULT_ROBOT_PRESET_ID } from './agent/robotPresets/index.js'
import { RobotSession } from './robotSession/index.js'

const webcamPanelRef = ref<InstanceType<typeof PkWebcamPanel> | null>(null)

const ROBOT_HOST = import.meta.env.VITE_ROBOT_HOST ?? '192.168.4.1'
// Robot preset (RC-1): which named tool set this hardware variant exposes.
// Mirrors the VITE_ROBOT_HOST convention above — a config value is the
// minimal UI hook for this increment (no preset-picker widget yet).
const ROBOT_PRESET = import.meta.env.VITE_ROBOT_PRESET ?? DEFAULT_ROBOT_PRESET_ID

// RC-7: all robot behaviour (robotUrl, the recipe interpreter that fulfils the
// motion tools, capture_image, the AG-UI clientTools + handlers, and the live
// agent-label fetch) lives in the unit-testable RobotSession service. App.vue
// only instantiates it, supplies the browser-side capabilities backed by the
// mounted <PkWebcamPanel>, and renders. The webcam methods are read lazily
// through the ref so the panel need not exist yet at construction time.
const session = new RobotSession({
  robotHost: ROBOT_HOST,
  presetId: ROBOT_PRESET,
  agUiUrl: typeof __AGUI_URL__ !== 'undefined' ? __AGUI_URL__ : '',
  capabilities: {
    isReady: () => webcamPanelRef.value != null,
    captureFrame: () => webcamPanelRef.value?.captureFrame() ?? null,
    composeBeforeAfter: (before, after) =>
      webcamPanelRef.value?.composeBeforeAfter(before, after) ?? Promise.resolve(null),
    fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
  },
})

const clientTools = session.clientTools
const clientToolHandlers = session.clientToolHandlers
const agentLabel = session.agentLabel

onMounted(() => session.loadAgentInfo())
</script>

<template>
  <div class="robot-controller">
    <PkNavHeader>
      <template #logo>
        <PkLogo />
        <span class="app-title">Pukeko Robot Controller</span>
      </template>
      <template #nav-controls>
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
