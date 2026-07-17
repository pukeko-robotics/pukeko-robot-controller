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
  applyTheme,
  ChatInterface,
  PkLogo,
  PkNavHeader,
  PkWebcamPanel,
} from '@galvanized-pukeko/vue-ui'
import { getRobotPreset, listPresets } from './agent/robotPresets/index.js'
import { RobotSession } from './robotSession/index.js'
import PresetPicker from './components/PresetPicker.vue'
import ToolBelt from './components/ToolBelt.vue'
import RobotsBrains from './components/RobotsBrains.vue'
import Splitter from './components/Splitter.vue'
import { TUTOR_THEME } from './theme/robotControllerTheme.js'
import { createToolFiringTracker } from './lib/toolFiringTracker.js'

const webcamPanelRef = ref<InstanceType<typeof PkWebcamPanel> | null>(null)
// EXT-6 / PLAT-23: the Tutor zone's own root element. applyTheme is scoped to
// it (not global `:root`) — see theme/robotControllerTheme.ts for why.
const tutorZoneEl = ref<HTMLElement | null>(null)

// EXT-6: the draggable splitter's left-pane (Cockpit) width, as a percentage
// of the workspace row. ~57% approximates the registered mockup's 1.3fr:1fr
// ratio (1.3 / (1.3 + 1) ≈ 0.565). Session-only, not persisted — the EXT-6
// graph node explicitly leaves "splitter defaults" as a later build-time /
// META-5 UX-loop detail, not something this task needs to settle.
const splitPercent = ref(57)

const ROBOT_HOST = import.meta.env.VITE_ROBOT_HOST ?? '192.168.4.1'

// EXT-6 Robot's Brains: the Pilot's real system prompt, baked in at build
// time (vite.config.ts reads system-prompt.md; see env.d.ts). Same guarded
// pattern as __AGUI_URL__ below — falls back to '' outside a Vite build.
const systemPromptText = typeof __SYSTEM_PROMPT__ !== 'undefined' ? __SYSTEM_PROMPT__ : ''

// RC-8: the active preset, seeded from env/default and switchable at runtime via
// the <PresetPicker> in the nav header. The registry drives the option list, so
// custom presets (RC-2/RC-7) appear automatically once registered.
const presets = listPresets()
const activePresetId = ref(resolveSeedPreset(import.meta.env.VITE_ROBOT_PRESET))

// EXT-6 Tool Belt: the active preset's full tool list (the built-in robot
// tools today; the registry is also where student-authored tools would show
// up once EXT-1/EXT-7 exist — see the report for why that half is scoped
// out). Deliberately separate from RobotSession.clientTools below, which is
// only the *client-fulfilled* subset the AG-UI run declares — the belt is a
// Cockpit display concern, not an agent-wiring one.
const activePreset = computed(() => getRobotPreset(activePresetId.value))
const beltTools = computed(() =>
  activePreset.value.tools.map((t) => ({ name: t.name, label: t.name.replace(/_/g, ' ') })),
)

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

// EXT-6 Tool Belt "pulse briefly when their tool fires": `firingToolName` is
// the name of the client-fulfilled tool currently executing, or null.
// createToolFiringTracker (src/lib/toolFiringTracker.ts) wraps RobotSession's
// real handlers — this is the ACTUAL work window (robot fetch + webcam
// capture/compose), which is deliberately more accurate than watching
// vue-ui's `runState`/`statusText`: those flip to 'running-tool' only for
// the brief SSE announcement of the tool call and are already back to
// 'idle' by the time a client-fulfilled handler actually runs (chatService's
// runLoop calls handlers AFTER RUN_FINISHED — see ToolBelt.vue's comment for
// the server-fulfilled-tool fallback that DOES use runState/statusText,
// since the browser has no handler/visibility into those at all). Extracted
// into its own module (rather than left inline here) so the fix is
// unit-tested directly — see tests/toolFiringTracker.test.ts — instead of
// only provable by mounting the whole app.
const { firingToolName, wrap: wrapFiringHandler } = createToolFiringTracker()
const clientToolHandlers = computed(() => {
  const handlers = session.value.clientToolHandlers
  const wrapped: Record<string, (args: unknown) => Promise<string>> = {}
  for (const [name, handler] of Object.entries(handlers)) {
    wrapped[name] = wrapFiringHandler(name, handler)
  }
  return wrapped
})
// agentLabel is a Ref *inside* the session; unwrap it explicitly (Vue only
// auto-unwraps one level, so a computed-wrapping-a-ref would render an object).
const agentLabel = computed(() => session.value.agentLabel.value)

