/**
 * `Repeat` — the list renderer (PLAN §4.4, `repeat` row).
 *
 * A `Repeat` owns nothing but the mapping from a reactive item collection to widgets:
 *
 * - `items()` is read inside an `effect` owned by the widget scope with `flush: 'frame'`, so any
 *   number of collection changes in one frame costs exactly one keyed diff (ADR-0008 §3);
 * - the diff is **keyed**: rows whose key survived are reused, only a real reorder re-attaches the
 *   children (through `addWidget` order), and nothing is rebuilt unless its key or item identity
 *   changed;
 * - a row whose key survived but whose *item reference* changed either goes through the optional
 *   `update` callback or is rebuilt — the caller decides which is cheaper;
 * - `virtualize: true` mounts only the visible window (plus `overscan` rows), positioned by two
 *   filler widgets so the rows still sit at their real scroll offset; `setScrollOffset()` moves it.
 *
 * The pure half of all this (`diffKeys`, `planRepeatUpdate`, `computeVisibleRange`,
 * `planVirtualWindow`) lives in `repeat-plan.ts` and is unit-tested without Phaser.
 */

import Phaser from 'phaser';
import type {
  BoxConstraints,
  BoxLayoutOptions,
  GridLayoutOptions,
  LayoutParams,
  Rect,
  Size,
} from '@phaser-mvvm/layout';
import {
  BindingContext,
  createBinding,
  reactive,
  warn,
  devLog,
  isDevMode,
} from '@phaser-mvvm/core';
import type { PathScope, StopBinding } from '@phaser-mvvm/core';
import { Widget } from '@phaser-mvvm/phaser';
import { optionBag, splitWidgetOptions, baseWidgetOptions } from './options';
import {
  contentExtentOf,
  describeRepeatFlow,
  planRepeatUpdate,
  planVirtualWindow,
  resolveRepeatContainer,
  type RepeatFlow,
  type VirtualWindow,
} from './repeat-plan';

/** Rows mounted above and below the visible window when `overscan` is not given. */
export const DEFAULT_OVERSCAN = 2;

export interface RepeatOptions<Item> extends LayoutParams {
  /** Reactive source of the list. Read inside a `flush: 'frame'` effect. */
  items: () => readonly Item[];
  /** Stable identity of an item; a repeated key is reported through `planRepeatUpdate`. */
  key: (item: Item, index: number) => string | number;
  /** Builds the widget of one row. `context` carries `$item`, `$index`, `$root` and `$parent`. */
  template: (item: Item, index: number, ctx: BindingContext) => Widget;
  /**
   * Called when a row's key survived but its item reference changed. Without it such a row is
   * rebuilt from `template`.
   */
  update?: (widget: Widget, item: Item, index: number) => void;
  /** Container algorithm of the rows. Defaults to a vertical box. */
  container?: BoxLayoutOptions | GridLayoutOptions;
  /** Mounts only the visible window. Needs `itemExtent` and a vertical box container. */
  virtualize?: boolean;
  /** Uniform extent of one row (its height *including* the flow gap), in design pixels. */
  itemExtent?: number;
  /** Extra rows mounted above and below the window. Defaults to `DEFAULT_OVERSCAN`. */
  overscan?: number;
  /** Widget shown when the list is empty; `null` (the default) shows nothing. */
  empty?: (() => Widget) | null;
  /**
   * Parent scope of the rows (an addition to the PLAN field list): with it a row template reaches
   * the page view model through `$root`/`$parent`. Defaults to an empty root scope, in which case a
   * row template can still use `$item`, `$index` and the item's own fields.
   */
  context?: BindingContext;
  name?: string;
  /** Tab order hint for the focus manager (lower first). */
  focusOrder?: number;
  /** Accessible name for the DOM mirror (see `Widget.a11yLabel`); defaults to the visible text. */
  label?: string;
}

type RepeatWidgetOptions<Item> = Omit<RepeatOptions<Item>, keyof LayoutParams | 'name'>;

const REPEAT_KEYS = [
  'items',
  'key',
  'template',
  'update',
  'container',
  'virtualize',
  'itemExtent',
  'overscan',
  'empty',
  'context',
] as const;

/** Live per-row state; reactive, so `$item`/`$index` re-render their readers when a row is reused. */
interface RowState<Item> {
  item: Item;
  index: number;
}

interface RowEntry<Item> {
  readonly widget: Widget;
  readonly context: BindingContext;
  readonly state: RowState<Item>;
}

