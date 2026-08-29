import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import jpegJs from 'jpeg-js'
import { PNG } from 'pngjs'
import {
  DEGREES_PER_TURN_STEP,
  FOOTPRINT_CELLS,
  HEADINGS,
  cellAt,
  type CellKind,
  type Heading,
  type RobotWorldState,
  type World,
} from './world.js'

/**
 * Renders the grid world to a JPEG, as seen by an external camera looking straight down.
 *
 * ONE VIEWPOINT SHIPS, AND IT IS NOT THE ONE THE HARDWARE HAS. This is a 3rd-person overhead
 * view. The real robot carries a forward-facing onboard camera and sees a low, oblique, partial
 * slice of the same scene. The two are not interchangeable, so a prompt tuned against this
 * emulator does NOT transfer unchanged to hardware: an agent taught to read a whole map at a
 * glance has learned something the robot's own camera will never give it. That is an accepted
 * cost of phase one — an overhead view makes the world legible while the world model itself is
 * being got right — and it was a choice, not an oversight. A 1st-person onboard view is a
 * deliberate future option; there is no viewpoint switch here on purpose, because a half-built
 * one would invite exactly the assumption above to be made silently.
 *
 * THE ROBOT IS A PHOTOGRAPH, NOT A MARKER, AND THAT IS THE WHOLE POINT OF IT. The terrain is
 * still hand-drawn flat colour, but the robot is the real overhead photograph of the chassis,
 * composited over the terrain with alpha. A vision model asked to find itself in the frame does
 * not recognise a flat black square as a robot — it reports no wires, no blue LED, none of the
 * features it has learned a robot has — and every navigation prompt a student writes begins with
 * exactly that question. Do not replace it with a shape, and do not paint anything on top of it:
 * an overlay across the body destroys the recognisability it is here to buy.
 *
 * Drawing stays pure JS — flat rectangles plus one alpha blit, decoded by `pngjs` and encoded by
 * `jpeg-js`, with no Canvas2D, no native binaries and no postinstall build step.
 */

/** Pixels per world cell. Large enough that the photographed chassis is legible when scaled. */
export const CELL_PX = 32

/** The robot's drawn size: its 2×2-cell footprint, in pixels. */
export const SPRITE_PX = CELL_PX * FOOTPRINT_CELLS

/**
 * The terrain palette. The robot is not in here any more — it is a photograph, not a colour.
 *
 * `soft` is the one colour the world's vocabulary did not dictate. It is a mid grey, chosen to
 * be plainly distinct from both the white floor and the purple hard obstacle, because the
 * difference the agent has to see is "I can enter this but it will cost me" versus "I cannot
 * enter this at all".
 */
export const PALETTE: Readonly<Record<CellKind | 'grid', RgbaColour>> = {
  floor: [255, 255, 255, 255],
  hard: [128, 0, 192, 255],
  soft: [128, 128, 128, 255],
  abyss: [255, 216, 0, 255],
  targetRed: [220, 32, 32, 255],
  targetGreen: [32, 176, 64, 255],
  grid: [200, 200, 200, 255],
}

export type RgbaColour = readonly [number, number, number, number]

export interface Raster {
  width: number
  height: number
  data: Uint8Array
}

function createRaster(width: number, height: number): Raster {
  return { width, height, data: new Uint8Array(width * height * 4) }
}

function setPixel(raster: Raster, x: number, y: number, colour: RgbaColour): void {
  if (x < 0 || y < 0 || x >= raster.width || y >= raster.height) return
  const offset = (y * raster.width + x) * 4
  raster.data[offset] = colour[0]
  raster.data[offset + 1] = colour[1]
  raster.data[offset + 2] = colour[2]
  raster.data[offset + 3] = colour[3]
}

function fillRect(
  raster: Raster,
  left: number,
  top: number,
  width: number,
  height: number,
  colour: RgbaColour,
): void {
  for (let y = top; y < top + height; y++) {
    for (let x = left; x < left + width; x++) setPixel(raster, x, y, colour)
  }
}

/**
 * How many samples per axis each destination pixel averages when the photograph is scaled down.
 *
 * The source is 320 px across and the sprite is 64, a 5:1 reduction, so a single nearest-
 * neighbour sample per pixel throws away 24 of every 25 source pixels and turns the ribbon wires
 * into speckle. Nine samples is enough to keep them reading as wires, and this runs eight times
 * at startup and never again.
 */
const SUPERSAMPLE = 3

/**
 * Scale the photograph down to `sizePx` and rotate it `degrees` clockwise, in one pass.
 *
 * Destination pixels are mapped BACK into the source, so every output pixel is covered exactly
 * once and no gaps open up at 45°. Colour is averaged weighted by alpha: the transparent region
 * around the chassis is transparent *black*, and averaging it in unweighted would ring the robot
 * with a dark halo that looks like the marker this node exists to delete.
 *
 * A 45° rotation cannot keep the corners of a square, and does not need to: the photograph's own
 * corners are fully transparent.
 */
