/**
 * The Compose-style DSL: write a view as nested calls instead of option bags plus children arrays.
 *
 * ```ts
 * import { ui, Column, Row, Text, Button } from '@phaser-mvvm/widgets/compose';
 *
 * const page = ui(this, () => {
 *   Column({ gap: 12, padding: 20, width: 520 }, () => {
 *     Text('Hello phaser-mvvm', { size: 'xl' });          // or Text(() => vm.title.value)
 *     Row({ gap: 8, justifyContent: 'end' }, () => {
 *       Button('取消', { variant: 'ghost' });
 *       Button('确定', { variant: 'primary', onClick: save });
 *     });
 *   });
 * });
 * this.mvvm.mount(page);
 * ```
 *
 * What the DSL adds over the `this.add.ui*` factories is *structure*: the trailing content lambda
 * opens a scope, so nesting mirrors the source instead of an array literal, sibling order is the
 * source order, and no call has to name its scene. What it does *not* do is invent a second option
 * vocabulary — every composable takes the same options object as the widget class it wraps, so the
 * guide's option tables stay valid.
 *
 * Data slots (`Text`'s string, a field's `value`) also accept a `ref` or a getter and are bound
 * automatically — see `reactive-source.ts`. Everything else (geometry, callbacks) is passed as-is.
 *
 * The scope mechanics live in `@phaser-mvvm/phaser` (`uiscope.ts`), so a custom widget can join a DSL
 * tree with `emitWidget()`/`withUiParent()` without importing this module.
 */

import type Phaser from 'phaser';
import type { BindingContext } from '@phaser-mvvm/core';
import type { MVVMPlugin } from '@phaser-mvvm/phaser';
import { devLog } from '@phaser-mvvm/core';
import {
  AbsoluteWidget,
  type AbsoluteWidgetOptions,
  bindBooleanModel,
  BOX_KEYS,
  bindModel,
  bindNumberModel,
  bindText,
  bindValue,
  BoxWidget,
  type BoxLayoutOptions,
  type BoxWidgetOptions,
  buildUiPage,
  buildUiSubtree,
  currentUiScene,
  emitWidget,
  GRID_KEYS,
  type GridLayoutOptions,
  GridWidget,
  type GridWidgetOptions,
  type LayoutParams,
  RectWidget,
  type RectWidgetOptions,
  runtimeOptionTarget,
  StackWidget,
  STACK_KEYS,
  type StackWidgetOptions,
  type Widget,
  withUiParent,
} from '@phaser-mvvm/phaser';
import {
  Button as ButtonWidget,
  BUTTON_EVENTS,
  type ButtonOptions,
  type ButtonVariant,
} from './Button';
import { BranchWidget } from './Branch';
import type { BranchBuilder, BranchKey } from './branch-plan';
import { Divider as DividerWidget, type DividerOptions } from './Divider';
import { Image as ImageWidget, type ImageOptions } from './Image';
import { Label, type LabelOptions, type LabelTone } from './Label';
import { Panel as PanelWidget, type PanelOptions, type PanelVariant } from './Panel';
import { Repeat, type RepeatOptions } from './Repeat';
import { ScrollView, type ScrollViewOptions } from './ScrollView';
import { withListFlow, type ListFlowShorthands } from './list-flow';
import { optionBag } from './options';
import { Slider as SliderWidget, SLIDER_EVENTS, type SliderOptions } from './Slider';
import { Spacer as SpacerWidget, type SpacerOptions } from './Spacer';
import {
  VirtualKeyboardWidget,
  type VirtualKeyboardKind,
  type VirtualKeyboardOptions,
} from './VirtualKeyboard';
import { TextArea as TextAreaWidget, type TextAreaOptions } from './TextArea';
import { TextField as TextFieldWidget, type TextFieldOptions } from './TextField';
import { TEXT_INPUT_EVENTS, type TextInputBase } from './TextInputBase';
import {
  isReactiveSource,
  isWritableSource,
  type ReactiveSource,
  readReactive,
  sourceGetter,
  writeReactive,
} from './reactive-source';

// --------------------------------------------------------------------- the entry point

/**
 * Builds a view and returns its root widget.
 *
 * Exactly one root is the normal case. Zero roots is an error (an empty page is always a mistake);
 * more than one is wrapped in a transparent vertical container — the same forgiveness Compose shows
 * for a multi-child `setContent` — with a development warning, because the implicit container still
 * decides the flow direction.
 *
 * The result is *not* mounted: hand it to `this.mvvm.mount(page)` (which also lays it out) or to
 * `new UIRoot(scene)`.
 */
export function ui(scene: Phaser.Scene, content: () => void): Widget {
  return buildUiPage(scene, content, 'ui()').root;
}

/**
 * Builds a view **and mounts it** — the `setContent { … }` of this framework.
 *
 * `ui()` returns the root so a caller can decide what to do with it (a dialog, a section that is
 * swapped in later); `render()` is the one-call form for the common case of a whole page:
 *
 * ```ts
 * render(this.mvvm, () => {
 *   Column({ padding: 16, gap: 12 }, () => {
 *     Text('Hello');
 *     Button('确定', { variant: 'primary', onClick: save });
 *   });
 * });
 * ```
 *
 * A page built this way does not need `installFactories()`/`installWidgetFactories()`: the DSL
 * constructs the widget classes directly, so the `this.add.*` registrations are irrelevant to it.
 */
export function render(plugin: MVVMPlugin, content: () => void): Widget {
  // `ScenePlugin#scene` is protected, so the scene comes from the UI root — which is the object the page
  // is mounted into anyway, and reading it creates and wires that root on first use.
  const root = plugin.root;
  const page = ui(root.scene, content);
  plugin.mount(page);
  devLog('render(): mounted the page built by the content lambda');
  return page;
}