function sameOrder(a: readonly Widget[], b: readonly Widget[]): boolean {
  return a.length === b.length && a.every((widget, index) => widget === b[index]);
}

export class Repeat<Item> extends Widget {
  private readonly repeatOptions: RepeatWidgetOptions<Item>;
  private readonly flow: RepeatFlow;
  private readonly virtualized: boolean;
  private readonly rootContext: BindingContext;
  private readonly rows = new Map<string, RowEntry<Item>>();
  private readonly stopItems: StopBinding;

  private mountedKeys: string[] = [];
  private itemCount = 0;
  private scrollOffset = 0;
  private viewport = -1;
  private syncQueued = false;
  private emptyWidget: Widget | null = null;
  private leadingFiller: Widget | null = null;
  private trailingFiller: Widget | null = null;
  private leadingHeight = 0;
  private trailingHeight = 0;

  constructor(scene: Phaser.Scene, options: RepeatOptions<Item>) {
    const { layout, widget } = splitWidgetOptions<RepeatWidgetOptions<Item>>(
      optionBag(options),
      REPEAT_KEYS,
    );
    super(scene, { layout, ...baseWidgetOptions(options) });

    this.repeatOptions = widget;
    this.container = resolveRepeatContainer(widget.container);
    this.flow = describeRepeatFlow(this.container);
    this.virtualized = widget.virtualize === true && this.extent() > 0 && this.flow.virtualizable;

    if (widget.virtualize === true && !this.virtualized) {
      warn(
        this.extent() > 0
          ? 'Repeat: virtualization needs a vertical box container; rendering every row instead.'
          : 'Repeat: `virtualize: true` requires a positive `itemExtent`; rendering every row instead.',
      );
    }

    this.rootContext = widget.context ?? new BindingContext({});

    // `equals: () => false`: a reactive array is mutated in place (`push`/`splice`), so an unchanged
    // reference can still mean "re-diff" — the effect only re-runs when a tracked read changed.
    this.stopItems = createBinding<readonly Item[], Repeat<Item>>({
      host: this,
      read: () => this.repeatOptions.items() ?? [],
      apply: (items) => {
        this.applyItems(items);
      },
      equals: () => false,
      flush: 'frame',
    });
  }

  // ------------------------------------------------------------------ public API

  /** Keys currently mounted, in visual order. */
  getRenderedKeys(): string[] {
    return this.mountedKeys.slice();
  }

  /** Mounted widget of a key, or `null` when the row is not rendered (virtualised away). */
  getWidgetForKey(key: string): Widget | null {
    return this.rows.get(key)?.widget ?? null;
  }

  /** Number of mounted rows. */
  get renderedCount(): number {
    return this.mountedKeys.length;
  }

  /** Number of items in the current source. */
  get totalCount(): number {
    return this.itemCount;
  }

  /** Scroll offset currently used by the virtual window, in pixels. */
  get offset(): number {
    return this.scrollOffset;
  }

  /** `true` when only the visible window is mounted. */
  get virtualizedEnabled(): boolean {
    return this.virtualized;
  }

  /** Scrolls the virtual window (clamped to the list's own content); a no-op when not virtualised. */
  setScrollOffset(offset: number): void {
    if (!this.virtualized) {
      return;
    }
    const wanted = typeof offset === 'number' && Number.isFinite(offset) ? offset : 0;
    const next = Math.min(Math.max(0, wanted), this.maxScrollOffset());
    if (next === this.scrollOffset) {
      return;
    }
    this.scrollOffset = next;
    this.applyItems(this.repeatOptions.items() ?? []);
  }

  /** Largest useful scroll offset: the content height minus the viewport. */
  get maxOffset(): number {
    return this.maxScrollOffset();
  }

  /**
   * Full length of the list in pixels, viewport excluded.
   *
   * This is the number an enclosing `ScrollView` measures: it does not depend on how tall this list's
   * own box is, so a port can size its scrollbar and its scroll limits from the real list length even
   * when the two viewports differ.
   */
  get contentExtent(): number {
    if (!this.virtualized) {
      return 0;
    }
    return contentExtentOf(this.itemCount, this.extent(), this.flow.gap);
  }

  private maxScrollOffset(): number {
    return Math.max(0, this.contentExtent - this.viewportSize());
  }

  /** Drops every mounted row and rebuilds the list from the current items. */
  refresh(): void {
    for (const key of this.mountedKeys) {
      this.unmountRow(key);
    }
    this.mountedKeys = [];
    this.destroyEmpty();
    this.applyItems(this.repeatOptions.items() ?? []);
  }

