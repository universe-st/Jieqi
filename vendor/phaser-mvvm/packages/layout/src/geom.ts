/**
 * Geometry primitives for the layout engine.
 *
 * The layout engine is renderer-agnostic: it never touches Phaser. All maths lives on these
 * plain objects so the engine can be unit-tested in Node and reused with other backends.
 */

export interface Size {
  width: number;
  height: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Shorthand accepted anywhere insets are configured. */
export type InsetsInput =
  number | readonly [number, number] | readonly [number, number, number, number] | Partial<Insets>;

export const ZERO_INSETS: Readonly<Insets> = { top: 0, right: 0, bottom: 0, left: 0 };

export function size(width = 0, height = 0): Size {
  return { width, height };
}

export function rect(x = 0, y = 0, width = 0, height = 0): Rect {
  return { x, y, width, height };
}

export function copySize(target: Size, source: Size): Size {
  target.width = source.width;
  target.height = source.height;
  return target;
}

export function copyRect(target: Rect, source: Rect): Rect {
  target.x = source.x;
  target.y = source.y;
  target.width = source.width;
  target.height = source.height;
  return target;
}

export function sizeEquals(a: Size, b: Size): boolean {
  return a.width === b.width && a.height === b.height;
}

export function rectEquals(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/** Expands a size by insets (border-box from content-box). */
export function addInsets(target: Size, insets: Insets): Size {
  target.width += insets.left + insets.right;
  target.height += insets.top + insets.bottom;
  return target;
}

export function horizontalInsets(insets: Insets): number {
  return insets.left + insets.right;
}

export function verticalInsets(insets: Insets): number {
  return insets.top + insets.bottom;
}

/** Shrinks a rect by insets, keeping the rect non-negative in size. */
export function deflateRect(target: Rect, insets: Insets): Rect {
  target.x += insets.left;
  target.y += insets.top;
  target.width = Math.max(0, target.width - insets.left - insets.right);
  target.height = Math.max(0, target.height - insets.top - insets.bottom);
  return target;
}

export function inflateRect(target: Rect, insets: Insets): Rect {
  target.x -= insets.left;
  target.y -= insets.top;
  target.width += insets.left + insets.right;
  target.height += insets.top + insets.bottom;
  return target;
}

export function clamp(value: number, min: number, max: number): number {
  if (min > max) {
    return min;
  }
  return value < min ? min : value > max ? max : value;
}

/** Replaces non-finite values (NaN, Infinity) with `fallback`. */
export function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

export type SnapMode = 'none' | 'round' | 'floor' | 'ceil';

/**
 * Snaps a single coordinate/size value to the device pixel grid.
 *
 * The layout engine keeps sub-pixel geometry internally and only snaps when writing the final
 * rect back to a GameObject, so text stays crisp without breaking fractional layout maths.
 */
export function snapValue(value: number, dpr: number, mode: SnapMode): number {
  if (mode === 'none' || !Number.isFinite(value)) {
    return value;
  }
  const scaled = value * dpr;
  const snapped =
    mode === 'floor'
      ? Math.floor(scaled)
      : mode === 'ceil'
        ? Math.ceil(scaled)
        : Math.round(scaled);
  return snapped / dpr;
}

export function snapRect(target: Rect, dpr: number, mode: SnapMode): Rect {
  if (mode === 'none') {
    return target;
  }
  const x = snapValue(target.x, dpr, mode);
  const y = snapValue(target.y, dpr, mode);
  target.width = Math.max(0, snapValue(target.x + target.width, dpr, mode) - x);
  target.height = Math.max(0, snapValue(target.y + target.height, dpr, mode) - y);
  target.x = x;
  target.y = y;
  return target;
}

export function snapSize(target: Size, dpr: number, mode: SnapMode): Size {
  if (mode === 'none') {
    return target;
  }
  target.width = Math.max(0, snapValue(target.width, dpr, mode));
  target.height = Math.max(0, snapValue(target.height, dpr, mode));
  return target;
}
