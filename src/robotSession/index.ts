// RobotSession barrel (RC-7). App.vue and tests import from here.
export { RobotSession } from './RobotSession.js';
export type { RobotSessionOptions, ClientToolHandler } from './RobotSession.js';
export {
  runRecipe,
  frameToEnvelope,
  coerceSteps,
  type RobotCapabilities,
  type BrowserCapabilities,
} from './interpreter.js';
