import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import jpegJs from 'jpeg-js'
import { PNG } from 'pngjs'
import type { RobotPhysicalProfile } from '../src/agent/robotPresets/physical.js'
import { tileAt, type CellKind, type RobotWorldState, type World } from './world.js'

/**
 * Renders the world to a JPEG, as seen by an external camera looking straight down.
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
 * UNITS: the terrain is drawn per TILE, because that is how a map is authored, and the robot is
 * drawn from CENTIMETRES, because that is what its pose and its body are measured in. The bridge
 * is `pxPerCm` — one number, computed in one place from the tile's own size. The robot's drawn
 * size is therefore derived from its body and the map's scale; it is never a count of tiles.
 *
 * Drawing stays pure JS — flat rectangles plus one alpha blit, decoded by `pngjs` and encoded by
 * `jpeg-js`, with no Canvas2D, no native binaries and no postinstall build step.
 */

/** Pixels per map TILE. Large enough that the photographed chassis is legible when scaled. */
export const TILE_PX = 32

/**
 * How many pre-rotated copies of the photograph are kept, spread evenly around the circle.
 *
 * The pose is continuous now, so no fixed set of orientations can be exact; the question is only
 * where to stop. 24 is the answer because it is the TURN CYCLE: 360/24 is 15 degrees, so a robot
 * that has only ever been turned lands on an exact sprite every time, and a robot carrying
 * accumulated jitter is drawn at most 7.5 degrees out. That error is a drawing artifact and
 * nothing more — the pose, the collision test and the sensor all use the exact `headingDeg`, so
 * raising this number improves the picture and changes no behaviour.
 *
 * Keeping a frame a single blit is the reason for pre-rotating at all: rotating the photograph
 * per frame would put a supersampled resample in the request path of every `/capture`.
 */
export const SPRITE_ORIENTATIONS = 24

/**
 * The terrain palette. The robot is not in here — it is a photograph, not a colour.
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
 * The source is 320 px across and the drawn body is around 64, a 5:1 reduction, so a single
 * nearest-neighbour sample per pixel throws away 24 of every 25 source pixels and turns the
 * ribbon wires into speckle. Nine samples is enough to keep them reading as wires, and this runs
 * once per orientation at startup and never again.
 */
const SUPERSAMPLE = 3

/**
 * Scale the photograph to `bodyPx` and rotate it `degrees` clockwise onto a `canvasPx` square.
 *
 * The canvas is deliberately LARGER than the body: a rotated rectangle needs its diagonal, and
 * the eight-heading renderer got away with a tight square only because it never had to keep the
 * corners. Destination pixels are mapped BACK into the source, so every output pixel is covered
 * exactly once and no gaps open up at an odd angle. Colour is averaged weighted by alpha: the
 * region around the chassis is transparent *black*, and averaging it in unweighted would ring
 * the robot with a dark halo that looks like the marker the photograph exists to replace.
 */
