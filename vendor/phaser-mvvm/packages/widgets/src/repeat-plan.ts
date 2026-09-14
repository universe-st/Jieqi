/**
 * Pure planning helpers behind `Repeat` (PLAN §4.4, `repeat` row).
 *
 * Nothing here touches Phaser or the layout engine, which is what makes the interesting parts of a
 * keyed, optionally virtualised list testable in plain Node:
 *
 * - `diffKeys` / `planRepeatUpdate` — the keyed diff (added / removed / moved / kept);
 * - `computeVisibleRange` — the row window of a virtualised list;
 * - `planVirtualWindow` — the same window plus the leading/trailing filler heights that keep the
 *   visible rows at their real scroll position;
 * - `resolveRepeatContainer` / `describeRepeatFlow` — the container algorithm and the flow metrics
 *   (items per row, gap) the window maths needs.
 */

import type { BoxLayoutOptions, ContainerLayout, GridLayoutOptions } from '@phaser-mvvm/layout';

/** Keys that only a grid container understands (used to tell the two option bags apart). */
const GRID_ONLY_KEYS = [
  'columns',
  'rows',
  'minColumnWidth',
  'minRowHeight',
  'justifyItems',
  'autoFlow',
] as const;

/** The keyed diff of two key lists. */
export interface KeyDiff {
  /** Keys new in `next`, in `next` order (duplicates collapsed). */
  added: string[];
  /** Keys gone since `prev`, in `prev` order (duplicates collapsed). */
  removed: string[];
  /** Keys present in both, in `next` order (duplicates collapsed). */
  kept: string[];
  /** Kept keys whose position *among the kept keys* changed — a real reorder, not a shift. */
  moved: string[];
}

/** Everything `Repeat` needs to turn two key lists into widget operations. */
export interface RepeatUpdatePlan extends KeyDiff {
  /** The desired key order (exactly `next`, duplicates included). */
  order: string[];
  /** `true` when the two lists describe the same rows in the same order. */
  unchanged: boolean;
  /** Keys that appear more than once in `next` (a `key` function bug the caller should fix). */
  duplicates: string[];
}

/** Half-open row window of a virtualised list: `[start, end)`. */
export interface VisibleRange {
  /** First visible row index. */
  start: number;
  /** One past the last visible row index. */
  end: number;
}

/** A row window plus the filler heights that keep the rows at their real scroll position. */
export interface VirtualWindow extends VisibleRange {
  /** Height of the filler that stands for the rows above the window. */
  leading: number;
  /** Height of the filler that stands for the rows below the window. */
  trailing: number;
}

export interface VirtualWindowOptions {
  /** Scroll offset along the flow axis, in pixels. */
  offset: number;
  /** Visible size of the scroll viewport, in pixels. */
  viewport: number;
  /** Uniform extent of one row (height, gap included), in pixels. */
  itemExtent: number;
  /** Total number of items. */
  count: number;
  /** Extra rows mounted above and below the window. Defaults to `0`. */
  overscan?: number;
  /** Items per row: `1` for a vertical box, the column count for a grid. Defaults to `1`. */
  perRow?: number;
  /** Flow gap between two rows; subtracted from the fillers so the geometry stays exact. */
  gap?: number;
}

/** How a container flows its rows, as far as the window maths is concerned. */
export interface RepeatFlow {
  /** Flow axis of the container. */
  axis: 'vertical' | 'horizontal' | 'none';
  /** Items placed per row (`0` when the flow cannot be predicted, e.g. `columns: 'auto'`). */
  perRow: number;
  /** Main-axis gap between two rows. */
  gap: number;
  /** `true` when a uniform `itemExtent` describes a row window of this container. */
  virtualizable: boolean;
}

/** First occurrence order, duplicates dropped. */
function unique(keys: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const key of keys) {
    if (!seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  }
  return out;
}

/**
 * Compares two key lists.
 *
 * Keys are identifiers, so duplicates are collapsed to their first occurrence; `planRepeatUpdate`
 * reports them separately (`duplicates`) because a repeated key means the caller's `key` function is
 * not unique. `moved` compares the *relative* order of the surviving keys, so inserting or deleting
 * a row does not mark every later row as moved.
 */
export function diffKeys(prev: readonly string[], next: readonly string[]): KeyDiff {
  const prevSet = new Set(prev);
  const nextSet = new Set(next);

  const added = unique(next.filter((key) => !prevSet.has(key)));
  const removed = unique(prev.filter((key) => !nextSet.has(key)));
  const kept = unique(next.filter((key) => prevSet.has(key)));
  const prevKept = unique(prev.filter((key) => nextSet.has(key)));
  const moved = kept.filter((key, index) => prevKept[index] !== key);

  return { added, removed, moved, kept };
}

