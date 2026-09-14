/**
 * `FocusManager` — keyboard/gamepad focus for a widget tree.
 *
 * The manager owns a stack of *scopes*; each scope has one collection of focusable widgets (a
 * stable, ordered list built from that scope's root) and the single index inside that list that
 * currently holds focus. Everything device specific lives in `nav.ts`; everything pointer specific
 * lives in `input.ts`; this file decides *which* widget should be focused.
 *
 * Three rules shape the design:
 *
 * - the collection is the boundary: `focus()` ignores widgets that were not collected,
 * - only the **top scope** is live. `attach()` installs the base scope (the page); `pushScope()`
 *   layers another one on top (a modal dialog, PLAN M8) and suspends the one below — its widget
 *   keeps its place but loses the focus ring, so exactly one widget in the tree ever looks focused,
 *   and traversal cannot leave the modal,
 * - `popScope()` restores what the suspended scope had focused, when that widget is still there.
 *
 * The interesting algorithms are exported as pure functions (`collectFocusable`, `stageRectsOf`,
 * `pickDirectional`, `directionalTolerance`) so they can be tested with plain objects, without a
 * Phaser runtime; the scope stack is covered by `test/focus-scope.test.ts` with the same kind of
 * fakes.
 */

import type { Rect } from '@phaser-mvvm/layout';
import type { NavAction, NavDirection } from './nav';
import type { ActivationSource, FocusTarget, Widget } from './Widget';

/** Default funnel width multiplier used by `directionalTolerance`. */
const TOLERANCE_FACTOR = 0.6;
/** Floor for `directionalTolerance`, in design pixels. */
const MIN_TOLERANCE = 64;

// ---------------------------------------------------------------------------- pure helpers

/**
 * Minimal view of a widget-tree node.
 *
 * A real `Widget` satisfies this structurally, and so does a three-line object literal in a test —
 * which is the point: collection and ordering can be verified without building a Scene.
 */
export interface FocusNodeLike {
  /** Widget children, in tree order. Non-widget children are ignored. */
  readonly children: readonly unknown[];
  /** `false` when the node (and therefore its subtree) is out of the layout flow, i.e. hidden. */
  readonly inFlow: boolean;
  readonly visible: boolean;
  readonly enabled: boolean;
  readonly focusable: boolean;
  /** Ordering hint; ties keep the widget-tree order. */
  readonly focusOrder: number;
}

/** True for values that carry the focus-related fields of a widget. */
export function isFocusNodeLike(value: unknown): value is FocusNodeLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    'focusable' in value &&
    'focusOrder' in value &&
    'inFlow' in value
  );
}

/**
 * Collects the focusable widgets of a subtree, in navigation order.
 *
 * A widget is collected when it is focusable, enabled and visible. A subtree that is out of flow
 * (`inFlow === false`, which for `Widget` means "hidden") contributes nothing at all, because
 * anything inside it is invisible even though its own `visible` flag may still be `true`.
 *
 * The result is sorted by `focusOrder` with the tree order (pre-order) as the tie breaker, and the
 * sort is stable, so repeated calls on an unchanged tree return the same order.
 */
export function collectFocusable(root: FocusNodeLike): Widget[] {
  const found: Array<{ widget: Widget; order: number; treeIndex: number }> = [];
  let treeIndex = 0;

  const visit = (node: FocusNodeLike): void => {
    const index = treeIndex++;
    if (node.inFlow === false) {
      return;
    }
    if (node.focusable === true && node.enabled !== false && node.visible !== false) {
      found.push({ widget: node as unknown as Widget, order: node.focusOrder, treeIndex: index });
    }
    for (const child of node.children) {
      if (isFocusNodeLike(child)) {
        visit(child);
      }
    }
  };

  visit(root);

  found.sort((a, b) => (a.order === b.order ? a.treeIndex - b.treeIndex : a.order - b.order));
  return found.map((entry) => entry.widget);
}

