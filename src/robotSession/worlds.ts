// RC-44: which world the student is driving — the real hardware, or the
// simulated grid world served by `robot-emulator/`.
//
// This is a robot-TARGET selector, not a camera selector. The emulated world
// only advances when `/forward`, `/turn_left` and the rest actually REACH the
// emulator, so a switch that repointed only the image source would leave the
// student watching a static picture while their commands flew off to hardware
// that is not there. Both the motion URLs and the frames follow the choice, and
// that is why the whole thing hangs off one host per world.
//
// Everything here is plain, Vue-free and injectable so the wiring is unit-
// testable without mounting App.vue — the same reason RobotSession itself was
// extracted (RC-7). App.vue supplies the reactive getters and the real fetch.
import {
  createHttpSnapshotCaptureSource,
  type ImageCaptureSource,
} from '@galvanized-pukeko/vue-ui';
import { RobotSession, type RobotSessionOptions } from './RobotSession.js';
import type { BrowserCapabilities } from './interpreter.js';

/** The real Acebott biped on its access point. */
export const REAL_ROBOT_WORLD_ID = 'real';
/** The `robot-emulator/` grid world. */
export const SIMULATED_WORLD_ID = 'simulated';

export type WorldId = typeof REAL_ROBOT_WORLD_ID | typeof SIMULATED_WORLD_ID;

export interface WorldOption {
  id: WorldId;
  /** The picker's option label. */
  name: string;
  /** The short badge the Cockpit shows so the active world is obvious at a glance. */
  badge: string;
}

/**
 * The selectable worlds, real first — the default, and today's behaviour.
 * Ordered as the picker renders them.
 */
export const WORLDS: readonly WorldOption[] = [
  { id: REAL_ROBOT_WORLD_ID, name: 'Real robot', badge: 'Real robot' },
  { id: SIMULATED_WORLD_ID, name: 'Simulated world', badge: 'Simulated world' },
];

/** The Acebott's own access-point address, unchanged from before RC-44. */
export const DEFAULT_ROBOT_HOST = '192.168.4.1';

/**
 * Where `pnpm run emulator` listens by default — ROBOT_EMULATOR_PORT's own
 * default, 8081 (see robot-emulator/index.ts). Overridden at build time by
 * VITE_ROBOT_EMULATOR_HOST, exactly as VITE_ROBOT_HOST overrides the robot's.
 */
export const DEFAULT_EMULATOR_HOST = 'localhost:8081';

/** The emulator's rendered-frame endpoint. */
export const CAPTURE_PATH = '/capture';

/** The hosts the two worlds live on, resolved from env by the caller. */
export interface WorldHosts {
  robotHost: string;
  emulatorHost: string;
}

/**
 * Read a host out of a build-time env var, falling back to its default. An
 * empty-but-present var counts as unset, matching App.vue's `?? host`
 * convention and `resolveSeedPreset`.
 */
export function resolveHost(raw: string | undefined, fallback: string): string {
  return raw && raw.trim().length > 0 ? raw.trim() : fallback;
}

/** The host every HTTP call for `worldId` goes to — motion endpoints included. */
export function hostForWorld(worldId: WorldId, hosts: WorldHosts): string {
  return worldId === SIMULATED_WORLD_ID ? hosts.emulatorHost : hosts.robotHost;
}

/**
 * The snapshot endpoint to fetch frames from for `worldId`, or **null** when
 * the world has none. The real robot's frames come off the mounted
 * <PkWebcamPanel>'s canvas rather than over HTTP, so `null` there is the honest
 * answer, and it is also the value createHttpSnapshotCaptureSource reads as "no
 * target configured" — its `isReady()` reports false and it never fetches.
 */
export function captureUrlForWorld(worldId: WorldId, hosts: WorldHosts): string | null {
  if (worldId !== SIMULATED_WORLD_ID) return null;
  return `http://${hosts.emulatorHost}${CAPTURE_PATH}`;
}

/** The bits of a mounted <PkWebcamPanel> the capabilities need. */
export interface WebcamPanelLike {
  captureFrame(): string | null;
  composeBeforeAfter(before: string, after: string): Promise<string | null>;
}