  override destroy(fromScene?: boolean): void {
    this.stopItems();
    this.rows.clear();
    this.mountedKeys = [];
    super.destroy(fromScene);
  }

  // ------------------------------------------------------------------ layout

  /** The repeat itself has no intrinsic size: it is the sum of the rows it currently mounts. */
  override measureContent(_constraint: BoxConstraints): Size {
    return { width: 0, height: 0 };
  }

  /**
   * Re-evaluates the window whenever the layout assigns a new height.
   *
   * The re-sync is deferred to a microtask: `applyRect` runs inside the engine's arrange pass, and
   * adding widgets there would mutate the tree the engine is walking.
   */
  protected override onRectChanged(rect: Rect): void {
    super.onRectChanged(rect);
    this.arrangedOnce = true;
    if (!this.virtualized) {
      return;
    }
    const viewport = this.viewportSize();
    if (Math.abs(viewport - this.viewport) < 0.5) {
      return;
    }
    this.viewport = viewport;
    this.queueSync();
  }

  private queueSync(): void {
    if (this.syncQueued) {
      return;
    }
    this.syncQueued = true;
    queueMicrotask(() => {
      this.syncQueued = false;
      if (this.isDestroyed) {
        return;
      }
      this.applyItems(this.repeatOptions.items() ?? []);
    });
  }

  // ------------------------------------------------------------------ diffing

  private applyItems(items: readonly Item[]): void {
    const list = Array.isArray(items) ? items : [];
    this.itemCount = list.length;

    const keyOf = this.repeatOptions.key;
    const keys: string[] = [];
    const states = new Map<string, RowState<Item>>();
    for (let index = 0; index < list.length; index++) {
      const item = list[index] as Item;
      const key = String(keyOf(item, index));
      keys.push(key);
      if (!states.has(key)) {
        states.set(key, { item, index });
      }
    }

    if (list.length === 0) {
      this.renderEmpty();
      return;
    }
    this.destroyEmpty();

    const window = this.windowFor(keys.length);
    const windowKeys: string[] = [];
    for (let index = window.start; index < window.end; index++) {
      const key = keys[index];
      if (key !== undefined && !windowKeys.includes(key)) {
        windowKeys.push(key);
      }
    }

    const plan = planRepeatUpdate(this.mountedKeys, windowKeys);
    if (isDevMode() && (plan.removed.length > 0 || plan.added.length > 0)) {
      // Virtualisation is invisible by design, so a wrong window looks like "rows are missing" with no
      // clue why. This is the one line that makes the window observable (guarded: it runs per diff).
      devLog(
        `repeat: window [${window.start}, ${window.end}) of ${keys.length} - mounted ${this.mountedKeys.length}`,
      );
    }
    for (const key of plan.removed) {
      this.unmountRow(key);
    }

    const ordered: Widget[] = [];
    const orderedKeys: string[] = [];
    for (const key of windowKeys) {
      const state = states.get(key);
      if (state === undefined) {
        continue;
      }
      let entry = this.rows.get(key);
      if (entry === undefined) {
        entry = this.mountRow(key, state.item, state.index);
      } else if (!Object.is(entry.state.item, state.item)) {
        if (this.repeatOptions.update !== undefined) {
          this.repeatOptions.update(entry.widget, state.item, state.index);
          entry.state.item = state.item;
          entry.state.index = state.index;
        } else {
          this.unmountRow(key);
          entry = this.mountRow(key, state.item, state.index);
        }
      } else if (entry.state.index !== state.index) {
        // Live scope: writing the reactive index re-renders `{{ $index }}` on the next flush.
        entry.state.index = state.index;
      }
      ordered.push(entry.widget);
      orderedKeys.push(key);
    }

    this.mountedKeys = orderedKeys;
    this.applyFillers(window, keys.length, ordered.length);
    if (this.orderChildren(ordered)) {
      this.notifyStructureChange();
    }
  }

  /**
   * Tells the tree that this subtree gained or lost widgets.
   *
   * `Widget.setEngineRecursive()` hands a `structureListener` to the children it walks, so a widget
   * that grows children **after** it was mounted (exactly what a `Repeat` does) is not guaranteed to
   * carry one of its own: the nearest listener up the parent chain is notified instead. The layout
   * root installs that listener, and the scene plugin turns the bumped version into a router/focus
   * refresh on the next frame — which is what makes a freshly mounted row clickable.
   *
   * The *layout* half needs no help here: `LayoutEngine.invalidate()` collects the clean ancestors
   * above a relayout boundary in its own dirty path, so the arrange pass still descends to this
   * widget and the new rows receive their `applyRect` (see `engine-dirty-path.test.ts`). The
   * ancestor-marking this method used to do was a workaround for that gap and was removed with it.
   */
  private notifyStructureChange(): void {
    let node: Widget | null = this;
    while (node !== null) {
      const listener = node.structureListener;
      if (typeof listener === 'function') {
        listener();
        return;
      }
      node = (node.parent as Widget | null) ?? null;
    }
  }