/** Minimal shape of a container in the `parentContainer` chain. */
export interface AnchorLike {
  readonly x: number;
  readonly y: number;
  readonly parentContainer?: AnchorLike | null;
}

/**
 * Minimal shape needed to lift a widget's rect into stage coordinates.
 *
 * `appliedRect` is the rect written by the layout engine and is relative to the widget's parent
 * container, so the parent chain is summed on top of it — the widget's own `x`/`y` are ignored
 * on purpose, `appliedRect` is the layout's answer and the authoritative one.
 */
export interface RectSourceLike {
  readonly appliedRect: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly parentContainer?: AnchorLike | null;
}

/**
 * Converts a widget's `appliedRect` into stage coordinates.
 *
 * Rotation and scale of the intermediate containers are ignored: the layout engine only ever
 * positions containers, and geometry is what directional navigation needs (PLAN M3).
 */
export function stageRectOf(source: RectSourceLike): Rect {
  const rect = source.appliedRect;
  let x = rect.x;
  let y = rect.y;

  let parent = source.parentContainer;
  while (parent) {
    x += parent.x;
    y += parent.y;
    parent = parent.parentContainer;
  }

  return { x, y, width: rect.width, height: rect.height };
}

/** `stageRectOf` for a list of widgets (index-aligned with the input list). */
export function stageRectsOf(widgets: readonly RectSourceLike[]): Rect[] {
  const rects: Rect[] = [];
  for (const widget of widgets) {
    rects.push(stageRectOf(widget));
  }
  return rects;
}

/**
 * Whether `candidate` contains `focused` somewhere up its container chain — i.e. it is an ancestor.
 *
 * Directional navigation needs this because a container's box overlaps everything inside it: the
 * `ScrollView` holding the focused button is usually the *nearest* thing "below" it, so it won by
 * distance and focus moved off the button onto a container that only scrolls (round 67).
 */
export function containsWidget(
  candidate: AnchorLike,
  focused: AnchorLike | null | undefined,
): boolean {
  let node: AnchorLike | null | undefined = focused?.parentContainer;
  while (node) {
    if (node === candidate) {
      return true;
    }
    node = node.parentContainer;
  }
  return false;
}

/**
 * Funnel width used by `FocusManager.move()`: 60% of the tangential size of the current rect, but
 * never less than 64 design pixels (a 40px-tall row in a list would otherwise be unreachable
 * sideways).
 */
export function directionalTolerance(current: Rect, direction: NavDirection): number {
  const tangential = direction === 'left' || direction === 'right' ? current.height : current.width;
  return Math.max(tangential * TOLERANCE_FACTOR, MIN_TOLERANCE);
}

/**
 * Picks the index of the best directional neighbour, or `null` when there is none.
 *
 * A candidate qualifies when its centre is strictly inside the requested half-plane (below for
 * `down`, …) and its tangential offset from the current centre is within `tolerance`. Among the
 * qualifying candidates the winner is the one with the smallest primary-axis distance; ties are
 * broken by the smaller tangential offset. The current rect never wins: its primary distance is 0,
 * which is not "strictly inside" the half-plane.
 *
 * `skip` marks candidates to ignore for this call (index-aligned with `candidates`). The focus
 * manager uses it to try the least surprising options first — see {@link containsWidget}: an ancestor
 * of the focused widget (the `ScrollView` a focused button sits in) is often the nearest box in the
 * requested direction, and letting it win moves the ring onto the container, where the D-Pad only
 * scrolls and focus stops moving (measured on `#/a11y` in round 67). The manager asks again without
 * `skip` when nothing else answered, so no target becomes unreachable.
 */
