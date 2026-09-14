/**
 * Box (flex-like) arranger: vertical and horizontal flow, with optional wrapping.
 *
 * ============================ SPECIFICATION (to implement) ============================
 *
 * Defaults: `direction: 'vertical'`, `gap: 0` (`rowGap`/`columnGap` override it),
 * `justifyContent: 'start'`, `alignItems: 'stretch'`, `wrap: false`, `alignContent: 'start'`,
 * `reverse: false`.
 *
 * Flow set: children with `node.inFlow === false` or `params.position === 'absolute'` are skipped
 * entirely (they are still measured by the engine only when someone asks for them; here: ignore).
 * Remaining children are ordered by `params.order` ascending (stable: ties keep declaration order);
 * `reverse` flips the resulting order.
 *
 * `measureBox(ctx, options)` — returns the container's content size:
 *   - Build either one line (no wrap, or main axis unbounded) or several lines: start a new line
 *     when adding the next child's outer main size (plus the gap) would exceed the available main
 *     extent (`ctx.constraint` max on the main axis when it is finite, otherwise unbounded).
 *   - Measure each child with `ctx.measureChild(child, ctx.constraint)` and use the returned outer
 *     size (margins included).
 *   - Line main size  = Σ child outer main + gap × (count − 1).
 *   - Line cross size = max child outer cross in that line.
 *   - Single line: content = (line main, line cross) on the respective axes.
 *   - Wrapped: content main = Σ line mains (laid out along the main axis, i.e. lines stack along the
 *     *cross* axis: for `direction: 'vertical'` each line is a row of items and lines flow down, so
 *     content height = Σ line crosses + rowGap × (lines − 1) and content width = max line main);
 *     content cross = max line cross.
 *   - Free-space distribution during measure only happens when the main axis is *tight*
 *     (`min === max` on that axis): children with `grow > 0` (or main-axis `'fill'`, treated as
 *     `grow: 1` with basis 0) split the leftover proportionally to their weight, and children with
 *     `shrink > 0` give up space proportionally when overflowing. Otherwise measure with base sizes.
 *
 * `arrangeBox(ctx, options)` — assigns final rects inside `ctx.rect` (the content box):
 *   - Non-wrapped: available main = content main size. Compute each child's preferred outer size
 *     with `ctx.resolveOuterSize(child)` (percent lengths resolve against the *actual* content box).
 *     leftover = available main − Σ outer main − gap × (count − 1).
 *     Grow: if leftover > 0, distribute it proportionally to `grow` (main-axis `'fill'` ⇒ `grow: 1`),
 *     growing only the main size.
 *     Shrink: if leftover < 0 and Σ shrink weights > 0, remove space proportionally to
 *     `shrink × base main size`, never below 0.
 *     Remaining leftover (after grow/shrink) is distributed by `justifyContent` using
 *     `distribute(leftover, count, justify)` from `./internal` (gap is applied on top of that).
 *   - Cross axis per child: `alignSelf` if not `'auto'`, else `alignItems`.
 *     `'stretch'` ⇒ cross size = line cross size (minus the child's cross margins);
 *     otherwise use the resolved outer cross size and align with `alignOffset` inside the line.
 *   - Wrapped: compute line cross sizes first (max child cross, stretch-aware), distribute leftover
 *     cross space across lines with `alignContent` via `distribute(...)`, then place each line's
 *     children along the main axis using `justifyContent`.
 *   - Every placement goes through `ctx.placeChild(child, rect)`; `rect` is the child's **border
 *     box** in the parent's local coordinates with margins applied
 *     (`x = mainOffset + margin.left`, `y = lineOffset + margin.top`, …).
 *
 * Requirements: pure (no state kept between calls), no per-call allocations beyond the rect objects
 * handed to `placeChild`, deterministic ordering, and never mutating `ctx.constraint`/`ctx.children`.
 * ======================================================================================
 *
 * IMPLEMENTATION NOTES (ambiguities resolved here)
 * ------------------------------------------------
 * - Line breaking always happens along the *main* axis (the SPEC rule), therefore the lines stack
 *   along the *cross* axis: for `direction: 'vertical'` a line is a column of items and the lines
 *   are laid out left to right. The content size follows from that geometry — the main extent is
 *   the largest line and the cross extent is the sum of the line crosses plus the cross-axis gap —
 *   which is the flex/most-consistent reading of the SPEC ("lines stack along the cross axis");
 *   the literal `height = Σ line crosses + rowGap × (lines − 1)` example in the SPEC describes the
 *   horizontal (row-wrap) case.
 * - A main-axis `'fill'` child contributes base size 0 and grow weight 1, so it absorbs the leftover
 *   instead of forcing a wrap; an explicit `grow > 0` wins over that implicit 1. A resolvable
 *   `basis` replaces the measured base main size, and — as with CSS `flex-basis` — it also becomes
 *   the child's main-axis size whenever nothing grows or shrinks it.
 * - `'stretch'` gives the child the whole line cross size (minus its cross margins) even when the
 *   child declares a cross length, as the SPEC states literally. A cross-axis `'fill'` child gets
 *   the line cross size as well, because `fill` resolves against the container's content box rather
 *   than against the line it lands in.
 * - Cross-axis alignment positions the child's *margin box* inside the line, so `center`/`end`
 *   account for the leading margin.
 * - Free-space distribution during measure is skipped when the "tight" main extent is unbounded
 *   (`min === max === Infinity`), which would otherwise produce Infinite sizes. Note that the engine
 *   hands containers a *loosened* constraint (children are never forced to fill their parent), so in
 *   practice this branch only fires for a zero-extent axis: all free space is distributed in the
 *   arrange pass. The resulting geometry is identical either way, because the engine clamps the
 *   container's measured content into the container's own constraint.
 * - A local array is allocated only when children must be filtered/sorted/reversed, plus one small
 *   working set per call; the placement path itself allocates nothing per child beyond the rect
 *   handed to `placeChild`.
 */

