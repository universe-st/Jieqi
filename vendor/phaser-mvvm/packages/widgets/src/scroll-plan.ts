/**
 * Pure planning helpers behind `ScrollView` (PLAN §4.5, milestone M7).
 *
 * Nothing here touches Phaser or the layout engine, so the arithmetic that decides *how far* a list
 * scrolls, *how big* a scrollbar thumb is and *when* inertia stops is unit-testable in plain Node.
 * The widget half only sequences these functions and paints the result.
 */

/** DOM `WheelEvent.deltaMode` values; the numbers are what `normalizeWheel` receives. */
export const DELTA_MODE_PIXEL = 0;
export const DELTA_MODE_LINE = 1;
export const DELTA_MODE_PAGE = 2;

/** Pixels one line of wheel delta is worth in `DELTA_MODE_LINE`. */
export const LINE_HEIGHT = 16;
/** Lines one page of wheel delta is worth in `DELTA_MODE_PAGE`. */
export const PAGE_LINES = 3;

/** How far a `bounce`-enabled view may be pulled past its limits, in pixels. */
export const BOUNCE_LIMIT = 48;
/** How much of the raw pull the rubber band shows before it saturates (see `resist`). */
export const BOUNCE_RESISTANCE = 0.5;

/** Velocity (px/ms) below which inertia stops. */
export const INERTIA_STOP_VELOCITY = 0.02;
/** Exponential velocity decay per millisecond while coasting (~250 ms time constant). */
export const INERTIA_DECELERATION = 0.004;

/** Extra pixels that still count as "at the end", so sub-pixel layout cannot trap the offset. */
export const SCROLL_EPSILON = 0.5;

/** `true` when a content longer than the viewport can actually be scrolled. */
export function isScrollable(contentLength: number, viewport: number): boolean {
  if (!Number.isFinite(contentLength) || !Number.isFinite(viewport)) {
    return false;
  }
  return contentLength - viewport > SCROLL_EPSILON;
}

/**
 * Clamps a scroll offset into `[0, maxOffset]`.
 *
 * With `bounce` the offset may leave the range by up to `BOUNCE_LIMIT`, but each pixel beyond the
 * edge only moves the content `BOUNCE_RESISTANCE` pixels — the "rubber band" feel — so a hard fling
 * cannot throw the content off screen.
 */
export function clampOffset(offset: number, maxOffset: number, bounce = false): number {
  const value = Number.isFinite(offset) ? offset : 0;
  const limit = Number.isFinite(maxOffset) ? Math.max(0, maxOffset) : 0;
  if (value < 0) {
    return bounce ? -resist(-value) : 0;
  }
  if (value > limit) {
    return bounce ? limit + resist(value - limit) : limit;
  }
  return value;
}

/**
 * Overshoot a pull of `distance` past an edge produces.
 *
 * The band first gives `BOUNCE_RESISTANCE` of the pull and then stiffens, approaching
 * `BOUNCE_LIMIT` asymptotically: however hard a fling pulls, the content never leaves the frame.
 */
function resist(distance: number): number {
  const pulled = Math.max(0, distance) * BOUNCE_RESISTANCE;
  return BOUNCE_LIMIT * (1 - 1 / (1 + pulled / BOUNCE_LIMIT));
}

/**
 * Converts a raw wheel delta into pixels.
 *
 * Browsers report `DOM_DELTA_PIXEL` (0), `DOM_DELTA_LINE` (1) or `DOM_DELTA_PAGE` (2); the widget
 * layer feeds this the raw value plus `WheelEvent.deltaMode`, so one physical notch moves the same
 * distance in every browser. `speed` is the caller's multiplier (`ScrollView.wheelSpeed`).
 */
export function normalizeWheel(deltaY: number, deltaMode: number, speed = 1): number {
  if (!Number.isFinite(deltaY)) {
    return 0;
  }
  const factor = Number.isFinite(speed) ? speed : 1;
  switch (deltaMode) {
    case DELTA_MODE_LINE:
      return deltaY * LINE_HEIGHT * factor;
    case DELTA_MODE_PAGE:
      return deltaY * LINE_HEIGHT * PAGE_LINES * factor;
    default:
      return deltaY * factor;
  }
}

/** Outcome of one inertia step. */
export interface InertiaStep {
  /** Velocity to carry into the next frame, in px/ms. */
  velocity: number;
  /** Distance to scroll this step, in pixels. */
  delta: number;
  /** `true` once the velocity fell below the stop threshold (the caller should halt the ticker). */
  stopped: boolean;
}

/**
 * Advances an inertia (fling) simulation by `deltaMs`.
 *
 * The velocity decays exponentially (`v *= e^(-deceleration · deltaMs)`), which makes the fling
 * frame-rate independent: a 100 ms frame coasts as far as ten 10 ms frames. The step reports the
 * distance travelled (the exact integral of the decay over the step), so the caller only has to add
 * it to the offset.
 */
