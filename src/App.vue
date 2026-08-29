<script lang="ts">
import { DEFAULT_ROBOT_PRESET_ID } from './agent/robotPresets/index.js'
import { registerRobotToolDisplays } from './toolDisplays/index.js'

// RC-14: register the robot's bespoke tool-result renderers (capture_image
// thumbnail + motion Before/After diff) on vue-ui's PLAT-17 registry at app
// init — module load of the component that mounts the chat engine, so it runs
// before any tool-call badge can mount. The registry is deliberately not
// reactive (see vue-ui's toolDisplay.ts), so registration must precede render.
// PLAT-13: the registry is globalThis-anchored, so the same registration
// reaches ToolCallBadge whichever vue-ui bundle (root or /copilot) renders it.
registerRobotToolDisplays()

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
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import {
  applyTheme,
  configService,
  PkLogo,
  PkNavHeader,
  PkWebcamPanel,
} from '@galvanized-pukeko/vue-ui'
// PLAT-13: the headless CopilotKit engine. HeadlessChat is vue-ui's embeddable
// bespoke-styled chat surface (PkInput/PkButton/bubbles/ToolCallBadge) driven
// entirely by CopilotKit composables — the surviving engine PLAT-12 made the
// web-client default and PLAT-18 proved live against a real gth AG-UI server.
// The provider/agent wiring mirrors vue-ui's HeadlessChatApp (self-managed
// AG-UI HttpAgent, no CopilotKit cloud runtime), inlined here because the
// robot embeds the chat INSIDE its own Cockpit/Tutor chrome rather than under
// the full-app PkAppChrome wrapper.
import { CopilotKitProvider, HttpAgent } from '@copilotkit/vue/v2'
import { HeadlessChat } from '@galvanized-pukeko/vue-ui/copilot'
import { getRobotPreset, listPresets } from './agent/robotPresets/index.js'
import {
  captureUrlForWorld,
  createWorldCapabilities,
  createWorldSession,
  DEFAULT_EMULATOR_HOST,
  DEFAULT_ROBOT_HOST,
  REAL_ROBOT_WORLD_ID,
  resolveHost,
  SIMULATED_WORLD_ID,
  WORLDS,
  type RobotSession,
  type WorldId,
} from './robotSession/index.js'
import PresetPicker from './components/PresetPicker.vue'
import WorldPicker from './components/WorldPicker.vue'
import ToolBelt from './components/ToolBelt.vue'
import RobotsBrains from './components/RobotsBrains.vue'
import Splitter from './components/Splitter.vue'
import { TUTOR_THEME } from './theme/robotControllerTheme.js'
import { createToolFiringTracker } from './lib/toolFiringTracker.js'
import { createToolAnnouncementTracker } from './lib/toolAnnouncementTracker.js'

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

// RC-44: one host per world. The emulator's is configurable the same way the
// robot's is — a build-time VITE_ var, defaulted to where `pnpm run emulator`
// listens (ROBOT_EMULATOR_PORT's own default). See robotSession/worlds.ts.
const HOSTS = {
  robotHost: resolveHost(import.meta.env.VITE_ROBOT_HOST, DEFAULT_ROBOT_HOST),
  emulatorHost: resolveHost(import.meta.env.VITE_ROBOT_EMULATOR_HOST, DEFAULT_EMULATOR_HOST),
}

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

// RC-44: which world the student is driving. Real hardware by default — that
// is today's behaviour, unchanged. The choice is a robot-TARGET choice, not a
// camera one: the simulated world only advances when the motion endpoints
// actually reach the emulator, so frames AND commands both follow it.
const activeWorldId = ref<WorldId>(REAL_ROBOT_WORLD_ID)
const isSimulated = computed(() => activeWorldId.value === SIMULATED_WORLD_ID)
const activeWorld = computed(
  () => WORLDS.find((w) => w.id === activeWorldId.value) ?? WORLDS[0],
)
// The snapshot URL the simulated world is being read from, shown to the student
// when it cannot be reached (see simulatorUnreachable below).
const simulatedCaptureUrl = computed(
  () => captureUrlForWorld(SIMULATED_WORLD_ID, HOSTS) ?? '',
)

// The most recent frame the emulator served, and whether the last attempt to
// fetch one failed. Both are updated by onSimulatedFrame below — i.e. only when
// the app was fetching a frame anyway (a capture_image, or either half of a
// motion recipe's Before/After). THERE IS DELIBERATELY NO TIMER AND NO POLLING
// LOOP here: an idle simulator has nothing new to show, and a poll would burn a
// fetch and a render per tick to establish that. Please do not "fix" this into
// one.
const latestSimulatedFrame = ref<string | null>(null)
const simulatorUnreachable = ref(false)

