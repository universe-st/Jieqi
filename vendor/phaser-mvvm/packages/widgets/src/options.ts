/**
 * Option handling shared by the widget library.
 *
 * Every widget mixes node-level `LayoutParams` (`width`, `padding`, `grow`, …) with its own options
 * in one flat object, the same convention the declarative layout containers use. `splitOptions` from
 * the adapter — which is public API — does the split; this module adds the two small helpers the
 * widgets need on top of it, so the widgets themselves stay free of key bookkeeping.
 */

import type { BoxLayoutOptions, LayoutParams } from '@phaser-mvvm/layout';
import { splitOptions, type PointerChainEvent } from '@phaser-mvvm/phaser';

/** Box-container option keys, matching `BoxLayoutOptions` in `@phaser-mvvm/layout`. */
export const BOX_CONTAINER_KEYS = [
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

/**
 * Picks the base-widget options out of a flat bag.
 *
 * Every widget class hands `{ layout, name }` to `Widget`, and the keys that live on the base class
 * have to ride along or they are silently dropped (`focusOrder` was exactly that case: documented as
 * an option, set by nobody). Spreading this keeps the plumbing in one place.
 *
 * The two pointer-chain hooks are here for the same reason: they belong to *every* widget (the chain
 * asks any widget on the path), so a container built as `Panel({ onPointerIntercept })` must reach
 * `Widget` through the same door as `label`.
 */
export function baseWidgetOptions(options: object): {
  name?: string;
  visible?: boolean;
  focusOrder?: number;
  label?: string;
  onPointerIntercept?: (event: PointerChainEvent) => boolean;
  onPointerEvent?: (event: PointerChainEvent) => boolean;
} {
  const bag = optionBag(options);
  const picked: {
    name?: string;
    visible?: boolean;
    focusOrder?: number;
    label?: string;
    onPointerIntercept?: (event: PointerChainEvent) => boolean;
    onPointerEvent?: (event: PointerChainEvent) => boolean;
  } = {};
  if (typeof bag.name === 'string') {
    picked.name = bag.name;
  }
  if (typeof bag.visible === 'boolean') {
    picked.visible = bag.visible;
  }
  if (typeof bag.focusOrder === 'number' && Number.isFinite(bag.focusOrder)) {
    picked.focusOrder = bag.focusOrder;
  }
  if (typeof bag.label === 'string') {
    picked.label = bag.label;
  }
  if (typeof bag.onPointerIntercept === 'function') {
    picked.onPointerIntercept = bag.onPointerIntercept as (event: PointerChainEvent) => boolean;
  }
  if (typeof bag.onPointerEvent === 'function') {
    picked.onPointerEvent = bag.onPointerEvent as (event: PointerChainEvent) => boolean;
  }
  return picked;
}

export interface WidgetOptionSplit<W> {
  /** Node-level params handed to `Widget`. */
  layout: LayoutParams;
  /** Widget-level options, read straight off the typed option bag. */
  widget: W;
}

/**
 * Views a rich options interface as the plain bag `splitOptions` walks.
 *
 * The double assertion is the price of reading a typed option object key by key: an interface has no
 * implicit index signature, while a mapped type such as `Omit<X, K>` does.
 */
export function optionBag(options: object): Record<string, unknown> {
  return options as unknown as Record<string, unknown>;
}

/**
 * Splits a mixed option bag into `LayoutParams` and the widget's own options.
 *
 * Keys listed in `widgetKeys` are moved out of the layout params; everything else flows through to
 * `normalizeParams`, which ignores names it does not know. `name` is dropped by `splitOptions` and
 * must be read from the original object.
 */
export function splitWidgetOptions<W extends Record<string, unknown>>(
  options: Record<string, unknown>,
  widgetKeys: readonly string[],
): WidgetOptionSplit<W> {
  const { layout, container } = splitOptions<W>(options, widgetKeys);
  return { layout, widget: container };
}

/** Collects the box-container keys of a mixed option bag, leaving widget-only keys behind. */
export function boxOptionsOf(source: Record<string, unknown>): BoxLayoutOptions {
  const options: Record<string, unknown> = {};
  for (const key of BOX_CONTAINER_KEYS) {
    const value = source[key];
    if (value !== undefined) {
      options[key] = value;
    }
  }
  return options as BoxLayoutOptions;
}
