/**
 * Safe-area insets — keeping UI out of a phone's notch and home indicator.
 *
 * A canvas fills the whole viewport on a phone, including the strip the system draws its camera cutout
 * and gesture bar in. The browser is the only thing that knows how tall those strips are: CSS exposes
 * them as `env(safe-area-inset-*)`, and reading them means asking the DOM (a positioned probe element
 * whose size *is* the inset). Everything in this module except {@link readSafeAreaInsets} is pure, so
 * the part with a right answer — clamping — is unit-tested in plain Node like the rest of the
 * adapter's geometry (`reveal.ts`, `back-plan.ts`, `nav.ts`).
 *
 * Two things worth knowing before using it:
 *
 * - the insets are **zero unless the page opts in** to letting the canvas reach the cutout, i.e.
 *   `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`. Without
 *   `viewport-fit=cover` iOS reports `0` for every inset (and letterboxes the canvas), so the framework
 *   cannot decide this alone — the option is honoured, the meta tag is the application's job.
 * - the values are re-read on every resize (rotation changes which edges the cutout is on), which is
 *   why {@link readSafeAreaInsets} creates and removes its probe each time instead of caching.
 */

import type { Insets, Size } from '@phaser-mvvm/layout';

/** The four insets, in design (CSS) pixels. */
export type SafeAreaInsets = Insets;

/** A CSS-pixel rectangle (structurally a `DOMRect` and the layout `Rect`). */
export interface CanvasBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** No insets: a desktop window, or a phone that did not ask for `viewport-fit=cover`. */
export const NO_SAFE_AREA: SafeAreaInsets = { top: 0, right: 0, bottom: 0, left: 0 };

/**
 * Largest share of a dimension the insets may take, per side.
 *
 * A cutout strip is a fixed number of *physical* pixels, so on a short viewport (a phone held
 * landscape, a small window) the raw value can exceed the room available. Reserving more than this
 * leaves a UI box that is smaller than the controls need, which is worse than overlapping the strip:
 * the clamp keeps at least half of each dimension for the actual interface.
 */
export const SAFE_AREA_MAX_FRACTION = 0.25;