import type { BoxConstraints } from './constraint';
import { clamp, type Insets, type Rect, type Size } from './geom';
import { axisMaxOf, axisMinOf, alignOffset, distribute } from './internal';
import { alignSelfOf, crossAxisOf, mainAxisOf, resolveLength } from './params';
import type { Align, Axis, Justify } from './params';
import type { ArrangerContext, BoxLayoutOptions, LayoutChild } from './types';

/** `true` for children that take part in the flow. */
function isFlowChild(child: LayoutChild): boolean {
  return child.node.inFlow && child.params.position !== 'absolute';
}

/**
 * Flow children of a box/grid container, in visual order.
 *
 * Out-of-flow and absolute children are dropped, the rest are sorted by `params.order` ascending
 * (stable, so ties keep declaration order) and reversed when `reverse` is set. `ctx.children` is
 * returned untouched when no work is needed, so the common case allocates nothing.
 */
export function orderedFlowChildren(
  ctx: ArrangerContext,
  reverse: boolean,
): readonly LayoutChild[] {
  const declared = ctx.children;
  let keepAll = true;
  let sorted = true;
  let previous = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < declared.length; i += 1) {
    const child = declared[i] as LayoutChild;
    if (!isFlowChild(child)) {
      keepAll = false;
      continue;
    }
    if (child.params.order < previous) {
      sorted = false;
    }
    previous = child.params.order;
  }
  if (keepAll && sorted && !reverse) {
    return declared;
  }

  const flow: LayoutChild[] = [];
  for (let i = 0; i < declared.length; i += 1) {
    const child = declared[i] as LayoutChild;
    if (isFlowChild(child)) {
      flow.push(child);
    }
  }
  if (!sorted) {
    flow.sort((a, b) => a.params.order - b.params.order);
  }
  if (reverse) {
    flow.reverse();
  }
  return flow;
}

/** Gap between two siblings on `axis`; `rowGap`/`columnGap` override the `gap` shorthand. */
function gapOf(options: BoxLayoutOptions, axis: Axis): number {
  const gap = options.gap ?? 0;
  return (axis === 'vertical' ? options.rowGap : options.columnGap) ?? gap;
}

function extentOf(axis: Axis, value: Size): number {
  return axis === 'horizontal' ? value.width : value.height;
}

