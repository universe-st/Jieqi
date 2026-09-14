/**
 * Box constraints: the contract between a parent and its children.
 *
 * A parent hands down a constraint (min/max width and height), a child returns a size that
 * satisfies it. This is the same model Flutter uses and it is what makes the two-pass engine
 * cacheable: the measured size of a node is a pure function of (constraint, content revision).
 */

import type { Insets, Size } from './geom';
import { clamp, size } from './geom';

export const UNBOUNDED = Number.POSITIVE_INFINITY;

export interface BoxConstraints {
  minWidth: number;
  maxWidth: number;
  minHeight: number;
  maxHeight: number;
}

export function constraints(
  minWidth = 0,
  maxWidth = UNBOUNDED,
  minHeight = 0,
  maxHeight = UNBOUNDED,
): BoxConstraints {
  return { minWidth, maxWidth, minHeight, maxHeight };
}

/** Both axes fixed: the child must be exactly this size. */
export function tight(width: number, height: number): BoxConstraints {
  return { minWidth: width, maxWidth: width, minHeight: height, maxHeight: height };
}

/** `tightFor(120)` → width fixed at 120, height unconstrained. */
export function tightFor(width?: number, height?: number): BoxConstraints {
  return constraints(width ?? 0, width ?? UNBOUNDED, height ?? 0, height ?? UNBOUNDED);
}

/** Child may be smaller than the available space, but never larger. */
export function loose(width = UNBOUNDED, height = UNBOUNDED): BoxConstraints {
  return constraints(0, width, 0, height);
}

export function unbounded(): BoxConstraints {
  return constraints(0, UNBOUNDED, 0, UNBOUNDED);
}

/** A generic "at most" constraint used by content-measuring containers. */
export function atMost(width = UNBOUNDED, height = UNBOUNDED): BoxConstraints {
  return loose(width, height);
}

/** Keeps `min <= max` on both axes. */
export function enforce(target: BoxConstraints): BoxConstraints {
  // One documented policy for a contradictory pair, the same one `geom.clamp()` uses: min wins. A
  // midpoint used to be returned here, which satisfied neither bound and drifted every time the
  // constraint passed through `enforce()` again (each nested measure).
  if (target.minWidth > target.maxWidth) {
    target.maxWidth = target.minWidth;
  }
  if (target.minHeight > target.maxHeight) {
    target.maxHeight = target.minHeight;
  }
  return target;
}

export function isTight(target: BoxConstraints): boolean {
  return target.minWidth === target.maxWidth && target.minHeight === target.maxHeight;
}

export function hasBoundedWidth(target: BoxConstraints): boolean {
  return Number.isFinite(target.maxWidth);
}

export function hasBoundedHeight(target: BoxConstraints): boolean {
  return Number.isFinite(target.maxHeight);
}

/** Shrinks a constraint by insets (e.g. padding), never below zero. */
export function deflate(target: BoxConstraints, insets: Insets): BoxConstraints {
  const horizontal = insets.left + insets.right;
  const vertical = insets.top + insets.bottom;
  return {
    minWidth: Math.max(0, target.minWidth - horizontal),
    maxWidth: Math.max(0, target.maxWidth - horizontal),
    minHeight: Math.max(0, target.minHeight - vertical),
    maxHeight: Math.max(0, target.maxHeight - vertical),
  };
}

/** Drops the minimums: child may be any size up to the maximum. */
export function loosen(target: BoxConstraints): BoxConstraints {
  return {
    minWidth: 0,
    maxWidth: target.maxWidth,
    minHeight: 0,
    maxHeight: target.maxHeight,
  };
}

export function constrainSize(target: BoxConstraints, value: Size): Size {
  return size(
    clamp(value.width, target.minWidth, target.maxWidth),
    clamp(value.height, target.minHeight, target.maxHeight),
  );
}

export function constrainWidth(target: BoxConstraints, width: number): number {
  return clamp(width, target.minWidth, target.maxWidth);
}

export function constrainHeight(target: BoxConstraints, height: number): number {
  return clamp(height, target.minHeight, target.maxHeight);
}

/** The largest size the constraint allows; unbounded axes report 0. */
export function maxSize(target: BoxConstraints): Size {
  return size(
    Number.isFinite(target.maxWidth) ? target.maxWidth : 0,
    Number.isFinite(target.maxHeight) ? target.maxHeight : 0,
  );
}

export function isSatisfied(target: BoxConstraints, value: Size): boolean {
  return (
    value.width >= target.minWidth - 1e-6 &&
    value.width <= target.maxWidth + 1e-6 &&
    value.height >= target.minHeight - 1e-6 &&
    value.height <= target.maxHeight + 1e-6
  );
}

export function constraintsEqual(a: BoxConstraints, b: BoxConstraints): boolean {
  return (
    a.minWidth === b.minWidth &&
    a.maxWidth === b.maxWidth &&
    a.minHeight === b.minHeight &&
    a.maxHeight === b.maxHeight
  );
}

export function constraintsKey(target: BoxConstraints): string {
  return `${target.minWidth}|${target.maxWidth}|${target.minHeight}|${target.maxHeight}`;
}

export function cloneConstraints(target: BoxConstraints): BoxConstraints {
  return {
    minWidth: target.minWidth,
    maxWidth: target.maxWidth,
    minHeight: target.minHeight,
    maxHeight: target.maxHeight,
  };
}
