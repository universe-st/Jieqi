/**
 * Grid arranger: fixed or automatic column count, cell placement, row/column spanning.
 *
 * ============================ SPECIFICATION (to implement) ============================
 *
 * Defaults: `columns: 'auto'`, `rows: 'auto'`, `minColumnWidth: 120`, `minRowHeight: 100`,
 * `columnGap: 0`, `rowGap: 0`, `justifyItems: 'stretch'`, `alignItems: 'stretch'`,
 * `autoFlow: 'row'`.
 *
 * Flow set: children with `node.inFlow === false` or `params.position === 'absolute'` are skipped;
 * the rest are ordered by `params.order` ascending (stable, ties keep declaration order).
 *
 * Column count:
 *   - `columns: number` ⇒ that many columns (at least 1).
 *   - `columns: 'auto'` ⇒ when the content width is finite:
 *     `max(1, floor((width + columnGap) / (minColumnWidth + columnGap)))`; when unbounded ⇒ the
 *     number of flow children (one single row).
 *   - `rows: number` fixes the row count (extra children overflow into new rows); `'auto'` derives it.
 *
 * Placement:
 *   - Explicit: `params.gridColumn` / `params.gridRow` (1-based) with `gridColumnSpan` /
 *     `gridRowSpan`. Unset values are auto-placed into the next free cell (`autoFlow: 'row'` fills
 *     row-major, `'column'` column-major) skipping cells already occupied by explicit items or spans.
 *
 * `measureGrid(ctx, options)` — returns the container's content size:
 *   - Cell width: when the content main size is definite, `columnWidth = (width − gap × (columns − 1)) / columns`
 *     (columns ≥ 1); otherwise use `minColumnWidth` as the cell width.
 *   - Measure every child with a cell constraint (a tight cell width when it is definite, height
 *     unconstrained) via `ctx.measureChild(child, constraint)`; a spanning item is measured against
 *     the summed span width.
 *   - Row heights: `'auto'` ⇒ max child outer height in the row; `rows: number` ⇒
 *     `minRowHeight` unless content needs more.
 *   - Content = (columns × columnWidth + gaps, Σ rowHeights + rowGaps), i.e. the full grid box.
 *
 * `arrangeGrid(ctx, options)` — assigns final rects inside `ctx.rect`:
 *   - Recompute the column count and column width from the *actual* content box, then build the cell
 *     rects (cell i, j) and place the child of each cell via `ctx.placeChild(child, rect)`:
 *     `justifyItems` / `alignItems` position a non-stretched child inside its cell using
 *     `alignOffset`; `'stretch'` (default) gives the child the full cell rect (minus margins).
 *   - `rect` passed to `placeChild` is the child's **border box** in parent-local coordinates with
 *     margins applied.
 *   - `rowGap` and `columnGap` are applied between rows/columns only (not outside the grid).
 *
 * Requirements: pure, deterministic, no retained state, never mutating `ctx`.
 * ======================================================================================
 *
 * IMPLEMENTATION NOTES (ambiguities resolved here)
 * ------------------------------------------------
 * - Placement is a three-step pass: fully explicit items (`gridColumn` + `gridRow`) claim their
 *   cells first, then partially explicit ones (a locked column scans rows, a locked row scans
 *   columns) and finally the fully automatic items walk a row-major / column-major cursor, skipping
 *   every occupied cell. Explicit indices are clamped into the grid and an explicit span may exceed
 *   it (the cell rect then overflows, exactly like the measure formula predicts).
 * - Column-major flow needs a row limit before the grid is filled: `rows` when it is fixed,
 *   otherwise `ceil(items / columns)` rows, which is what CSS `grid-auto-flow: column` does. The
 *   limit grows on demand when spans cannot fit.
 * - Row heights: with `rows: 'auto'` a row is as tall as its tallest child and *not* floored by
 *   `minRowHeight` (the SPEC's measure rule); with a fixed `rows` count every row is at least
 *   `minRowHeight` tall. A row-spanning child that needs more height than its rows currently offer
 *   spreads the missing height evenly over the rows it covers.
 * - `columns: 'auto'` with a non-positive `minColumnWidth + columnGap` cannot fit an infinite number
 *   of columns, so it falls back to one column per child (the "unbounded" rule).
 * - Container-level `justifyItems` / `alignItems: 'auto'` mean "use the default", i.e. `'stretch'`.
 * - Cells are measured with the cell (or span) width as an *upper* bound rather than as a tight
 *   size: a forced cell width would make every `auto` item report the whole cell and leave
 *   `justifyItems`/`alignItems` nothing to align. The grid box is derived from the column count and
 *   the gaps, so its own measured size does not depend on this choice.
 * - `'stretch'` (and a `'fill'` item) fills the cell; `'fill'` items are filled even under a
 *   non-stretch alignment, because `fill` resolves against the grid's content box instead of the
 *   cell. Non-stretch alignment positions the child's *margin box* inside the cell, so `center`
 *   and `end` account for the leading margin.
 * - Cells never stretch to fill a taller content box: the grid box is the sum of its rows, and any
 *   leftover cross space stays at the bottom (there is no grid equivalent of `alignContent`).
 */

