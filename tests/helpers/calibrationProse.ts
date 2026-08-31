/**
 * RC-49 — the guard that stops the model-facing prose drifting from the robot definition.
 *
 * The robot's calibration is written TWICE: once as data on the robot profile
 * (`src/agent/robotPresets/physical.ts`, the numbers the emulator moves by) and once as prose —
 * `system-prompt.md` and the tool descriptions in `acebottQd021.ts` — which is what the model
 * actually reads and believes. Nothing but this file keeps the two in step. Recalibrate the gait
 * or add a second preset and the prose quietly keeps yesterday's figures while every test stays
 * green; that is exactly the shape of the original "prompt says 15°, emulator turns 45°" incident.
 *
 * RC-49 considered TEMPLATING the prose from the profile and rejected it: the prompt is a
 * teaching artefact people tune by hand, not a table of numbers, and templating reaches much
 * further into prose than it first appears. So the numbers stay hand-written and this checks them.
 *
 * ## How it avoids being a tautology
 *
 * One side of every comparison is PARSED OUT OF THE PROSE by pattern; the other is read from the
 * profile. A guard that derived both sides from the profile would agree with every edit, including
 * one that quietly changed what the robot is — the bug this cluster keeps re-growing (RC-46,
 * RC-51). Nothing here interpolates a profile figure into an expected string.
 *
 * ## Two deliberate non-rules
 *
 * - **A figure the prose does not state is not a failure.** `system-prompt.md` says nothing about
 *   the backward stride and should not be forced to. Each figure is guarded wherever it actually
 *   appears, and a source that is silent about one contributes nothing for it. (The price is that
 *   deleting a figure disarms its rule, so the spec asserts every rule still matches something
 *   today — see `matchCounts`.)
 * - **Prose that is not a calibration figure is never checked.** The patterns below match numbers
 *   in their stated context only. A guard that made the prompt awkward to edit would be deleted by
 *   the first person it annoyed, and would then protect nothing.
 */
import { readFileSync } from 'node:fs';
import type { ZodTypeAny } from 'zod';
import type { RobotPhysicalProfile } from '../../src/agent/robotPresets/physical.js';
import { getRobotPreset } from '../../src/agent/robotPresets/index.js';

/** Where a piece of model-facing prose came from, and what class of source it is. */
export interface ProseSource {
  /** Human-readable, and what a finding names — so a failure points at the file to edit. */
  id: string;
  /** `prompt` = system-prompt.md, `steps` = the shared `steps` param text, `tool` = one tool's own. */
  kind: 'prompt' | 'steps' | 'tool';
  /** For `kind: 'tool'`, which tool — this is what keeps the forward figure off `move_backward`. */
  tool?: string;
  text: string;
}

/** One disagreement between the prose and the profile. Names the figure AND both values. */
export interface CalibrationFinding {
  /** The figure that disagrees, e.g. `turn angle per cycle`. */
  figure: string;
  /** The source id the stale text sits in. */
  source: string;
  /** The matched text, verbatim, so the reader can find it without hunting. */
  quote: string;
  /** What the prose says. */
  proseValue: number;
  /** What the robot profile says. */
  profileValue: number;
  message: string;
}

type Comparison = 'equal' | 'strictlyBelow';

interface CalibrationRule {
  id: string;
  figure: string;
  unit: string;
  /** Which sources this figure may legitimately appear in. */
  appliesTo: (source: ProseSource) => boolean;
  /**
   * Each pattern captures the number(s) stated in the prose. Patterns with TWO capture groups are
   * multiples: group 1 is the cycle count, group 2 the stated total.
   */
  patterns: RegExp[];
  comparison: Comparison;
  /** The profile value this prose figure must agree with (or, for `strictlyBelow`, stay under). */
  expected: (profile: RobotPhysicalProfile, cycles: number) => number;
}

const isPromptOrSteps = (s: ProseSource) => s.kind === 'prompt' || s.kind === 'steps';

/**
 * The rules. Every regex is written against the prose as it is actually phrased — see the sample
 * in each comment — because a pattern that matches nothing is a guard that is switched off.
 */
