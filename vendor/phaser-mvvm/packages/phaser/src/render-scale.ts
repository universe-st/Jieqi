/**
 * How many **device** pixels one layout unit covers — the number that decides whether baked text is
 * sharp enough to survive the trip to the screen.
 *
 * Phaser never sizes its drawing buffer by `devicePixelRatio`: the `ScaleManager` keeps
 * `canvas.width === gameSize.width` and, under `FIT`/`RESIZE`, scales the canvas in **CSS** pixels.
 * A 450×900 design therefore reaches a 2× display as a 450×900 bitmap stretched over 900×1800 device
 * pixels, and the browser upsamples everything in it. Vector shapes survive that (they are rasterised
 * after the camera transform, at whatever the buffer offers), but a `Phaser.GameObjects.Text` is
 * *baked into a canvas texture* at the font size in layout units, so its sharpness is decided once, at
 * creation — the upsampling can only blur what is already there.
 *
 * Baking that texture at this ratio instead costs memory and buys sharp glyphs: `Text.style.resolution`
 * keeps the object's display size in layout units (both renderers divide the frame by
 * `source.resolution`), so layout and measurement are untouched.
 *
 * The value is **measured, not configured**: `devicePixelRatio × (canvas CSS width ÷ game size width)`.
 * `MVVMPluginConfig.textResolution` overrides the result for text (see `MVVMPlugin#textResolution`).
 *
 * This module is deliberately Phaser-free at runtime (`import type` only) so the arithmetic and the
 * quantisation rule can be unit-tested in Node like the rest of this package's pure logic.
 */

import type Phaser from 'phaser';

/**
 * The auto-detected ratio is quantised to this step.
 *
 * A 1.504 ratio does not need a 1.504× texture: 1.5× covers the device grid, and the step keeps a
 * resize-driven ratio jitter from re-baking every glyph at a value nothing can see.
 */
const TEXT_RESOLUTION_STEP = 0.5;

/**
 * Upper bound for the **auto-detected** ratio. Above 2 the win is hard to see and the cost is not:
 * texture area grows with the square, so a 3× phone would spend 9× the glyph memory.
 *
 * An explicit `textResolution` bypasses the cap — an app that measured its own budget knows better.
 */
const MAX_AUTO_TEXT_RESOLUTION = 2;

interface ScaleLike {
  gameSize?: { width?: number; height?: number };
  displaySize?: { width?: number; height?: number };
  on?: (event: string, handler: () => void) => unknown;
}

interface SceneLike {
  game?: { canvas?: { getBoundingClientRect?: () => { width: number } } | null };
  scale?: ScaleLike;
}

/** Measured ratio per `ScaleManager`, dropped whenever that manager reports a resize. */
const cache = new WeakMap<object, { epoch: number; layoutWidth: number; value: number }>();
const observed = new WeakSet<object>();
let epoch = 0;

/**
 * Device pixels per **layout unit** for this scene, or `1` when nothing can be measured.
 *
 * `layoutWidth` is the width of the space the widgets are laid out in — the root's own size, which
 * differs from the game size exactly when the page renders at device resolution
 * (`UIRootOptions.designResolution`). Omitted, the game size is used, which is right for an ordinary
 * unmagnified game.
 *
 * Cached per `ScaleManager` and invalidated on `resize`, because the answer moves with the fit zoom (a
 * window that gets narrower makes every layout unit smaller on screen) and because the measurement
 * reads the canvas rectangle, which is a DOM query the widget-building path should not repeat per
 * label.
 */
export function detectRenderScale(scene: Phaser.Scene | undefined, layoutWidth?: number): number {
  const scale = (scene as SceneLike | undefined)?.scale;
  if (!scale || typeof scale !== 'object') {
    return 1;
  }
  const width = positive(layoutWidth) ?? positive(scale.gameSize?.width) ?? 1;
  watch(scale);
  const hit = cache.get(scale);
  if (hit && hit.epoch === epoch && hit.layoutWidth === width) {
    return hit.value;
  }
  const value = measure(scene as SceneLike, scale, width);
  cache.set(scale, { epoch, layoutWidth: width, value });
  return value;
}

/**
 * Rounds an auto-detected ratio to something worth baking at: ≥ 1, on a ½ step, at most 2.
 *
 * `1.504 → 1.5`, `2 → 2`, `2.625 → 2` (capped), `1.2 → 1` (the extra 20 % of texture area buys an
 * edge nothing can resolve).
 */
export function quantizeTextResolution(scale: number): number {
  if (!Number.isFinite(scale) || scale <= 1) {
    return 1;
  }
  const stepped = Math.round(scale / TEXT_RESOLUTION_STEP) * TEXT_RESOLUTION_STEP;
  return Math.min(MAX_AUTO_TEXT_RESOLUTION, Math.max(1, stepped));
}

function watch(scale: ScaleLike): void {
  if (observed.has(scale) || typeof scale.on !== 'function') {
    return;
  }
  observed.add(scale);
  // The handler closes over nothing: the `ScaleManager` may outlive the scene that first asked, and a
  // listener holding a scene would keep it alive for the rest of the game's life.
  scale.on('resize', () => {
    epoch++;
  });
}

function measure(scene: SceneLike, scale: ScaleLike, layoutWidth: number): number {
  const ratio = displayWidth(scene, scale) / layoutWidth;
  const value = devicePixelRatio() * ratio;
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function positive(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/** The canvas' width in CSS pixels: its rectangle if the DOM is reachable, else Phaser's own figure. */
function displayWidth(scene: SceneLike, scale: ScaleLike): number {
  const rect = scene.game?.canvas?.getBoundingClientRect?.();
  if (rect && rect.width > 0) {
    return rect.width;
  }
  const displayWidth = scale.displaySize?.width ?? 0;
  return displayWidth > 0 ? displayWidth : (scale.gameSize?.width ?? 1);
}

function devicePixelRatio(): number {
  const dpr = (globalThis as { devicePixelRatio?: number }).devicePixelRatio;
  return typeof dpr === 'number' && Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
}