// --------------------------------------------------------------------- containers

/** Options of `Column`/`Row`: the box widget's own bag plus the DSL slots. */
export type ColumnOptions = Slotted<BoxWidgetOptions, SlotKeys<BoxWidgetOptions, BoxSlotKeys>> &
  DslOptions;
export type RowOptions = Slotted<BoxWidgetOptions, SlotKeys<BoxWidgetOptions, BoxSlotKeys>> &
  DslOptions;

/** A vertical box: `Column({ gap: 8 }, () => { … })` or `Column(() => { … })`. */
export function Column(options?: ColumnOptions | (() => void), content?: () => void): BoxWidget {
  const args = normalizeContent(options, content);
  const { rest } = splitDsl<BoxWidgetOptions>(args.options, 'box');
  const scene = currentUiScene();
  const widget = new BoxWidget(scene, { ...rest, direction: 'vertical' });
  scene.add.existing(widget);
  applyDslOptions(widget, args.options);
  return withUiParent(widget, args.content);
}

/** A horizontal box. */
export function Row(options?: RowOptions | (() => void), content?: () => void): BoxWidget {
  const args = normalizeContent(options, content);
  const { rest } = splitDsl<BoxWidgetOptions>(args.options, 'box');
  const scene = currentUiScene();
  const widget = new BoxWidget(scene, { ...rest, direction: 'horizontal' });
  scene.add.existing(widget);
  applyDslOptions(widget, args.options);
  return withUiParent(widget, args.content);
}

/** A grid of equally sized tracks. */
export function Grid(
  options?:
    | (Slotted<GridWidgetOptions, SlotKeys<GridWidgetOptions, GridSlotKeys>> & DslOptions)
    | (() => void),
  content?: () => void,
): GridWidget {
  const args = normalizeContent(options, content);
  const { rest } = splitDsl<GridWidgetOptions>(args.options, 'grid');
  const scene = currentUiScene();
  const widget = new GridWidget(scene, rest);
  scene.add.existing(widget);
  applyDslOptions(widget, args.options);
  return withUiParent(widget, args.content);
}

/** A stack: children overlap and are aligned inside the same box. */
export function Stack(
  options?:
    | (Slotted<StackWidgetOptions, SlotKeys<StackWidgetOptions, StackSlotKeys>> & DslOptions)
    | (() => void),
  content?: () => void,
): StackWidget {
  const args = normalizeContent(options, content);
  const { rest } = splitDsl<StackWidgetOptions>(args.options, 'stack');
  const scene = currentUiScene();
  const widget = new StackWidget(scene, rest);
  scene.add.existing(widget);
  applyDslOptions(widget, args.options);
  return withUiParent(widget, args.content);
}

/** An absolutely positioned container: children carry `position: 'absolute'` plus their offsets. */
export function Absolute(
  options?:
    (Slotted<AbsoluteWidgetOptions, SlotKeys<AbsoluteWidgetOptions>> & DslOptions) | (() => void),
  content?: () => void,
): AbsoluteWidget {
  const args = normalizeContent(options, content);
  const { rest } = splitDsl<AbsoluteWidgetOptions>(args.options, 'absolute');
  const scene = currentUiScene();
  const widget = new AbsoluteWidget(scene, rest);
  scene.add.existing(widget);
  applyDslOptions(widget, args.options);
  return withUiParent(widget, args.content);
}

/**
 * A themed, painted container — what Compose calls a `Surface` or a `Card`.
 *
 * Deliberately the **only** name for it: an alias (`Surface`) sat here for a while and nothing ever
 * used it — not a demo, not a test — while the guide taught `Panel` everywhere. Two names for one
 * thing is not "Compose-like", it is a coin flip for the reader, so the alias was removed in round 95
 * and the mapping to Compose's vocabulary lives in the guide instead (09 §3).
 *
 * `Column`/`Row` are transparent layout boxes; `Panel` is the one that paints a background, so it is
 * what a card, a dialog or a page root is made of.
 */
export function Panel(options?: PanelDslOptions | (() => void), content?: () => void): PanelWidget {
  const args = normalizeContent(options, content);
  const { rest: bag } = splitDsl<PanelOptions>(args.options, 'box');
  const { variant, ...rest } = bag;
  const scene = currentUiScene();
  const widget = new PanelWidget(scene, {
    ...rest,
    ...(variant === undefined ? {} : { variant: readReactive(variant) }),
  });
  scene.add.existing(widget);
  applyDslOptions(widget, args.options);
  bindOption(widget, variant, (host, next) => host.setVariant(next));
  return withUiParent(widget, args.content);
}

/**
 * A solid colour block - the adapter's `RectWidget`.
 *
 * The DSL has no shape vocabulary of its own (panels, dividers and skins draw their own rectangles), so
 * this is the primitive for a plain swatch, a colour chip, or a spacer that needs a fill. It takes the
 * widget's own options plus the usual DSL slots, exactly like every other leaf.
 */
export function Rect(
  options: Slotted<RectWidgetOptions, SlotKeys<RectWidgetOptions>> & DslOptions = {},
): RectWidget {
  const { rest } = splitDsl<RectWidgetOptions>(options);
  const scene = currentUiScene();
  const widget = new RectWidget(scene, rest);
  scene.add.existing(widget);
  applyDslOptions(widget, options);
  return emitWidget(widget);
}