const RULES: CalibrationRule[] = [
  {
    id: 'forward-per-cycle',
    figure: 'forward distance per cycle',
    unit: 'cm',
    // The system prompt and the `steps` text talk about forward in general; among the per-tool
    // descriptions only move_forward's may state it. `move_backward` says "~N cm per cycle" too,
    // and letting this rule read that string is how 1.3 would get "corrected" to 1.5.
    appliesTo: (s) => isPromptOrSteps(s) || s.tool === 'move_forward',
    patterns: [
      // "1 forward ≈ 1.5 cm" · "1 forward cycle ≈ 1.5 cm"
      /1 forward(?: cycle)? ≈ (\d+(?:\.\d+)?) cm/g,
      // "~1.5 cm per cycle" (move_forward's own description)
      /~(\d+(?:\.\d+)?) cm per cycle/g,
    ],
    comparison: 'equal',
    expected: (profile) => profile.motion.forwardPerCycleCm,
  },
  {
    id: 'backward-per-cycle',
    figure: 'backward distance per cycle',
    unit: 'cm',
    // Note the asymmetry with forward: system-prompt.md states no backward figure at all, and is
    // not required to. Only the `steps` text and move_backward's own description do.
    appliesTo: (s) => s.kind === 'steps' || s.tool === 'move_backward',
    patterns: [
      // "1 backward cycle ≈ 1.3 cm"
      /1 backward(?: cycle)? ≈ (\d+(?:\.\d+)?) cm/g,
      // "~1.3 cm per cycle" (move_backward's own description)
      /~(\d+(?:\.\d+)?) cm per cycle/g,
    ],
    comparison: 'equal',
    expected: (profile) => profile.motion.backwardPerCycleCm,
  },
  {
    id: 'turn-per-cycle',
    figure: 'turn angle per cycle',
    unit: '°',
    appliesTo: () => true,
    patterns: [
      // "1 turn ≈ 15°" · "1 turn cycle ≈ 15°"
      /1 turn(?: cycle)? ≈ (\d+(?:\.\d+)?)°/g,
      // "~15° per cycle" · "(~15° per turn cycle)"
      /~(\d+(?:\.\d+)?)° per (?:turn )?cycle/g,
      // "Turn 1 step (~15°)"
      /Turn 1 step \(~(\d+(?:\.\d+)?)°\)/g,
      // "sweep … a step (~15°) at a time"
      /a step \(~(\d+(?:\.\d+)?)°\)/g,
    ],
    comparison: 'equal',
    expected: (profile) => profile.motion.turnDegreesPerCycle,
  },
  {
    id: 'turn-multiples',
    figure: 'turn angle for a multi-cycle turn',
    unit: '°',
    // The single-cycle figure is not where a stale number hides best — the DERIVED multiples are.
    // The prompt does not only say 15°; it says 6 ≈ 90°, 3 ≈ 45°, and teaches a calibration
    // procedure built on "steps=3 (~45°)". Change the turn figure and every one of those becomes
    // false while the single-cycle figure could well have been updated.
    appliesTo: () => true,
    patterns: [
      // "(6 ≈ 90°, 3 ≈ 45°)" — a bare cycle count immediately before the ≈
      /(\d+) ≈ (\d+(?:\.\d+)?)°/g,
      // "6 turn cycles ≈ 90°"
      /(\d+) turn cycles ≈ (\d+(?:\.\d+)?)°/g,
      // "`turn_right` steps=3 (~45°)"
      /steps=(\d+) \(~(\d+(?:\.\d+)?)°\)/g,
    ],
    comparison: 'equal',
    expected: (profile, cycles) => profile.motion.turnDegreesPerCycle * cycles,
  },
  {
    id: 'sensor-minimum-range',
    figure: "sensor's minimum range (the bumper)",
    unit: 'cm',
    // Only the system prompt states this one, and it states it three ways.
    appliesTo: (s) => s.kind === 'prompt',
    patterns: [
      // "**< 3 cm:** \"something touching the nose\"" — the bold list form only, so the slim-object
      // aside ("<~4 cm: chair legs, sticks") is not mistaken for the sensor floor.
      /\*\*< (\d+(?:\.\d+)?) cm:\*\*/g,
      // "Robot has a 3 cm bumper"
      /(\d+(?:\.\d+)?) cm bumper/g,
      // The LOWER bound of every stated cm range: "3–50 cm", "3–3.5 cm". Both are the bumper.
      /(\d+(?:\.\d+)?)–\d+(?:\.\d+)? cm/g,
    ],
    comparison: 'equal',
    expected: (profile) => profile.sensor.minRangeCm,
  },
  {
    id: 'trust-band-inside-sensor-range',
    figure: "trust-band upper bound vs the sensor's maximum range",
    unit: 'cm',
    // THIS ONE IS AN INEQUALITY, AND DELIBERATELY SO. The prompt's "3–50 cm" is a TRUST BAND —
    // advice about how to interpret a reading — not the sensor's maximum range, which is 400 cm.
    // Asserting 50 == maxRangeCm would be simply wrong, and would also break the prompt's central
    // aiming procedure ("over 50 cm means you are pointed at open space — re-aim"), which only
    // means anything BECAUSE the sensor can return readings well above 50.
    //
    // What must hold is the RELATIONSHIP: the band's upper bound has to sit strictly inside the
    // sensor's real range. Set `maxRangeCm: 40` and the re-aim advice becomes unreachable
    // nonsense — the sensor could never report the reading the prompt tells the model to react to
    // — and nothing else in the suite would notice.
    appliesTo: (s) => s.kind === 'prompt',
    patterns: [
      // The UPPER bound of every stated cm range: "3–50 cm", "3–3.5 cm".
      /\d+(?:\.\d+)?–(\d+(?:\.\d+)?) cm/g,
      // "**> 50 cm:**", "expect distance to stay >50 cm" — the over-range advice.
      />\s?(\d+(?:\.\d+)?) cm/g,
    ],
    comparison: 'strictlyBelow',
    expected: (profile) => profile.sensor.maxRangeCm,
  },
];

