/**
 * Layout parameters: the per-node declarative sizing model, plus its normalised form.
 *
 * Authors write `Partial<LayoutParams>` (with string shorthands such as `'50%'`, `'auto'`,
 * `'fill'` and insets shorthands); the engine works with `ResolvedParams`, which has every
 * field filled in with a concrete value and insets expanded.
 */

import type { Insets, InsetsInput } from './geom';
import { ZERO_INSETS, clamp, finiteOr } from './geom';

/** A single length unit: a number of design pixels, or a keyword/percentage. */
export type LengthUnit = number | 'auto' | 'fill' | `${number}%`;

/** A length unit with optional extra clamps, e.g. `{ value: 'fill', min: 80, max: 240 }`. */
export interface LengthValue {
  value: LengthUnit;
  min?: number;
  max?: number;
}

export type Length = LengthUnit | LengthValue;

export type Align = 'auto' | 'start' | 'center' | 'end' | 'stretch';
export type Justify =
  'start' | 'center' | 'end' | 'space-between' | 'space-around' | 'space-evenly';

/**
 * Every key `LayoutParams` accepts, as a runtime list.
 *
 * It exists for the option audit: a widget option bag mixes node-level params with the widget's own
 * options, and a mistyped key (`pading`, `with`) used to be *silently ignored* — the widget looked
 * wrong and nothing said why. The check needs to tell "a layout key I do not read" from "a key nobody
 * knows", which is only possible with the list written down.
 *
 * Typed as `keyof LayoutParams`, so a key that does not exist is a compile error; completeness is
 * guarded from the other side by the demo sweep (`scripts/visual-check.mjs` and the scene walk assert
 * that a page full of options produces no unknown-option warning at all).
 */
export const LAYOUT_PARAM_KEYS: readonly (keyof LayoutParams)[] = [
  'width',
  'height',
  'minWidth',
  'maxWidth',
  'minHeight',
  'maxHeight',
  'grow',
  'shrink',
  'basis',
  'margin',
  'padding',
  'alignSelf',
  'aspectRatio',
  'position',
  'left',
  'top',
  'right',
  'bottom',
  'order',
  'hideMode',
  'gridColumn',
  'gridRow',
  'gridColumnSpan',
  'gridRowSpan',
] as const;

export interface LayoutParams {
  width?: Length;
  height?: Length;
  minWidth?: Length;
  maxWidth?: Length;
  minHeight?: Length;
  maxHeight?: Length;

  /** Flex-grow weight on the parent's main axis (default 0). */
  grow?: number;
  /** Flex-shrink weight used when the line overflows (default 0 — overflow is allowed). */
  shrink?: number;
  /** Initial main-axis size before grow/shrink is applied. */
  basis?: Length;

  margin?: InsetsInput;
  padding?: InsetsInput;
  alignSelf?: Align;
  aspectRatio?: number;

  position?: 'flow' | 'absolute';
  left?: Length;
  top?: Length;
  right?: Length;
  bottom?: Length;

  /** Ordering hint inside box/grid containers; ties keep declaration order. */
  order?: number;
  /** `collapse` (default) removes the node from the flow when it is not visible. */
  hideMode?: HideMode;

  gridColumn?: number;
  gridRow?: number;
  gridColumnSpan?: number;
  gridRowSpan?: number;
}

/** `'collapse'` (default) removes a hidden node from the flow; `'keep'` keeps its slot. */
export type HideMode = 'collapse' | 'keep';

/**
 * Whether a node takes part in the flow.
 *
 * A hidden node collapses by default - the next sibling moves into its place, which is the layout a
 * Compose `if` produces. `hideMode: 'keep'` keeps the slot instead: the node is still measured and
 * placed (so siblings do not move) while the renderer leaves it invisible, the CSS `visibility:
 * hidden` of this framework. It only ever affects *layout*: focus and pointer collection look at
 * `visible`, so a kept-but-hidden node is neither focusable nor clickable.
 */
export function inFlowOf(visible: boolean, hideMode: HideMode = 'collapse'): boolean {
  return visible || hideMode === 'keep';
}