// RC-44: built ONCE for the app's lifetime and shared by every session. The
// HTTP snapshot source inside reads its URL through a getter on each capture,
// so it always addresses the world selected *now* rather than the one selected
// when it was constructed.
const capabilities = createWorldCapabilities({
  getWorldId: () => activeWorldId.value,
  hosts: HOSTS,
  getWebcamPanel: () => webcamPanelRef.value,
  fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
  onSimulatedFrame: (frame) => {
    simulatorUnreachable.value = frame == null
    if (frame != null) latestSimulatedFrame.value = frame
  },
})

function makeSession(presetId: string, worldId: WorldId): RobotSession {
  return createWorldSession({
    worldId,
    hosts: HOSTS,
    presetId,
    agUiUrl: typeof __AGUI_URL__ !== 'undefined' ? __AGUI_URL__ : '',
    capabilities,
  })
}

// RC-8: switching preset re-initialises the RobotSession (presetId/motionToolDefs
// are readonly by design), so the new preset's client-fulfilled motion tools
// take effect without a page reload. A mid-conversation switch resets the robot
// session — the brief sanctions that; the paired `:key` on <CopilotKitProvider>
// below remounts the provider + HeadlessChat with a FRESH HttpAgent (empty
// message log = clean conversation) and the new session's frontendTools —
// the headless analogue of the bespoke path's `:key` remount of
// <ChatInterface>. The provider/model label is preset-independent, so
// re-fetch it after each re-init.
const session = shallowRef(makeSession(activePresetId.value, activeWorldId.value))

// PLAT-13: the AG-UI agent the CopilotKit provider manages ("self-managed
// HttpAgent" — the same wire the bespoke chatService spoke: AG-UI over
// HTTP/SSE, no CopilotKit cloud runtime). Created here (not inside vue-ui's
// HeadlessChatApp shell) so App.vue holds the instance and can subscribe to
// its event stream for the Tool Belt's server-tool signal below. Same URL
// resolution as HeadlessChatApp: the build-time define, else config.json
// (loaded by main.ts before mount).
function makeAgent(): HttpAgent {
  const url =
    (typeof __AGUI_URL__ !== 'undefined' && __AGUI_URL__) || configService.get().agUiUrl
  return new HttpAgent({ url })
}
const agent = shallowRef(makeAgent())
const selfManagedAgents = computed(() => ({ default: agent.value }))

// RC-44: a world switch re-initialises exactly as a preset switch does, and
// for the same reason — RobotSession.robotHost is readonly by design, so a new
// host means a new session. The paired `:key` on <CopilotKitProvider> below
// carries the world too, so the remount gives a fresh HttpAgent and an empty
// message log: a conversation describing a world that no longer exists is
// worse than a clean start.
watch([activePresetId, activeWorldId], ([presetId, worldId]) => {
  session.value = makeSession(presetId, worldId)
  agent.value = makeAgent()
  session.value.loadAgentInfo()
})

// Trap 1: <PkWebcamPanel> stays MOUNTED in every world — composeBeforeAfter
// lives on it and draws on its hidden canvas, so the motion recipes need it
// even when the frames come from the emulator. Only the camera stream is
// stopped (and the panel hidden), never the component.
watch(isSimulated, (simulated) => {
  if (simulated) {
    webcamPanelRef.value?.stopCamera()
    simulatorUnreachable.value = false
    latestSimulatedFrame.value = null
  } else {
    webcamPanelRef.value?.startCamera()
  }
})

// EXT-6 Tool Belt "pulse briefly when their tool fires": `firingToolName` is
// the name of the client-fulfilled tool currently executing, or null.
// createToolFiringTracker (src/lib/toolFiringTracker.ts) wraps RobotSession's
// real handlers — this is the ACTUAL work window (robot fetch + webcam
// capture/compose), which is deliberately more accurate than the SSE
// announcement window: the stream announces a client tool's call and is
// already finished by the time CopilotKit actually runs the handler (the
// C-a interrupt flow fulfils client tools AFTER the run's RUN_FINISHED —
// see ToolBelt.vue's comment for the server-fulfilled-tool signal that DOES
// use the announcement window, since the browser has no handler/visibility
// into those at all). Extracted into its own module (rather than left
// inline here) so the fix is unit-tested directly — see
// tests/toolFiringTracker.test.ts — instead of only provable by mounting
// the whole app.
const { firingToolName, wrap: wrapFiringHandler } = createToolFiringTracker()

