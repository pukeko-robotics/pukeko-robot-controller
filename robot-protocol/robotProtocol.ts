import type { NextFunction, Request, Response } from 'express'

/**
 * The wire protocol of the agent build of for-agents/Biped_Robot_Web.py, in one place.
 *
 * Two servers in this repository speak it: `robot-stub/` (a protocol-only test fixture that
 * echoes commands back) and `robot-emulator/` (a grid world with a real position, heading and
 * camera). They are deliberately different products, but they must present the *same* surface —
 * the same endpoint names, the same steps cap, the same clamping of a bad `?steps=`, the same
 * CORS headers — because the control loop, the agent and every piece of middleware between them
 * are supposed to be unable to tell any of the three apart.
 *
 * That is why these live here rather than being copied into each server. Two copies drift, and
 * the drift is invisible: an emulator that clamps at a different maximum than the firmware still
 * looks correct in isolation and still passes its own tests, while quietly no longer emulating
 * the thing it claims to.
 */

/** Movement endpoints accept an optional `?steps=N` — default 1, capped at MAX_STEPS. */
export const MAX_STEPS = 10

export const MOVEMENT_ENDPOINTS = ['/forward', '/backward', '/turn_left', '/turn_right'] as const
export type MovementPath = (typeof MOVEMENT_ENDPOINTS)[number]

export const TRICK_ENDPOINTS = [
  '/sprint',
  '/dance',
  '/avoid',
  '/follow',
  '/kick_left',
  '/kick_right',
  '/tilt_left',
  '/tilt_right',
  '/stamp_left',
  '/stamp_right',
  '/ankles_left',
  '/ankles_right',
] as const
export type TrickPath = (typeof TRICK_ENDPOINTS)[number]

/**
 * Read `?steps=` the way the firmware does: anything that is not a positive integer becomes 1,
 * and anything above MAX_STEPS is capped rather than rejected. A caller never gets an error for
 * a bad step count, which matters because the value usually arrives from a language model.
 */
export function clampSteps(raw: unknown): number {
  if (typeof raw !== 'string') return 1
  const n = parseInt(raw, 10)
  if (isNaN(n) || n < 1) return 1
  return Math.min(n, MAX_STEPS)
}

/**
 * CORS so the browser-side motion tool handler can call /distance, /forward, etc. directly.
 * The real robot firmware (Biped_Robot_Web.py) sends the same three headers and answers a
 * preflight with 204.
 */
export function corsMiddleware(req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') {
    res.status(204).end()
    return
  }
  next()
}