function minExtent(constraint: BoxConstraints, axis: Axis): number {
  return axis === 'horizontal' ? constraint.minWidth : constraint.minHeight;
}

function maxExtent(constraint: BoxConstraints, axis: Axis): number {
  return axis === 'horizontal' ? constraint.maxWidth : constraint.maxHeight;
}

function marginStart(axis: Axis, margin: Insets): number {
  return axis === 'horizontal' ? margin.left : margin.top;
}

function marginEnd(axis: Axis, margin: Insets): number {
  return axis === 'horizontal' ? margin.right : margin.bottom;
}

/** Grow weight of a child: its own `grow`, or 1 for a main-axis `fill`. */
function growWeightOf(ctx: ArrangerContext, child: LayoutChild, axis: Axis): number {
  const grow = child.params.grow;
  if (grow > 0) {
    return grow;
  }
  return ctx.isFill(child, axis) ? 1 : 0;
}

/**
 * Main-axis size a child contributes before `grow`/`shrink` is applied.
 *
 * A main-axis `fill` child contributes 0 (it grows into the leftover space; the engine resolves
 * `fill` to the whole content box while measuring, which must not count as a base size). A
 * resolvable `basis` wins over the measured outer size.
 */
function baseMainOf(ctx: ArrangerContext, child: LayoutChild, axis: Axis, outer: Size): number {
  const params = child.params;
  if (ctx.isFill(child, axis)) {
    return 0;
  }
  if (params.basis !== null) {
    const resolved = resolveLength(params.basis, extentOf(axis, ctx.contentSize));
    if (resolved !== null) {
      return (
        Math.max(0, resolved) + marginStart(axis, params.margin) + marginEnd(axis, params.margin)
      );
    }
  }
  return extentOf(axis, outer);
}

/**
 * Greedy line breaking along the main axis.
 *
 * `ends` receives the exclusive end index of every line; the number of lines is returned. Without
 * wrapping (or with an unbounded main extent) a single line holding every child is produced.
 */
function breakLines(
  sizes: readonly number[],
  count: number,
  gap: number,
  limit: number,
  wraps: boolean,
  ends: number[],
): number {
  if (!wraps) {
    ends.push(count);
    return 1;
  }
  let lines = 0;
  let start = 0;
  let used = 0;
  for (let i = 0; i < count; i += 1) {
    const size = sizes[i] as number;
    const needed = i === start ? size : used + gap + size;
    if (i > start && needed > limit) {
      ends.push(i);
      lines += 1;
      start = i;
      used = size;
    } else {
      used = needed;
    }
  }
  ends.push(count);
  return lines + 1;
}

/**
 * Applies `grow`/`shrink` to one line in place and returns the resulting main extent.
 *
 * `extent === null` means the axis is not tight: the base sizes are kept (the measure pass only
 * distributes free space into a tight axis). Free space is handed out proportionally to `grow`
 * (main-axis `fill` counts as 1); overflow is taken back proportionally to
 * `shrink × base size`, never going below 0.
 */
function flexLine(
  ctx: ArrangerContext,
  items: readonly LayoutChild[],
  sizes: number[],
  start: number,
  end: number,
  axis: Axis,
  gap: number,
  extent: number | null,
): number {
  const count = end - start;
  const gaps = gap * (count - 1);
  let total = 0;
  for (let i = start; i < end; i += 1) {
    total += sizes[i] as number;
  }
  if (extent === null) {
    return total + gaps;
  }

  const leftover = extent - total - gaps;
  if (leftover > 0) {
    let weight = 0;
    for (let i = start; i < end; i += 1) {
      weight += growWeightOf(ctx, items[i] as LayoutChild, axis);
    }
    if (weight > 0) {
      for (let i = start; i < end; i += 1) {
        const child = items[i] as LayoutChild;
        sizes[i] = (sizes[i] as number) + (leftover * growWeightOf(ctx, child, axis)) / weight;
      }
      total = extent - gaps;
    }
  } else if (leftover < 0) {
    let weight = 0;
    for (let i = start; i < end; i += 1) {
      const shrink = (items[i] as LayoutChild).params.shrink;
      weight += (shrink > 0 ? shrink : 0) * (sizes[i] as number);
    }
    if (weight > 0) {
      const deficit = -leftover;
      total = 0;
      for (let i = start; i < end; i += 1) {
        const shrink = (items[i] as LayoutChild).params.shrink;
        const base = sizes[i] as number;
        const next = Math.max(0, base - (deficit * (shrink > 0 ? shrink : 0) * base) / weight);
        sizes[i] = next;
        total += next;
      }
    }
  }
  return total + gaps;
}