/**
 * A clipped viewport: `Scroll({ height: 240 }, () => { … })`.
 *
 * The content lambda builds exactly one widget, which becomes the scroll content. A `Scroll` whose
 * content is itself a `List` also gets virtualisation, because `ScrollView` finds the list it wraps.
 */
/**
 * Options of `Scroll`: the port's own bag with a reactive **`offset`**.
 *
 * `offset` is the scroll position as state — Compose's `rememberScrollState()`. With a `Ref` it is
 * two-way: dragging, the wheel, a fling, a pinch zoom or a focus reveal writes the new position back,
 * and writing the ref scrolls the view ("回到顶部" is `offset.value = 0`). A getter is one-way: the
 * state drives the view, and the view never writes anywhere.
 */
export type ScrollDslOptions = Slotted<
  Omit<ScrollViewOptions, 'content' | 'offset'>,
  SlotKeys<ScrollViewOptions>
> & {
  /** Scroll position along the primary axis, in design pixels. */
  offset?: ReactiveSource<number>;
} & DslOptions;

export function Scroll(
  options?: ScrollDslOptions | (() => void),
  content?: () => void,
): ScrollView {
  const args = normalizeContent(options, content);
  // `offset` is a DSL slot on the *widget* (`setScrollOffset`), not a `ScrollViewOptions` field, so it is
  // taken out before the bag is resolved into widget options.
  const { offset, ...widgetOptions } = args.options as ScrollDslOptions & {
    offset?: ReactiveSource<number>;
  };
  const { rest } = splitDsl<Omit<ScrollViewOptions, 'content'>>(widgetOptions, 'scroll');
  const scene = currentUiScene();
  const widget = new ScrollView(scene, rest);
  scene.add.existing(widget);
  applyDslOptions(widget, args.options);
  emitWidget(widget);
  if (args.content) {
    widget.setContent(buildUiSubtree(scene, args.content, 'Scroll()'));
  }
  wireScrollOffset(widget, offset);
  return widget;
}

/**
 * Wires the `offset` slot: state → view always, view → state when the source can be written.
 *
 * The listener is registered on the **`'scroll'` event**, which every offset change goes through now
 * (drag, wheel, fling, `scrollTo`, a zoom, a content swap, the post-resize clamp) — a slot that only
 * heard about `setOffset()` would keep a stale position after a pinch zoom. Writing the same value back
 * is a no-op on both sides, so the two directions cannot echo each other.
 */
function wireScrollOffset(widget: ScrollView, offset: ReactiveSource<number> | undefined): void {
  if (offset === undefined) {
    return;
  }
  bindOption(widget, offset, (host, next) => host.setScrollOffset(next));
  if (!isWritableSource(offset)) {
    return;
  }
  const listener = (): void => writeReactive(offset, widget.offset);
  widget.on('scroll', listener);
  widget.scope.onScopeDispose(() => widget.off('scroll', listener));
}

/**
 * Shows **one of several views** and rebuilds when the key changes — the structural conditional.
 *
 * `visible: () => …` keeps every node and flips a flag, which is right for "this warning appears when
 * the name is too short" and wrong for "this panel is a different tree on each tab" (all the
 * alternatives would be built, and only one shown). `Branch` builds the selected branch and destroys
 * the one you left, with the same entry rule as a page (`buildUiPage`: zero roots is an error, several
 * roots are wrapped with a warning).
 *
 * ```ts
 * Branch(
 *   () => this.tab.value,          // a ref or a getter; a constant builds once and never switches
 *   {
 *     profile: () => { … },
 *     settings: () => { … },
 *   },
 * );
 * ```
 *
 * A key with no branch is not a crash: the branch on screen is cleared and one development warning
 * names the key. State that must survive a switch belongs on the scene/ViewModel, not in the branch's
 * closure.
 */
export function Branch<K extends string | number>(
  select: ReactiveSource<K>,
  branches: Readonly<Record<string, BranchBuilder | undefined>>,
  options: BoxWidgetOptions & DslOptions = {},
): BranchWidget {
  const { rest } = splitDsl<BoxWidgetOptions>(options, 'box');
  const scene = currentUiScene();
  const widget = new BranchWidget(scene, { ...rest, branches });
  scene.add.existing(widget);
  applyDslOptions(widget, options);
  emitWidget(widget);

  // A `ref`/getter is bound frame-aligned like every other data slot, so the switch happens on the
  // frame the value flips; a constant is built once, here.
  if (isReactiveSource(select)) {
    bindValue<K>(
      widget,
      () => readReactive(select),
      (key) => {
        widget.setBranch(key as BranchKey);
      },
    );
  } else {
    widget.setBranch(readReactive(select));
  }
  return widget;
}

// --------------------------------------------------------------------- leaves

/**
 * Options every composable accepts on top of its widget's own bag.
 *
 * `visible` is the DSL's condition: a hidden widget leaves the flow (`hideMode: 'collapse'` is the
 * layout default), so `{ visible: () => open.value }` behaves like wrapping the widget in a Compose
 * `if`. It is a *reactive* slot, so the node is not rebuilt when the value flips.
 */
export interface DslOptions {
  visible?: ReactiveSource<boolean>;
}

/** Container option key unions, derived from the one table `setContainerOptions()` validates against. */
type BoxSlotKeys = (typeof BOX_KEYS)[number];
type GridSlotKeys = (typeof GRID_KEYS)[number];
type StackSlotKeys = (typeof STACK_KEYS)[number];

/** The keys of `T` that are runtime slots: its layout params, plus `C` (a container's own options). */
type SlotKeys<T, C = never> = Extract<keyof T, keyof LayoutParams> | Extract<keyof T, C>;