function rotatedSprite(source: Raster, sizePx: number, degrees: number): Raster {
  const out = createRaster(sizePx, sizePx)
  const radians = (degrees * Math.PI) / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  const destCentre = sizePx / 2
  const sourceCentreX = source.width / 2
  const sourceCentreY = source.height / 2
  const scale = source.width / sizePx
  const samples = SUPERSAMPLE * SUPERSAMPLE

  for (let destY = 0; destY < sizePx; destY++) {
    for (let destX = 0; destX < sizePx; destX++) {
      let red = 0
      let green = 0
      let blue = 0
      let alphaSum = 0

      for (let subY = 0; subY < SUPERSAMPLE; subY++) {
        for (let subX = 0; subX < SUPERSAMPLE; subX++) {
          const u = (destX + (subX + 0.5) / SUPERSAMPLE - destCentre) * scale
          const v = (destY + (subY + 0.5) / SUPERSAMPLE - destCentre) * scale
          // The inverse of a clockwise screen rotation (y grows downwards) by `degrees`.
          const sourceX = Math.floor(sourceCentreX + u * cos + v * sin)
          const sourceY = Math.floor(sourceCentreY - u * sin + v * cos)
          if (sourceX < 0 || sourceY < 0 || sourceX >= source.width || sourceY >= source.height) {
            continue
          }
          const offset = (sourceY * source.width + sourceX) * 4
          const alpha = source.data[offset + 3]
          red += source.data[offset] * alpha
          green += source.data[offset + 1] * alpha
          blue += source.data[offset + 2] * alpha
          alphaSum += alpha
        }
      }

      const offset = (destY * sizePx + destX) * 4
      out.data[offset] = alphaSum === 0 ? 0 : Math.round(red / alphaSum)
      out.data[offset + 1] = alphaSum === 0 ? 0 : Math.round(green / alphaSum)
      out.data[offset + 2] = alphaSum === 0 ? 0 : Math.round(blue / alphaSum)
      out.data[offset + 3] = Math.round(alphaSum / samples)
    }
  }

  return out
}

/** Composite a sprite over whatever is already in the raster, honouring its alpha channel. */
function blitSprite(raster: Raster, left: number, top: number, sprite: Raster): void {
  for (let y = 0; y < sprite.height; y++) {
    for (let x = 0; x < sprite.width; x++) {
      const source = (y * sprite.width + x) * 4
      const alpha = sprite.data[source + 3]
      if (alpha === 0) continue

      const destX = left + x
      const destY = top + y
      if (destX < 0 || destY < 0 || destX >= raster.width || destY >= raster.height) continue

      const dest = (destY * raster.width + destX) * 4
      for (let channel = 0; channel < 3; channel++) {
        raster.data[dest + channel] = Math.round(
          (sprite.data[source + channel] * alpha + raster.data[dest + channel] * (255 - alpha)) /
            255,
        )
      }
      raster.data[dest + 3] = 255
    }
  }
}

/**
 * The overhead photograph of the real chassis. Provenance: `docs/assets/` in the takahē repo.
 *
 * Resolved by handing `fileURLToPath` the module's own URL as a STRING, rather than by building a
 * `new URL(...)` relative to it. The unit suite runs under jsdom, which replaces the global `URL`
 * with its own class, and a URL object made by that class is not one `fileURLToPath` accepts — it
 * throws "The URL must be of scheme file", which reads like a broken asset path and is not one.
 * The string form takes `fileURLToPath`'s own parsing branch and is unaffected.
 */
const SPRITE_SOURCE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  'assets',
  'robot-top-down.png',
)

/**
 * Decode once and pre-rotate all eight headings at startup, so rendering a frame stays a blit.
 *
 * The photograph is taken with the robot facing UP, so the rotation for a heading is simply its
 * position in the clockwise `HEADINGS` cycle times 45°. That is derived from the cycle rather
 * than written as a second table on purpose: a table would be a duplicate of `HEADINGS`' order
 * and could silently drift out of step with it.
 */
function loadRobotSprites(): Readonly<Record<Heading, Raster>> {
  const png = PNG.sync.read(readFileSync(SPRITE_SOURCE_PATH))
  const source: Raster = { width: png.width, height: png.height, data: new Uint8Array(png.data) }

  const sprites = {} as Record<Heading, Raster>
  for (const [index, heading] of HEADINGS.entries()) {
    sprites[heading] = rotatedSprite(source, SPRITE_PX, index * DEGREES_PER_TURN_STEP)
  }
  return sprites
}

const ROBOT_SPRITES = loadRobotSprites()

/** Draw the world and the robot into a raw RGBA raster. */
export function renderRaster(world: World, state: RobotWorldState): Raster {
  const raster = createRaster(world.width * CELL_PX, world.height * CELL_PX)

  for (let y = 0; y < world.height; y++) {
    for (let x = 0; x < world.width; x++) {
      const kind = cellAt(world, x, y)
      if (kind === null) continue
      fillRect(raster, x * CELL_PX, y * CELL_PX, CELL_PX, CELL_PX, PALETTE[kind])
    }
  }

  // Faint cell separators, so a run of identically-coloured cells is still countable by eye.
  // Drawn before the robot, so the robot's own footprint is not ruled across.
  for (let y = 0; y < world.height; y++) {
    for (let x = 0; x < world.width; x++) {
      for (let i = 0; i < CELL_PX; i++) {
        setPixel(raster, x * CELL_PX + i, y * CELL_PX, PALETTE.grid)
        setPixel(raster, x * CELL_PX, y * CELL_PX + i, PALETTE.grid)
      }
    }
  }

  // The sprite covers the whole 2×2 footprint anchored at the robot's top-left cell. A destroyed
  // robot is drawn where it fell, so the final frame explains the ending.
  blitSprite(raster, state.x * CELL_PX, state.y * CELL_PX, ROBOT_SPRITES[state.heading])

  return raster
}

/**
 * Quality is high on purpose. This image is read by a vision model and asserted on by decoded
 * pixels, and JPEG's chroma smearing at low quality turns a one-cell colour patch into a blend
 * of itself and its neighbours.
 */
export const JPEG_QUALITY = 92

/** Render the world and encode it as image/jpeg bytes. */
export function renderJpeg(world: World, state: RobotWorldState): Buffer {
  const raster = renderRaster(world, state)
  return jpegJs.encode(
    { width: raster.width, height: raster.height, data: raster.data },
    JPEG_QUALITY,
  ).data
}