/** Arranger-local working set; one instance per call keeps the arrangers reentrant. */
interface BoxFlow {
  items: readonly LayoutChild[];
  /** Main axis of the flow. */
  axis: Axis;
  /** Gap between two siblings on the main axis. */
  gap: number;
  /** Available main extent of the content box. */
  extent: number;
  justify: Justify;
  alignItems: Align;
  /** Main-axis start of the content box, in parent-local coordinates. */
  origin: number;
  /** Outer main size per child, rewritten with the flexed sizes. */
  mains: number[];
  /** Preferred outer cross size per child, before alignment. */
  crosses: number[];
}

/** Places one line of children: main axis by `justifyContent`, cross axis by `alignSelf`. */
function placeLine(
  ctx: ArrangerContext,
  flow: BoxFlow,
  start: number,
  end: number,
  crossPosition: number,
  lineCross: number,
): void {
  const axis = flow.axis;
  const crossAxis = crossAxisOf(axis);
  const count = end - start;
  let total = 0;
  for (let i = start; i < end; i += 1) {
    total += flow.mains[i] as number;
  }
  const alignment = distribute(flow.extent - total - flow.gap * (count - 1), count, flow.justify);
  let position = flow.origin + alignment.leading;

  for (let i = start; i < end; i += 1) {
    const child = flow.items[i] as LayoutChild;
    const margin = child.params.margin;
    const align = alignSelfOf(child.params.alignSelf, flow.alignItems);
    const outerMain = flow.mains[i] as number;
    // `'stretch'` fills the line; so does a cross-axis `fill` item, whose length resolves against
    // the container's content box rather than against the line it lands in. Both are clamped by the
    // child's own cross-axis min/max — the measure pass clamps the same way, and letting the arrange
    // pass hand out a bigger box would make `maxWidth` a no-op inside a stretching container (and
    // make the two passes disagree about the child's size).
    let outerCross =
      align === 'stretch' || ctx.isFill(child, crossAxis) ? lineCross : (flow.crosses[i] as number);
    if (align === 'stretch' || ctx.isFill(child, crossAxis)) {
      const crossMargins = marginStart(crossAxis, margin) + marginEnd(crossAxis, margin);
      outerCross =
        clamp(
          outerCross - crossMargins,
          axisMinOf(child.params, crossAxis),
          axisMaxOf(child.params, crossAxis),
        ) + crossMargins;
    }
    const borderMain = Math.max(0, outerMain - marginStart(axis, margin) - marginEnd(axis, margin));
    const borderCross = Math.max(
      0,
      outerCross - marginStart(crossAxis, margin) - marginEnd(crossAxis, margin),
    );
    const mainPosition = position + marginStart(axis, margin);
    const crossPositionOfChild =
      alignOffset(crossPosition, lineCross, outerCross, align) + marginStart(crossAxis, margin);

    const rect: Rect =
      axis === 'horizontal'
        ? {
            x: mainPosition,
            y: crossPositionOfChild,
            width: borderMain,
            height: borderCross,
          }
        : {
            x: crossPositionOfChild,
            y: mainPosition,
            width: borderCross,
            height: borderMain,
          };
    ctx.placeChild(child, rect);

    position += outerMain + flow.gap + alignment.between;
  }
}