/**
 * The keys of `T` that may also be given as a `Ref`/getter — the **layout slots**.
 *
 * `K` is exactly what the widget can apply at runtime: its `LayoutParams` (`width`, `padding`, `grow`, …)
 * and, for a container, its container options (`gap`, `alignItems`, `columns`, …). Every other option
 * keeps its literal type, because a key without a runtime setter cannot be a slot — promising otherwise in
 * the types and ignoring the value at runtime is the trap `reportUnknownOptions()` exists to close.
 *
 * ```ts
 * Column({ gap: () => (state.dense.value ? 4 : 12) }, () => { … });   // re-lays out when the ref flips
 * Text('hi', { width: () => (state.wide.value ? 300 : 120) });        // … and so does a leaf's own box
 * ```
 *
 * The flip re-runs the layout pass on the subtree; nothing is rebuilt, so focus, scroll offsets and child
 * state survive — which is the whole point of a slot.
 */
export type Slotted<T, K extends keyof T = never> = {
  [P in keyof T]: P extends K ? T[P] | ReactiveSource<NonNullable<T[P]>> : T[P];
};

/**
 * Splits the DSL-level slots out of a widget's own option bag, **resolving the layout slots** on the way.
 *
 * A widget is constructed with values, not with sources: `new BoxWidget(scene, { gap: Ref })` would store
 * the `Ref` as a gap. So a slot key given as a `Ref`/getter is read once here (`readReactive`), and
 * `applyDslOptions()` binds it afterwards so later flips go through `setLayoutParams()` /
 * `setContainerOptions()`.
 *
 * `containerType` is the container the wrapper is about to build (`'box'`, `'grid'`, …) — it decides which
 * of the bag's keys are container options; leaf widgets pass nothing and only their layout params resolve.
 */
function splitDsl<W extends object>(
  options: object,
  containerType?: string | null,
): {
  visible: ReactiveSource<boolean> | undefined;
  rest: Omit<W, 'visible'>;
} {
  const { visible, ...rest } = optionBag(options) as {
    visible?: ReactiveSource<boolean>;
  } & Record<string, unknown>;
  // The cast is the point of this function: `W` is the **widget's** option bag (values), while the bag
  // handed in is the DSL's (values *or* sources). Resolution is what makes the two the same shape.
  return { visible, rest: resolveSlots<Omit<W, 'visible'>>(rest, containerType) };
}

/**
 * Replaces every layout slot that was given as a `Ref`/getter with its current value.
 *
 * @see splitDsl — this is the construction-time half of the same rule.
 */
function resolveSlots<W extends object>(
  bag: Record<string, unknown>,
  containerType?: string | null,
): W {
  let resolved: Record<string, unknown> | null = null;
  for (const [key, value] of Object.entries(bag)) {
    if (!isReactiveSource(value) || runtimeOptionTarget(containerType ?? null, key) === null) {
      continue;
    }
    resolved ??= { ...bag };
    resolved[key] = readReactive(value as ReactiveSource<unknown>);
  }
  return (resolved ?? bag) as W;
}

/** Applies the DSL-level options (currently just `visible`) to a freshly built widget. */
function applyDslOptions(widget: Widget, options: object): void {
  const bag = optionBag(options);
  const visible = bag.visible as ReactiveSource<boolean> | undefined;
  if (visible !== undefined) {
    widget.setVisible(readReactive(visible));
    if (isReactiveSource(visible)) {
      bindValue(
        widget,
        () => readReactive(visible) === true,
        (value, host) => {
          host.setVisible(value);
        },
      );
    }
  }
  bindLayoutSlots(widget, bag);
}

/**
 * Binds every layout slot of a freshly built widget — the one place that turns `{ gap: () => … }` or
 * `{ width: ref }` into a runtime patch.
 *
 * It runs for **every** DSL wrapper (`applyDslOptions` is the funnel they all call) because these keys are
 * the ones no widget setter owns: `width`/`padding`/`grow`/… go through `setLayoutParams()`, container
 * options (`gap`, `alignItems`, `columns`, …) through `setContainerOptions()`. The engine reads both on the
 * next layout pass, so flipping a ref re-lays out the subtree instead of rebuilding it.
 *
 * Which keys qualify comes from `runtimeOptionTarget()` — the same table `setContainerOptions()` validates
 * against — and never from the value's shape: `onClick`, `validate` and `items` are callbacks, and a
 * callback is textually indistinguishable from a getter.
 */
function bindLayoutSlots(widget: Widget, options: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(options)) {
    if (key === 'visible' || !isReactiveSource(value)) {
      continue;
    }
    const target = runtimeOptionTarget(widget.container?.type ?? null, key);
    if (target === null) {
      continue;
    }
    bindValue(widget, sourceGetter(value), (next, host) => {
      if (target === 'container') {
        host.setContainerOptions({ [key]: next });
      } else {
        host.setLayoutParams({ [key]: next } as LayoutParams);
      }
    });
  }
}

/**
 * Binds one reactive option slot to a widget setter.
 *
 * Constants keep the straight-line path (the widget is constructed with them); only a `Ref`/getter
 * creates a frame-aligned binding, exactly like the data slots do.
 */
function bindOption<T, W extends Widget>(
  widget: W,
  value: ReactiveSource<T> | undefined,
  apply: (widget: W, next: T) => void,
): void {
  if (value === undefined || !isReactiveSource(value)) {
    return;
  }
  bindValue(widget, sourceGetter(value), (next, host) => apply(host as W, next));
}

/**
 * `Panel` options with the DSL's reactive slots.
 *
 * `variant` is a theme token, and a token is state as often as it is a constant: a card turns `danger`
 * while its form is invalid and `primary` once it is saved.
 */
