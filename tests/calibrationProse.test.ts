import { describe, it, expect } from 'vitest'
import {
  CALIBRATION_RULE_IDS,
  checkCalibrationProse,
  checkCalibrationProseDetailed,
  collectCalibrationProse,
  type ProseSource,
} from './helpers/calibrationProse.js'
import {
  getPhysicalProfile,
  resolvePhysicalProfile,
  type RobotPhysicalProfile,
  type RobotPhysicalProfileOverrides,
} from '../src/agent/robotPresets/index.js'

/**
 * RC-49 — the robot's calibration is stated twice, and this is what stops the two copies drifting.
 *
 * The profile (`physical.ts`) is what the emulator moves by; the prose (`system-prompt.md` and the
 * tool descriptions) is what the model reads and believes. Change one without the other and every
 * test in this repo stays green while the model is being told a lie — which is exactly how the
 * "prompt says 15°, emulator turns 45°" incident happened.
 *
 * The guard itself is `helpers/calibrationProse.ts`; this spec drives it. Note what the shape buys:
 * because the check is a FUNCTION over (profile, prose), it can be run against a deliberately wrong
 * profile, so the tests below do not merely assert the absence of drift — they demonstrate the
 * failure. A pile of `expect(text).toContain('1.5 cm')` calls cannot demonstrate anything.
 *
 * THE PROSE SIDE IS ALWAYS PARSED, NEVER INTERPOLATED. No expected value here is read back out of
 * the module under test; a guard that derived both sides from the profile would nod along with any
 * edit at all, including one that quietly changed what the robot is.
 */

/** The real prose, read from disk and from the preset module — not a fixture copy. */
const SOURCES = collectCalibrationProse()

/** A profile that differs from the shipped one in exactly the stated way. */
function mutated(overrides: RobotPhysicalProfileOverrides): RobotPhysicalProfile {
  return resolvePhysicalProfile(overrides)
}

const messagesOf = (findings: { message: string }[]) => findings.map((f) => f.message)