export function pickDirectional(
  current: Rect,
  candidates: readonly Rect[],
  direction: NavDirection,
  tolerance: number,
  skip?: readonly boolean[],
): number | null {
  const currentX = current.x + current.width / 2;
  const currentY = current.y + current.height / 2;
  const horizontal = direction === 'left' || direction === 'right';

  let best: number | null = null;
  let bestPrimary = Number.POSITIVE_INFINITY;
  let bestTangential = Number.POSITIVE_INFINITY;

  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index];
    if (!candidate) {
      continue;
    }
    if (skip?.[index] === true) {
      continue;
    }

    const dx = candidate.x + candidate.width / 2 - currentX;
    const dy = candidate.y + candidate.height / 2 - currentY;

    const primary =
      direction === 'down' ? dy : direction === 'up' ? -dy : direction === 'right' ? dx : -dx;
    if (primary <= 0) {
      continue;
    }

    const tangential = horizontal ? Math.abs(dy) : Math.abs(dx);
    if (tangential > tolerance) {
      continue;
    }

    if (primary < bestPrimary || (primary === bestPrimary && tangential < bestTangential)) {
      best = index;
      bestPrimary = primary;
      bestTangential = tangential;
    }
  }

  return best;
}

// ---------------------------------------------------------------------------- FocusManager

export interface FocusManagerOptions {
  /** Root widget to collect focusable widgets from; may also be given later via `attach()`. */
  root?: Widget | null;
  /**
   * Keeps focus inside the collected set: traversal wraps at the edges and `blur()` cannot release
   * focus. Used by modal pages (M8).
   */
  trapFocus?: boolean;
  /** Whether `next()`/`previous()` wrap around at the ends. Defaults to `true`. */
  wrap?: boolean;
  /** Called whenever the focused widget changes (`null` when focus is released). */
  onFocusChange?: (widget: Widget | null) => void;
  /**
   * Advisory flag for hosts and skins: when `true` the focused widget may paint a focus ring. The
   * manager itself never renders anything, so the flag changes no routing behaviour.
   */
  ring?: boolean;
  /** Called when a navigation source reports `back` (Escape, gamepad B/○, …). */
  onBack?: () => void;
}

/**
 * Options of {@link FocusManager.pushScope}.
 *
 * `trap`/`wrap` default to the manager's own, so a host that configured a trapping manager gets
 * trapping scopes without repeating itself; a modal passes `trap: true` explicitly because the page
 * below it is usually not trapped.
 */
export interface FocusScopeOptions {
  /** Traversal wraps at the ends **and** `blur()` cannot release focus. */
  trap?: boolean;
  /** Traversal wraps at the ends. */
  wrap?: boolean;
  /**
   * Focus the first focusable widget of the new scope immediately, instead of waiting for the first
   * `Tab`. A dialog wants this: `Enter` should activate its default button, not the page's.
   */
  focusFirst?: boolean;
}

/** One level of the focus stack: a root, the widgets collected under it, and the focus index. */
interface FocusScope {
  readonly root: Widget;
  trap: boolean;
  wrap: boolean;
  widgets: Widget[];
  index: number;
  /**
   * Widget that held focus in this scope when a deeper scope was pushed, restored by `popScope()`.
   * Kept across the suspension, because the widget itself is untouched — only its ring was dropped.
   */
  suspended: Widget | null;
}

/** Shared empty answer, so `focusables` never hands out a fresh array per call. */
const NO_WIDGETS: readonly Widget[] = [];

/**
 * The focus manager of one widget subtree.
 *
 * It implements `FocusTarget`, so `widget.focus()` / `widget.blur()` (`Widget` forwards those to
 * `widget.focusManager`) work without the widget knowing about the scene plugin.
 *
 * The scope stack is what makes a modal dialog possible: the dialog's root is pushed as a new scope,
 * so `Tab`, the arrow keys and pointer-driven focus all walk the dialog's widgets only, and the page
 * underneath keeps its state until the dialog closes.
 */
export class FocusManager implements FocusTarget {
  /** Advisory focus-ring flag, see `FocusManagerOptions.ring`. */
  ring: boolean;
  /** Change callback, writable so hosts can swap it after construction. */
  onFocusChange: ((widget: Widget | null) => void) | null;
  /** `back` handler, writable for the same reason. */
  onBack: (() => void) | null;