export type PanelDslOptions = Slotted<
  Omit<PanelOptions, 'variant'>,
  SlotKeys<PanelOptions, BoxSlotKeys>
> & {
  /** Background flavour; a `Ref`/getter repaints the panel (and its default border) when it changes. */
  variant?: ReactiveSource<PanelVariant>;
} & DslOptions;

/**
 * `VirtualKeyboard` options with the DSL's reactive slots.
 *
 * `kind` accepts a literal or a reactive source: a `ref`/getter rebuilds the keys when it changes.
 */
export type VirtualKeyboardDslOptions = Slotted<
  Omit<VirtualKeyboardOptions, 'kind'>,
  SlotKeys<VirtualKeyboardOptions, BoxSlotKeys>
> & {
  /** Which key set to show; a `Ref`/getter switches it (the widget rebuilds its keys). */
  kind?: ReactiveSource<VirtualKeyboardKind>;
} & DslOptions;

/** Options of `Text`: the label's own bag, plus the DSL's reactive slots. */
export type TextOptions = Slotted<
  Omit<LabelOptions, 'tone' | 'maxLines' | 'ellipsis'>,
  SlotKeys<LabelOptions>
> & {
  /** Semantic colour; a `Ref`/getter repaints the label when it flips. */
  tone?: ReactiveSource<LabelTone>;
  /**
   * Lines shown before the rest is dropped; a `Ref`/getter collapses and expands the label.
   *
   * Truncation is the one label option that is *state* rather than configuration — "2 lines, then show
   * all" is a paragraph's expanded/collapsed mode — so it is a data slot like `tone`:
   *
   * ```ts
   * const expanded = ref(false);
   * Text(() => vm.notes.value, { maxLines: () => (expanded.value ? 99 : 2), ellipsis: true });
   * ```
   */
  maxLines?: ReactiveSource<number>;
  /** Append `…` to the last visible line when lines are dropped; reactive for the same reason. */
  ellipsis?: ReactiveSource<boolean>;
} & DslOptions;

/**
 * A single- or multi-line label.
 *
 * ```ts
 * Text('静态文本');
 * Text(() => vm.title.value, { maxLines: 2, ellipsis: true });   // re-renders when the ref flips
 * ```
 */
export function Text(value: ReactiveSource<string>, options: TextOptions = {}): Label {
  const scene = currentUiScene();
  const { tone, maxLines, ellipsis, ...rest } = options;
  const label = new Label(scene, {
    ...resolveSlots<LabelOptions>(optionBag(rest)),
    ...(tone === undefined ? {} : { tone: readReactive(tone) }),
    ...(maxLines === undefined ? {} : { maxLines: readReactive(maxLines) }),
    ...(ellipsis === undefined ? {} : { ellipsis: readReactive(ellipsis) === true }),
    text: readReactive(value),
  });
  scene.add.existing(label);
  emitWidget(label);
  applyDslOptions(label, options);
  if (isReactiveSource(value)) {
    bindText(label, sourceGetter(value));
  }
  bindOption(label, tone, (host, next) => host.setTone(next));
  bindOption(label, maxLines, (host, next) => host.setMaxLines(next));
  bindOption(label, ellipsis, (host, next) => host.setEllipsis(next === true));
  return label;
}

/**
 * Options of `Button`: the widget's bag plus reactive `variant`/`disabled`/`loading`/`value`/`visible`.
 *
 * `value` is the toggle state as a *data slot*, so it behaves like a text field's value: a `Ref` is
 * two-way (flipping the button writes the ref, changing the ref flips the button), a getter is one-way
 * and reports changes through `onValueChange`. `onValueChange` listens to `BUTTON_EVENTS.CHANGE`, which
 * fires for *any* committed value change — a programmatic `setValue()` included; the user-only callback
 * is the `onClick` option.
 */
export type ButtonDslOptions = Slotted<
  Omit<ButtonOptions, 'variant' | 'disabled' | 'loading' | 'value'>,
  SlotKeys<ButtonOptions>
> & {
  variant?: ReactiveSource<ButtonVariant>;
  disabled?: ReactiveSource<boolean>;
  loading?: ReactiveSource<boolean>;
  value?: ReactiveSource<boolean>;
  onValueChange?: (value: boolean, button: ButtonWidget) => void;
} & DslOptions;

/** A button; its label, variant and state flags may all be reactive. */
export function Button(
  label: ReactiveSource<string>,
  options: ButtonDslOptions = {},
): ButtonWidget {
  const scene = currentUiScene();
  const { variant, disabled, loading, value, onValueChange, ...rest } = options;
  const button = new ButtonWidget(scene, {
    ...resolveSlots<ButtonOptions>(optionBag(rest)),
    ...(variant === undefined ? {} : { variant: readReactive(variant) }),
    ...(disabled === undefined ? {} : { disabled: readReactive(disabled) === true }),
    ...(loading === undefined ? {} : { loading: readReactive(loading) === true }),
    ...(value === undefined ? {} : { value: readReactive(value) === true }),
    text: readReactive(label),
  });
  scene.add.existing(button);
  emitWidget(button);
  applyDslOptions(button, options);
  if (isReactiveSource(label)) {
    bindText(button, sourceGetter(label));
  }
  bindOption(button, variant, (host, next) => host.setVariant(next));
  bindOption(button, disabled, (host, next) => host.setDisabled(next === true));
  bindOption(button, loading, (host, next) => host.setLoading(next === true));

  if (value !== undefined) {
    const store = isWritableSource(value)
      ? (next: boolean): void => writeReactive(value, next)
      : (next: boolean): void => onValueChange?.(next, button);
    bindBooleanModel(button, () => readReactive(value) === true, store);
  }
  if (onValueChange && (value === undefined || isWritableSource(value))) {
    // A getter source already routes user changes to `onValueChange` through the binding above.
    button.on(BUTTON_EVENTS.CHANGE, (next: boolean) => onValueChange(next, button));
  }
  return button;
}

