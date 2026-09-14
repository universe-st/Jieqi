/**
 * `UIRoot` — the layout root of a UI page.
 *
 * It owns the `LayoutEngine`, is sized to the layout space — the game size, or the authored design
 * resolution when the game renders at device resolution (`UIRootOptions.designResolution`) — keeps that
 * size up to date on `scale` resize, and drives one layout pass on demand. Everything else in the UI hangs below it; widgets find the
 * engine through the tree, so a single root per UI scene is all that is needed.
 *
 * Default container is a `stack` with `align: 'center'`, which is what a single full-screen page
 * usually wants. Pass a different container type when the root itself should flow its children.
 */

import type Phaser from 'phaser';
import { devLog, isDevMode, warn } from '@phaser-mvvm/core';
import { LayoutEngine, tight } from '@phaser-mvvm/layout';
import type { ContainerLayout, Size } from '@phaser-mvvm/layout';
import { Widget, type WidgetOptions } from './Widget';
import {
  NO_SAFE_AREA,
  clampSafeArea,
  cssInsetsToDesign,
  insetsInsideCanvas,
  isZeroSafeArea,
  readSafeAreaInsets,
  type SafeAreaInsets,
} from './safe-area';

/** A layout pass is logged once it measures this many nodes (development only). */
const LOG_MEASURE_THRESHOLD = 200;
/** …or once it takes at least this long, in milliseconds. */
const LOG_PASS_MS = 2;

export interface UIRootOptions extends WidgetOptions {
  /** Alignment used when the root container is a `stack`. Defaults to `'center'`. */
  align?: 'start' | 'center' | 'end';
  /** Render depth of the UI layer. Defaults to 1000. */
  depth?: number;
  /**
   * The size the page's layout is **authored** for, when the game itself is bigger than that.
   *
   * A game that renders at device resolution sizes its game at `design × devicePixelRatio` and zooms
   * its camera by the same factor, so that one design pixel covers several buffer pixels instead of
   * being upsampled by the browser afterwards. The page's own coordinates do not change — but three
   * things the framework derives from "the game size" would then be wrong, and this option is how the
   * root is told which size the layout, the snapping and the DOM overlay actually belong to:
   *
   * - the root lays out (and reserves the safe area) for this size, not for the game size;
   * - the snap grid defaults to the magnification it implies (`game size ÷ this size`), which is the
   *   buffer's real grid under a zoomed camera rather than the 1 of an unmagnified one;
   * - `devicePixelRatio × canvas CSS width ÷ this width` is what the widgets bake their glyphs at and
   *   what positions the DOM input bridge, both of which are expressed in layout units.
   *
   * Leave it unset (the default) and every one of those falls back to the game size, which is right for
   * the ordinary unmagnified game.
   *
   * ```ts
   * const dpr = window.devicePixelRatio;
   * MVVMPlugin.configure({ designResolution: { width: 450, height: 900 } });
   * new Phaser.Game({
   *   scale: { mode: Phaser.Scale.FIT, width: 450 * dpr, height: 900 * dpr },
   *   // …and in each scene: `this.cameras.main.setZoom(dpr)`.
   * });
   * ```
   */
  designResolution?: { width: number; height: number };
  /**
   * Pixels of the **drawing buffer** per layout unit, used for snapping.
   *
   * Defaults to the magnification implied by {@link UIRootOptions.designResolution} — `1` for an
   * ordinary game, and `devicePixelRatio` for one rendering at device resolution — because that is the
   * grid the buffer can actually represent.
   *
   * Deliberately **not** `window.devicePixelRatio` on its own: Phaser keeps the canvas backing store at
   * `gameSize` (it scales the canvas in *CSS* pixels), so an unmagnified game has exactly one buffer
   * pixel per layout unit however dense the display is. Snapping to a finer grid than the buffer can
   * represent does not buy sharpness — it puts every edge on a half pixel, which the rasteriser draws as
   * two half-lit pixels, and borders and text boxes visibly soften (V79).
   *
   * Set it by hand when the magnification is not uniform or does not come from a camera zoom (a
   * container scaled by 2, say).
   */
  dpr?: number;
  /** Snapping mode. Defaults to `'round'`. */
  snapMode?: 'none' | 'round' | 'floor' | 'ceil';
  /** Which arranger the root uses for its children. Defaults to `{ type: 'stack' }`. */
  container?: ContainerLayout;
  /**
   * Keep the UI inside the device's safe area (notch, camera cutout, home indicator). Defaults to
   * `true`; on any device without insets (a desktop window, a phone that did not ask for
   * `viewport-fit=cover`) the measured values are `0` and nothing changes.
   *
   * Set `false` when the game *wants* the canvas to reach the cutout — a full-bleed background, or an
   * application that applies the insets itself.
   *
   * Read when the root is created (like the other build-time options): `mvvm.configure({ safeArea })`
   * on a live scene does not move an existing root.
   */
  safeArea?: boolean;
}