export interface ResolvedParams {
  width: LengthUnit;
  height: LengthUnit;
  minWidth: number;
  maxWidth: number;
  minHeight: number;
  maxHeight: number;
  grow: number;
  shrink: number;
  basis: LengthUnit | null;
  margin: Insets;
  padding: Insets;
  alignSelf: Align;
  aspectRatio: number | null;
  position: 'flow' | 'absolute';
  left: LengthUnit | null;
  top: LengthUnit | null;
  right: LengthUnit | null;
  bottom: LengthUnit | null;
  order: number;
  hideMode: 'collapse' | 'keep';
  gridColumn: number | null;
  gridRow: number | null;
  gridColumnSpan: number;
  gridRowSpan: number;
  /** Extra clamps carried by `{ value, min, max }` length objects. */
  widthMin: number;
  widthMax: number;
  heightMin: number;
  heightMax: number;
}

export const UNBOUNDED_LENGTH = Number.POSITIVE_INFINITY;

export const DEFAULT_LAYOUT_PARAMS: Readonly<ResolvedParams> = Object.freeze({
  width: 'auto',
  height: 'auto',
  minWidth: 0,
  maxWidth: UNBOUNDED_LENGTH,
  minHeight: 0,
  maxHeight: UNBOUNDED_LENGTH,
  grow: 0,
  shrink: 0,
  basis: null,
  margin: { ...ZERO_INSETS },
  padding: { ...ZERO_INSETS },
  alignSelf: 'auto',
  aspectRatio: null,
  position: 'flow',
  left: null,
  top: null,
  right: null,
  bottom: null,
  order: 0,
  hideMode: 'collapse',
  gridColumn: null,
  gridRow: null,
  gridColumnSpan: 1,
  gridRowSpan: 1,
  widthMin: 0,
  widthMax: UNBOUNDED_LENGTH,
  heightMin: 0,
  heightMax: UNBOUNDED_LENGTH,
});

const PERCENT_PATTERN = /^(-?\d+(?:\.\d+)?)%$/;

/** `12` → `{ value: 12 }`; `'50%'` → `{ value: '50%' }`; `undefined` → `undefined`. */
export function toLengthValue(length?: Length): LengthValue | undefined {
  if (length === undefined || length === null) {
    return undefined;
  }
  if (typeof length === 'object') {
    return length;
  }
  return { value: length };
}

export function toLengthUnit(length?: Length): LengthUnit | undefined {
  return toLengthValue(length)?.value;
}

export function resolveInsets(input?: InsetsInput): Insets {
  if (input === undefined || input === null) {
    return { ...ZERO_INSETS };
  }
  if (typeof input === 'number') {
    return { top: input, right: input, bottom: input, left: input };
  }
  if (Array.isArray(input)) {
    if (input.length === 2) {
      const [vertical, horizontal] = input as readonly [number, number];
      return { top: vertical, right: horizontal, bottom: vertical, left: horizontal };
    }
    if (input.length === 4) {
      const [top, right, bottom, left] = input as readonly [number, number, number, number];
      return { top, right, bottom, left };
    }
    throw new Error('resolveInsets: array shorthand must have exactly 2 or 4 entries');
  }
  const partial = input as Partial<Insets>;
  return {
    top: partial.top ?? 0,
    right: partial.right ?? 0,
    bottom: partial.bottom ?? 0,
    left: partial.left ?? 0,
  };
}

export type LengthKind = 'fixed' | 'percent' | 'auto' | 'fill';

export function lengthKind(unit: LengthUnit): LengthKind {
  if (typeof unit === 'number') {
    return 'fixed';
  }
  if (unit === 'auto') {
    return 'auto';
  }
  if (unit === 'fill') {
    return 'fill';
  }
  return 'percent';
}

export function isDefiniteUnit(unit: LengthUnit): boolean {
  const kind = lengthKind(unit);
  return kind === 'fixed' || kind === 'percent';
}

/**
 * Turns a length into pixels against a base (the parent's content box on that axis).
 *
 * Returns `null` for `'auto'` and whenever a percentage cannot be resolved (base is not
 * bounded), which tells the caller to fall back to content sizing.
 */
export function resolveLength(unit: LengthUnit, base = 0): number | null {
  if (typeof unit === 'number') {
    // `NaN`/`Infinity` are authoring mistakes, not lengths; treating them as "auto" keeps them from
    // spreading into rects (where they would silently disable hit testing and rendering).
    return Number.isFinite(unit) ? unit : null;
  }
  if (unit === 'auto') {
    return null;
  }
  if (unit === 'fill') {
    return Number.isFinite(base) ? base : null;
  }
  const match = PERCENT_PATTERN.exec(unit);
  if (!match) {
    return null;
  }
  if (!Number.isFinite(base)) {
    return null;
  }
  return (Number.parseFloat(match[1] as string) / 100) * base;
}