/** A texture image. */
/** Options of `Image`: the widget's bag with a reactive texture. */
export type ImageDslOptions = Slotted<
  Omit<ImageOptions, 'texture' | 'frame'>,
  SlotKeys<ImageOptions>
> & {
  /**
   * Texture key, as registered with `scene.textures`; a `Ref`/getter swaps it at runtime.
   *
   * Which picture is on screen is state as often as it is configuration — an avatar that changes with
   * the selected player, a badge that turns into a "new" marker — and `Image#setTexture()` already
   * re-measures, so the slot is one line of state rather than a rebuilt widget.
   */
  texture?: ReactiveSource<string>;
  /** Frame inside the texture; reactive for the same reason. */
  frame?: ReactiveSource<string>;
} & DslOptions;

/** A texture drawn inside a layout rect. */
export function Image(options: ImageDslOptions): ImageWidget {
  const { texture, frame, ...rest } = options;
  const scene = currentUiScene();
  const widget = new ImageWidget(scene, {
    ...resolveSlots<ImageOptions>(optionBag(rest)),
    texture: readReactive(texture ?? ''),
    ...(frame === undefined ? {} : { frame: readReactive(frame) }),
  });
  scene.add.existing(widget);
  applyDslOptions(widget, options);
  bindOption(widget, texture, (host, next) => host.setTexture(next));
  // `setTexture(texture, frame)`: a reactive frame keeps the current texture and swaps only the frame,
  // which is why the two slots cannot share one `bindOption` callback without losing the other half.
  bindOption(widget, frame, (host, next) => {
    host.setTexture(host.currentTexture, next);
  });
  return emitWidget(widget);
}

/** Empty space. `Spacer({ flex: true })` is this framework's `Modifier.weight(1f)`. */
export function Spacer(
  options: Slotted<SpacerOptions, SlotKeys<SpacerOptions>> & DslOptions = {},
): SpacerWidget {
  const { rest } = splitDsl<SpacerOptions>(options);
  const scene = currentUiScene();
  const widget = new SpacerWidget(scene, rest);
  scene.add.existing(widget);
  applyDslOptions(widget, options);
  return emitWidget(widget);
}

/**
 * An on-screen keyboard for players with no keyboard (PLAN M9's 手柄文本输入).
 *
 * The keys are ordinary `Button`s, so the D-Pad, `Tab`, the pointer, the focus ring and the
 * accessibility mirror all work on them for free; the widget supplies the layout, the page/case state
 * and the mapping from a key to an edit on the target field (`insertText`/`deleteText`, i.e. the same
 * path a keystroke takes — `maxLength` and numeric filtering included).
 *
 * ```ts
 * const name = TextField({ label: '玩家名', width: 240 });
 * VirtualKeyboard({ target: () => name, onSubmit: () => this.submit() });
 * ```
 *
 * `kind` is a data slot like any other: a literal, a `ref`, or a getter. When it changes the keyboard
 * rebuilds its own keys, so switching between the letters keyboard and the numpad is one line of state
 * — no swapping widgets by hand, and no way to lose `onSubmit` on the way (round 81, V48):
 *
 * ```ts
 * const pin = ref(false);
 * VirtualKeyboard({ target: () => field, kind: () => (pin.value ? 'numeric' : 'text') });
 * ```
 */
export function VirtualKeyboard(options: VirtualKeyboardDslOptions): VirtualKeyboardWidget {
  const { visible, kind, ...rest } = options;
  const scene = currentUiScene();
  const widget = new VirtualKeyboardWidget(scene, {
    ...resolveSlots<VirtualKeyboardOptions>(optionBag(rest)),
    ...(kind === undefined ? {} : { kind: readReactive(kind) }),
  });
  scene.add.existing(widget);
  applyDslOptions(widget, options);
  bindOption(widget, kind, (host, next) => {
    host.setKind(next);
  });
  return withUiParent(widget);
}

export function Divider(
  options: Slotted<DividerOptions, SlotKeys<DividerOptions>> & DslOptions = {},
): DividerWidget {
  const { rest } = splitDsl<DividerOptions>(options);
  const scene = currentUiScene();
  const widget = new DividerWidget(scene, rest);
  scene.add.existing(widget);
  applyDslOptions(widget, options);
  return emitWidget(widget);
}

/**
 * Field options plus the Compose-style state pair.
 *
 * `value` accepts a `Ref` (two-way: user edits write straight back into it) or a getter (one-way).
 * `onValueChange` is the hoisted alternative: it listens to the field's `change` event, so a caller
 * that keeps state in a store rather than a `ref` can still write it back. Note that `change` reports
 * *every* committed value change — a programmatic `setValue()` included (see `TEXT_INPUT_EVENTS.CHANGE`);
 * use the field's `onChange` *option* when only user edits should count.
 */