onMounted(() => {
  session.value.loadAgentInfo()
  // PLAT-23: scope the Tutor palette to the Tutor zone's own root element,
  // not global `:root` — the Cockpit is a genuinely different (dark) palette,
  // applied separately as plain scoped CSS custom properties on `.cockpit`
  // (see the <style> block below). See theme/robotControllerTheme.ts for the
  // full token-mapping + WCAG rationale.
  if (tutorZoneEl.value) applyTheme(TUTOR_THEME, tutorZoneEl.value)
})
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
    <main class="workspace">
      <!-- EXT-6 Cockpit: camera viewport + Robot's Brains, with the Tool Belt
           on its LEFT edge. Dark zone — see theme/robotControllerTheme.ts. -->
      <section class="cockpit" :style="{ flexBasis: splitPercent + '%' }">
        <ToolBelt :tools="beltTools" :firing-tool="firingToolName" />
        <div class="cockpit-main">
          <section class="camera-viewport" aria-label="Camera Feed">
            <PkWebcamPanel ref="webcamPanelRef" />
          </section>
          <RobotsBrains
            :preset-name="activePreset.name"
            :agent-label="agentLabel"
            :system-prompt="systemPromptText"
          />
        </div>
      </section>

      <Splitter v-model="splitPercent" />

      <!-- EXT-6 Tutor: the teaching/authoring chat. Light zone, themed via
           applyTheme scoped to this element (see onMounted above). -->
      <section class="tutor" ref="tutorZoneEl">
        <div class="tutor-header">
          <span class="tutor-avatar" aria-hidden="true">🐦</span>
          <span class="tutor-name">Tutor</span>
          <span class="tutor-badge">Online</span>
        </div>
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
  /* Cockpit-zone-local CSS custom properties (PLAT-23's robot-controller-local
     escape hatch — not part of the vue-ui PkColorToken contract). See
     theme/robotControllerTheme.ts's COCKPIT_VARS doc comment for the full
     rationale + which pairs were WCAG-checked and how. Scoped here (not
     :root) so they only ever apply within this component tree; cascades
     into ToolBelt/RobotsBrains/Splitter's own scoped styles regardless of
     Vue's style-scoping attribute, same as any CSS custom property. */
  --rc-cockpit-bg: #13142a;
  --rc-cockpit-surface: #1a1b34;
  --rc-cockpit-border: #252740;
  --rc-cockpit-text: #e8e8f0;
  /* AA-Large / non-text UI only — see robotControllerTheme.ts. */
  --rc-cockpit-text-muted: #7b7da0;
  /* AA-compliant small secondary/body text for the dark zone. */
  --rc-cockpit-text-secondary: #9295b8;
  --rc-pilot: #0ea5e9;
  --rc-pilot-hover: #0284c7;
  --rc-danger: #ef4444;
  --rc-success: #22c55e;
  --rc-warning: #f59e0b;
  /* Tutor persona-badge tint — no PkColorToken "tint" role exists for
     --pk-color-primary, so this is a robot-controller-local var (per the
     brief) rather than a hardcoded hex in the rule below. */
  --rc-tutor-primary-tint: #eef2ff;
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

.workspace {
  flex: 1;
  display: flex;
  min-height: 0;
  overflow: hidden;
}

/* ── Cockpit (left, dark zone) ──────────────────────────────────────────── */

.cockpit {
  flex: 1 1 auto;
  min-width: 280px;
  display: flex;
  flex-direction: row;
  min-height: 0;
  overflow: hidden;
  background: var(--rc-cockpit-bg);
}

.cockpit-main {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.camera-viewport {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
}

/* ── Tutor (right, light zone) ──────────────────────────────────────────── */

.tutor {
  flex: 1 1 auto;
  min-width: 280px;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--pk-color-surface, #fff);
}

.tutor-header {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: var(--padding-third) var(--padding-twothird);
  border-bottom: 1px solid var(--pk-color-border, #e5e7eb);
  background: var(--pk-color-surface, #fff);
}

.tutor-avatar {
  width: 1.75rem;
  height: 1.75rem;
  border-radius: 0.6rem;
  background: var(--pk-color-primary, #4338ca);
  color: var(--pk-color-on-primary, #fff);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.95rem;
  flex-shrink: 0;
}

.tutor-name {
  font-size: 0.9rem;
  font-weight: 700;
  color: var(--pk-color-primary, #4338ca);
}

.tutor-badge {
  font-size: 0.65rem;
  font-weight: 600;
  color: var(--pk-color-primary, #4338ca);
  background: var(--rc-tutor-primary-tint, #eef2ff);
  padding: 0.15rem 0.55rem;
  border-radius: 100px;
  margin-left: 0.25rem;
}

/* ChatInterface's own scoped style hardcodes `height: 100%`, which assumed
   being the sole child of its panel (the old layout). It now shares .tutor
   with .tutor-header above it, so override height→flex here to share space
   correctly instead of overflowing past the header. */
.tutor :deep(.chat-interface) {
  flex: 1 1 0;
  height: auto;
  min-height: 0;
}
</style>
