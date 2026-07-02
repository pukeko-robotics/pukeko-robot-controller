// RobotSession (RC-7): the unit-testable service extracted out of App.vue.
// It owns everything that used to live inline in the SFC — robotUrl, the
// recipe interpreter, runMotion/capture_image fulfilment, the AG-UI clientTools
// + handlers the <ChatInterface> is fed, and the /info agent-label fetch —
// leaving App.vue to only instantiate this, supply the browser capabilities
// (webcam ref + fetch), and render. Mirrors how galvanized-pukeko factors its
// chatService.ts / configService.ts. Because every side effect is injected via
// BrowserCapabilities, runMotion is now reachable (and asserted) in tests
// without mounting the component.
import { ref, type Ref } from 'vue';
import type { Tool } from '@galvanized-pukeko/vue-ui';
import { DEFAULT_ROBOT_PRESET_ID, getClientToolDefs } from '../agent/robotPresets/index.js';
import type { RobotToolDef } from '../agent/robotPresets/index.js';
import {
  frameToEnvelope,
  runRecipe,
  type BrowserCapabilities,
  type RobotCapabilities,
} from './interpreter.js';

export interface RobotSessionOptions {
  robotHost: string;
  // Browser side effects (webcam capture/compose + fetch). Supplied by App.vue
  // from the mounted <PkWebcamPanel> ref; faked in tests.
  capabilities: BrowserCapabilities;
  presetId?: string;
  // The build-time AG-UI URL (App.vue's `__AGUI_URL__` define). When empty,
  // loadAgentInfo falls back to /config.json. Injected so loadAgentInfo is
  // testable without the Vite global.
  agUiUrl?: string;
}

export class RobotSession {
  readonly robotHost: string;
  readonly presetId: string;
  // Provider/model label for the nav header, populated by loadAgentInfo().
  readonly agentLabel: Ref<string> = ref('');

  private readonly caps: RobotCapabilities;
  private readonly agUiUrl: string;
  private readonly motionToolDefs: RobotToolDef[];

  constructor(options: RobotSessionOptions) {
    this.robotHost = options.robotHost;
    this.presetId = options.presetId ?? DEFAULT_ROBOT_PRESET_ID;
    this.agUiUrl = options.agUiUrl ?? '';
    this.motionToolDefs = getClientToolDefs(this.presetId);
    // Compose the full capability context the interpreter needs by adding the
    // host-derived robotUrl on top of the injected browser capabilities.
    this.caps = {
      ...options.capabilities,
      robotHost: this.robotHost,
      robotUrl: (path: string) => this.robotUrl(path),
    };
  }

  robotUrl(path: string): string {
    return `http://${this.robotHost}${path}`;
  }

  // Fulfil one client-side motion tool by running its recipe. Returns the JSON
  // string handed back to the model.
  runMotion(def: RobotToolDef, args: unknown): Promise<string> {
    return runRecipe(def, args, this.caps);
  }

  // The generic single-frame capability (capture_image) — not a preset tool,
  // shared across every preset, so it stays here rather than in recipe data.
  async captureImage(): Promise<string> {
    if (!this.caps.isReady()) {
      return JSON.stringify({ error: 'Webcam not initialized' });
    }
    const envelope = frameToEnvelope(this.caps.captureFrame());
    if (envelope) return JSON.stringify(envelope);
    return JSON.stringify({ error: 'Failed to capture frame. Is the camera active?' });
  }

  // The AG-UI run-input tool declarations fed to <ChatInterface> — capture_image
  // plus the active preset's client-fulfilled motion tools, in preset order.
  // Same shape App.vue used to build inline (RC-1's client<->server parity is
  // preserved: name/description/parameters come straight from the preset).
  get clientTools(): Tool[] {
    return [
      {
        name: 'capture_image',
        description:
          'Capture a photo from the robot webcam. Returns the current image of the robot and its surroundings as seen from above.',
        parameters: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
      ...this.motionToolDefs.map((def) => ({
        name: def.name,
        // clientDescription (when set) is authoritative for what the model
        // sees for a client-fulfilled tool — see RobotToolDef.
        description: def.clientDescription ?? def.description,
        parameters: def.jsonSchema,
      })),
    ];
  }

  // Handlers for the tools above, keyed by name.
  get clientToolHandlers(): Record<string, (args: unknown) => Promise<string>> {
    return {
      capture_image: () => this.captureImage(),
      ...Object.fromEntries(
        this.motionToolDefs.map((def) => {
          if (!def.recipe) {
            throw new Error(`Client-fulfilled tool '${def.name}' is missing a recipe.`);
          }
          return [def.name, (args: unknown) => this.runMotion(def, args)];
        })
      ),
    };
  }

  // Provider/model label fetched live from the AG-UI server's /info endpoint so
  // the nav header always reflects the running profile. Uses the injected
  // agUiUrl, falling back to /config.json. Sets `agentLabel`.
  async loadAgentInfo(): Promise<void> {
    try {
      let agUiUrl = this.agUiUrl;
      if (!agUiUrl) {
        const cfgRes = await this.caps.fetch('/config.json');
        if (cfgRes.ok) agUiUrl = ((await cfgRes.json()).agUiUrl as string) ?? '';
      }
      if (!agUiUrl) return;
      const base = agUiUrl.replace(/\/agents\/.*$/, '');
      const res = await this.caps.fetch(`${base}/info`);
      if (!res.ok) return;
      const info = (await res.json()) as { provider?: string | null; model?: string | null };
      this.agentLabel.value = [info.provider, info.model].filter(Boolean).join(' ');
    } catch (err) {
      console.warn('[RobotSession] Failed to load agent info:', err);
    }
  }
}