export interface TextFieldDslOptions
  extends
    Slotted<
      Omit<TextFieldOptions, 'value' | 'onChange' | 'disabled' | 'readOnly'>,
      SlotKeys<TextFieldOptions>
    >,
    DslOptions {
  value?: ReactiveSource<string>;
  /** Reactive enabled state: `disabled: () => saving.value` (a `false` re-enables the field). */
  disabled?: ReactiveSource<boolean>;
  /**
   * Reactive "keep the text, reject every edit": `readOnly: () => locked.value`.
   *
   * The read-only twin of `disabled`, and the one a form actually wants while it saves: the text stays
   * readable and selectable, the box paints `surfaceAlt`, and every edit path (typing, paste, the DOM
   * bridge, the virtual keyboard) goes through the same funnel.
   */
  readOnly?: ReactiveSource<boolean>;
  /** Reactive validation state: an error message (shown under the field), or `null`/`false` to clear. */
  error?: ReactiveSource<string | boolean | null>;
  onValueChange?: (value: string, field: TextFieldWidget) => void;
}

/** {@link TextFieldDslOptions} for the multi-line field. */
export interface TextAreaDslOptions
  extends
    Slotted<
      Omit<TextAreaOptions, 'value' | 'onChange' | 'disabled' | 'readOnly'>,
      SlotKeys<TextAreaOptions>
    >,
    DslOptions {
  value?: ReactiveSource<string>;
  /** Reactive enabled state; see {@link TextFieldDslOptions.disabled}. */
  disabled?: ReactiveSource<boolean>;
  /** Reactive read-only state; see {@link TextFieldDslOptions.readOnly}. */
  readOnly?: ReactiveSource<boolean>;
  /** Reactive validation state; see {@link TextFieldDslOptions.error}. */
  error?: ReactiveSource<string | boolean | null>;
  onValueChange?: (value: string, field: TextAreaWidget) => void;
}

/** A single-line text input. */
export function TextField(options: TextFieldDslOptions = {}): TextFieldWidget {
  const scene = currentUiScene();
  const { value, onValueChange, disabled, readOnly, error, ...rest } = options;
  const field = new TextFieldWidget(scene, {
    ...resolveSlots<TextFieldOptions>(optionBag(rest)),
    ...(disabled === undefined ? {} : { disabled: readReactive(disabled) === true }),
    ...(readOnly === undefined ? {} : { readOnly: readReactive(readOnly) === true }),
    value: value === undefined ? '' : readReactive(value),
  });
  scene.add.existing(field);
  applyDslOptions(field, options);
  emitWidget(field);
  applyStateSlots(field, disabled, error);
  bindOption(field, readOnly, (host, next) => host.setReadOnly(next === true));
  wireFieldModel(field, value, onValueChange);
  return field;
}

/** A multi-line text input. */
export function TextArea(options: TextAreaDslOptions = {}): TextAreaWidget {
  const scene = currentUiScene();
  const { value, onValueChange, disabled, readOnly, error, ...rest } = options;
  const field = new TextAreaWidget(scene, {
    ...resolveSlots<TextAreaOptions>(optionBag(rest)),
    ...(disabled === undefined ? {} : { disabled: readReactive(disabled) === true }),
    ...(readOnly === undefined ? {} : { readOnly: readReactive(readOnly) === true }),
    value: value === undefined ? '' : readReactive(value),
  });
  scene.add.existing(field);
  applyDslOptions(field, options);
  emitWidget(field);
  applyStateSlots(field, disabled, error);
  bindOption(field, readOnly, (host, next) => host.setReadOnly(next === true));
  wireFieldModel(field, value, onValueChange);
  return field;
}

/**
 * Options of `Slider`: the widget's bag with a reactive two-way `value`.
 *
 * `value` accepts a `Ref` (edits write straight back into it, no converter glue) or a getter (one-way);
 * `onValueChange` fires on every user change, so a caller that keeps state in a store can write it back.
 */
export interface SliderDslOptions
  extends
    Slotted<
      Omit<SliderOptions, 'value' | 'onChange' | 'disabled' | 'min' | 'max'>,
      SlotKeys<SliderOptions>
    >,
    DslOptions {
  value?: ReactiveSource<number>;
  /**
   * Lower bound; a `Ref`/getter moves the range at runtime (e.g. a unit switch).
   *
   * The range is state like the value is: the knob sits at `(value - min) / (max - min)`, so switching
   * °C/°F or a device-dependent limit is one line instead of a rebuilt slider. Pair it with `max` —
   * a range has two halves and each slot passes the other through (`setRange(min, host.max)`).
   */
  min?: ReactiveSource<number>;
  /** Upper bound; see {@link SliderDslOptions.min}. */
  max?: ReactiveSource<number>;
  /** Reactive enabled state: `disabled: () => locked.value`. */
  disabled?: ReactiveSource<boolean>;
  /**
   * Called whenever the slider's value really changed — a drag/tap/key, **or** a value the widget had
   * to clamp when the range moved.
   *
   * Both cases must reach a caller that keeps its state outside a `ref`: a store that never hears about
   * the clamp would hold a value the widget can no longer show (see `Slider#setValue` for the measured
   * case). The user-only callback is the widget's `onChange` option.
   */
  onValueChange?: (value: number, slider: SliderWidget) => void;
}

/**
 * A draggable value control — the touch-native one.
 *
 * ```ts
 * Slider({ value: volume, min: 0, max: 1, step: 0.05, width: 200 });
 * Slider({ value: () => settings.brightness, onValueChange: (next) => save(next) });
 * ```
 */