import type { BoxConstraints } from './constraint';
import { clamp, type Rect, type Size } from './geom';
import { alignOffset, axisMaxOf, axisMinOf } from './internal';
import type { Align } from './params';
import type { ArrangerContext, GridLayoutOptions, LayoutChild } from './types';
import { orderedFlowChildren } from './box';

/** Default cell width used with `columns: 'auto'` when the content width is unbounded. */
const DEFAULT_MIN_COLUMN_WIDTH = 120;
/** Default row height used with a fixed `rows` count. */
const DEFAULT_MIN_ROW_HEIGHT = 100;
/** Row stride of the occupancy keys; grids wider than this are beyond any sane layout. */
const CELL_KEY_STRIDE = 65536;
/** A constraint with an unconstrained height, used to measure a cell's child. */
const UNBOUNDED_HEIGHT = Number.POSITIVE_INFINITY;

interface GridPlacement {
  /** 0-based row of every flow child. */
  rowOf: number[];
  /** 0-based column of every flow child. */
  columnOf: number[];
  /** Number of rows the grid spans (at least 1). */
  rows: number;
}

function numberOption(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? value : fallback;
}

function gapOption(value: number | undefined): number {
  return Math.max(0, numberOption(value, 0));
}

/** `'auto'` on a container-level alignment means "keep the default", i.e. `'stretch'`. */
function containerAlign(value: Align | undefined): Align {
  return value === undefined || value === 'auto' ? 'stretch' : value;
}

/**
 * Column count: the declared one, or the SPEC formula `floor((width + gap) / (minColumnWidth + gap))`
 * against the content width. An unbounded width puts every child in one single row.
 */
function columnCountOf(options: GridLayoutOptions, width: number, count: number): number {
  const columns = options.columns;
  if (typeof columns === 'number') {
    return Number.isFinite(columns) ? Math.max(1, Math.floor(columns)) : 1;
  }
  const gap = gapOption(options.columnGap);
  const minColumnWidth = Math.max(
    0,
    numberOption(options.minColumnWidth, DEFAULT_MIN_COLUMN_WIDTH),
  );
  if (!Number.isFinite(width)) {
    return Math.max(1, count);
  }
  const stride = minColumnWidth + gap;
  if (!(stride > 0)) {
    return Math.max(1, count);
  }
  return Math.max(1, Math.floor((width + gap) / stride));
}

/** Cell width of a definite content box: the gaps are taken out before the columns share it. */
function cellWidthOf(width: number, columns: number, columnGap: number): number {
  return Math.max(0, (width - columnGap * (columns - 1)) / columns);
}

/** Width of a cell spanning `span` columns (gaps between the spanned cells included). */
function spanExtent(cellExtent: number, span: number, gap: number): number {
  return Math.max(0, cellExtent * span + gap * (span - 1));
}