  private readonly scopes: FocusScope[] = [];
  private defaultWrap: boolean;
  private defaultTrap: boolean;

  constructor(options: FocusManagerOptions = {}) {
    this.defaultWrap = options.wrap ?? true;
    this.defaultTrap = options.trapFocus ?? false;
    this.ring = options.ring ?? true;
    this.onFocusChange = options.onFocusChange ?? null;
    this.onBack = options.onBack ?? null;

    if (options.root) {
      this.attach(options.root);
    }
  }

  /**
   * Whether traversal wraps at the ends of the scope in play.
   *
   * Writing it updates the live scope as well as the default for scopes pushed later — the field
   * used to be a plain property, and a host that flipped it mid-session expects it to take effect.
   */
  get wrap(): boolean {
    return this.topScope()?.wrap ?? this.defaultWrap;
  }

  set wrap(value: boolean) {
    this.defaultWrap = value;
    const top = this.topScope();
    if (top) {
      top.wrap = value;
    }
  }

  /** When `true`, focus can neither wrap out of the scope in play nor be released. */
  get trapFocus(): boolean {
    return this.topScope()?.trap ?? this.defaultTrap;
  }

  set trapFocus(value: boolean) {
    this.defaultTrap = value;
    const top = this.topScope();
    if (top) {
      top.trap = value;
    }
  }

  /** Root of the scope in play, or `null` while detached. */
  get root(): Widget | null {
    return this.topScope()?.root ?? null;
  }

  /** The collected widgets of the scope in play, in navigation order. */
  get focusables(): readonly Widget[] {
    return this.topScope()?.widgets ?? NO_WIDGETS;
  }

  /** Widget that currently holds focus, or `null`. */
  get focusedWidget(): Widget | null {
    const scope = this.topScope();
    if (!scope || scope.index < 0) {
      return null;
    }
    return scope.widgets[scope.index] ?? null;
  }

  /** Number of scopes on the stack; `0` while detached, `1` for a plain page. */
  get scopeDepth(): number {
    return this.scopes.length;
  }

  /** True when `widget` is part of the collection of the scope in play. */
  has(widget: Widget): boolean {
    return this.topScope()?.widgets.includes(widget) ?? false;
  }

  /**
   * Installs the **base** scope: the page. Any scope pushed on top of it belongs to a transient
   * overlay that cannot outlive the page, so re-attaching drops the whole stack.
   */
  attach(root: Widget): void {
    const only = this.scopes.length === 1 ? this.scopes[0] : undefined;
    if (only && only.root === root) {
      this.refresh();
      return;
    }
    this.detach();
    this.scopes.push(this.createScope(root, {}));
    this.collect(this.scopes[0] as FocusScope);
  }

  /**
   * Pushes a new scope on top of the stack and suspends the one below.
   *
   * Suspension is what keeps the illusion intact: the widget that had focus keeps its place in its
   * own collection (so `popScope()` can hand focus back), but its ring is dropped — otherwise a
   * button behind a dialog would still look focused while `Tab` walks the dialog.
   */
  pushScope(root: Widget, options: FocusScopeOptions = {}): void {
    const previous = this.topScope();
    if (previous) {
      const focused = this.focusedWidget;
      previous.suspended = focused;
      if (focused) {
        focused.setFocusedInternal(false);
      }
      previous.index = -1;
    }

    const scope = this.createScope(root, options);
    this.scopes.push(scope);
    this.collect(scope);

    if (options.focusFirst === true) {
      this.step(1);
    }
  }

  /**
   * Pops the top scope and restores the focus of the scope below.
   *
   * Focus goes back to the widget that held it when the scope was pushed — unless that widget was
   * removed in the meantime, in which case focus is simply released.
   *
   * @returns `false` when there was no scope to pop.
   */
  popScope(): boolean {
    const scope = this.scopes.pop();
    if (!scope) {
      return false;
    }
    this.release(scope);

    const next = this.topScope();
    if (!next) {
      this.notify(null);
      return true;
    }

    const wanted = next.suspended;
    next.suspended = null;
    this.collect(next);

    if (wanted && wanted.isDestroyed !== true && next.widgets.includes(wanted)) {
      this.focus(wanted);
    } else {
      this.notify(null);
    }
    return true;
  }