export class UIRoot extends Widget {
  readonly layoutEngine: LayoutEngine;

  /** Whether the root reserves the device's safe area (see `UIRootOptions.safeArea`). */
  readonly safeAreaEnabled: boolean;

  private laidOut = false;
  private structureCounter = 0;
  private insets: SafeAreaInsets = { top: 0, right: 0, bottom: 0, left: 0 };
  private deviceInsets: SafeAreaInsets = { top: 0, right: 0, bottom: 0, left: 0 };
  /** The size the layout is authored for, or `null` to follow the game size (the default). */
  private readonly design: { width: number; height: number } | null;
  /** The numeric size of the last layout, so readers never have to resolve a `LengthUnit`. */
  private laidOutSize: Size = { width: 0, height: 0 };
  /** The caller's explicit snap grid, or `null` to keep tracking the magnification. */
  private readonly snapGrid: number | null;

  constructor(scene: Phaser.Scene, options: UIRootOptions = {}) {
    super(scene, { layout: { width: 0, height: 0, ...options.layout }, name: options.name });

    this.container = options.container ?? {
      type: 'stack',
      options: { align: options.align ?? 'center' },
    };

    this.structureListener = () => {
      this.structureCounter++;
    };

    const design = options.designResolution;
    this.design =
      design && design.width > 0 && design.height > 0
        ? { width: design.width, height: design.height }
        : null;
    if (design && !this.design && isDevMode()) {
      warn('UIRoot: designResolution needs positive width and height; ignoring it');
    }
    this.warnOnSkewedDesign();

    this.snapGrid = typeof options.dpr === 'number' && options.dpr > 0 ? options.dpr : null;
    this.layoutEngine = new LayoutEngine({
      // The buffer's own grid, unless the caller knows better: see `UIRootOptions.dpr`.
      dpr: this.snapGrid ?? this.layoutScale,
      snapMode: options.snapMode ?? 'round',
    });
    this.setEngineRecursive(this.layoutEngine);

    this.safeAreaEnabled = options.safeArea !== false;
    this.setDepth(options.depth ?? 1000);
    scene.add.existing(this);
    scene.scale.on('resize', this.handleResize, this);

    this.resize();
  }

  /**
   * Game (and therefore buffer) units per layout unit.
   *
   * `1` unless {@link UIRootOptions.designResolution} is set, in which case it is whatever
   * magnification separates the two — the camera zoom a device-resolution game renders with. It is the
   * number the snap grid and the text-baking ratio are built from, so a page can read it to bake its
   * own art at the same density.
   */
  get layoutScale(): number {
    if (!this.design) {
      return 1;
    }
    const game = this.scene?.scale?.gameSize;
    const scale = game && game.width > 0 ? game.width / this.design.width : 1;
    return Number.isFinite(scale) && scale > 0 ? scale : 1;
  }

  /**
   * Bumped whenever the widget tree gains or loses a widget; the scene plugin compares it to know
   * when input targets have to be re-collected.
   */
  get structureVersion(): number {
    return this.structureCounter;
  }

  override addWidget<T extends Widget>(child: T): T {
    const added = super.addWidget(child);
    this.flushLayout();
    return added;
  }

  /** Re-reads the game size, marks the root dirty and lays out immediately. */
  resize(): void {
    const size = this.authoredSize();
    this.resizeTo(size.width, size.height);
  }

  /**
   * The size the layout works in: the authored design resolution when there is one, else the game size.
   *
   * Every other size the root derives — the snap grid, the safe-area reservation — is expressed in these
   * units, so this is the one place that decides what "a layout unit" means for this page.
   */
  private authoredSize(): { width: number; height: number } {
    const gameSize = this.scene?.scale?.gameSize;
    if (this.design) {
      return this.design;
    }
    return { width: gameSize?.width ?? 0, height: gameSize?.height ?? 0 };
  }