/**
 * Cell assignment for the flow children.
 *
 * Explicit items claim their cells first so that automatic items can skip them. The automatic items
 * then walk a cursor in row-major or column-major order; spans simply fail to fit and the cursor
 * moves on.
 */
function placeGridItems(
  items: readonly LayoutChild[],
  options: GridLayoutOptions,
  columns: number,
): GridPlacement {
  const count = items.length;
  const rowOf: number[] = new Array<number>(count).fill(0);
  const columnOf: number[] = new Array<number>(count).fill(0);
  const flow = options.autoFlow ?? 'row';
  const declaredRows =
    typeof options.rows === 'number' && Number.isFinite(options.rows)
      ? Math.max(1, Math.floor(options.rows))
      : null;
  let rowLimit = declaredRows ?? Math.max(1, Math.ceil(count / columns));
  let lastRow = 0;
  let occupied: Set<number> | null = null;

  const isFree = (row: number, column: number, columnSpan: number, rowSpan: number): boolean => {
    if (occupied === null) {
      return true;
    }
    for (let r = row; r < row + rowSpan; r += 1) {
      for (let c = column; c < column + columnSpan; c += 1) {
        if (occupied.has(r * CELL_KEY_STRIDE + c)) {
          return false;
        }
      }
    }
    return true;
  };

  const place = (index: number, row: number, column: number): void => {
    const params = (items[index] as LayoutChild).params;
    const columnSpan = params.gridColumnSpan;
    const rowSpan = params.gridRowSpan;
    rowOf[index] = row;
    columnOf[index] = column;
    if (occupied === null) {
      occupied = new Set<number>();
    }
    for (let r = row; r < row + rowSpan; r += 1) {
      for (let c = column; c < column + columnSpan; c += 1) {
        occupied.add(r * CELL_KEY_STRIDE + c);
      }
    }
    lastRow = Math.max(lastRow, row + rowSpan - 1);
  };

  // 1. Explicit cells (column and/or row locked) are reserved before anything is auto-placed.
  for (let i = 0; i < count; i += 1) {
    const params = (items[i] as LayoutChild).params;
    const column = params.gridColumn;
    const row = params.gridRow;
    if (column === null && row === null) {
      continue;
    }
    const columnSpan = params.gridColumnSpan;
    const rowSpan = params.gridRowSpan;
    if (column !== null && row !== null) {
      place(i, Math.max(0, Math.floor(row) - 1), clampColumn(column, columns));
      continue;
    }
    if (column !== null) {
      const locked = clampColumn(column, columns);
      let candidate = 0;
      while (!isFree(candidate, locked, columnSpan, rowSpan)) {
        candidate += 1;
      }
      place(i, candidate, locked);
      continue;
    }
    const lockedRow = Math.max(0, Math.floor(row as number) - 1);
    let candidate = 0;
    while (!isFree(lockedRow, candidate, columnSpan, rowSpan)) {
      candidate += 1;
    }
    place(i, lockedRow, candidate);
  }

  // 2. Automatic items walk the flow cursor, skipping every occupied cell.
  let cursor = 0;
  for (let i = 0; i < count; i += 1) {
    const params = (items[i] as LayoutChild).params;
    if (params.gridColumn !== null || params.gridRow !== null) {
      continue;
    }
    const columnSpan = params.gridColumnSpan;
    const rowSpan = params.gridRowSpan;
    if (flow === 'column') {
      for (;;) {
        if (cursor >= columns * rowLimit) {
          // Spans did not fit into the balanced rows: give the grid another row and keep looking.
          rowLimit += 1;
          continue;
        }
        const column = Math.floor(cursor / rowLimit);
        const row = cursor % rowLimit;
        if (isFree(row, column, columnSpan, rowSpan)) {
          place(i, row, column);
          cursor += 1;
          break;
        }
        cursor += 1;
      }
      continue;
    }
    for (;;) {
      const row = Math.floor(cursor / columns);
      const column = cursor % columns;
      if (column + columnSpan > columns) {
        cursor = (row + 1) * columns;
        continue;
      }
      if (isFree(row, column, columnSpan, rowSpan)) {
        place(i, row, column);
        cursor += 1;
        break;
      }
      cursor += 1;
    }
  }

  return {
    rowOf,
    columnOf,
    rows: Math.max(declaredRows ?? 1, lastRow + 1),
  };
}