export function measureBox(ctx: ArrangerContext, options: BoxLayoutOptions = {}): Size {
  const axis = mainAxisOf(options.direction ?? 'vertical');
  const crossAxis = crossAxisOf(axis);
  const gap = gapOf(options, axis);
  const crossGap = gapOf(options, crossAxis);
  const items = orderedFlowChildren(ctx, options.reverse === true);
  const count = items.length;
  if (count === 0) {
    return { width: 0, height: 0 };
  }

  const bases: number[] = new Array<number>(count);
  const crosses: number[] = new Array<number>(count);
  for (let i = 0; i < count; i += 1) {
    const child = items[i] as LayoutChild;
    const measured = ctx.measureChild(child, ctx.constraint);
    bases[i] = baseMainOf(ctx, child, axis, measured);
    crosses[i] = extentOf(crossAxis, measured);
  }

  const limit = maxExtent(ctx.constraint, axis);
  const bounded = Number.isFinite(limit);
  const wraps = options.wrap === true && bounded;
  const tight = bounded && minExtent(ctx.constraint, axis) === limit ? limit : null;

  const lines: number[] = [];
  const lineCount = breakLines(bases, count, gap, limit, wraps, lines);

  let contentMain = 0;
  let contentCross = 0;
  let start = 0;
  for (let line = 0; line < lineCount; line += 1) {
    const end = lines[line] as number;
    const lineMain = flexLine(ctx, items, bases, start, end, axis, gap, tight);
    let lineCross = 0;
    for (let i = start; i < end; i += 1) {
      lineCross = Math.max(lineCross, crosses[i] as number);
    }
    if (wraps) {
      contentMain = Math.max(contentMain, lineMain);
      contentCross += lineCross + (line > 0 ? crossGap : 0);
    } else {
      contentMain = lineMain;
      contentCross = lineCross;
    }
    start = end;
  }

  return axis === 'horizontal'
    ? { width: contentMain, height: contentCross }
    : { width: contentCross, height: contentMain };
}

export function arrangeBox(ctx: ArrangerContext, options: BoxLayoutOptions = {}): void {
  const axis = mainAxisOf(options.direction ?? 'vertical');
  const crossAxis = crossAxisOf(axis);
  const gap = gapOf(options, axis);
  const crossGap = gapOf(options, crossAxis);
  const items = orderedFlowChildren(ctx, options.reverse === true);
  const count = items.length;
  if (count === 0) {
    return;
  }

  const content = ctx.rect;
  const extent = extentOf(axis, content);
  const availableCross = extentOf(crossAxis, content);

  const mains: number[] = new Array<number>(count);
  const crosses: number[] = new Array<number>(count);
  for (let i = 0; i < count; i += 1) {
    const child = items[i] as LayoutChild;
    const outer = ctx.resolveOuterSize(child);
    mains[i] = baseMainOf(ctx, child, axis, outer);
    crosses[i] = extentOf(crossAxis, outer);
  }

  const wraps = options.wrap === true && Number.isFinite(extent);
  const lines: number[] = [];
  const lineCount = breakLines(mains, count, gap, extent, wraps, lines);

  const flow: BoxFlow = {
    items,
    axis,
    gap,
    extent,
    justify: options.justifyContent ?? 'start',
    alignItems: options.alignItems ?? 'stretch',
    origin: axis === 'horizontal' ? content.x : content.y,
    mains,
    crosses,
  };

  const lineCrosses: number[] = new Array<number>(lineCount);
  let usedCross = 0;
  let start = 0;
  for (let line = 0; line < lineCount; line += 1) {
    const end = lines[line] as number;
    let lineCross = wraps ? 0 : availableCross;
    if (wraps) {
      for (let i = start; i < end; i += 1) {
        lineCross = Math.max(lineCross, crosses[i] as number);
      }
    }
    flexLine(ctx, items, mains, start, end, axis, gap, extent);
    lineCrosses[line] = lineCross;
    usedCross += lineCross + (line > 0 ? crossGap : 0);
    start = end;
  }

  const crossOrigin = axis === 'horizontal' ? content.y : content.x;
  const alignment = distribute(
    availableCross - usedCross,
    lineCount,
    options.alignContent ?? 'start',
  );
  let crossPosition = crossOrigin + alignment.leading;
  start = 0;
  for (let line = 0; line < lineCount; line += 1) {
    const end = lines[line] as number;
    const lineCross = lineCrosses[line] as number;
    placeLine(ctx, flow, start, end, crossPosition, lineCross);
    crossPosition += lineCross + crossGap + alignment.between;
    start = end;
  }
}