// PLAT-13: the session's client tools in CopilotKit `frontendTools` shape
// (declarations byte-identical to the bespoke run-input ones — see
// RobotSession.frontendTools), each handler wrapped by the firing tracker.
// Computed-per-session, so the provider (remounted per preset via `:key`)
// always receives one stable array — CopilotKitProvider's contract.
const frontendTools = computed(() =>
  session.value.frontendTools({ wrapHandler: wrapFiringHandler })
)

// PLAT-13: the Tool Belt's signal for SERVER-fulfilled tools — the SSE
// announcement window (TOOL_CALL_START → next lifecycle event), read off the
// agent's own event subscription (lib/toolAnnouncementTracker.ts). This is
// the same window the bespoke `runState`/`statusText` fallback exposed, now
// sourced without chatService. Re-subscribed whenever a preset switch swaps
// in a fresh agent.
const { announcedToolName, subscriber: announcementSubscriber } =
  createToolAnnouncementTracker()
let announcementSub: { unsubscribe: () => void } | null = null
watch(
  agent,
  (a) => {
    announcementSub?.unsubscribe()
    announcementSub = a.subscribe(announcementSubscriber)
  },
  { immediate: true }
)
onUnmounted(() => announcementSub?.unsubscribe())

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
        <WorldPicker :worlds="WORLDS" v-model="activeWorldId" />
        <span v-if="agentLabel" class="agent-label">Model: {{ agentLabel }}</span>
      </template>
    </PkNavHeader>
    <main class="workspace">
      <!-- EXT-6 Cockpit: camera viewport + Robot's Brains, with the Tool Belt
           on its LEFT edge. Dark zone — see theme/robotControllerTheme.ts. -->
      <section class="cockpit" :style="{ flexBasis: splitPercent + '%' }">
        <ToolBelt
          :tools="beltTools"
          :firing-tool="firingToolName"
          :announced-tool="announcedToolName"
        />
        <div class="cockpit-main">
          <section class="camera-viewport" aria-label="Camera Feed">
            <!-- RC-44 trap 1: the webcam panel is NEVER unmounted. The motion
                 recipes' Before/After composite is built by its
                 composeBeforeAfter, which draws on the panel's hidden canvas
                 rather than on the camera stream — so it works fine for
                 simulated frames, but only while the component exists. A
                 `v-if` here would null the ref and break every composite
                 silently. Hidden with `v-show`, stream stopped by the watcher
                 above. -->
            <div v-show="!isSimulated" class="webcam-holder">
              <PkWebcamPanel ref="webcamPanelRef" />
            </div>

            <!-- RC-44 trap 2: in the simulated world the student must never be
                 shown the live webcam while the agent is looking at the
                 emulator. This shows the most recent frame the emulator
                 actually served, and a placeholder until one arrives. -->
            <div v-if="isSimulated" class="simulated-view">
              <img
                v-if="latestSimulatedFrame"
                class="simulated-frame"
                :src="latestSimulatedFrame"
                alt="Overhead view of the simulated world"
              />
              <p v-else-if="simulatorUnreachable" class="simulated-message simulated-message--error">
                Could not reach the simulated world at {{ simulatedCaptureUrl }}. Start it with
                <code>pnpm run emulator</code> — the camera is not the problem here.
              </p>
              <p v-else class="simulated-message">
                No frame yet. The simulated world appears here as soon as the robot takes its
                first picture or makes its first move.
              </p>
              <p
                v-if="latestSimulatedFrame && simulatorUnreachable"
                class="simulated-message simulated-message--error"
              >
                The last frame could not be fetched from {{ simulatedCaptureUrl }} — this view is
                out of date. Is <code>pnpm run emulator</code> still running?
              </p>
              <p class="simulated-note">
                This is a 3rd-person overhead view of the world. It is not what the robot's
                onboard camera sees, so a prompt tuned here will not transfer unchanged to the
                real robot.
              </p>
            </div>

            <!-- The active world, stated where the student is looking rather
                 than only inside the dropdown: a simulated run that looks
                 identical to a real one is a trap. -->
            <span class="world-badge" :class="{ 'world-badge--sim': isSimulated }">
              {{ activeWorld.badge }}
            </span>
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
        <!-- PLAT-13: the headless CopilotKit engine. `:key` remounts the whole
             provider subtree on a preset switch — fresh HttpAgent (clean
             conversation) + the new session's frontendTools, mirroring the
             bespoke remount of <ChatInterface>. `a2ui-target="chat"` keeps the
             Tutor pane a single chat column (the robot agent emits no A2UI
             surfaces; the default 'panel' target would reserve a split pane). -->
        <CopilotKitProvider
          :key="`${activePresetId}:${activeWorldId}`"
          :self-managed-agents="selfManagedAgents"
          :frontend-tools="frontendTools"
        >
          <HeadlessChat agent-id="default" a2ui-target="chat" />
        </CopilotKitProvider>
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
  /* --rc-tutor-primary(-hover) — post-review fix (Mari, live-verified gap):
     the nav header (`:deep(.nav-wrapper)` below) is a SIBLING of .tutor
     under .robot-controller, not inside it, so it never inherits the
     --pk-color-* tokens applyTheme wrote on the .tutor element itself (CSS
     custom properties only cascade to descendants of the node they're set
     on). These two vars are literal copies of
     TUTOR_THEME['--pk-color-primary'] (#4338CA) and the brief's locked
     hover value (#6366F1) — CSS can't import a TS module's string at build
     time, so, same as vue-ui's own theme.ts documents doing between itself
     and global.css, these must be kept in lock-step with
     theme/robotControllerTheme.ts by hand. */
  --rc-tutor-primary: #4338ca;
  --rc-tutor-primary-hover: #6366f1;
}

