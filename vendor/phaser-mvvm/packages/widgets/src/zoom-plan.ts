/**
 * Pinch-zoom maths for `ScrollView`, kept Phaser-free so it can be unit-tested in Node.
 *
 * The gesture is "two fingers, one scale": the distance between the pointers sets the scale, and the
 * point between them is what must stay under the fingers. The second half is the part that is easy to
 * get wrong - scaling a scroll view without moving its offset zooms into the corner instead of into the
 * pinch, which feels broken even though the scale is exactly right.
 */

export interface ZoomPoint {
  x: number;
  y: number;
}

/** Distance between two pointers. */
export function pinchDistance(a: ZoomPoint, b: ZoomPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Midpoint between two pointers. */
export function pinchMidpoint(a: ZoomPoint, b: ZoomPoint): ZoomPoint {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/**
 * The scale a pinch produces, clamped to `[min, max]`.
 *
 * A degenerate starting distance (fingers on the same pixel) or a non-finite measurement keeps the
 * current scale rather than jumping to `Infinity`.
 */
export function pinchScale(
  startScale: number,
  startDistance: number,
  distance: number,
  min: number,
  max: number,
): number {
  if (!Number.isFinite(startDistance) || startDistance <= 0 || !Number.isFinite(distance)) {
    return startScale;
  }
  const low = Math.min(min, max);
  const high = Math.max(min, max);
  const next = startScale * (distance / startDistance);
  return Math.min(high, Math.max(low, next));
}

/**
 * The scroll offset that keeps `anchor` (a point in *viewport* coordinates) over the same content
 * point after the scale changed from `fromScale` to `toScale`.
 *
 * `offset` is the negated content translation (`contentX = offset + viewportX * scale`), so the anchor
 * stays put when `offset' = anchorInContent * toScale - anchorInViewport`.
 */
export function pinchOffset(
  offset: number,
  anchorViewport: number,
  fromScale: number,
  toScale: number,
): number {
  if (!Number.isFinite(fromScale) || fromScale <= 0 || !Number.isFinite(toScale) || toScale <= 0) {
    return offset;
  }
  const anchorInContent = (offset + anchorViewport) / fromScale;
  return anchorInContent * toScale - anchorViewport;
}

/** Clamps an offset to `[0, limit]`; a limit of 0 pins it to the start. */
export function clampZoomOffset(offset: number, limit: number): number {
  if (!Number.isFinite(offset)) {
    return 0;
  }
  return Math.min(Math.max(limit, 0), Math.max(0, offset));
}