  /**
   * Re-collects the focusable widgets **of the scope in play**.
   *
   * Call after the tree changed (a widget was added/removed, or made focusable/visible) or after
   * `focusOrder` was changed. Focus is kept when the widget is still collectable. Scopes below the
   * top one are left alone: they are suspended, and their collections are rebuilt when they become
   * live again.
   */
  refresh(): void {
    const top = this.topScope();
    if (!top) {
      return;
    }
    this.collect(top);
  }

  /** Moves focus to `widget`. Widgets outside the scope in play are ignored (see the trap rule). */
  focus(widget: Widget): void {
    const scope = this.topScope();
    if (!scope) {
      return;
    }
    const index = scope.widgets.indexOf(widget);
    if (index === -1) {
      return;
    }
    this.applyFocus(widget, index);
  }

  /** Releases focus from `widget` (only if it actually holds it, and only when not trapped). */
  blur(widget: Widget): void {
    const scope = this.topScope();
    if (!scope || scope.trap) {
      return;
    }
    if (this.focusedWidget !== widget) {
      return;
    }
    scope.index = -1;
    widget.setFocusedInternal(false);
    this.notify(null);
  }

  /**
   * Focuses the next widget in the collection (the first one when nothing is focused).
   *
   * Returns `true` when focus moved, `false` when it could not (empty set, or an edge with
   * `wrap === false` and no trap).
   */
  next(): boolean {
    return this.step(1);
  }

  /** Focuses the previous widget in the collection; mirrors `next()`. */
  previous(): boolean {
    return this.step(-1);
  }

  /**
   * Moves focus geometrically: the nearest widget whose centre lies in `direction` and whose
   * centre is within the funnel (`directionalTolerance`) of the focused rect.
   *
   * With no focused widget the geometric move has no origin, so focus enters the set (the first
   * focusable widget), which is what pressing an arrow key in a fresh page should do.
   */
  move(direction: NavDirection): boolean {
    const scope = this.topScope();
    if (!scope) {
      return false;
    }

    const current = this.focusedWidget;
    if (!current) {
      return this.next();
    }

    const rects = stageRectsOf(scope.widgets);
    const currentRect = rects[scope.index];
    if (!currentRect) {
      return false;
    }

    const tolerance = directionalTolerance(currentRect, direction);
    // Two passes: first without the containers that enclose the focused widget (a scroll port must not
    // steal the direction from the button inside it), then — only if that found nothing — with them, so
    // a port that is genuinely the next thing in that direction stays reachable.
    const enclosing = scope.widgets.map((widget) => containsWidget(widget, current));
    const picked =
      pickDirectional(currentRect, rects, direction, tolerance, enclosing) ??
      pickDirectional(currentRect, rects, direction, tolerance);
    if (picked === null) {
      return false;
    }

    const widget = scope.widgets[picked];
    if (!widget) {
      return false;
    }
    return this.applyFocus(widget, picked);
  }

  /**
   * Activates the focused widget.
   *
   * Keyboard activations use `'keyboard'` (the default) and gamepad ones `'gamepad'`; the source is
   * forwarded to `Widget.activate()` so widgets can behave differently per device.
   */
  activate(source: ActivationSource = 'keyboard'): boolean {
    const widget = this.focusedWidget;
    if (!widget) {
      return false;
    }
    return widget.activate(source);
  }

  /** Reports `back` to the host; returns `true` when a handler consumed it. */
  back(): boolean {
    if (!this.onBack) {
      return false;
    }
    this.onBack();
    return true;
  }