  /** The window of a virtualised list, or the whole list when virtualization is off. */
  private windowFor(count: number): VirtualWindow {
    if (!this.virtualized) {
      return { start: 0, end: count, leading: 0, trailing: 0 };
    }
    const viewport = this.viewportSize();
    this.viewport = viewport;
    return planVirtualWindow({
      offset: this.scrollOffset,
      viewport,
      itemExtent: this.extent(),
      count,
      overscan: this.overscan(),
      perRow: 1,
      gap: this.flow.gap,
    });
  }

  private mountRow(key: string, item: Item, index: number): RowEntry<Item> {
    const state = reactive({ item, index }) as RowState<Item>;
    const context = this.rowContext(state);
    const widget = this.repeatOptions.template(item, index, context);
    const entry: RowEntry<Item> = { widget, context, state };
    this.rows.set(key, entry);
    this.addWidget(widget);
    return entry;
  }

  private unmountRow(key: string): void {
    const entry = this.rows.get(key);
    if (entry === undefined) {
      return;
    }
    this.rows.delete(key);
    this.removeWidget(entry.widget, true);
  }

  /**
   * Builds the row scope.
   *
   * `$item`/`$index` are read through the row's reactive state, so a row that survives a reorder or
   * an item update simply re-renders: the widget, its bindings and its focus stay alive.
   */
  private rowContext(state: RowState<Item>): BindingContext {
    const rootNode = this.rootContext.scopeNode;
    return this.rootContext.child({
      vm: state.item,
      item: state.item,
      index: state.index,
      scopeNode: (base: PathScope): PathScope => {
        Object.defineProperty(base, '$vm', { get: () => state.item, enumerable: true });
        Object.defineProperty(base, '$item', { get: () => state.item, enumerable: true });
        Object.defineProperty(base, '$index', { get: () => state.index, enumerable: true });
        base.$root = rootNode;
        base.$parent = rootNode;
        return base;
      },
    });
  }

  // ------------------------------------------------------------------ fillers & children

  /** Keeps the fillers in step with the window so the mounted rows keep their real geometry. */
  private applyFillers(window: VirtualWindow, count: number, mounted: number): void {
    const show = this.virtualized && mounted > 0 && count > 0;
    this.leadingHeight = show ? window.leading : 0;
    this.trailingHeight = show ? window.trailing : 0;
    this.leadingFiller = this.syncFiller(this.leadingFiller, this.leadingHeight, 'repeat.leading');
    this.trailingFiller = this.syncFiller(
      this.trailingFiller,
      this.trailingHeight,
      'repeat.trailing',
    );
  }

  /** Creates a filler on demand and keeps its height in step; detachment happens in `orderChildren`. */
  private syncFiller(filler: Widget | null, height: number, name: string): Widget | null {
    if (height <= 0) {
      return filler;
    }
    if (filler === null) {
      return new Widget(this.scene, { layout: { height }, name });
    }
    if (filler.layoutParams.height !== height) {
      filler.setLayoutParams({ height });
    }
    return filler;
  }

  private renderEmpty(): void {
    for (const key of this.mountedKeys) {
      this.unmountRow(key);
    }
    this.mountedKeys = [];
    this.leadingHeight = 0;
    this.trailingHeight = 0;

    const factory = this.repeatOptions.empty;
    if (factory !== null && factory !== undefined && this.emptyWidget === null) {
      this.emptyWidget = factory();
    }
    if (this.orderChildren([])) {
      this.notifyStructureChange();
    }
  }

  private destroyEmpty(): void {
    if (this.emptyWidget === null) {
      return;
    }
    this.removeWidget(this.emptyWidget, true);
    this.emptyWidget = null;
  }