.app-title {
  font-size: 1.1rem;
  font-weight: 600;
  /* Post-review fix: pull the brand title into the Tutor indigo (Mari's
     call, live-verified — was var(--main-text-color), plain near-black,
     "no brand identity at all" in the nav header). */
  color: var(--rc-tutor-primary, #4338ca);
  margin-left: var(--padding-third);
}

/* Nav header (PkNavHeader's `.nav-wrapper` root): spans BOTH zones — a
   sibling of .cockpit/.tutor under .robot-controller, not nested inside
   either, so it's outside the reach of the Tutor-scoped applyTheme call
   (confirmed: PkNavHeader is a direct child of `.robot-controller` in the
   template below, not of `.tutor`/`.cockpit`) — this rule cannot leak into
   the dark Cockpit zone because `.nav-wrapper` doesn't exist inside it; the
   two are separate DOM subtrees, not nested. Mari's call (post-review,
   live-verified): keep the light/white background — already
   var(--bg-input-idle) from vue-ui's own rule, untouched — but pull
   interactive active-states into the Tutor indigo family. These three vars
   ARE read by PkNavHeader.vue's own `.nav-link:hover/.active` and
   `.nav-control:hover` rules (unlike the .pk-button case below, this one
   genuinely works via var redefinition alone) — no elements using those
   classes are rendered by this app today (only the #logo/#nav-controls
   slots are used), so this is presentational forward-compat, not a visible
   change today beyond .app-title above. */
:deep(.nav-wrapper) {
  --bg-button-nob-active: var(--rc-tutor-primary-tint, #eef2ff);
  --border-button-nob-active: 1px solid var(--rc-tutor-primary, #4338ca);
  --text-button-nob-active: var(--rc-tutor-primary, #4338ca);
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
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
}

/* RC-44: the webcam panel's wrapper. `v-show` (display: none) rather than
   `v-if` — the component stays mounted so composeBeforeAfter's canvas keeps
   working; see the template comment. */
.webcam-holder {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  display: flex;
}

.simulated-view {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--padding-third);
  padding: var(--padding-twothird);
  overflow: hidden;
  background: var(--rc-cockpit-bg);
}

.simulated-frame {
  max-width: 100%;
  min-height: 0;
  flex: 1 1 auto;
  object-fit: contain;
  image-rendering: pixelated;
  border-radius: var(--border-radius-small-box);
}

.simulated-message {
  max-width: 42ch;
  margin: 0;
  text-align: center;
  font-size: 0.9rem;
  color: var(--rc-cockpit-text-secondary);
}

.simulated-message--error {
  color: var(--rc-warning);
}

.simulated-message code {
  font-family: monospace;
}

.simulated-note {
  flex: 0 0 auto;
  max-width: 52ch;
  margin: 0;
  text-align: center;
  font-size: 0.8rem;
  line-height: 1.4;
  color: var(--rc-cockpit-text-secondary);
}

/* The active world, always visible over the viewport. */
.world-badge {
  position: absolute;
  top: var(--padding-third);
  right: var(--padding-third);
  z-index: 1;
  padding: 0.15rem 0.6rem;
  border-radius: 100px;
  font-size: 0.7rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--rc-cockpit-text);
  background: var(--rc-cockpit-surface);
  border: 1px solid var(--rc-cockpit-border);
}

.world-badge--sim {
  color: #13142a;
  background: var(--rc-warning);
  border-color: var(--rc-warning);
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
  /* Post-review fix (Mari, confirmed live via computed-style inspection):
     PLAT-23 only migrated the chat components (incl. ToolCallBadge) onto
     --pk-color-* — PkButton/PkInput still read the OLD generic
     --bg-button-…, --text-button-… and --border-input-… layer (global.css),
     so applyTheme alone left Send/New-Conversation/the chat input unthemed.
     Still true on the headless engine: HeadlessChat renders the same
     PkButton/PkInput primitives.
     Redefine the *primary-variant* vars here, scoped to .tutor, to the SAME
     colours already applied via applyTheme — var(--pk-color-primary) /
     var(--pk-color-on-primary) correctly resolve to the Tutor palette
     inside .tutor (that's exactly what applyTheme wrote), so this reuses
     the existing tokens rather than hand-typing new hex. */
  --bg-button-prim-idle: var(--pk-color-primary);
  --bg-button-prim-active: var(--pk-color-primary);
  --border-button-prim-idle: var(--pk-color-primary);
  --border-button-prim-active: var(--rc-tutor-primary-hover, #6366f1);
  --text-button-prim-idle: var(--pk-color-on-primary);
  --text-button-prim-active: var(--pk-color-on-primary);
}

/* The var redefinition above is necessary but NOT sufficient: verified by
   reading source (HeadlessChat.vue's <PkButton> for Send — same as the
   bespoke ChatInterface's was — and PkNewConversationButton.vue) that
   NEITHER passes the `pk-button-prim` / `pk-button-sec` modifier class
   PkButton.vue's variant rules key off — so with no modifier class, nothing
   in PkButton.vue reads --bg-button-prim-idle etc. at all, and both buttons
   render as bare, unstyled native <button>s (which is exactly the plain-gray
   appearance found live). Still a robot-controller-local override, not a
   vue-ui change — vue-ui's own source is untouched; this targets the class
   PkButton.vue already emits (`.pk-button`) from the CONSUMING app's scoped
   style via :deep(), the same technique HeadlessChat.vue itself uses for
   its own `.stop-button` (which is why :not(.stop-button) below leaves that
   one alone — it already has its own, more specific, danger-red rule). */
.tutor :deep(.pk-button):not(.stop-button) {
  background: var(--pk-color-primary, #4338ca);
  color: var(--pk-color-on-primary, #fff);
  border-color: var(--pk-color-primary, #4338ca);
}

/* Hover/active: background stays on the same AAA-safe fill (white text on
   #4338CA is 7.90:1) rather than switching to the brief's LOCKED hover hex
   (#6366F1) as the fill — white-on-#6366F1 measures 4.47:1, just under the
   4.5:1 AA text threshold (checked with the same script as the WCAG table
   in task-1-report.md). #6366F1 is still genuinely used, as a border/glow
   accent (a decorative, non-text UI affordance — 4.47:1 against the white
   page background clears the 3:1 non-text threshold easily), rather than
   silently dropped or shipped as a marginal text-contrast fail. */
.tutor :deep(.pk-button):not(.stop-button):hover,
.tutor :deep(.pk-button):not(.stop-button):active {
  border-color: var(--rc-tutor-primary-hover, #6366f1);
  box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.35);
}

.tutor :deep(.pk-input) {
  border-color: var(--pk-color-border, #e5e7eb);
  /* PkInput.vue never sets `color` at all (checked its source) — the input
     text falls through to the browser default (pure black), not the Tutor
     text token. Set it explicitly rather than leave it as a second
     "untouched" gap. */
  color: var(--pk-color-text, #111827);
}

.tutor :deep(.pk-input:focus),
.tutor :deep(.pk-input:hover:not(:disabled)) {
  border-color: var(--pk-color-primary, #4338ca);
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

/* HeadlessChat's own scoped style hardcodes `height: 100%` (exactly as the
   bespoke ChatInterface did), which assumes being the sole child of its
   panel. It shares .tutor with .tutor-header above it, so override
   height→flex here to share space correctly instead of overflowing past the
   header. */
.tutor :deep(.pk-headless-chat) {
  flex: 1 1 0;
  height: auto;
  min-height: 0;
}
</style>