function positive(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Clamps the insets to what `size` can spare.
 *
 * Each axis is clamped independently against its own dimension, so a 44px top inset on a 390×844 phone
 * is kept as-is while the same 44px on a 60px-tall landscape strip is reduced to 15 (a quarter of 60).
 * Negative, `NaN` and missing values become `0`: every one of them comes from a DOM measurement, and a
 * UI that reserved `-12px` would be more broken than one that ignored a bad reading.
 */
export function clampSafeArea(
  insets: Partial<SafeAreaInsets> | null | undefined,
  size: Size,
): SafeAreaInsets {
  if (!insets) {
    return { ...NO_SAFE_AREA };
  }
  const maxVertical = Math.floor(Math.max(0, size.height) * SAFE_AREA_MAX_FRACTION);
  const maxHorizontal = Math.floor(Math.max(0, size.width) * SAFE_AREA_MAX_FRACTION);
  return {
    top: Math.min(positive(insets.top), maxVertical),
    bottom: Math.min(positive(insets.bottom), maxVertical),
    left: Math.min(positive(insets.left), maxHorizontal),
    right: Math.min(positive(insets.right), maxHorizontal),
  };
}

/**
 * Keeps only the part of each inset that the canvas actually sits under.
 *
 * The insets belong to the *viewport*, the UI to the *canvas*, and the two are not the same rectangle:
 * `Scale.FIT` with `autoCenter` letterboxes a 980×614 design into, say, a 390×244 box centered in a
 * 390×844 window, and a 47px camera strip at the top of that window covers empty letterbox, not the UI.
 * Reserving it anyway shrinks the interface for nothing (measured: the padding was 47 CSS px tall on a
 * canvas that starts 299px down), so each edge contributes only the length the two rectangles share.
 *
 * A canvas that is larger than the viewport (or missing one) keeps the full inset: overlapping by
 * definition.
 */
export function insetsInsideCanvas(
  insets: SafeAreaInsets,
  canvas: CanvasBox | null,
  viewport: { width: number; height: number },
): SafeAreaInsets {
  if (!canvas) {
    return { ...insets };
  }
  const canvasLeft = canvas.x;
  const canvasRight = canvas.x + canvas.width;
  const canvasTop = canvas.y;
  const canvasBottom = canvas.y + canvas.height;
  const shared = (bandStart: number, bandEnd: number, start: number, end: number): number =>
    Math.max(0, Math.min(bandEnd, end) - Math.max(bandStart, start));
  return {
    top: shared(0, insets.top, canvasTop, canvasBottom),
    bottom: shared(viewport.height - insets.bottom, viewport.height, canvasTop, canvasBottom),
    left: shared(0, insets.left, canvasLeft, canvasRight),
    right: shared(viewport.width - insets.right, viewport.width, canvasLeft, canvasRight),
  };
}

/**
 * Converts insets measured in **CSS pixels** into the root's **design pixels**.
 *
 * The two differ whenever the canvas is displayed at a different size than the game's coordinate space,
 * i.e. under `Scale.FIT`/`ENVELOP`: there a 47px camera strip is 47 / 0.4 ≈ 118 design pixels. Reserving
 * the raw number would leave the UI under the cutout by exactly the display scale — the failure the
 * option exists to prevent — so the conversion happens before {@link clampSafeArea}.
 *
 * `factor` is `gameSize / displaySize` (1 under `Scale.RESIZE`, and 1 for a missing or nonsensical
 * measurement, which is the neutral answer).
 */
export function cssInsetsToDesign(insets: SafeAreaInsets, factor: number): SafeAreaInsets {
  const safe = Number.isFinite(factor) && factor > 0 ? factor : 1;
  return {
    top: insets.top * safe,
    right: insets.right * safe,
    bottom: insets.bottom * safe,
    left: insets.left * safe,
  };
}

/** True when every side is zero (the common case everywhere but a notched phone). */
export function isZeroSafeArea(insets: SafeAreaInsets): boolean {
  return insets.top === 0 && insets.right === 0 && insets.bottom === 0 && insets.left === 0;
}

/**
 * Reads `env(safe-area-inset-*)` from the document.
 *
 * Two probe elements are appended to `<body>`, measured and removed: one pinned to the top-left whose
 * size is the top/left insets, one to the bottom-right for the bottom/right ones. They are `1px`-free
 * (`width: env(…)`), `visibility: hidden` and `pointer-events: none`, so nothing is painted, nothing is
 * hit-testable and the layout of the page is untouched — but they still resolve `env()` because they are
 * rendered.
 *
 * Returns {@link NO_SAFE_AREA} outside a browser (Node unit tests) and when the DOM cannot be measured,
 * which is also what a page without `viewport-fit=cover` reports.
 */
export function readSafeAreaInsets(doc?: Document | null): SafeAreaInsets {
  const target = doc ?? (typeof document === 'undefined' ? null : document);
  const body = target?.body;
  if (!target || !body || typeof target.createElement !== 'function') {
    return { ...NO_SAFE_AREA };
  }

  const makeProbe = (edges: string): HTMLElement => {
    const probe = target.createElement('div');
    probe.setAttribute('aria-hidden', 'true');
    probe.style.cssText = [
      'position: fixed',
      'visibility: hidden',
      'pointer-events: none',
      'padding: 0',
      'border: 0',
      edges,
    ].join(';');
    body.appendChild(probe);
    return probe;
  };

  const topLeft = makeProbe(
    'top: 0; left: 0; width: env(safe-area-inset-left, 0px); height: env(safe-area-inset-top, 0px)',
  );
  const bottomRight = makeProbe(
    'right: 0; bottom: 0; width: env(safe-area-inset-right, 0px); height: env(safe-area-inset-bottom, 0px)',
  );

  const tl = topLeft.getBoundingClientRect();
  const br = bottomRight.getBoundingClientRect();
  const rects = { top: tl.height, left: tl.width, bottom: br.height, right: br.width };
  topLeft.remove();
  bottomRight.remove();

  return {
    top: positive(rects.top),
    right: positive(rects.right),
    bottom: positive(rects.bottom),
    left: positive(rects.left),
  };
}
