/**
 * Rendering resolution: one buffer pixel per design pixel.
 *
 * The game renders its 450×900 design into a 450×900 buffer and lets the browser scale the canvas to
 * fit the screen, which is what gives the board its slightly soft look — vector lines and baked art are
 * upsampled by the browser afterwards rather than rasterised at the device's density.
 *
 * This is deliberate. A previous device-resolution pass (buffer = design × devicePixelRatio, camera
 * zoomed to match, `designResolution` split) made every line razor-sharp, and the result was judged too
 * harsh on the eyes — see the 1.2.2→1.2.3 revert. Bakes keep their fixed headroom: textures are
 * rasterised at 2× design size, so they survive the CSS upscale without looking worse than the board.
 */

import type Phaser from 'phaser';

import { DESIGN_HEIGHT, DESIGN_WIDTH } from './palette';

/** Buffer pixels per design pixel. Fixed at 1: the buffer is exactly the design. */
export const RENDER_SCALE = 1;

/** Samples per design pixel for everything the game bakes — textures and text glyphs. */
export const BAKE_SCALE = 2;

/**
 * Puts a scene's camera on the design box.
 *
 * At zoom 1 the camera shows `gameSize ÷ 1` world units; centring it on the design box's own centre
 * puts the visible rectangle exactly on `0,0 … DESIGN_WIDTH,DESIGN_HEIGHT`. Kept as a function so a
 * future device-resolution pass has a single place to switch back on.
 */
export function applyRenderScale(scene: Phaser.Scene): void {
  const camera = scene.cameras.main;
  camera.setZoom(RENDER_SCALE);
  camera.centerOn(DESIGN_WIDTH / 2, DESIGN_HEIGHT / 2);
}