/** Resolves a length, then clamps it with the params' own min/max for that axis. */
export function resolveAxisLength(
  unit: Length | undefined,
  base: number,
  min: number,
  max: number,
): number | null {
  const resolved = resolveLength(toLengthUnit(unit) ?? 'auto', base);
  if (resolved === null) {
    return null;
  }
  return clamp(resolved, min, max);
}

/**
 * Replaces a non-finite numeric length with `'auto'`.
 *
 * `{ width: NaN }` is an authoring mistake that would otherwise travel all the way into a rect (and
 * from there into hit testing and rendering, where a `NaN` silently disables both).
 */
function sanitizeLengthUnit(unit: LengthUnit | undefined): LengthUnit {
  return unit === undefined || (typeof unit === 'number' && !Number.isFinite(unit)) ? 'auto' : unit;
}

function sanitizeLengthUnitOrNull(length: Length | undefined): LengthUnit | null {
  const unit = toLengthUnit(length);
  return unit === undefined ? null : sanitizeLengthUnit(unit);
}

/**
 * Normalises a 1-based grid line index.
 *
 * `gridColumn: NaN` (or a fraction, or `Infinity`) used to travel into the row/column arithmetic and
 * produced `NaN` track sizes — cells with `NaN` heights silently disappear from the layout. Anything
 * that is not a finite number becomes `null`, which means "let the grid place it automatically".
 */
function normalizeGridIndex(value: number | undefined | null): number | null {
  if (value === undefined || value === null || !Number.isFinite(value)) {
    return null;
  }
  const index = Math.floor(value);
  return index >= 1 ? index : null;
}

/** Normalises a span: at least one track, never `NaN` or fractional. */
function normalizeGridSpan(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return 1;
  }
  return Math.max(1, Math.floor(value));
}

function normalizeBound(value: Length | undefined, fallback: number): number {
  const resolved = resolveLength(toLengthUnit(value) ?? 'auto', 0);
  return resolved === null || !Number.isFinite(resolved) ? fallback : resolved;
}

export function normalizeParams(params?: LayoutParams): ResolvedParams {
  if (!params) {
    return cloneResolvedParams(DEFAULT_LAYOUT_PARAMS);
  }
  const width = toLengthValue(params.width);
  const height = toLengthValue(params.height);
  const basis = toLengthUnit(params.basis);

  return {
    width: sanitizeLengthUnit(width?.value),
    height: sanitizeLengthUnit(height?.value),
    minWidth: normalizeBound(params.minWidth, 0),
    maxWidth: normalizeBound(params.maxWidth, UNBOUNDED_LENGTH),
    minHeight: normalizeBound(params.minHeight, 0),
    maxHeight: normalizeBound(params.maxHeight, UNBOUNDED_LENGTH),
    grow: finiteOr(params.grow ?? 0, 0),
    shrink: finiteOr(params.shrink ?? 0, 0),
    basis: basis === undefined ? null : sanitizeLengthUnit(basis),
    margin: resolveInsets(params.margin),
    padding: resolveInsets(params.padding),
    alignSelf: params.alignSelf ?? 'auto',
    aspectRatio:
      params.aspectRatio !== undefined && params.aspectRatio > 0 ? params.aspectRatio : null,
    position: params.position ?? 'flow',
    left: sanitizeLengthUnitOrNull(params.left),
    top: sanitizeLengthUnitOrNull(params.top),
    right: sanitizeLengthUnitOrNull(params.right),
    bottom: sanitizeLengthUnitOrNull(params.bottom),
    order: finiteOr(params.order ?? 0, 0),
    hideMode: params.hideMode ?? 'collapse',
    gridColumn: normalizeGridIndex(params.gridColumn),
    gridRow: normalizeGridIndex(params.gridRow),
    gridColumnSpan: normalizeGridSpan(params.gridColumnSpan),
    gridRowSpan: normalizeGridSpan(params.gridRowSpan),
    widthMin: finiteOr(width?.min ?? 0, 0),
    widthMax: finiteOr(width?.max ?? UNBOUNDED_LENGTH, UNBOUNDED_LENGTH),
    heightMin: finiteOr(height?.min ?? 0, 0),
    heightMax: finiteOr(height?.max ?? UNBOUNDED_LENGTH, UNBOUNDED_LENGTH),
  };
}