export function applyInertia(velocity: number, deceleration: number, deltaMs: number): InertiaStep {
  const start = Number.isFinite(velocity) ? velocity : 0;
  const decay = Number.isFinite(deceleration) ? Math.max(0, deceleration) : INERTIA_DECELERATION;
  const elapsed = Number.isFinite(deltaMs) ? Math.max(0, deltaMs) : 0;
  const keep = Math.exp(-decay * elapsed);
  const next = start * keep;
  // Exact integral of the exponential over the step: additive, so the distance does not depend on
  // how the elapsed time is chopped into frames.
  const delta = decay > 0 ? (start - next) / decay : start * elapsed;
  return {
    velocity: next,
    delta,
    stopped: Math.abs(next) < INERTIA_STOP_VELOCITY,
  };
}

/** Where the scrollbar thumb sits, and how long it is. */
export interface ThumbGeometry {
  /** `false` when there is nothing to scroll: the caller hides the scrollbar. */
  visible: boolean;
  /** Offset of the thumb inside the track, in pixels (measured from the track's start). */
  position: number;
  /** Thumb length in pixels (`0` when hidden). */
  length: number;
}

/**
 * Scrollbar thumb geometry.
 *
 * The thumb is proportional to the visible fraction of the content, never shorter than `minThumb`,
 * and its position maps the offset onto the remaining track. A content that fits (or a track too
 * small to hold the thumb) reports `visible: false`.
 */
export function thumbGeometry(
  offset: number,
  viewport: number,
  contentLength: number,
  trackLength: number,
  minThumb = 24,
): ThumbGeometry {
  if (!isScrollable(contentLength, viewport) || !Number.isFinite(trackLength) || trackLength <= 0) {
    return { visible: false, position: 0, length: 0 };
  }

  const minimum = Math.max(0, Number.isFinite(minThumb) ? minThumb : 0);
  const ratio = Math.min(1, Math.max(0, viewport / contentLength));
  const length = Math.min(trackLength, Math.max(minimum, ratio * trackLength));
  const maxOffset = contentLength - viewport;
  const progress = maxOffset <= 0 ? 0 : Math.min(1, Math.max(0, offset / maxOffset));
  const travel = Math.max(0, trackLength - length);

  return { visible: true, position: progress * travel, length };
}

/** Decision of a pointer drag: whether it has passed the threshold, and by how much. */
export interface ScrollDragPlan {
  /** `true` once the pointer travelled at least `threshold` pixels. */
  dragging: boolean;
  /** Horizontal travel since the drag started (0 until `dragging`). */
  dx: number;
  /** Vertical travel since the drag started (0 until `dragging`). */
  dy: number;
}

/**
 * Decides whether a press-and-move has become a scroll drag.
 *
 * Below the threshold the gesture is still a *click* on the content, which is why the threshold has
 * to be at least the input router's own drag threshold: anything this function accepts as a drag is
 * already rejected as a click by the router, so a scroll never activates the control under the
 * pointer.
 */
export function planScrollDrag(
  start: { x: number; y: number },
  current: { x: number; y: number },
  threshold: number,
): ScrollDragPlan {
  const dx = current.x - start.x;
  const dy = current.y - start.y;
  const limit = Number.isFinite(threshold) ? Math.max(0, threshold) : 0;
  const travelled = Math.sqrt(dx * dx + dy * dy);
  if (travelled < limit) {
    return { dragging: false, dx: 0, dy: 0 };
  }
  return { dragging: true, dx, dy };
}

/** A rectangle in one coordinate space. */
export interface ScrollRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Extent of a set of rectangles, as `{ width, height }`.
 *
 * `ScrollView` uses it to learn how long its content really is: the layout engine clamps a child's
 * *measured* size to the viewport, while the content's own children keep their overflowing positions
 * (and a virtualised `Repeat` pads itself with fillers), so the union of the arranged rects is the
 * only honest answer.
 */
export function extentOfRects(rects: readonly ScrollRect[]): { width: number; height: number } {
  let maxX = 0;
  let maxY = 0;
  for (const rect of rects) {
    if (!rect) {
      continue;
    }
    maxX = Math.max(maxX, rect.x + rect.width);
    maxY = Math.max(maxY, rect.y + rect.height);
  }
  return { width: maxX, height: maxY };
}

/** How far a key press scrolls. */
export interface ScrollKeyStep {
  /** Pixels to add to the offset along the scroll axis. */
  delta: number;
  /** `true` for keys that jump to an end of the content (Home/End). */
  jump: 'start' | 'end' | null;
  /**
   * Which axis the **key** belongs to: `'x'` for `ArrowLeft`/`ArrowRight`, `'y'` for everything else.
   *
   * The widget used to decide the axis from `direction` alone, which meant a `direction: 'both'` port
   * sent `ArrowLeft`/`ArrowRight` into its y axis (V60: measured `ArrowRight` moving y 0 → 40 → 80 → 120
   * while x stayed 0). The key knows; the port only overrules it when it scrolls on one axis anyway.
   */
  axis: 'x' | 'y';
}