export function Slider(options: SliderDslOptions = {}): SliderWidget {
  const scene = currentUiScene();
  const { value, onValueChange, disabled, min, max, ...rest } = options;
  const slider = new SliderWidget(scene, {
    ...resolveSlots<SliderOptions>(optionBag(rest)),
    ...(disabled === undefined ? {} : { disabled: readReactive(disabled) === true }),
    ...(min === undefined ? {} : { min: readReactive(min) }),
    ...(max === undefined ? {} : { max: readReactive(max) }),
    ...(value === undefined ? {} : { value: readReactive(value) }),
  });
  scene.add.existing(slider);
  applyDslOptions(slider, options);
  emitWidget(slider);
  if (disabled !== undefined) {
    bindOption(slider, disabled, (host, next) => host.setEnabled(next !== true));
  }
  // One Phaser-level call carries both halves of the range (`setRange(min, max)`), so each slot passes
  // the other through — the same shape as `Image`'s texture/frame pair. Order does not matter: both
  // bindings run in the same flush and each reads the field the other just wrote.
  bindOption(slider, min, (host, next) => host.setRange(next, host.max));
  bindOption(slider, max, (host, next) => host.setRange(host.min, next));

  if (value !== undefined) {
    const store = isWritableSource(value)
      ? (next: number): void => writeReactive(value, next)
      : (next: number): void => onValueChange?.(next, slider);
    bindNumberModel(slider, sourceGetter(value) as () => number, store);
  }
  if (onValueChange && (value === undefined || isWritableSource(value))) {
    // A getter source already routes user changes to `onValueChange` through the binding above.
    slider.on(SLIDER_EVENTS.CHANGE, (next: number) => onValueChange(next, slider));
  }
  return slider;
}

// --------------------------------------------------------------------- lists

/** Options of `List`: everything `Repeat` takes except the template, which is the content lambda. */
export type ListOptions<Item> = Slotted<
  Omit<RepeatOptions<Item>, 'template' | 'empty' | 'container'>,
  SlotKeys<RepeatOptions<Item>>
> &
  DslOptions &
  ListFlowShorthands & {
    /** Content lambda for the empty state; omitted shows nothing. */
    empty?: (() => void) | null;
    /** Row flow in its full form; the shorthands above are merged into it (explicit fields win). */
    container?: BoxLayoutOptions | GridLayoutOptions;
  };

/**
 * A keyed list, optionally virtualised — the `LazyColumn` of this framework.
 *
 * ```ts
 * List({ items: () => vm.rows, key: (row) => row.id, gap: 6 }, (row, index) => {
 *   Row({ gap: 8 }, () => {
 *     Text(() => row.name);
 *     Spacer({ flex: true });
 *     Text(`${index + 1}`);
 *   });
 * });
 * ```
 *
 * The content lambda runs once per key, so it must build exactly one root widget.
 */
export function List<Item>(
  options: ListOptions<Item>,
  item: (item: Item, index: number, ctx: BindingContext) => void,
): Repeat<Item> {
  const scene = currentUiScene();
  const { empty, visible, gap, rowGap, columnGap, container, ...rest } = options;
  const widget = new Repeat<Item>(scene, {
    ...resolveSlots<Omit<RepeatOptions<Item>, 'template' | 'empty' | 'container'>>(optionBag(rest)),
    container: withListFlow(container, { gap, rowGap, columnGap }),
    template: (row, index, ctx) => buildUiSubtree(scene, () => item(row, index, ctx), 'List()'),
    empty:
      empty === null || empty === undefined
        ? null
        : () => buildUiSubtree(scene, empty, 'List({ empty })'),
  });
  scene.add.existing(widget);
  applyDslOptions(widget, options);
  return emitWidget(widget);
}

// --------------------------------------------------------------------- internals

interface ComposedArgs<O> {
  options: O;
  content: (() => void) | undefined;
}

/**
 * Accepts both call shapes: `Column(() => { … })` (Compose-like, no options) and
 * `Column({ gap: 8 }, () => { … })`.
 */
function normalizeContent<O>(
  options: O | (() => void) | undefined,
  content: (() => void) | undefined,
): ComposedArgs<O> {
  if (typeof options === 'function') {
    return { options: {} as O, content: options as () => void };
  }
  return { options: (options ?? {}) as O, content };
}

/**
 * Connects a text field to its data slot.
 *
 * A `Ref` gets full two-way binding (`bindModel` handles both directions and pauses write-back during
 * IME composition); a getter is read-only, so edits are routed to `onValueChange` instead. With
 * neither, the field simply keeps its own value.
 */
/**
 * Applies the reactive state slots of a text field: `disabled` and `error`.
 *
 * Both write through the widget's own API (`setEnabled`/`setError`), so a reactive error is exactly the
 * error the DOM bridge, the accessibility mirror and the painted state already know about — no second
 * source of truth. A literal is applied once; a `Ref`/getter keeps a frame-aligned binding.
 */
function applyStateSlots(
  field: TextInputBase,
  disabled: ReactiveSource<boolean> | undefined,
  error: ReactiveSource<string | boolean | null> | undefined,
): void {
  if (error !== undefined) {
    field.setError(readReactive(error) ?? null);
    bindOption(field, error, (host, next) => {
      host.setError(next ?? null);
    });
  }
  if (disabled !== undefined) {
    bindOption(field, disabled, (host, next) => host.setEnabled(next !== true));
  }
}

function wireFieldModel<T extends TextFieldWidget | TextAreaWidget>(
  field: T,
  value: ReactiveSource<string> | undefined,
  onValueChange: ((value: string, field: T) => void) | undefined,
): void {
  if (value !== undefined) {
    const store = isWritableSource(value)
      ? (next: string): void => writeReactive(value, next)
      : (next: string): void => onValueChange?.(next, field);
    bindModel(field, sourceGetter(value), store);
  }
  if (onValueChange) {
    field.on(TEXT_INPUT_EVENTS.CHANGE, (next: string) => onValueChange(next, field));
  }
}