/** Clamps a 1-based explicit column into the grid. */
function clampColumn(column: number, columns: number): number {
  return Math.min(columns - 1, Math.max(0, Math.floor(column) - 1));
}

/**
 * Records a child's outer height requirement: it lands on the first row of its span and any height
 * a spanning child still needs is spread evenly over the rows it covers.
 */
function applyRowHeight(
  rowHeights: number[],
  row: number,
  rowSpan: number,
  height: number,
  rowGap: number,
): void {
  const last = Math.min(rowHeights.length - 1, row + rowSpan - 1);
  if (last <= row) {
    rowHeights[row] = Math.max(rowHeights[row] as number, height);
    return;
  }
  let spanned = rowGap * (last - row);
  for (let r = row; r <= last; r += 1) {
    spanned += rowHeights[r] as number;
  }
  const deficit = height - spanned;
  if (deficit > 0) {
    const share = deficit / (last - row + 1);
    for (let r = row; r <= last; r += 1) {
      rowHeights[r] = (rowHeights[r] as number) + share;
    }
  }
}

/** Floors every row at `minRowHeight`, used when `rows` is a fixed count. */
function applyMinRowHeight(rowHeights: number[], options: GridLayoutOptions): void {
  if (typeof options.rows !== 'number') {
    return;
  }
  const minRowHeight = Math.max(0, numberOption(options.minRowHeight, DEFAULT_MIN_ROW_HEIGHT));
  for (let r = 0; r < rowHeights.length; r += 1) {
    rowHeights[r] = Math.max(rowHeights[r] as number, minRowHeight);
  }
}

export function measureGrid(ctx: ArrangerContext, options: GridLayoutOptions = {}): Size {
  const items = orderedFlowChildren(ctx, false);
  const count = items.length;
  if (count === 0) {
    return { width: 0, height: 0 };
  }

  const columnGap = gapOption(options.columnGap);
  const rowGap = gapOption(options.rowGap);
  const minColumnWidth = Math.max(
    0,
    numberOption(options.minColumnWidth, DEFAULT_MIN_COLUMN_WIDTH),
  );
  const width = ctx.contentSize.width;
  const definite = Number.isFinite(width);
  const columns = columnCountOf(options, width, count);
  const cellWidth = definite ? cellWidthOf(width, columns, columnGap) : minColumnWidth;

  const placement = placeGridItems(items, options, columns);
  const rowHeights: number[] = new Array<number>(placement.rows).fill(0);

  for (let i = 0; i < count; i += 1) {
    const child = items[i] as LayoutChild;
    const cells = spanExtent(cellWidth, child.params.gridColumnSpan, columnGap);
    // The cell width is an *upper* bound, not a forced size: a tight cell width would make every
    // `auto` item report the whole cell and leave `justifyItems`/`alignItems` with nothing to do.
    // The grid box itself is derived from the column count and gaps, so it does not depend on this.
    const constraint: BoxConstraints = {
      minWidth: 0,
      maxWidth: cells,
      minHeight: 0,
      maxHeight: UNBOUNDED_HEIGHT,
    };
    const measured = ctx.measureChild(child, constraint);
    applyRowHeight(
      rowHeights,
      placement.rowOf[i] as number,
      child.params.gridRowSpan,
      measured.height,
      rowGap,
    );
  }

  applyMinRowHeight(rowHeights, options);

  let height = rowGap * (placement.rows - 1);
  for (let r = 0; r < rowHeights.length; r += 1) {
    height += rowHeights[r] as number;
  }

  return {
    width: spanExtent(cellWidth, columns, columnGap),
    height: Math.max(0, height),
  };
}