/** Ids of every rule, so a spec can assert the whole set is still armed. */
export const CALIBRATION_RULE_IDS: readonly string[] = RULES.map((r) => r.id);

const NEARLY_EQUAL = 1e-9;

function formatValue(value: number, unit: string): string {
  return unit === '°' ? `${value}°` : `${value} ${unit}`;
}

export interface CalibrationCheck {
  findings: CalibrationFinding[];
  /** How many prose figures each rule actually matched. A zero here means that rule guards nothing. */
  matchCounts: Record<string, number>;
}

/**
 * Compare every calibration figure the prose states against the robot profile.
 *
 * Returns one finding per disagreement, each naming the figure, the source, the matched text and
 * BOTH values — a guard that only says "the prompt is stale" sends the next person hunting.
 */
export function checkCalibrationProseDetailed(
  profile: RobotPhysicalProfile,
  sources: readonly ProseSource[],
): CalibrationCheck {
  const findings: CalibrationFinding[] = [];
  const matchCounts: Record<string, number> = Object.fromEntries(RULES.map((r) => [r.id, 0]));

  for (const rule of RULES) {
    for (const source of sources) {
      if (!rule.appliesTo(source)) continue;
      for (const pattern of rule.patterns) {
        // Fresh regex per source: a /g regex carries lastIndex between calls.
        const scan = new RegExp(pattern.source, pattern.flags);
        let match: RegExpExecArray | null;
        while ((match = scan.exec(source.text)) !== null) {
          const isMultiple = match.length > 2 && match[2] !== undefined;
          const cycles = isMultiple ? Number(match[1]) : 1;
          const proseValue = Number(isMultiple ? match[2] : match[1]);
          if (!Number.isFinite(proseValue)) continue;
          matchCounts[rule.id] += 1;

          const profileValue = rule.expected(profile, cycles);
          const agrees =
            rule.comparison === 'equal'
              ? Math.abs(proseValue - profileValue) < NEARLY_EQUAL
              : proseValue < profileValue;
          if (agrees) continue;

          const prose = formatValue(proseValue, rule.unit);
          const onProfile = formatValue(profileValue, rule.unit);
          const message =
            rule.comparison === 'equal'
              ? isMultiple
                ? `${source.id} states ${rule.figure}: ${cycles} cycles as ${prose} ("${match[0]}"), but the robot profile makes ${cycles} cycles ${onProfile}.`
                : `${source.id} states ${rule.figure} as ${prose} ("${match[0]}"), but the robot profile says ${onProfile}.`
              : `${source.id} states ${rule.figure} as ${prose} ("${match[0]}"), which is not strictly inside the robot profile's ${onProfile}.`;

          findings.push({
            figure: rule.figure,
            source: source.id,
            quote: match[0],
            proseValue,
            profileValue,
            message,
          });
        }
      }
    }
  }

  return { findings, matchCounts };
}

