import jpegJs from 'jpeg-js'
import { cellAt, type CellKind, type RobotWorldState, type World } from './world.js'

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
 * Drawing is done by hand into a raw RGBA buffer and handed to a pure-JS JPEG encoder. Flat
 * rectangles and one triangle need no Canvas2D implementation, and staying pure JS keeps this
 * repository free of native binaries and postinstall build steps.
 */

/** Pixels per world cell. Large enough that the heading triangle is unambiguous when scaled. */
export const CELL_PX = 32

/**
 * The palette. `robot` is the robot's own marker; the rest are the terrain colours.
 *
 * `soft` is the one colour the world's vocabulary did not dictate. It is a mid grey, chosen to
 * be plainly distinct from both the white floor and the purple hard obstacle, because the
 * difference the agent has to see is "I can enter this but it will cost me" versus "I cannot
 * enter this at all".
 */
export const PALETTE: Readonly<Record<CellKind | 'robot' | 'heading' | 'grid', RgbaColour>> = {
  floor: [255, 255, 255, 255],
  hard: [128, 0, 192, 255],
  soft: [128, 128, 128, 255],
  abyss: [255, 216, 0, 255],
  targetRed: [220, 32, 32, 255],
  targetGreen: [32, 176, 64, 255],
  robot: [0, 0, 0, 255],
  /** The heading triangle, drawn on top of the black robot marker so it reads at a glance. */
  heading: [255, 255, 255, 255],
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
 * The robot's heading marker: a triangle whose apex sits at the leading edge of its cell.
 *
 * A dot with a stripe, or a marker that only differs by rotation symmetry, leaves "which way is
 * it facing?" ambiguous at small scales — and that question is the one the agent most needs the
 * picture to answer.
 */
function fillHeadingTriangle(
  raster: Raster,
  cellLeft: number,
  cellTop: number,
  heading: RobotWorldState['heading'],
  colour: RgbaColour,
): void {
  const size = CELL_PX
  const centre = size / 2
  const inset = Math.round(size * 0.125)
  /** How far back from the leading edge the triangle reaches: the front half of the cell. */
  const axisLength = Math.round(size * 0.4)
  const baseHalfWidth = Math.round(size * 0.28)

  // `row` runs from the apex, which sits at the leading edge, back towards the base. Keeping
  // the whole triangle in the front half of the cell is what makes the heading legible at a
  // glance — and it is why "which half of the cell is bright" is a sound thing to assert on.
  for (let row = 0; row < axisLength; row++) {
    const halfWidth = Math.round((row / (axisLength - 1)) * baseHalfWidth)
    for (let offset = -halfWidth; offset <= halfWidth; offset++) {
      let x: number
      let y: number
      switch (heading) {
        case 'north':
          x = cellLeft + centre + offset
          y = cellTop + inset + row
          break
        case 'south':
          x = cellLeft + centre + offset
          y = cellTop + size - inset - row
          break
        case 'east':
          x = cellLeft + size - inset - row
          y = cellTop + centre + offset
          break
        case 'west':
          x = cellLeft + inset + row
          y = cellTop + centre + offset
          break
      }
      setPixel(raster, Math.round(x), Math.round(y), colour)
    }
  }
}

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
  for (let y = 0; y < world.height; y++) {
    for (let x = 0; x < world.width; x++) {
      for (let i = 0; i < CELL_PX; i++) {
        setPixel(raster, x * CELL_PX + i, y * CELL_PX, PALETTE.grid)
        setPixel(raster, x * CELL_PX, y * CELL_PX + i, PALETTE.grid)
      }
    }
  }

  const left = state.x * CELL_PX
  const top = state.y * CELL_PX
  // A destroyed robot is drawn on the cell it fell into, so the final frame explains the ending.
  fillRect(raster, left + 2, top + 2, CELL_PX - 4, CELL_PX - 4, PALETTE.robot)
  fillHeadingTriangle(raster, left, top, state.heading, PALETTE.heading)

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