/**
 * The axis a key scrolls **this** port along.
 *
 * A one-axis port overrules the key — a horizontal strip paging with `PageUp`/`PageDown` is long-standing
 * behaviour, and a vertical port never scrolls sideways. A `direction: 'both'` port has no "the" axis, so
 * the key decides: `ArrowLeft`/`ArrowRight` move x, everything else moves y.
 *
 * This used to be decided from `direction` alone inside the widget, which sent the horizontal arrows of a
 * two-axis port into its y axis (V60: measured `ArrowRight` moving y 0 → 40 → 80 → 120 while x stayed 0).
 */
export function keyScrollAxis(
  direction: 'vertical' | 'horizontal' | 'both',
  key: string,
): 'x' | 'y' {
  if (direction === 'horizontal') {
    return 'x';
  }
  if (direction === 'vertical') {
    return 'y';
  }
  return key === 'ArrowLeft' || key === 'ArrowRight' ? 'x' : 'y';
}

/**
 * Maps a scrollable key (`ArrowUp`/`ArrowDown`/`PageUp`/`PageDown`/`Home`/`End`, plus the horizontal
 * pair) to a scroll step; `null` for every other key, so the widget leaves navigation alone.
 */
export function planScrollKey(
  key: string,
  viewport: number,
  line = 40,
  pageFraction = 0.9,
): ScrollKeyStep | null {
  const step = Number.isFinite(line) ? line : 40;
  const page = Math.max(step, (Number.isFinite(viewport) ? viewport : 0) * pageFraction);
  switch (key) {
    case 'ArrowUp':
      return { delta: -step, jump: null, axis: 'y' };
    case 'ArrowDown':
      return { delta: step, jump: null, axis: 'y' };
    case 'ArrowLeft':
      return { delta: -step, jump: null, axis: 'x' };
    case 'ArrowRight':
      return { delta: step, jump: null, axis: 'x' };
    case 'PageUp':
      return { delta: -page, jump: null, axis: 'y' };
    case 'PageDown':
      return { delta: page, jump: null, axis: 'y' };
    case 'Home':
      return { delta: 0, jump: 'start', axis: 'y' };
    case 'End':
      return { delta: 0, jump: 'end', axis: 'y' };
    default:
      return null;
  }
}

/**
 * The slice of content a port can currently show, in **content space**.
 *
 * Content space is the holder's own coordinate system: the offset is measured in screen pixels while
 * `appliedRect` is not, so the band divides the offset and the viewport by the holder's scale (`zoom`)
 * before comparing them.
 */
export interface CullBand {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  /** Whether the port scrolls — and therefore culls — on the axis. */
  axisX: boolean;
  axisY: boolean;
}

/** Results of {@link cullBand}, reused by the caller to keep the per-frame pass allocation-free. */
export function cullBand(
  offsetX: number,
  offsetY: number,
  viewportWidth: number,
  viewportHeight: number,
  scale: number,
  margin: number,
  axisX: boolean,
  axisY: boolean,
  out: CullBand = { minX: 0, maxX: 0, minY: 0, maxY: 0, axisX, axisY },
): CullBand {
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const pad = (Number.isFinite(margin) ? Math.max(0, margin) : 0) / safeScale;
  const width = Number.isFinite(viewportWidth) ? Math.max(0, viewportWidth) : 0;
  const height = Number.isFinite(viewportHeight) ? Math.max(0, viewportHeight) : 0;
  out.minX = offsetX / safeScale - pad;
  out.maxX = (offsetX + width) / safeScale + pad;
  out.minY = offsetY / safeScale - pad;
  out.maxY = (offsetY + height) / safeScale + pad;
  out.axisX = axisX;
  out.axisY = axisY;
  return out;
}

/**
 * Whether a content-space rect misses the band on an axis the port scrolls.
 *
 * Only the scrolling axes are tested: the mask hides both, but a node that is out of sight on the
 * cross axis of a vertical port is content the caller sized wider than the viewport on purpose (a
 * horizontal strip inside a page), and culling it would fight the layout instead of the frame budget.
 * Touching edges count as visible, so a rect is culled only once it is entirely out of sight.
 */
export function outsideCullBand(
  band: CullBand,
  x: number,
  y: number,
  width: number,
  height: number,
): boolean {
  if (band.axisY && (y + height < band.minY || y > band.maxY)) {
    return true;
  }
  if (band.axisX && (x + width < band.minX || x > band.maxX)) {
    return true;
  }
  return false;
}