/**
 * Applies a *partial* params patch on top of an already-resolved params object.
 *
 * Only the fields the patch actually mentions are recomputed; everything else keeps its current
 * value. This is what makes an incremental update safe: `normalizeParams(patch)` alone returns a
 * complete object with defaults filled in, so assigning it would silently reset every field the
 * caller left out — `setLayoutParams({ height: 100 })` would drop a `position: 'absolute'` or a
 * `width: 'fill'` the node was configured with.
 *
 * A key present with the value `undefined` counts as "not mentioned". The shorthand keys that fan
 * out into several resolved fields are handled together: `width`/`height` also refresh their
 * matching `…Min`/`…Max` clamps, and `margin`/`padding` are expanded (and copied, so the result
 * never shares an insets object with the caller).
 */
export function mergeParams(current: ResolvedParams, patch?: LayoutParams): ResolvedParams {
  const next = cloneResolvedParams(current);
  if (!patch) {
    return next;
  }
  const resolved = normalizeParams(patch);
  const mentions = (key: keyof LayoutParams): boolean =>
    (patch as Record<string, unknown>)[key as string] !== undefined;

  if (mentions('width')) {
    next.width = resolved.width;
    next.widthMin = resolved.widthMin;
    next.widthMax = resolved.widthMax;
  }
  if (mentions('height')) {
    next.height = resolved.height;
    next.heightMin = resolved.heightMin;
    next.heightMax = resolved.heightMax;
  }
  if (mentions('minWidth')) next.minWidth = resolved.minWidth;
  if (mentions('maxWidth')) next.maxWidth = resolved.maxWidth;
  if (mentions('minHeight')) next.minHeight = resolved.minHeight;
  if (mentions('maxHeight')) next.maxHeight = resolved.maxHeight;
  if (mentions('grow')) next.grow = resolved.grow;
  if (mentions('shrink')) next.shrink = resolved.shrink;
  if (mentions('basis')) next.basis = resolved.basis;
  if (mentions('margin')) next.margin = { ...resolved.margin };
  if (mentions('padding')) next.padding = { ...resolved.padding };
  if (mentions('alignSelf')) next.alignSelf = resolved.alignSelf;
  if (mentions('aspectRatio')) next.aspectRatio = resolved.aspectRatio;
  if (mentions('position')) next.position = resolved.position;
  if (mentions('left')) next.left = resolved.left;
  if (mentions('top')) next.top = resolved.top;
  if (mentions('right')) next.right = resolved.right;
  if (mentions('bottom')) next.bottom = resolved.bottom;
  if (mentions('order')) next.order = resolved.order;
  if (mentions('hideMode')) next.hideMode = resolved.hideMode;
  if (mentions('gridColumn')) next.gridColumn = resolved.gridColumn;
  if (mentions('gridRow')) next.gridRow = resolved.gridRow;
  if (mentions('gridColumnSpan')) next.gridColumnSpan = resolved.gridColumnSpan;
  if (mentions('gridRowSpan')) next.gridRowSpan = resolved.gridRowSpan;

  return next;
}

export function cloneResolvedParams(params: ResolvedParams): ResolvedParams {
  return {
    ...params,
    margin: { ...params.margin },
    padding: { ...params.padding },
  };
}

/** The axis a box container flows along. */
export type Axis = 'horizontal' | 'vertical';

export function mainAxisOf(direction: Axis): Axis {
  return direction;
}

export function crossAxisOf(direction: Axis): Axis {
  return direction === 'vertical' ? 'horizontal' : 'vertical';
}

export function mainSizeOf(axis: Axis, value: { width: number; height: number }): number {
  return axis === 'horizontal' ? value.width : value.height;
}

export function crossSizeOf(axis: Axis, value: { width: number; height: number }): number {
  return axis === 'horizontal' ? value.height : value.width;
}

export function alignSelfOf(
  childAlign: Align,
  parentAlign: Align | undefined,
): Exclude<Align, 'auto'> {
  if (childAlign !== 'auto') {
    return childAlign;
  }
  if (!parentAlign || parentAlign === 'auto') {
    return 'start';
  }
  return parentAlign;
}