/** The full repeat plan: the diff plus the desired order and the pathological-case report. */
export function planRepeatUpdate(
  prevKeys: readonly string[],
  nextKeys: readonly string[],
): RepeatUpdatePlan {
  const counts = new Map<string, number>();
  for (const key of nextKeys) {
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const duplicates: string[] = [];
  for (const [key, count] of counts) {
    if (count > 1) {
      duplicates.push(key);
    }
  }

  return {
    ...diffKeys(prevKeys, nextKeys),
    order: nextKeys.slice(),
    unchanged:
      prevKeys.length === nextKeys.length &&
      prevKeys.every((key, index) => key === nextKeys[index]),
    duplicates,
  };
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/**
 * Row window of a virtualised list: the rows intersecting `[offset, offset + viewport)`, padded by
 * `overscan` rows on both sides and clamped to `[0, count)`.
 *
 * `end` is exclusive. A non-positive `itemExtent` means "cannot virtualise", which yields the whole
 * range — the same degradation `Repeat` reports with a dev warning.
 */
export function computeVisibleRange(
  offset: number,
  viewport: number,
  itemExtent: number,
  count: number,
  overscan = 0,
): VisibleRange {
  const total = Math.max(0, Math.floor(finiteNumber(count, 0)));
  if (total === 0) {
    return { start: 0, end: 0 };
  }

  const extent = finiteNumber(itemExtent, 0);
  if (extent <= 0) {
    return { start: 0, end: total };
  }

  const scroll = Math.max(0, finiteNumber(offset, 0));
  const size = Math.max(0, finiteNumber(viewport, 0));
  const pad = Math.max(0, Math.floor(finiteNumber(overscan, 0)));

  const first = Math.max(0, Math.floor(scroll / extent));
  const rows = size > 0 ? Math.ceil(size / extent) : 0;
  const start = clamp(first - pad, 0, total);
  const end = clamp(first + rows + pad, start, total);

  return { start, end };
}

/**
 * Full length of a virtualised list in pixels, viewport excluded.
 *
 * `itemExtent` includes the flow gap, so the length is `count × extent − gap` (the last row has no gap
 * after it). Non-finite and non-positive inputs collapse to 0 instead of a negative length.
 */
export function contentExtentOf(itemCount: number, itemExtent: number, gap: number): number {
  if (!Number.isFinite(itemCount) || !Number.isFinite(itemExtent) || !Number.isFinite(gap)) {
    return 0;
  }
  if (itemCount <= 0 || itemExtent <= 0) {
    return 0;
  }
  return Math.max(0, itemCount * itemExtent - gap);
}

/**
 * The window plus the filler heights a box/grid container needs.
 *
 * The fillers reproduce the exact layout the full list would have: with a flow gap `g`, a row `i`
 * starts at `i * itemExtent` (where `itemExtent` already includes `g`), so the leading filler is
 * `start * itemExtent - g` (a gap follows it) and the trailing filler is
 * `(rows - end) * itemExtent - g`. Both are clamped at `0` and omitted when the window touches the
 * corresponding end of the list.
 */
export function planVirtualWindow(options: VirtualWindowOptions): VirtualWindow {
  const total = Math.max(0, Math.floor(finiteNumber(options.count, 0)));
  const perRow = Math.max(1, Math.floor(finiteNumber(options.perRow ?? 1, 1)));
  const extent = finiteNumber(options.itemExtent, 0);
  const gap = Math.max(0, finiteNumber(options.gap ?? 0, 0));
  const rows = Math.ceil(total / perRow);

  const range = computeVisibleRange(
    options.offset,
    options.viewport,
    extent,
    rows,
    options.overscan ?? 0,
  );

  const start = Math.min(total, range.start * perRow);
  const end = Math.min(total, range.end * perRow);
  const leading = range.start > 0 ? Math.max(0, range.start * extent - gap) : 0;
  const trailing = end < total ? Math.max(0, (rows - range.end) * extent - gap) : 0;

  return { start, end, leading, trailing };
}

/** `true` when an option bag describes a grid container. */
export function isGridContainerOptions(
  options: BoxLayoutOptions | GridLayoutOptions,
): options is GridLayoutOptions {
  if ((options as { type?: string }).type === 'grid') {
    return true;
  }
  return GRID_ONLY_KEYS.some((key) => (options as Record<string, unknown>)[key] !== undefined);
}

/** Normalises the `container` option of `Repeat`, defaulting to a vertical box. */
export function resolveRepeatContainer(
  container?: BoxLayoutOptions | GridLayoutOptions,
): ContainerLayout {
  if (container === undefined) {
    return { type: 'box', options: { direction: 'vertical' } };
  }
  if (isGridContainerOptions(container)) {
    return { type: 'grid', options: { ...container } };
  }
  return { type: 'box', options: { ...container, direction: container.direction ?? 'vertical' } };
}

/** Items per row, gap and virtualisability of a resolved container. */
export function describeRepeatFlow(container: ContainerLayout | null): RepeatFlow {
  if (container === null) {
    return { axis: 'none', perRow: 0, gap: 0, virtualizable: false };
  }

  if (container.type === 'box') {
    const options = container.options;
    const horizontal = options.direction === 'horizontal';
    const gap = Math.max(
      0,
      finiteNumber(
        horizontal ? (options.columnGap ?? options.gap) : (options.rowGap ?? options.gap),
        0,
      ),
    );
    return {
      axis: horizontal ? 'horizontal' : 'vertical',
      perRow: 1,
      gap,
      // M6 virtualises the vertical flow only: the viewport it measures is a height.
      virtualizable: !horizontal,
    };
  }

  if (container.type === 'grid') {
    const options = container.options;
    const columns = options.columns;
    const perRow = typeof columns === 'number' && columns > 0 ? Math.floor(columns) : 0;
    return {
      axis: 'vertical',
      perRow,
      gap: Math.max(0, finiteNumber(options.rowGap, 0)),
      // Virtualising a grid needs filler *rows* of empty cells; M6 covers the box flow only.
      virtualizable: false,
    };
  }

  return { axis: 'none', perRow: 0, gap: 0, virtualizable: false };
}