  /**
   * Warns when the design resolution does not share the game's aspect ratio.
   *
   * A camera zoom can only turn one design pixel into `n` buffer pixels if both axes are magnified by
   * the same factor; when they are not, the page is stretched and every layout length means something
   * different horizontally and vertically — a silent, very confusing kind of wrong.
   */
  private warnOnSkewedDesign(): void {
    if (!this.design || !isDevMode()) {
      return;
    }
    const game = this.scene?.scale?.gameSize;
    if (!game || !(game.width > 0) || !(game.height > 0)) {
      return;
    }
    const scaleX = game.width / this.design.width;
    const scaleY = game.height / this.design.height;
    if (Math.abs(scaleX - scaleY) > scaleX * 0.01) {
      warn(
        `UIRoot: designResolution ${this.design.width}x${this.design.height} does not have the game's ` +
          `aspect ratio (${game.width}x${game.height}): the page will be stretched ` +
          `(${scaleX.toFixed(3)}x horizontally, ${scaleY.toFixed(3)}x vertically)`,
      );
    }
  }

  /**
   * The numeric size the root is laid out in: the authored design resolution when there is one, else the
   * live game size (`0x0` before the first layout). Read by the plugin to resolve how many device pixels
   * a layout unit covers, and by anything else that has to convert layout units to screen ones.
   */
  get layoutSize(): Size {
    return { width: this.laidOutSize.width, height: this.laidOutSize.height };
  }

  /** Sizes the root to an explicit size (design-resolution overrides, tests, embedded UI). */
  resizeTo(width: number, height: number): void {
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    this.laidOutSize = { width: w, height: h };
    // The magnification can move under a live root — a device-pixel-ratio change, or an app that
    // re-sizes its game from the window — and the snap grid has to follow it, or the rects would keep
    // landing on a grid that no longer matches the buffer.
    if (this.snapGrid === null) {
      this.layoutEngine.dpr = this.layoutScale;
    }
    this.layoutParams.width = w;
    this.layoutParams.height = h;
    this.applySafeArea({ width: w, height: h });
    this.markDirty();
    this.flushLayout();
  }

  /**
   * The safe-area insets currently reserved, in design pixels.
   *
   * Zero on any device without them, and zero for every root built with `safeArea: false`.
   */
  get safeAreaInsets(): SafeAreaInsets {
    return { ...this.insets };
  }

  /** The device's own insets (CSS pixels), before the canvas overlap is taken into account. */
  get deviceSafeAreaInsets(): SafeAreaInsets {
    return { ...this.deviceInsets };
  }

  /** The canvas' CSS rectangle, or `null` when the DOM is not reachable. */
  private canvasBox(): { x: number; y: number; width: number; height: number } | null {
    const canvas = this.scene?.game?.canvas;
    if (!canvas || typeof canvas.getBoundingClientRect !== 'function') {
      return null;
    }
    const rect = canvas.getBoundingClientRect();
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
  }

  /** The viewport the insets belong to (Phaser's parent size, falling back to the window). */
  private viewportSize(): { width: number; height: number } {
    const scale = this.scene?.scale as { parentSize?: Size; windowSize?: Size } | undefined;
    const size = scale?.parentSize ?? scale?.windowSize;
    const width = size?.width ?? 0;
    const height = size?.height ?? 0;
    if (width > 0 && height > 0) {
      return { width, height };
    }
    return typeof window === 'undefined'
      ? { width: 0, height: 0 }
      : { width: window.innerWidth, height: window.innerHeight };
  }

  /**
   * CSS pixels → design pixels: `gameSize / displaySize` (1 under `Scale.RESIZE`).
   *
   * `env(safe-area-inset-*)` is a CSS length; the layout works in the game's coordinate space. The two
   * coincide in the responsive mode the examples default to, and differ by the display scale in
   * `Scale.FIT` — where reserving the raw CSS number would leave the UI under the cutout.
   */
  private cssToDesignFactor(layoutWidth: number): number {
    const display = this.scene?.scale?.displaySize;
    // The layout width, not the game width: with a camera zoomed over a bigger game, one CSS pixel
    // covers fewer *design* units than `gameSize / displaySize` would claim, and the insets the caller
    // measures are in design units.
    if (!display || !(display.width > 0) || !(layoutWidth > 0)) {
      return 1;
    }
    return layoutWidth / display.width;
  }

