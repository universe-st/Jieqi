/**
 * The device-resolution pass: how many buffer pixels one design pixel covers.
 *
 * Phaser sizes its drawing buffer from `gameSize` and only ever scales the canvas in **CSS** pixels, so
 * a game whose design is 450×900 reaches a 2× phone as a 450×900 bitmap stretched over ~780×1560 device
 * pixels: every `Graphics` line and every glyph is upsampled by the browser afterwards, which is what
 * "the board looks slightly soft" actually is.
 *
 * The fix is to give the game a **device-resolution** game size (`design × RENDER_SCALE`) and zoom the
 * camera by the same factor. The buffer is then as dense as the screen, vector art is rasterised at that
 * density, and the design coordinates the whole game is written in do not move an inch. The framework is
 * told about the split through `designResolution`, which keeps the UI laying out in design units, snapping
 * on the buffer's grid, and baking its own glyphs at the right density.
 *
 * What the camera cannot do is invent detail: anything this game *bakes* — a texture, a `Phaser.Text` — is
 * rasterised once, at its authored size, and a zoomed camera can only magnify that afterwards. Those
 * bakers therefore multiply their sizes by {@link BAKE_SCALE}.
 */

import type Phaser from 'phaser';

import { DESIGN_HEIGHT, DESIGN_WIDTH } from './palette';

/**
 * Buffer pixels per design pixel.
 *
 * Capped at 3 because the drawing buffer's *area* grows with the square: at 3× a 450×900 design is a
 * 1350×2700 buffer, which is the native resolution of a dense phone and about the most a mobile GPU
 * should be asked to fill for a board game.
 */
export const RENDER_SCALE = clampDevicePixelRatio();

/**
 * Samples per design pixel for everything the game bakes — textures and text glyphs.
 *
 * Never below 2, so the baked art keeps the headroom it already had on a 1× display (a window larger
 * than the design still has the canvas upscaled to fit).
 */
export const BAKE_SCALE = Math.max(2, Math.ceil(RENDER_SCALE));

/**
 * Puts a scene's camera at the device-resolution zoom, framed on the design box.
 *
 * The game is `RENDER_SCALE` times the design, so the camera has to be *both* zoomed and moved: a camera
 * shows `gameSize ÷ zoom` world units, and its centre in world space is `scroll + gameSize ÷ 2` whatever
 * the zoom is (Phaser's `Camera.preRender`). Centring that on the design box's own centre therefore puts
 * the visible rectangle exactly on `0,0 … DESIGN_WIDTH,DESIGN_HEIGHT` — at `RENDER_SCALE` framebuffer
 * pixels per design pixel. Leaving the scroll at the game area's origin, which is what an unzoomed scene
 * wants, would show the design box's top-left quadrant magnified instead of the whole board.
 *
 * Nothing else in the game has to know this happened: the coordinates every scene draws in are still
 * design coordinates.
 */
export function applyRenderScale(scene: Phaser.Scene): void {
  const camera = scene.cameras.main;
  camera.setZoom(RENDER_SCALE);
  camera.centerOn(DESIGN_WIDTH / 2, DESIGN_HEIGHT / 2);
}

function clampDevicePixelRatio(): number {
  const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio;
  return Number.isFinite(dpr) && dpr > 1 ? Math.min(dpr, 3) : 1;
}