export interface WorldCapabilitiesDeps {
  /** The world selected RIGHT NOW — read per capture, never captured at construction. */
  getWorldId: () => WorldId;
  hosts: WorldHosts;
  /** The mounted panel, read lazily: it need not exist yet at wiring time. */
  getWebcamPanel: () => WebcamPanelLike | null | undefined;
  fetch: typeof fetch;
  /**
   * Called with every frame the simulated world produced — the resolved data
   * URL, or null when the fetch failed. This is how the Cockpit's simulated
   * viewport stays current WITHOUT a timer: the app already fetches a frame for
   * each capture_image and twice per motion recipe, so the viewport simply
   * follows the frames the agent was going to pull anyway. Do not "fix" this
   * into a polling loop — an idle simulator has nothing new to show, and a poll
   * would burn a render per tick to prove it.
   */
  onSimulatedFrame?: (frame: string | null) => void;
  /** Injected in tests so the snapshot source can be observed; defaults to the real one. */
  createSnapshotSource?: typeof createHttpSnapshotCaptureSource;
}

/**
 * The browser capabilities App.vue hands every RobotSession, dispatching each
 * capture on the CURRENTLY selected world.
 *
 * Built once for the app's lifetime and reused across session re-instantiation:
 * the HTTP snapshot source reads its URL through a getter on every capture, so
 * one source serves both worlds and keeps addressing whichever is selected now.
 *
 * `composeBeforeAfter` always goes to the webcam panel, in both worlds. It
 * draws on that component's hidden canvas rather than on the camera stream, so
 * it composes simulated frames perfectly well — provided the component is still
 * mounted. A `v-if` that removed it would null the ref and break every motion
 * composite with the whole suite green, which is why App.vue keeps the panel
 * mounted and merely stops it streaming.
 */
export function createWorldCapabilities(deps: WorldCapabilitiesDeps): BrowserCapabilities {
  const makeSource = deps.createSnapshotSource ?? createHttpSnapshotCaptureSource;
  const snapshotSource: ImageCaptureSource = makeSource({
    getUrl: () => captureUrlForWorld(deps.getWorldId(), deps.hosts),
    fetch: deps.fetch,
  });

  async function captureSimulatedFrame(): Promise<string | null> {
    const frame = await snapshotSource.captureFrame();
    deps.onSimulatedFrame?.(frame);
    return frame;
  }

  return {
    // The panel is required in BOTH worlds: composeBeforeAfter lives on it. In
    // the simulated world a configured snapshot target is required too.
    isReady: () => {
      if (deps.getWebcamPanel() == null) return false;
      if (deps.getWorldId() === SIMULATED_WORLD_ID) return snapshotSource.isReady();
      return true;
    },
    captureFrame: () => {
      if (deps.getWorldId() === SIMULATED_WORLD_ID) return captureSimulatedFrame();
      return deps.getWebcamPanel()?.captureFrame() ?? null;
    },
    composeBeforeAfter: (before, after) =>
      deps.getWebcamPanel()?.composeBeforeAfter(before, after) ?? Promise.resolve(null),
    fetch: deps.fetch,
  };
}

export interface WorldSessionOptions extends Omit<RobotSessionOptions, 'robotHost'> {
  worldId: WorldId;
  hosts: WorldHosts;
}

/**
 * A RobotSession pointed at `worldId`'s host, so every motion URL the recipe
 * interpreter builds addresses that world.
 *
 * `robotHost` is readonly by design, so switching worlds means re-instantiating
 * the session — the same move a preset switch already makes (see App.vue's
 * `makeSession` + the `:key` remount of <CopilotKitProvider>), and for the same
 * reason: a conversation describing a world that no longer exists is worse than
 * a clean start.
 */
export function createWorldSession(options: WorldSessionOptions): RobotSession {
  const { worldId, hosts, ...rest } = options;
  return new RobotSession({ ...rest, robotHost: hostForWorld(worldId, hosts) });
}