/** {@link checkCalibrationProseDetailed} without the coverage counts. */
export function checkCalibrationProse(
  profile: RobotPhysicalProfile,
  sources: readonly ProseSource[],
): CalibrationFinding[] {
  return checkCalibrationProseDetailed(profile, sources).findings;
}

// --- Collecting the prose the model actually reads ------------------------

/**
 * The `steps` parameter text is set with zod's `.describe()`, which is where the model reads it
 * from — so that is where this reads it from too, rather than re-declaring the string here.
 */
function stepsDescriptionFrom(zodSchema: ZodTypeAny, toolName: string): string {
  const shape = (zodSchema as unknown as { shape?: Record<string, { description?: string }> }).shape;
  const description = shape?.steps?.description;
  if (!description) {
    throw new Error(
      `RC-49 calibration guard: ${toolName}'s zod schema states no \`steps\` description. ` +
        'If the calibration text moved, move this collector with it — do not leave the guard reading nothing.',
    );
  }
  return description;
}

/**
 * Every place the robot's calibration is stated to the model, gathered from disk and from the
 * preset module.
 *
 * `system-prompt.md` is read from the repo root (vitest runs with the repo root as cwd, the same
 * way `server/index.ts` loads it and `vite.config.ts` bakes it into the client bundle), NOT from a
 * copy in this suite: a fixture copy would drift from the real file exactly like the prose it is
 * meant to police.
 */
export function collectCalibrationProse(presetId?: string): ProseSource[] {
  const promptPath = `${process.cwd().replace(/\\/g, '/').replace(/\/$/, '')}/system-prompt.md`;
  const sources: ProseSource[] = [
    { id: 'system-prompt.md', kind: 'prompt', text: readFileSync(promptPath, 'utf-8') },
  ];

  const preset = getRobotPreset(presetId);
  const motionTools = preset.tools.filter((tool) => tool.clientEndpoint !== undefined);
  if (motionTools.length === 0) {
    throw new Error('RC-49 calibration guard: the preset declares no motion tools to check.');
  }

  const seenStepsText = new Set<string>();
  for (const tool of motionTools) {
    sources.push({ id: `${tool.name} description`, kind: 'tool', tool: tool.name, text: tool.description });
    if (tool.clientDescription) {
      sources.push({
        id: `${tool.name} clientDescription`,
        kind: 'tool',
        tool: tool.name,
        text: tool.clientDescription,
      });
    }
    // The `steps` text is shared across the four motion tools (one server string, one client
    // string), so it is de-duplicated — otherwise one stale figure would report four times.
    const serverSteps = stepsDescriptionFrom(tool.zodSchema, tool.name);
    if (!seenStepsText.has(serverSteps)) {
      seenStepsText.add(serverSteps);
      sources.push({ id: '`steps` description (server, zod)', kind: 'steps', text: serverSteps });
    }
    const clientSteps = (
      tool.jsonSchema as
        | { properties?: { steps?: { description?: string } } }
        | undefined
    )?.properties?.steps?.description;
    if (clientSteps && !seenStepsText.has(clientSteps)) {
      seenStepsText.add(clientSteps);
      sources.push({ id: '`steps` description (client, JSON Schema)', kind: 'steps', text: clientSteps });
    }
  }

  return sources;
}
