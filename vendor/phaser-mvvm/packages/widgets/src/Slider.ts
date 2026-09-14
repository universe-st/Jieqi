/**
 * `Slider` — a draggable value control, the touch-native member of the control library.
 *
 * Compose's `Slider` in spirit: a track, a filled portion and a knob, driven by a **continuous drag**
 * rather than by an activation. A press anywhere on the track jumps the knob there, and a drag keeps
 * tracking — including *outside* the widget's own rect, which is why the drag listens to the scene's
 * pointer stream instead of to the widget's own `pointermove` (Phaser stops emitting that event the
 * moment the pointer leaves the object; a finger sliding off the end of a slider must keep working).
 *
 * Values are **quantised and clamped** by `min`/`max`/`step` before anything is reported, so a bound
 * `ref` never sees an out-of-range or off-grid value. The geometry maths lives in the exported pure
 * functions below (`sliderValueFromPosition` / `sliderPositionOf`) and is unit-tested in Node.
 *
 * Keyboard: not wired yet. Arrow keys are consumed by the focus manager for navigation, so a keyboard
 * slider needs an agreement with it (tracked in `docs/DEFECT-BACKLOG.md`); pointer and touch are the
 * supported inputs today.
 */

import Phaser from 'phaser';
import type { BoxConstraints, LayoutParams, Rect, Size } from '@phaser-mvvm/layout';
import {
  ARROW_KEY_OF_DIRECTION,
  Widget,
  colorOf,
  pointerInWidgetSpace,
  type PointerChainOptionHooks,
} from '@phaser-mvvm/phaser';
import type { A11yDescriptor, NavAction } from '@phaser-mvvm/phaser';
import { paintFocusRing } from './appearance';
import {
  clampSliderValue,
  sliderFraction,
  sliderValueForKey,
  sliderValueFromPosition,
} from './slider-geometry';
import { optionBag, splitWidgetOptions, baseWidgetOptions } from './options';

export interface SliderOptions extends LayoutParams, PointerChainOptionHooks {
  /** Initial value; clamped into `[min, max]` and snapped to `step`. Defaults to `min`. */
  value?: number;
  /** Lower bound. Defaults to `0`. */
  min?: number;
  /** Upper bound. Defaults to `100`. */
  max?: number;
  /** Grid the value snaps to; `0` (the default) means continuous. */
  step?: number;
  disabled?: boolean;
  /** Track thickness in design pixels. Defaults to `6`. */
  trackThickness?: number;
  /** Knob radius in design pixels. Defaults to `9`. */
  knobRadius?: number;
  /** Called with the new value on every *user* change (not on `setValue`). */
  onChange?: (value: number, slider: Slider) => void;
  name?: string;
  /** Tab order hint for the focus manager (lower first). */
  focusOrder?: number;
  /** Accessible name for the DOM mirror (see `Widget.a11yLabel`); defaults to the visible text. */
  label?: string;
}

type SliderWidgetOptions = Omit<SliderOptions, keyof LayoutParams | 'name'>;

const SLIDER_KEYS = [
  'value',
  'min',
  'max',
  'step',
  'disabled',
  'trackThickness',
  'knobRadius',
  'onChange',
] as const;

/** Events emitted by a slider. */
export const SLIDER_EVENTS = {
  /** Fired with the new value when the user drags or taps the track. */
  CHANGE: 'change',
} as const;

/** Default track length when the caller does not set one. */
/** Keys the slider owns beyond navigation (`←`/`→` are navigation actions and go through `onAction`). */
const EXTRA_KEYS = new Set(['Home', 'End', 'PageUp', 'PageDown']);

const DEFAULT_WIDTH = 180;

export class Slider extends Widget {
  min: number;
  max: number;
  step: number;
  /** Track thickness in design pixels. */
  trackThickness: number;
  /** Knob radius in design pixels. */
  knobRadius: number;
  onChange: ((value: number, slider: Slider) => void) | null;

  private readonly trackGraphics: Phaser.GameObjects.Graphics;
  private current: number;
  private dragging = false;
  /** The pointer that owns the drag: a second finger must not steer this slider (touch ids are 1..n). */
  private dragPointerId: number | null = null;
  private styleKey = '';

