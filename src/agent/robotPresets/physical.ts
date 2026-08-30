// The physical characteristics of a robot — RC-51.
//
// A preset is where a robot's calibration lives, so it is where its BODY, its
// MOTION and its SENSOR belong too: one description, read by the emulator that
// simulates the robot and (RC-49) by the prompt that tells the model what its
// commands do. A second copy of these numbers anywhere is a divergence waiting
// to happen, and divergence between the simulated world and the real one is
// exactly what this area keeps producing.
//
// EVERY LENGTH HERE IS IN CENTIMETRES AND EVERY ANGLE IS IN DEGREES, and every
// field name says so. Nothing here is measured in tiles: a tile is a
// map-authoring convenience that belongs to the map, and the tile size is the
// only place the two units are allowed to meet. That is what makes a second
// robot cheap — how many tiles a body covers is DERIVED (a 10 cm body on a 5 cm
// grid covers 2x2 tiles because the arithmetic says so), never configured.
//
// Leaf module by design: no imports at all, so this is safe to pull into the
// browser bundle, into the node server and into `robot-emulator/` alike.

/** The chassis as seen top-down. `length` runs along the heading, `width` across it. */
export interface RobotBodyProfile {
  widthCm: number;
  lengthCm: number;
}

/** What one command cycle of each motion actually does to the hardware. */
export interface RobotMotionProfile {
  /** Distance one `/forward` cycle covers. */
  forwardPerCycleCm: number;
  /**
   * Distance one `/backward` cycle covers. Deliberately NOT equal to the
   * forward figure: the gait is not symmetric, and a control loop that only
   * ever practises against a symmetric one learns dead reckoning it will not
   * have on the real robot.
   */
  backwardPerCycleCm: number;
  /** Rotation one `/turn_left` or `/turn_right` cycle covers. */
  turnDegreesPerCycle: number;
  /**
   * Fractional variation applied to EVERY motion, uniform in
   * `[-jitterFraction, +jitterFraction]`. 0.015 is 1.5%.
   *
   * This is the setting most easily mistaken for decoration. Real motions do
   * not repeat, and an agent that only ever practises against exact ones learns
   * to trust odometry it does not have. Set it to 0 to get exact motion back
   * (which is what the reproducibility tests do); never set it to 0 to make a
   * behaviour easier to assert.
   */
  jitterFraction: number;
}

/** The forward-facing ultrasonic, described the way the real part is described. */
export interface RobotSensorProfile {
  /**
   * The closest the sensor can report. On the QD021 this is the copper-wire
   * bumper standing proud of the HC-SR04: nothing can get nearer than the
   * bumper, so nothing nearer can be measured.
   */
  minRangeCm: number;
  /** The furthest the sensor can report. Beyond this it reports the cap, not a distance. */
  maxRangeCm: number;
  /**
   * The full width of the ultrasonic's beam cone.
   *
   * Carried as data even though the emulator's first implementation casts a
   * single ray, because this is the characteristic the system prompt's aiming
   * advice is built on — it is why slim objects (under about 4 cm) are missed
   * entirely, and why "sweep a step at a time and take the smallest reading"
   * is the right way to aim. A cone-aware cast is a later refinement that
   * should read this number rather than introduce its own.
   */
  beamAngleDegrees: number;
}

export interface RobotPhysicalProfile {
  body: RobotBodyProfile;
  motion: RobotMotionProfile;
  sensor: RobotSensorProfile;
}

/** A preset may state any subset of the profile; whatever it omits takes the default. */
export interface RobotPhysicalProfileOverrides {
  body?: Partial<RobotBodyProfile>;
  motion?: Partial<RobotMotionProfile>;
  sensor?: Partial<RobotSensorProfile>;
}

/**
 * The defaults, which are the measured ACEBOTT QD021.
 *
 * THESE ARE MEASUREMENTS OF PHYSICAL HARDWARE, not tuning knobs. The tool
 * descriptions the model reads have said "1 forward/backward cycle ~ 1.5 cm;
 * 6 turn cycles ~ 90 degrees (~15 degrees per turn cycle)" since long before
 * the emulator existed, and `system-prompt.md` describes the 3 cm bumper and
 * the beam cone. The numbers are the hardware's and the emulator adopts them.
 * Never adjust one to make the simulation tidier — the whole point of the
 * simulated world is that practice against it transfers.
 */
export const DEFAULT_ROBOT_PHYSICAL_PROFILE: RobotPhysicalProfile = Object.freeze({
  // The measured chassis, seen top-down. Square, so a turn does not change how
  // much room it needs along either axis — but its DIAGONAL (14.1 cm) does not
  // fit through a 10 cm gap, which is why map openings are sized against the
  // diagonal rather than against the width.
  body: Object.freeze({ widthCm: 10, lengthCm: 10 }),
  motion: Object.freeze({
    forwardPerCycleCm: 1.5,
    backwardPerCycleCm: 1.3,
    turnDegreesPerCycle: 15,
    jitterFraction: 0.015,
  }),
  sensor: Object.freeze({
    // The bumper. `system-prompt.md` tells the model 3-3.5 cm is the closest
    // possible reading for a large object, so a floor of anything less is a
    // value the real robot physically cannot return.
    minRangeCm: 3,
    // The HC-SR04's rated reach. It is far beyond the 50 cm band the prompt
    // tells the model to trust, and that is deliberate: the prompt's advice
    // ("over 50 cm means you are aimed at open space, re-aim") is about
    // INTERPRETATION, and it only means anything if the sensor can actually
    // return such a reading. Clamping the hardware down to the trusted band
    // would delete the very reading the aiming procedure is written for.
    maxRangeCm: 400,
    // The HC-SR04's rated measuring angle.
    beamAngleDegrees: 15,
  }),
}) as RobotPhysicalProfile;

/** Fill every unset field of `overrides` from {@link DEFAULT_ROBOT_PHYSICAL_PROFILE}. */
export function resolvePhysicalProfile(
  overrides?: RobotPhysicalProfileOverrides
): RobotPhysicalProfile {
  const defaults = DEFAULT_ROBOT_PHYSICAL_PROFILE;
  return {
    body: { ...defaults.body, ...overrides?.body },
    motion: { ...defaults.motion, ...overrides?.motion },
    sensor: { ...defaults.sensor, ...overrides?.sensor },
  };
}
