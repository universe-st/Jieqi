/**
 * The contract between the layout engine and its nodes.
 *
 * `LayoutNode` is implemented by the Phaser adapter (`Widget`) and by the test harness. The engine
 * never reaches into a renderer: it only calls `measureContent` / `applyRect` and reads params.
 *
 * Two passes, always in this order:
 *
 *   1. measure — parent constraint flows down, content size flows up. Results are cached by
 *      (constraint, node revision), so an unchanged subtree costs one map lookup.
 *   2. arrange — the parent's content rect is distributed to the children, then each child is
 *      re-measured against its final (usually tight) constraint and `applyRect` is called top-down.
 *
 * Geometry is kept in sub-pixel units during layout; snapping to the device pixel grid happens
 * once, in `applyRect`, driven by `LayoutEngineOptions`.
 *
 * Container padding lives on the node itself (`layoutParams.padding`); the `ContainerLayout`
 * options never carry padding, so it cannot be applied twice.
 */

import type { BoxConstraints } from './constraint';
import type { Rect, Size } from './geom';
import type { Align, Axis, Justify, ResolvedParams } from './params';

export interface BoxLayoutOptions {
  /** Flow direction. Defaults to `'vertical'`. */
  direction?: Axis;
  /** Shorthand gap for both axes; `rowGap`/`columnGap` override it. */
  gap?: number;
  rowGap?: number;
  columnGap?: number;
  /** Main-axis distribution. Defaults to `'start'`. */
  justifyContent?: Justify;
  /** Cross-axis alignment of the children inside each line. Defaults to `'stretch'`. */
  alignItems?: Align;
  /** Enables multi-line flow (flex-wrap). Defaults to `false`. */
  wrap?: boolean;
  /** Cross-axis distribution of the lines themselves when `wrap` is on. Defaults to `'start'`. */
  alignContent?: Justify;
  /** Reverses the visual order of the flow. */
  reverse?: boolean;
}

export interface GridLayoutOptions {
  /** Fixed column count, or `'auto'` to derive it from `minColumnWidth`. Defaults to `'auto'`. */
  columns?: number | 'auto';
  rows?: number | 'auto';
  /** Used with `columns: 'auto'` to pick how many columns fit. Defaults to 120. */
  minColumnWidth?: number;
  /** Used with `rows: 'auto'`. Defaults to 100. */
  minRowHeight?: number;
  columnGap?: number;
  rowGap?: number;
  /** Horizontal placement of a cell's child inside the cell. Defaults to `'stretch'`. */
  justifyItems?: Align;
  /** Vertical placement of a cell's child inside the cell. Defaults to `'stretch'`. */
  alignItems?: Align;
  /** Cell filling order. Defaults to `'row'`. */
  autoFlow?: 'row' | 'column';
}

export interface StackLayoutOptions {
  /** Alignment of the stacked children inside the content box. Defaults to `'center'`. */
  align?: Exclude<Align, 'auto' | 'stretch'>;
}

/**
 * A scroll port: the content is measured **without the port's own limit on the scroll axis**.
 *
 * This is the layout half of "overflow: scroll". A node with a definite height normally caps its
 * content at that height, which is right for a panel (a child may not push its container around) but
 * wrong for a scroll port: content taller than the viewport would be squashed into it, so the flow
 * positions of everything below the first overflowing child would be wrong (in the showcase, whole
 * sections overlapped each other). The port therefore hands its children an *unbounded* maximum on
 * the axis it scrolls, while the port's own size stays whatever its parameters say.
 *
 * The cross axis is untouched, so a child's `width: 'fill'` still resolves against the viewport, and
 * percentages keep resolving against the viewport too: an unbounded maximum only suspends the cap,
 * it does not remove the containing block (see `LayoutEngine`'s content base).
 */
export interface ScrollLayoutOptions {
  /** Axis (or axes) the port scrolls along. Defaults to `'vertical'`. */
  axis?: Axis | 'both';
}

/** How a container node lays its children out. `null` means the node is a leaf. */
export type ContainerLayout =
  | { type: 'box'; options: BoxLayoutOptions }
  | { type: 'grid'; options: GridLayoutOptions }
  | { type: 'stack'; options: StackLayoutOptions }
  | { type: 'scroll'; options: ScrollLayoutOptions }
  | { type: 'absolute' };

export interface LayoutNode {
  /** Normalised params. Nodes must bump `revision` whenever these change. */
  readonly layoutParams: ResolvedParams;
  readonly children: readonly LayoutNode[];
  readonly container: ContainerLayout | null;
  /**
   * Parent node, or `null` for a layout root. The engine walks this chain in `invalidate()` to
   * mark ancestors dirty, so adapters must keep it accurate.
   */
  readonly parent: LayoutNode | null;

  /**
   * Content revision. Bump it on any change that can alter this node's measured size or the
   * measured size of its ancestors (text, children, padding, image frame, theme, …).
   */
  revision: number;

  /** When `false` the node is skipped by the flow (hidden with `hideMode: 'collapse'`). */
  readonly inFlow: boolean;

  /**
   * Intrinsic content size of a leaf, measured inside the already padding-deflated constraint.
   * Containers must also answer this (their container algorithm is used instead when they have
   * children, but the engine falls back to this method for empty containers).
   */
  measureContent(constraint: BoxConstraints): Size;

  /** Applies the final rect, in the parent's local coordinates, to the renderer object. */
  applyRect(rect: Rect): void;

  /**
   * This node's own size does not depend on its parent's constraint (a widget with a fixed width
   * and height, for example), so `LayoutEngine.invalidate()` stops its upward walk here: the
   * boundary and its subtree are recalculated while the ancestors above it keep their cached
   * measurements and their existing rects.
   *
   * Hosts must therefore ask the engine `hasDirtyNodes` (not `isDirty(root)`) before skipping a
   * layout pass.
   */
  readonly isRelayoutBoundary?: boolean;
}

/** A child of a container, as seen by the arranger algorithms. */
export interface LayoutChild {
  readonly node: LayoutNode;
  readonly params: ResolvedParams;
  readonly index: number;
  /** Outer size measured during the measure pass, margins included. */
  measured: Size;
  /** Rect assigned by the arranger, in the parent's local coordinates (margins applied). */
  rect: Rect;
}

export type MeasureChildFn = (child: LayoutChild, constraint: BoxConstraints) => Size;
export type PlaceChildFn = (child: LayoutChild, rect: Rect) => void;

/**
 * Everything an arranger needs. Instances are owned by the engine and reused between passes;
 * arrangers must not retain them.
 */
export interface ArrangerContext {
  readonly children: readonly LayoutChild[];
  /** Measures a child (margins and the child's own params are applied by the engine). */
  measureChild: MeasureChildFn;
  /** Assigns a child's final rect; the engine re-measures it tightly and recurses into arrange. */
  placeChild: PlaceChildFn;
  /** Content rect in the parent's local coordinates. Zeroed during the measure pass. */
  rect: Rect;
  /** The parent's content constraint (own constraint deflated by padding). */
  constraint: BoxConstraints;
  /** Definite content box size on each axis; `Infinity` where unbounded. Percent base. */
  contentSize: Size;
  /** `true` while the engine runs the measure pass. */
  measuring: boolean;
  /**
   * Preferred outer size of a child for the arrange pass: fixed/percent params resolved against
   * the *current* `contentSize`, falling back to the measured content size for `auto`/`fill`.
   */
  resolveOuterSize(child: LayoutChild): Size;
  /** True when the child asks to fill the given axis (`length === 'fill'`). */
  isFill(child: LayoutChild, axis: Axis): boolean;
}