/** Places a child inside its cell, honouring the container-level item alignment. */
function placeInCell(
  ctx: ArrangerContext,
  child: LayoutChild,
  cell: Rect,
  options: GridLayoutOptions,
): void {
  const margin = child.params.margin;
  const justify = containerAlign(options.justifyItems);
  const align = containerAlign(options.alignItems);
  const outer = ctx.resolveOuterSize(child);
  // `'stretch'` fills the cell; so does a `fill` item, whose length resolves against the grid's
  // content box rather than against the cell it lands in (the cell is its containing block).
  // Stretched/filled cells are clamped by the child's own min/max on that axis, exactly like the
  // measure pass does, so a `maxWidth` keeps working inside a stretching grid.
  const fillWidth = justify === 'stretch' || ctx.isFill(child, 'horizontal');
  const fillHeight = align === 'stretch' || ctx.isFill(child, 'vertical');
  const outerWidth = fillWidth
    ? clamp(
        cell.width - margin.left - margin.right,
        axisMinOf(child.params, 'horizontal'),
        axisMaxOf(child.params, 'horizontal'),
      ) +
      margin.left +
      margin.right
    : outer.width;
  const outerHeight = fillHeight
    ? clamp(
        cell.height - margin.top - margin.bottom,
        axisMinOf(child.params, 'vertical'),
        axisMaxOf(child.params, 'vertical'),
      ) +
      margin.top +
      margin.bottom
    : outer.height;

  ctx.placeChild(child, {
    x: alignOffset(cell.x, cell.width, outerWidth, justify) + margin.left,
    y: alignOffset(cell.y, cell.height, outerHeight, align) + margin.top,
    width: Math.max(0, outerWidth - margin.left - margin.right),
    height: Math.max(0, outerHeight - margin.top - margin.bottom),
  });
}

export function arrangeGrid(ctx: ArrangerContext, options: GridLayoutOptions = {}): void {
  const items = orderedFlowChildren(ctx, false);
  const count = items.length;
  if (count === 0) {
    return;
  }

  const content = ctx.rect;
  const columnGap = gapOption(options.columnGap);
  const rowGap = gapOption(options.rowGap);

  // The column count and the cell width follow the *actual* content box, so the cells fill it.
  const columns = columnCountOf(options, content.width, count);
  const cellWidth = cellWidthOf(content.width, columns, columnGap);

  const placement = placeGridItems(items, options, columns);
  const rowHeights: number[] = new Array<number>(placement.rows).fill(0);

  for (let i = 0; i < count; i += 1) {
    const child = items[i] as LayoutChild;
    const outer = ctx.resolveOuterSize(child);
    applyRowHeight(
      rowHeights,
      placement.rowOf[i] as number,
      child.params.gridRowSpan,
      outer.height,
      rowGap,
    );
  }
  applyMinRowHeight(rowHeights, options);

  const rowOffsets: number[] = new Array<number>(placement.rows).fill(0);
  let offset = content.y;
  for (let r = 0; r < placement.rows; r += 1) {
    rowOffsets[r] = offset;
    offset += (rowHeights[r] as number) + rowGap;
  }

  for (let i = 0; i < count; i += 1) {
    const child = items[i] as LayoutChild;
    const row = placement.rowOf[i] as number;
    const column = placement.columnOf[i] as number;
    const rowSpan = Math.min(child.params.gridRowSpan, placement.rows - row);

    let cellHeight = rowGap * (rowSpan - 1);
    for (let r = row; r < row + rowSpan; r += 1) {
      cellHeight += rowHeights[r] as number;
    }

    placeInCell(
      ctx,
      child,
      {
        x: content.x + column * (cellWidth + columnGap),
        y: rowOffsets[row] as number,
        width: spanExtent(cellWidth, child.params.gridColumnSpan, columnGap),
        height: Math.max(0, cellHeight),
      },
      options,
    );
  }
}