describe('RC-49 — the prose the model reads against the robot definition', () => {
  it('finds no disagreement between the shipped profile and the shipped prose', () => {
    const findings = checkCalibrationProse(getPhysicalProfile(), SOURCES)
    // The messages go into the failure output, so a drift reports itself rather than saying "1".
    expect(messagesOf(findings)).toEqual([])
  })

  it('is actually armed: every rule matches prose that exists today', () => {
    // The guard treats "the prose does not state this figure" as a non-failure — deliberately, so
    // system-prompt.md is not forced to mention the backward stride. The price of that leniency is
    // that a rewrite could silently disarm a rule, and a rule matching nothing passes forever. This
    // is the check that notices.
    const { matchCounts } = checkCalibrationProseDetailed(getPhysicalProfile(), SOURCES)
    const unarmed = CALIBRATION_RULE_IDS.filter((id) => matchCounts[id] === 0)
    expect(unarmed).toEqual([])
  })

  it('reads the prompt and the tool descriptions, not one of them', () => {
    const ids = SOURCES.map((s) => s.id)
    expect(ids).toContain('system-prompt.md')
    expect(ids).toContain('move_forward description')
    expect(ids).toContain('move_backward description')
    expect(ids).toContain('turn_left description')
    expect(ids).toContain('turn_right description')
    expect(ids.some((id) => id.startsWith('`steps` description'))).toBe(true)
  })

  describe('a figure changed on the robot without the prose following it', () => {
    it('catches the turn angle, and every multiple derived from it', () => {
      const findings = checkCalibrationProse(mutated({ motion: { turnDegreesPerCycle: 20 } }), SOURCES)
      const messages = messagesOf(findings)

      // The single-cycle figure, named with BOTH values so nobody has to go hunting for either.
      expect(
        messages.some((m) => m.includes('turn angle per cycle') && m.includes('15°') && m.includes('20°')),
      ).toBe(true)
      expect(messages.some((m) => m.includes('system-prompt.md') && m.includes('1 turn ≈ 15°'))).toBe(true)

      // And the derived multiples, which is where a stale figure hides best: someone updating "15°"
      // by search-and-replace leaves "6 ≈ 90°" and "steps=3 (~45°)" quietly false.
      expect(messages.some((m) => m.includes('6 ≈ 90°') && m.includes('120°'))).toBe(true)
      expect(messages.some((m) => m.includes('3 ≈ 45°') && m.includes('60°'))).toBe(true)
      expect(messages.some((m) => m.includes('steps=3 (~45°)'))).toBe(true)
      expect(messages.some((m) => m.includes('6 turn cycles ≈ 90°'))).toBe(true)

      // The prompt's sweep and calibration procedures restate ~15° too.
      expect(messages.some((m) => m.includes('a step (~15°)'))).toBe(true)
      expect(messages.some((m) => m.includes('Turn 1 step (~15°)'))).toBe(true)
    })

    it('catches the forward distance', () => {
      const findings = checkCalibrationProse(mutated({ motion: { forwardPerCycleCm: 2 } }), SOURCES)
      const messages = messagesOf(findings)
      expect(
        messages.some(
          (m) => m.includes('forward distance per cycle') && m.includes('1.5 cm') && m.includes('2 cm'),
        ),
      ).toBe(true)
      expect(messages.some((m) => m.includes('system-prompt.md') && m.includes('1 forward ≈ 1.5 cm'))).toBe(
        true,
      )
      expect(messages.some((m) => m.includes('move_forward description'))).toBe(true)
      // And it does not blame move_backward's own (correct, different) figure for it.
      expect(messages.some((m) => m.includes('move_backward'))).toBe(false)
    })

    it('catches the backward distance, separately from the forward one', () => {
      const findings = checkCalibrationProse(mutated({ motion: { backwardPerCycleCm: 1 } }), SOURCES)
      const messages = messagesOf(findings)
      expect(
        messages.some(
          (m) => m.includes('backward distance per cycle') && m.includes('1.3 cm') && m.includes('1 cm'),
        ),
      ).toBe(true)
      expect(messages.some((m) => m.includes('move_backward description'))).toBe(true)
      expect(messages.some((m) => m.includes('move_forward description'))).toBe(false)
    })

    it("catches the sensor's minimum range wherever the prompt states it", () => {
      const findings = checkCalibrationProse(mutated({ sensor: { minRangeCm: 5 } }), SOURCES)
      const messages = messagesOf(findings)
      expect(
        messages.some((m) => m.includes("sensor's minimum range") && m.includes('3 cm') && m.includes('5 cm')),
      ).toBe(true)
      // All three phrasings: the bumper sentence, the "touching the nose" floor, the trust band's
      // lower edge and the closest-possible reading.
      expect(messages.some((m) => m.includes('3 cm bumper'))).toBe(true)
      expect(messages.some((m) => m.includes('**< 3 cm:**'))).toBe(true)
      expect(messages.some((m) => m.includes('3–50 cm'))).toBe(true)
      expect(messages.some((m) => m.includes('3–3.5 cm'))).toBe(true)
    })

    it("catches a maximum range clamped below the band the prompt tells the model to re-aim on", () => {
      // Trap: 50 is NOT the sensor's maximum, and asserting equality would be wrong — 3–50 cm is a
      // TRUST BAND, advice about interpreting a reading, while the sensor reaches 400 cm. What must
      // hold is the relationship. Clamp the hardware to 40 cm and the prompt's whole aiming
      // procedure ("over 50 cm means you are pointed at open space — re-aim") becomes unreachable
      // nonsense: the sensor could never return the reading it is written for.
      const findings = checkCalibrationProse(mutated({ sensor: { maxRangeCm: 40 } }), SOURCES)
      const messages = messagesOf(findings)
      expect(
        messages.some(
          (m) => m.includes("trust-band upper bound") && m.includes('50 cm') && m.includes('40 cm'),
        ),
      ).toBe(true)
    })

    it('leaves the real maximum range alone, precisely because the band sits far inside it', () => {
      // The counterpart to the test above, and the reason this rule is an inequality: 400 cm is
      // eight times the trust band and that is correct, not a drift.
      const findings = checkCalibrationProse(getPhysicalProfile(), SOURCES)
      expect(findings.filter((f) => f.figure.includes('trust-band'))).toEqual([])
      expect(getPhysicalProfile().sensor.maxRangeCm).toBe(400)
    })
  })

  describe('editing the prompt', () => {
    /** The real prompt, with prose rewritten and nothing calibrational touched. */
    function withRewrittenProse(rewrite: (text: string) => string): ProseSource[] {
      return SOURCES.map((source) =>
        source.kind === 'prompt' ? { ...source, text: rewrite(source.text) } : source,
      )
    }

    it('does not complain about rewriting prose that states no calibration figure', () => {
      // A guard that makes the prompt awkward to edit gets deleted by the first person it annoys,
      // and then it protects nothing. The prompt is a teaching artefact people tune by hand — this
      // is why RC-49 rejected templating it from the profile.
      const edited = withRewrittenProse((text) =>
        text
          .replace('Be methodical.', 'Work in small, deliberate increments.')
          .replace('Small black biped, anywhere in frame.', 'A small black biped, anywhere in the frame.')
          .concat(
            '\n\nThe chassis stands about 20 cm tall and weighs roughly 400 g. Pause 2 s between commands ' +
              'when the scene is busy, and narrate what changed in one short sentence.\n',
          ),
      )
      expect(messagesOf(checkCalibrationProse(getPhysicalProfile(), edited))).toEqual([])
    })

    it('does not complain when a figure is dropped from the prompt entirely', () => {
      // A figure the prose does not state is not a failure — system-prompt.md says nothing about
      // the backward stride and is not forced to. (What a dropped figure DOES cost is coverage,
      // which is what the "is actually armed" test above is for.)
      const stripped = withRewrittenProse((text) => text.replace('Robot has a 3 cm bumper, ', 'The robot '))
      expect(messagesOf(checkCalibrationProse(getPhysicalProfile(), stripped))).toEqual([])
    })

    it('does complain when a calibration figure is edited to disagree with the robot', () => {
      // The other direction of the same guard: the prose is the copy that usually goes stale, and a
      // hand edit to it is caught the same way a profile change is.
      const staleProse = withRewrittenProse((text) => text.replace('1 turn ≈ 15°', '1 turn ≈ 45°'))
      const findings = checkCalibrationProse(getPhysicalProfile(), staleProse)
      expect(
        messagesOf(findings).some(
          (m) => m.includes('turn angle per cycle') && m.includes('45°') && m.includes('15°'),
        ),
      ).toBe(true)
    })
  })

  it('names the figure, the source, the quote and both values in every finding', () => {
    // A guard that only says "the prompt is stale" sends the next person hunting.
    const findings = checkCalibrationProse(mutated({ motion: { turnDegreesPerCycle: 20 } }), SOURCES)
    expect(findings.length).toBeGreaterThan(0)
    for (const finding of findings) {
      expect(finding.figure).toBeTruthy()
      expect(finding.source).toBeTruthy()
      expect(finding.quote).toBeTruthy()
      expect(finding.message).toContain(finding.source)
      expect(finding.message).toContain(finding.quote)
      expect(finding.message).toContain(String(finding.proseValue))
      expect(finding.message).toContain(String(finding.profileValue))
    }
  })
})