function rotatedSprite(
  source: Raster,
  bodyPx: { widthPx: number; lengthPx: number },
  canvasPx: number,
  degrees: number,
): Raster {
  const out = createRaster(canvasPx, canvasPx)
  const radians = (degrees * Math.PI) / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  const destCentre = canvasPx / 2
  const sourceCentreX = source.width / 2
  const sourceCentreY = source.height / 2
  // The photograph is taken with the robot facing UP, so its own x axis is the body's WIDTH and
  // its y axis the body's LENGTH. Scaling them separately is what lets a non-square body draw
  // correctly instead of being squashed to a square.
  const scaleAcross = source.width / bodyPx.widthPx
  const scaleAlong = source.height / bodyPx.lengthPx
  const samples = SUPERSAMPLE * SUPERSAMPLE

  for (let destY = 0; destY < canvasPx; destY++) {
    for (let destX = 0; destX < canvasPx; destX++) {
      let red = 0
      let green = 0
      let blue = 0
      let alphaSum = 0

      for (let subY = 0; subY < SUPERSAMPLE; subY++) {
        for (let subX = 0; subX < SUPERSAMPLE; subX++) {
          const u = destX + (subX + 0.5) / SUPERSAMPLE - destCentre
          const v = destY + (subY + 0.5) / SUPERSAMPLE - destCentre
          // The inverse of a clockwise screen rotation (y grows downwards) by `degrees`.
          const across = u * cos + v * sin
          const along = -u * sin + v * cos
          const sourceX = Math.floor(sourceCentreX + across * scaleAcross)
          const sourceY = Math.floor(sourceCentreY + along * scaleAlong)
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

      const offset = (destY * canvasPx + destX) * 4
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

let sourcePhotograph: Raster | null = null
function photograph(): Raster {
  if (sourcePhotograph === null) {
    const png = PNG.sync.read(readFileSync(SPRITE_SOURCE_PATH))
    sourcePhotograph = { width: png.width, height: png.height, data: new Uint8Array(png.data) }
  }
  return sourcePhotograph
}

interface SpriteSet {
  /** The square canvas each orientation is drawn on; big enough to hold the body's diagonal. */
  canvasPx: number
  orientations: readonly Raster[]
}

/**
 * Pre-rotated sprites for one drawn body size, decoded and resampled once and then reused.
 *
 * The cache is keyed on the DRAWN SIZE IN PIXELS rather than on the world or the preset, because
 * that is the only thing the rasters depend on: two maps at the same scale carrying the same
 * robot share one set, and a map at a different tile size correctly builds its own.
 */
const spriteCache = new Map<string, SpriteSet>()

function spritesFor(widthPx: number, lengthPx: number): SpriteSet {
  const key = `${widthPx}x${lengthPx}`
  const cached = spriteCache.get(key)
  if (cached) return cached

  const canvasPx = Math.ceil(Math.hypot(widthPx, lengthPx))
  const source = photograph()
  const orientations: Raster[] = []
  for (let index = 0; index < SPRITE_ORIENTATIONS; index++) {
    orientations.push(
      rotatedSprite(source, { widthPx, lengthPx }, canvasPx, (index * 360) / SPRITE_ORIENTATIONS),
    )
  }
  const set: SpriteSet = { canvasPx, orientations }
  spriteCache.set(key, set)
  return set
}

/** Draw the world and the robot into a raw RGBA raster. */
export function renderRaster(
  world: World,
  profile: RobotPhysicalProfile,
  state: RobotWorldState,
): Raster {
  const raster = createRaster(world.widthTiles * TILE_PX, world.heightTiles * TILE_PX)

  for (let yTiles = 0; yTiles < world.heightTiles; yTiles++) {
    for (let xTiles = 0; xTiles < world.widthTiles; xTiles++) {
      const kind = tileAt(world, xTiles, yTiles)
      if (kind === null) continue
      fillRect(raster, xTiles * TILE_PX, yTiles * TILE_PX, TILE_PX, TILE_PX, PALETTE[kind])
    }
  }

  // Faint tile separators, so a run of identically-coloured tiles is still countable by eye.
  // Drawn before the robot, so the robot's own body is not ruled across.
  for (let yTiles = 0; yTiles < world.heightTiles; yTiles++) {
    for (let xTiles = 0; xTiles < world.widthTiles; xTiles++) {
      for (let i = 0; i < TILE_PX; i++) {
        setPixel(raster, xTiles * TILE_PX + i, yTiles * TILE_PX, PALETTE.grid)
        setPixel(raster, xTiles * TILE_PX, yTiles * TILE_PX + i, PALETTE.grid)
      }
    }
  }

  // THE ROBOT IS DRAWN FROM CENTIMETRES, AT A SUB-TILE POSITION. At 32 px to a 5 cm tile a
  // 1.5 cm cycle is about 9.6 px, which is plainly visible movement; rounding the blit to a tile
  // would erase it and make every short move look like a no-op. Only the final pixel offset is
  // rounded, and the pose itself never is.
  const pxPerCm = TILE_PX / world.tileSizeCm
  const widthPx = Math.max(1, Math.round(profile.body.widthCm * pxPerCm))
  const lengthPx = Math.max(1, Math.round(profile.body.lengthCm * pxPerCm))
  const sprites = spritesFor(widthPx, lengthPx)
  const orientation =
    ((Math.round((state.headingDeg / 360) * SPRITE_ORIENTATIONS) % SPRITE_ORIENTATIONS) +
      SPRITE_ORIENTATIONS) %
    SPRITE_ORIENTATIONS

  // A destroyed robot is drawn where it fell, so the final frame explains the ending.
  blitSprite(
    raster,
    Math.round(state.xCm * pxPerCm - sprites.canvasPx / 2),
    Math.round(state.yCm * pxPerCm - sprites.canvasPx / 2),
    sprites.orientations[orientation],
  )

  return raster
}

/**
 * Quality is high on purpose. This image is read by a vision model and asserted on by decoded
 * pixels, and JPEG's chroma smearing at low quality turns a small colour patch into a blend
 * of itself and its neighbours.
 */
export const JPEG_QUALITY = 92

/** Render the world and encode it as image/jpeg bytes. */
export function renderJpeg(
  world: World,
  profile: RobotPhysicalProfile,
  state: RobotWorldState,
): Buffer {
  const raster = renderRaster(world, profile, state)
  return jpegJs.encode(
    { width: raster.width, height: raster.height, data: raster.data },
    JPEG_QUALITY,
  ).data
}