  /**
   * Dispatches a navigation action to the matching traversal/activation method.
   *
   * `source` is threaded through to `Widget.activate()`; returning `false` means "nothing happened"
   * (no focus, no neighbour, no `back` handler), which lets a host keep the action for itself.
   */
  handleAction(action: NavAction, source: ActivationSource): boolean {
    switch (action) {
      case 'next':
        return this.next();
      case 'prev':
        return this.previous();
      case 'up':
      case 'down':
      case 'left':
      case 'right':
        return this.move(action);
      case 'activate':
        return this.activate(source);
      case 'back':
        return this.back();
      default:
        return false;
    }
  }

  /**
   * Releases focus, clears **every** scope and disconnects each widget's `focusManager` back
   * reference. Idempotent; safe to call from a scene shutdown handler.
   */
  detach(): void {
    let hadFocus = false;
    for (const scope of this.scopes) {
      if (scope.index >= 0 && scope.widgets[scope.index]) {
        hadFocus = true;
      }
    }

    for (const scope of this.scopes) {
      this.release(scope);
    }
    this.scopes.length = 0;

    if (hadFocus) {
      this.notify(null);
    }
  }

  /** Alias for `detach()`, so hosts can use the usual teardown name. */
  dispose(): void {
    this.detach();
  }

  private topScope(): FocusScope | undefined {
    return this.scopes[this.scopes.length - 1];
  }

  private createScope(root: Widget, options: FocusScopeOptions): FocusScope {
    return {
      root,
      trap: options.trap ?? this.defaultTrap,
      wrap: options.wrap ?? this.defaultWrap,
      widgets: [],
      index: -1,
      suspended: null,
    };
  }

  /** Rebuilds a scope's collection, keeping focus when the widget is still collectable. */
  private collect(scope: FocusScope): void {
    const previous = scope.index >= 0 ? (scope.widgets[scope.index] ?? null) : null;

    for (const widget of scope.widgets) {
      if (widget.focusManager === this) {
        widget.focusManager = null;
      }
    }

    scope.widgets = collectFocusable(scope.root);
    for (const widget of scope.widgets) {
      widget.focusManager = this;
    }

    scope.index = previous ? scope.widgets.indexOf(previous) : -1;
    if (previous && scope.index === -1) {
      // The focused widget is no longer focusable: release it instead of keeping a stale reference.
      previous.setFocusedInternal(false);
      if (scope === this.topScope()) {
        this.notify(null);
      }
    }
  }

  /** Drops one scope's references: no widget of a dead scope keeps pointing at this manager. */
  private release(scope: FocusScope): void {
    for (const widget of scope.widgets) {
      if (widget.focusManager === this) {
        widget.focusManager = null;
      }
      if (widget.isDestroyed !== true) {
        widget.setFocusedInternal(false);
      }
    }
    scope.widgets = [];
    scope.index = -1;
    scope.suspended = null;
  }

  private step(delta: number): boolean {
    const scope = this.topScope();
    if (!scope) {
      return false;
    }

    const count = scope.widgets.length;
    if (count === 0) {
      return false;
    }

    if (scope.index === -1) {
      // Nothing focused yet: tab into the set from the correct end.
      return delta > 0 ? this.focusAt(0) : this.focusAt(count - 1);
    }

    let next = scope.index + delta;
    if (next < 0 || next >= count) {
      if (!scope.wrap && !scope.trap) {
        return false;
      }
      next = next < 0 ? count - 1 : 0;
    }
    return this.focusAt(next);
  }

  private focusAt(index: number): boolean {
    const widget = this.topScope()?.widgets[index];
    if (!widget) {
      return false;
    }
    return this.applyFocus(widget, index);
  }

  private applyFocus(widget: Widget, index: number): boolean {
    const scope = this.topScope();
    if (!scope || (scope.index === index && this.focusedWidget === widget)) {
      return false;
    }

    this.focusedWidget?.setFocusedInternal(false);
    scope.index = index;
    widget.setFocusedInternal(true);
    this.notify(widget);
    return true;
  }

  private notify(widget: Widget | null): void {
    this.onFocusChange?.(widget);
  }
}
