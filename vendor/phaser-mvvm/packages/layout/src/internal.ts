/**
 * Small helpers shared by the arranger algorithms (`box`, `grid`, `stack`, `absolute`).
 * Everything here is pure and allocation-free apart from the returned objects.
 */

import type { Rect, Size } from './geom';
import type { Align, Justify, LengthUnit, ResolvedParams } from './params';
import { resolveLength } from './params';

export interface Distribution {
  leading: number;
  between: number;
}

/** Splits leftover main-axis space according to a `justifyContent` value. */
export function distribute(leftover: number, count: number, justify: Justify): Distribution {
  if (count <= 0) {
    return { leading: 0, between: 0 };
  }
  const free = Math.max(0, leftover);
  switch (justify) {
    case 'center':
      return { leading: free / 2, between: 0 };
    case 'end':
      return { leading: free, between: 0 };
    case 'space-between':
      return count === 1 ? { leading: 0, between: 0 } : { leading: 0, between: free / (count - 1) };
    case 'space-around': {
      const gap = free / count;
      return { leading: gap / 2, between: gap };
    }
    case 'space-evenly': {
      const gap = free / (count + 1);
      return { leading: gap, between: gap };
    }
    case 'start':
    default:
      return { leading: 0, between: 0 };
  }
}

/** Offset of a box of `size` inside `available`, for a single-axis alignment value. */
export function alignOffset(origin: number, available: number, size: number, align: Align): number {
  switch (align) {
    case 'center':
      return origin + (available - size) / 2;
    case 'end':
      return origin + available - size;
    case 'stretch':
    case 'start':
    case 'auto':
    default:
      return origin;
  }
}

/** Resolves an absolute offset (`left`/`right`/`top`/`bottom`); `null` means "not set". */
export function resolveOffset(unit: LengthUnit | null, base: number): number | null {
  if (unit === null) {
    return null;
  }
  const value = resolveLength(unit, base);
  return value === null ? null : value;
}

/**
 * Effective `min` of a child's border box on one axis, including the clamps of a
 * `{ value, min, max }` length. Allocation-free so the arrange hot path can call it per child.
 */
export function axisMinOf(params: ResolvedParams, axis: 'horizontal' | 'vertical'): number {
  return axis === 'horizontal'
    ? Math.max(params.minWidth, params.widthMin)
    : Math.max(params.minHeight, params.heightMin);
}

/** Effective `max` of a child's border box on one axis; see `axisMinOf`. */
export function axisMaxOf(params: ResolvedParams, axis: 'horizontal' | 'vertical'): number {
  return axis === 'horizontal'
    ? Math.min(params.maxWidth, params.widthMax)
    : Math.min(params.maxHeight, params.heightMax);
}

/** The border-box size of a child, given its resolved outer (margin-box) size. */
export function borderSize(
  outer: Size,
  margin: { top: number; right: number; bottom: number; left: number },
): Size {
  return {
    width: Math.max(0, outer.width - margin.left - margin.right),
    height: Math.max(0, outer.height - margin.top - margin.bottom),
  };
}

/** The margin-box rect of a child placed at a border-box rect (inside the parent's content box). */
export function marginBoxOf(
  border: Rect,
  margin: { top: number; right: number; bottom: number; left: number },
): Rect {
  return {
    x: border.x - margin.left,
    y: border.y - margin.top,
    width: border.width + margin.left + margin.right,
    height: border.height + margin.top + margin.bottom,
  };
}