  /**
   * Re-reads the insets and writes them into the root's own padding.
   *
   * Padding rather than a child offset on purpose: the arranger already resolves padding, so a page with
   * `width: 'fill'` lands inside the safe area with no extra layout pass, and the root's own box still
   * covers the whole viewport (so the theme background and any camera-pinned layer stay full-bleed).
   *
   * The read happens on every resize — rotating a phone moves the cutout from the top edge to a side —
   * and the clamp keeps a short viewport from losing its whole UI to a fixed-size strip (`safe-area.ts`).
   */
  private applySafeArea(size: Size): void {
    this.deviceInsets = this.safeAreaEnabled
      ? readSafeAreaInsets(this.scene?.game?.canvas?.ownerDocument ?? null)
      : { ...NO_SAFE_AREA };
    const next = this.safeAreaEnabled
      ? clampSafeArea(
          cssInsetsToDesign(
            // The insets belong to the viewport; only the part the canvas sits under concerns the UI
            // (`Scale.FIT` letterboxes the canvas away from the cutout — see `insetsInsideCanvas`).
            insetsInsideCanvas(this.deviceInsets, this.canvasBox(), this.viewportSize()),
            this.cssToDesignFactor(size.width),
          ),
          size,
        )
      : { top: 0, right: 0, bottom: 0, left: 0 };
    const current = this.insets;
    const changed =
      current.top !== next.top ||
      current.right !== next.right ||
      current.bottom !== next.bottom ||
      current.left !== next.left;
    this.insets = next;
    if (changed || !isZeroSafeArea(next)) {
      this.layoutParams.padding = { ...next };
    }
    if (changed && !isZeroSafeArea(next) && isDevMode()) {
      devLog(
        `safeArea: top ${next.top} / right ${next.right} / bottom ${next.bottom} / left ${next.left} ` +
          `(${size.width}x${size.height})`,
      );
    }
  }

  /**
   * Runs a layout pass if anything in the widget tree is dirty.
   *
   * The check is `hasDirtyNodes`, not `isDirty(this)`: a change inside a fixed-size widget does not
   * propagate dirty state to the root (relayout boundary), so testing the root alone would skip the
   * pass and leave the UI stale.
   */
  flushLayout(): void {
    const engine = this.layoutEngine;
    if (this.laidOut && !engine.hasDirtyNodes) {
      return;
    }
    const width = typeof this.layoutParams.width === 'number' ? this.layoutParams.width : 0;
    const height = typeof this.layoutParams.height === 'number' ? this.layoutParams.height : 0;
    if (width <= 0 || height <= 0) {
      return;
    }
    this.laidOut = true;
    const { measureCalls, skippedSubtrees } = engine.stats;
    const startedAt = performance.now();
    engine.layout(this, tight(width, height), { width, height });

    // Development trace, and only for the passes worth looking at: an unchanged frame skips the pass
    // entirely, and a healthy incremental pass measures a handful of nodes. A pass that measures a large
    // part of the tree (or takes milliseconds) is the signal you want when asking "why is this frame
    // slow" - printing every pass would only bury it.
    const measured = engine.stats.measureCalls - measureCalls;
    const elapsed = performance.now() - startedAt;
    if (measured >= LOG_MEASURE_THRESHOLD || elapsed >= LOG_PASS_MS) {
      devLog(
        `layout: measured ${measured} node(s) in ${elapsed.toFixed(2)} ms ` +
          `(skipped ${engine.stats.skippedSubtrees - skippedSubtrees} subtree(s), ` +
          `${engine.stats.cacheHits} cache hit(s) so far)`,
      );
    }
  }

  /** Current UI size in design pixels. */
  get uiSize(): Size {
    const width = typeof this.layoutParams.width === 'number' ? this.layoutParams.width : 0;
    const height = typeof this.layoutParams.height === 'number' ? this.layoutParams.height : 0;
    return { width, height };
  }

  override destroy(fromScene?: boolean): void {
    this.scene?.scale.off('resize', this.handleResize, this);
    super.destroy(fromScene);
  }

  private handleResize(): void {
    this.resize();
  }
}