  constructor(scene: Phaser.Scene, options: SliderOptions = {}) {
    const { layout, widget } = splitWidgetOptions<SliderWidgetOptions>(
      optionBag(options),
      SLIDER_KEYS,
    );
    super(scene, { layout, ...baseWidgetOptions(options) });

    this.min = Number.isFinite(widget.min) ? (widget.min as number) : 0;
    this.max = Number.isFinite(widget.max) ? (widget.max as number) : 100;
    if (this.max < this.min) {
      this.max = this.min;
    }
    this.step =
      Number.isFinite(widget.step) && (widget.step as number) > 0 ? (widget.step as number) : 0;
    this.trackThickness = Math.max(2, Math.round(widget.trackThickness ?? 6));
    this.knobRadius = Math.max(4, Math.round(widget.knobRadius ?? 9));
    this.onChange = widget.onChange ?? null;
    this.current = clampSliderValue(widget.value ?? this.min, this.min, this.max, this.step);

    if (options.width === undefined) {
      this.layoutParams.width = DEFAULT_WIDTH;
    }
    if (options.height === undefined) {
      this.layoutParams.height = this.knobRadius * 2 + 4;
    }

    this.focusable = true;
    // A slider is a `slider` to a screen reader, with its range and current value read live.
    this.a11y = { role: 'slider' };
    this.trackGraphics = new Phaser.GameObjects.Graphics(scene);
    this.add(this.trackGraphics);

    this.enablePointerInput();
    // The pointer is read from its own coordinates rather than from Phaser's `localX`: that value is
    // offset by `displayOrigin` (half of the container's size - see `Widget#enablePointerInput`), so a
    // press in the middle of a 200px slider reports 200 and maps to the wrong end. `localXOf` uses the
    // same space helper the input router uses, so a click on a camera-pinned slider lands correctly too.
    this.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      this.beginDrag(pointer);
    });
    // `←`/`→` are *navigation actions*, so they are claimed through `onAction`: the same call serves the
    // keyboard and the gamepad, which is what makes a D-Pad adjust the value instead of walking focus
    // away from it (V28). `↑`/`↓` are declined on purpose — they are the way out of a horizontal
    // slider with a D-Pad, exactly like any other widget.
    this.onAction = (action) => this.handleAction(action);
    // Keys that are not navigation actions stay keyboard-only (`Widget#onKeyDown`).
    this.onKeyDown = (event) => this.handleExtraKey(event);

    if (widget.disabled === true) {
      this.setEnabled(false);
    }
    this.refreshAppearance();
  }

  // ------------------------------------------------------------------ value

  /** The current value, already clamped and snapped. */
  get value(): number {
    return this.current;
  }

  set value(next: number) {
    this.setValue(next);
  }

  /** Live description for the accessibility mirror (`a11y.ts`). */
  override describeA11y(): A11yDescriptor | null {
    return {
      role: 'slider',
      label: this.a11yLabel ?? this.name ?? 'slider',
      value: Math.round(this.current * 100) / 100,
      min: this.min,
      max: this.max,
      disabled: !this.enabled,
    };
  }

  getValue(): number {
    return this.current;
  }

  /**
   * Sets the value programmatically; clamps/snaps it and reports the result on `change`.
   *
   * `change` fires for **any** committed value change, programmatic ones included, because it is the
   * channel a two-way binding listens on (`bindNumberModel`): a widget that moved its own value
   * silently would leave the bound `ref` stale forever — the down-binding never re-reads an unchanged
   * source, so nothing would ever correct it (measured on `#/compose`: `setValue(80)` left
   * `slots().volume` at 40, and a range clamp left the same disagreement). The `onChange` **option**
   * stays user-only, which is the same split `TEXT_INPUT_EVENTS.CHANGE` and its `onChange` already have.
   */
  setValue(next: number): this {
    const resolved = clampSliderValue(next, this.min, this.max, this.step);
    if (resolved === this.current) {
      return this;
    }
    this.current = resolved;
    this.refreshAppearance();
    // `valuenow` is what a screen reader reads for a slider, and a programmatic write (`bindNumberModel`)
    // must reach it without waiting for focus.
    this.notifyA11yChanged();
    this.emit(SLIDER_EVENTS.CHANGE, resolved);
    return this;
  }

  /**
   * Changes the range; the current value is re-clamped (and re-snapped) against it.
   *
   * The **paint** does not depend on the value alone: the knob and the filled portion sit at
   * `(value - min) / (max - min)`, so widening the range keeps the value and moves the knob. That is
   * why this method repaints unconditionally instead of leaning on `setValue` — which returns early
   * when the value survived the clamp (V67: measured `setRange(0, 200)` with value 40 left the fill
   * covering 40% of the track instead of 20%) — and why `min`/`max` are part of the paint cache key.
   *
   * A clamp the *widget* performs is a real value change as far as the model is concerned, so it takes
   * the same reporting path as `setValue` (see there).
   */
  setRange(min: number, max: number): this {
    const nextMin = Number.isFinite(min) ? min : 0;
    const nextMax = Number.isFinite(max) ? Math.max(nextMin, max) : nextMin;
    const rangeChanged = nextMin !== this.min || nextMax !== this.max;
    this.min = nextMin;
    this.max = nextMax;
    if (!rangeChanged) {
      return this;
    }
    // The mirror reads `min`/`max` from `describeA11y()`, so a range change has to reach it even when
    // the value stayed inside it (V68: `aria-valuemax` kept the old bound).
    this.notifyA11yChanged();
    const resolved = clampSliderValue(this.current, this.min, this.max, this.step);
    if (resolved === this.current) {
      this.refreshAppearance();
      return this;
    }
    this.current = resolved;
    this.refreshAppearance();
    this.emit(SLIDER_EVENTS.CHANGE, resolved);
    return this;
  }

  /**
   * Sets the snapping grid; `0` means continuous.
   *
   * Re-snapping can move the value, and a moved value is reported through `setValue` (see there); the
   * paint itself does not depend on `step`, so an unchanged value needs no repaint.
   */
  setStep(step: number): this {
    this.step = Number.isFinite(step) && step > 0 ? step : 0;
    return this.setValue(this.current);
  }

  // ------------------------------------------------------------------ pointer

  /**
   * Starts a drag, or jumps the knob for a plain tap.
   *
   * The router sends `pointerdown` only to the resolved target, so a press that belongs to a panel
   * above the slider never starts a drag here.
   */
  private beginDrag(pointer: Phaser.Input.Pointer): void {
    if (!this.enabled) {
      return;
    }
    if (this.dragging) {
      return;
    }
    this.dragging = true;
    this.dragPointerId = pointer.id;
    this.applyLocalX(this.localXOf(pointer));
    // The scene stream keeps the drag alive once the pointer leaves the widget's rect, and it is the
    // same stream a touch produces, so one implementation covers mouse and finger.
    const input = this.scene?.input;
    input?.on('pointermove', this.onScenePointerMove);
    input?.on('pointerup', this.onScenePointerUp);
    input?.on('pointerupoutside', this.onScenePointerUp);
  }

  private readonly onScenePointerMove = (pointer: Phaser.Input.Pointer): void => {
    if (!this.dragging || this.isDestroyed || pointer.id !== this.dragPointerId) {
      return;
    }
    this.applyLocalX(this.localXOf(pointer));
  };

  private readonly onScenePointerUp = (pointer?: Phaser.Input.Pointer): void => {
    // Only the finger that grabbed the slider may let go of it.
    if (pointer && this.dragPointerId !== pointer.id) {
      return;
    }
    this.endDrag();
  };

  private endDrag(): void {
    if (!this.dragging) {
      return;
    }
    this.dragging = false;
    this.dragPointerId = null;
    const input = this.scene?.input;
    input?.off('pointermove', this.onScenePointerMove);
    input?.off('pointerup', this.onScenePointerUp);
    input?.off('pointerupoutside', this.onScenePointerUp);
  }

  /**
   * Pointer position in this widget's local space: the router's coordinate space minus the container
   * chain's offsets (the same sum the layout engine uses when it places the widget).
   */
  private localXOf(pointer: Phaser.Input.Pointer): number {
    const point = pointerInWidgetSpace(pointer, this, this.scene?.cameras.main ?? null);
    // The widget's own `x` is part of the offset: `applyLocalX` maps onto `this.rect`, whose origin
    // is this widget's top-left corner, so local 0 has to be the left edge — not the parent's.
    let offset = this.x;
    let node: Phaser.GameObjects.Container | null = this.parentContainer;
    while (node) {
      offset += node.x;
      node = node.parentContainer;
    }
    return point.x - offset;
  }

  /** Maps a local x onto the track and reports the resulting value. */
  private applyLocalX(localX: number): void {
    const width = Math.max(0, this.rect.width);
    const length = Math.max(0, width - this.knobRadius * 2);
    const next = sliderValueFromPosition(
      localX - this.knobRadius,
      length,
      this.min,
      this.max,
      this.step,
    );
    if (next === this.current) {
      return;
    }
    this.current = next;
    this.refreshAppearance();
    this.onChange?.(next, this);
    this.emit(SLIDER_EVENTS.CHANGE, next);
  }

  /**
   * Navigation actions along the slider's axis change the value.
   *
   * `left`/`right` are claimed for **every** device (keyboard arrows and gamepad D-Pad/stick); the
   * cross-axis directions are declined so they keep navigating focus away from the slider.
   */
  private handleAction(action: NavAction): boolean {
    if (!this.enabled) {
      return false;
    }
    if (action !== 'left' && action !== 'right') {
      return false;
    }
    return this.applyValue(
      sliderValueForKey(
        this.current,
        ARROW_KEY_OF_DIRECTION[action],
        this.min,
        this.max,
        this.step,
      ),
    );
  }

  /** Keys beyond navigation: `Home`/`End` jump to the ends, `PageUp`/`PageDown` by a tenth of the range. */
  private handleExtraKey(event: KeyboardEvent): boolean {
    if (!this.enabled) {
      return false;
    }
    if (!EXTRA_KEYS.has(event.key)) {
      return false;
    }
    return this.applyValue(
      sliderValueForKey(this.current, event.key, this.min, this.max, this.step),
    );
  }

  /** Applies whatever a key or a navigation action resolved to, reporting it exactly like a drag would. */
  private applyValue(next: number | null): boolean {
    if (next === null) {
      return false;
    }
    if (next !== this.current) {
      this.current = next;
      this.refreshAppearance();
      this.onChange?.(next, this);
      this.emit(SLIDER_EVENTS.CHANGE, next);
    }
    return true;
  }

  // ------------------------------------------------------------------ lifecycle

  override destroy(fromScene?: boolean): void {
    this.endDrag();
    super.destroy(fromScene);
  }

  // ------------------------------------------------------------------ layout & paint

  override measureContent(_constraint: BoxConstraints): Size {
    return { width: DEFAULT_WIDTH, height: this.knobRadius * 2 + 4 };
  }

  protected override onRectChanged(_rect: Rect): void {
    this.refreshAppearance();
  }

  protected override refreshAppearance(): void {
    const theme = this.theme;
    const width = Math.max(0, this.rect.width);
    const height = Math.max(0, this.rect.height);
    const disabled = !this.enabled;

    // Every input the paint below reads belongs in this key. `min`/`max` are the ones that are easy to
    // forget — the knob sits at `(value - min) / (max - min)`, so a range change moves the whole drawing
    // while `current` stays put (V67), and `knobRadius`/`trackThickness` resize it.
    //
    // `focusVisible` is in here for the same reason and was the one that got away (round 113): the ring
    // is drawn from `focusVisible`, not from `visualState`, so a pointer press on an already-focused
    // slider (state stays `focused`, visibility goes true → false) produced the same key and the paint
    // was skipped — the ring stayed on screen until something *else* forced a repaint. A cache key has to
    // cover everything the paint reads, including the inputs it reads for a *second* drawing decision.
    const key = [
      width,
      height,
      this.current,
      this.min,
      this.max,
      this.knobRadius,
      this.trackThickness,
      this.visualState,
      this.focusVisible,
      disabled,
      theme.name,
    ].join('|');
    if (key === this.styleKey) {
      return;
    }
    this.styleKey = key;

    const graphics = this.trackGraphics;
    graphics.clear();
    if (width <= 0 || height <= 0) {
      return;
    }

    const centerY = height / 2;
    const radius = this.knobRadius;
    const start = radius;
    const length = Math.max(0, width - radius * 2);
    const knobX = start + sliderFraction(this.current, this.min, this.max) * length;

    // Track (full length, then the filled part on top of it).
    const trackColor = colorOf(theme, undefined, theme.colors.border);
    const fillColor = disabled
      ? theme.colors.textDisabled
      : this.pressed || this.dragging
        ? theme.colors.primaryPressed
        : this.hovered
          ? theme.colors.primaryHover
          : theme.colors.primary;

    graphics.fillStyle(trackColor, disabled ? 0.5 : 1);
    graphics.fillRoundedRect(
      start,
      centerY - this.trackThickness / 2,
      length,
      this.trackThickness,
      this.trackThickness / 2,
    );
    if (knobX > start) {
      graphics.fillStyle(fillColor, 1);
      graphics.fillRoundedRect(
        start,
        centerY - this.trackThickness / 2,
        knobX - start,
        this.trackThickness,
        this.trackThickness / 2,
      );
    }

    // Knob: a solid disc with a rim; it grows a little while dragged, the standard touch affordance
    // that tells a finger "you are holding this".
    const active = this.dragging || this.pressed;
    const knobRadius = radius + (active ? 1 : 0);
    graphics.fillStyle(disabled ? theme.colors.surfaceAlt : theme.colors.surface, 1);
    graphics.fillCircle(knobX, centerY, knobRadius);
    graphics.lineStyle(theme.borderWidth * 2, disabled ? theme.colors.textDisabled : fillColor, 1);
    graphics.strokeCircle(knobX, centerY, knobRadius);

    if (this.focusVisible) {
      paintFocusRing(graphics, theme, width, height, Math.min(theme.radius.md, height / 2));
    }
  }
}