  /**
   * Brings the children into visual order, touching only the *order* — no widget is ever destroyed
   * or rebuilt here. Appending (the common case) costs one `addWidget` per new row; only a real
   * reorder falls back to detaching and re-attaching the mounted rows.
   */
  private orderChildren(ordered: readonly Widget[]): boolean {
    const desired: Widget[] = [];
    if (this.leadingFiller !== null && this.leadingHeight > 0) {
      desired.push(this.leadingFiller);
    }
    if (this.emptyWidget !== null) {
      desired.push(this.emptyWidget);
    }
    for (const widget of ordered) {
      desired.push(widget);
    }
    if (this.trailingFiller !== null && this.trailingHeight > 0) {
      desired.push(this.trailingFiller);
    }

    const wanted = new Set(desired);
    for (const child of this.getWidgetChildren()) {
      if (!wanted.has(child)) {
        this.removeWidget(child, false);
        this.detachFromDisplayList(child);
      }
    }

    const attached = this.getWidgetChildren();
    if (sameOrder(attached, desired)) {
      return false;
    }
    const present = new Set(attached);
    for (const widget of desired) {
      if (!present.has(widget)) {
        this.addWidget(widget);
      }
    }

    const afterAdd = this.getWidgetChildren();
    if (sameOrder(afterAdd, desired)) {
      return true;
    }
    for (const child of afterAdd) {
      this.removeWidget(child, false);
      this.detachFromDisplayList(child);
    }
    for (const widget of desired) {
      this.addWidget(widget);
    }
    return true;
  }

  /**
   * Takes a *kept* widget off the scene display list after detaching it.
   *
   * Phaser hands a removed container child **back to the display list** (`Container#removeHandler`
   * calls `gameObject.addToDisplayList()` for exclusive containers), so a pooled widget — the leading
   * and trailing fillers a virtualised list keeps for reuse — would sit in the render pipeline at
   * (0,0) with a live theme subscription while it is detached. Re-attaching does the opposite
   * automatically (`addHandler` calls `removeFromDisplayList`), so this keeps the pair symmetric.
   */
  private detachFromDisplayList(widget: Widget): void {
    if (widget.isDestroyed) {
      return;
    }
    (widget as unknown as { removeFromDisplayList?: () => void }).removeFromDisplayList?.();
  }

  // ------------------------------------------------------------------ metrics

  private extent(): number {
    const value = this.repeatOptions.itemExtent;
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
  }

  private overscan(): number {
    const value = this.repeatOptions.overscan;
    return typeof value === 'number' && Number.isFinite(value)
      ? Math.max(0, Math.floor(value))
      : DEFAULT_OVERSCAN;
  }

  /** Visible size of the list: the smaller of the repeat's own box and its parent's. */
  /** Set by the first `applyRect`, so "no height" can be told apart from "not arranged yet". */
  private arrangedOnce = false;

  private viewportSize(): number {
    const own = this.rect.height;
    const parent = this.parent as { appliedRect?: { height: number }; parent?: unknown } | null;
    const fromParent = parent?.appliedRect?.height ?? 0;
    if (own > 0 && fromParent > 0) {
      return Math.min(own, fromParent);
    }
    if (own > 0 || fromParent > 0) {
      return Math.max(own, fromParent);
    }

    // Neither this list nor its layout parent has a height yet. Rather than silently mounting only
    // `overscan` rows (or none at all with `overscan: 0`) while `maxOffset` still advertises the whole
    // list, walk up to the first ancestor that knows how tall it is — usually the enclosing
    // `ScrollView`, whose viewport is the honest answer for "how much is visible".
    let ancestor = (parent?.parent ?? null) as {
      appliedRect?: { height: number };
      parent?: unknown;
    } | null;
    while (ancestor) {
      const height = ancestor.appliedRect?.height ?? 0;
      if (height > 0) {
        return height;
      }
      ancestor = (ancestor.parent ?? null) as typeof ancestor;
    }

    // Warned only once the list has actually been through a layout pass: a freshly built list is
    // legitimately 0×0 until its first arrange, and the frame-flush that mounts the first window can
    // run before that. A list that is *still* 0 after being arranged is the real mistake.
    if (this.arrangedOnce) {
      warn(
        'Repeat: the virtualised list has no resolved height (own rect and every ancestor are 0), so ' +
          'the mounted window falls back to the overscan rows. Give the list a definite height, or put ' +
          'it inside a ScrollView with one.',
      );
    }
    return 0;
  }
}

/** Factory: creates a `Repeat` and registers it with the scene. */
export function repeat<Item>(scene: Phaser.Scene, options: RepeatOptions<Item>): Repeat<Item> {
  const widget = new Repeat<Item>(scene, options);
  scene.add.existing(widget);
  return widget;
}
