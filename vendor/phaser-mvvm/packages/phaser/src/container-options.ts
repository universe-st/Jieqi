/**
 * Container option keys, by container type — the table that lets one option bag be split at
 * construction time *and* patched at runtime.
 *
 * It lives outside `LayoutWidget.ts` and `Widget.ts` on purpose: both need it, and they cannot import
 * each other (`BoxWidget extends Widget` runs at module evaluation, where a circular import is fatal).
 *
 * The lists mirror `BoxLayoutOptions`/`GridLayoutOptions`/`StackLayoutOptions` in `@phaser-mvvm/layout`.
 * `runtimeOptionTarget()` is the one place that answers "is this key a runtime slot, and which half of the
 * bag does it patch?", so the DSL's slot binding and `Widget#setContainerOptions()` cannot disagree.
 */

import { LAYOUT_PARAM_KEYS } from '@phaser-mvvm/layout';

/** Box container option keys (`Column`/`Row`/`Panel`). */
export const BOX_KEYS = [
  'direction',
  'gap',
  'rowGap',
  'columnGap',
  'justifyContent',
  'alignItems',
  'wrap',
  'alignContent',
  'reverse',
] as const;

/** Grid container option keys. */
export const GRID_KEYS = [
  'columns',
  'rows',
  'minColumnWidth',
  'minRowHeight',
  'columnGap',
  'rowGap',
  'justifyItems',
  'alignItems',
  'autoFlow',
] as const;

/** Stack container option keys. */
export const STACK_KEYS = ['align'] as const;

/**
 * Every container type's keys.
 *
 * `absolute` positions its children with per-node offsets (`position: 'absolute'` + `left`/`top`), so it
 * has no container options of its own. `scroll` belongs to `ScrollView`, whose scrolling options are
 * *widget* options (`direction`, `inertia`, …) rather than layout ones — the `scroll` container the layout
 * engine sees carries none of them.
 */
export const CONTAINER_OPTION_KEYS: Readonly<Record<string, readonly string[]>> = {
  box: BOX_KEYS,
  grid: GRID_KEYS,
  stack: STACK_KEYS,
  absolute: [],
  scroll: [],
};

const LAYOUT_KEYS: ReadonlySet<string> = new Set<string>(LAYOUT_PARAM_KEYS as readonly string[]);

/** Which half of a widget's option bag a runtime patch of `key` goes to, or `null` for "not an option". */
export type RuntimeOptionTarget = 'layout' | 'container';

/**
 * Classifies one option key for a widget whose container is `containerType`.
 *
 * `layout` → {@link Widget.setLayoutParams} (the widget's own box: `width`, `padding`, `grow`, …);
 * `container` → {@link Widget.setContainerOptions} (how it lays its children out: `gap`, `alignItems`, …);
 * `null` → the key is neither, so a runtime patch would be a silent no-op.
 *
 * This is what the DSL asks before it turns a `Ref`/getter into a slot: a callback option
 * (`onClick`, `validate`) is also "a function", so the decision cannot be made from the value's shape.
 */
export function runtimeOptionTarget(
  containerType: string | null | undefined,
  key: string,
): RuntimeOptionTarget | null {
  if (LAYOUT_KEYS.has(key)) {
    return 'layout';
  }
  const keys = containerType ? CONTAINER_OPTION_KEYS[containerType] : undefined;
  return keys?.includes(key) ? 'container' : null;
}
