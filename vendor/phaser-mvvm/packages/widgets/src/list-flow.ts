/**
 * Row-flow shorthands of `List` (`gap` / `rowGap` / `columnGap`) folded into a container spec.
 *
 * `Repeat` reads the row flow from `container` only, so a top-level `gap` used to be one of those
 * options that TypeScript accepts in a doc snippet and the runtime silently ignores - the list simply
 * came out with no spacing. The DSL now understands the shorthands and merges them here.
 *
 * Kept Phaser-free (like `repeat-plan.ts`) so the merge rules are unit-testable in Node.
 */

import type { BoxLayoutOptions, GridLayoutOptions } from '@phaser-mvvm/phaser';

/** The three shorthands `List` accepts next to `container`. */
export interface ListFlowShorthands {
  gap?: number;
  rowGap?: number;
  columnGap?: number;
}

/**
 * Merges the shorthands into `container`.
 *
 * A grid container (`columns`/`rows` present) has no single `gap`: setting one there would be a
 * silently ignored key again, so `gap` is dropped for grids while `rowGap`/`columnGap` still apply.
 * Explicit `container` fields win over the shorthands, because they are the more specific form.
 */
export function withListFlow(
  container: BoxLayoutOptions | GridLayoutOptions | undefined,
  shorthands: ListFlowShorthands,
): BoxLayoutOptions | GridLayoutOptions | undefined {
  const { gap, rowGap, columnGap } = shorthands;
  if (
    container === undefined &&
    gap === undefined &&
    rowGap === undefined &&
    columnGap === undefined
  ) {
    return undefined;
  }
  const merged = { ...(container ?? {}) } as BoxLayoutOptions & GridLayoutOptions;
  const isGrid = merged.columns !== undefined || merged.rows !== undefined;
  if (gap !== undefined && !isGrid && merged.gap === undefined) {
    merged.gap = gap;
  }
  if (rowGap !== undefined && merged.rowGap === undefined) {
    merged.rowGap = rowGap;
  }
  if (columnGap !== undefined && merged.columnGap === undefined) {
    merged.columnGap = columnGap;
  }
  return merged;
}
