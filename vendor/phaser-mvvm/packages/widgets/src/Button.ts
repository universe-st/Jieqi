/**
 * `Button` — a themed, focusable, activatable control.
 *
 * Visual state comes from the `Widget` state machine (`normal`/`hover`/`pressed`/`disabled`/
 * `focused`) and is painted with a `ProceduralSkin`; the keyboard-focus ring is a `Graphics` outline
 * (PLAN §10.3), so no art asset is involved. The button never listens to Phaser input itself: the
 * input router calls `setHovered`/`setPressed` and `activate()`, which keeps pointer, keyboard and
 * gamepad handling in one place.
 */

import Phaser from 'phaser';
import type { BoxConstraints, LayoutParams, Rect, Size } from '@phaser-mvvm/layout';
import type {
  PointerChainOptionHooks,
  A11yDescriptor,
  Theme,
  WidgetState,
} from '@phaser-mvvm/phaser';
import { ProceduralSkin, Widget } from '@phaser-mvvm/phaser';
import { buttonSkinStyles, buttonTextColor, paintFocusRing } from './appearance';
import { buttonLabel, resolveButtonActivation, resolveButtonState } from './button-state';
import { toCssColor } from './color';
import { centeredOffset, contentBox, fitIcon } from './geometry';
import { optionBag, splitWidgetOptions, baseWidgetOptions } from './options';
import { glyphPadding } from './text-padding';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonOptions extends LayoutParams, PointerChainOptionHooks {
  /** Label text. */
  text?: string;
  /** Texture key of an icon, or a ready-made Game Object (which must expose `width`/`height`). */
  icon?: string | Phaser.GameObjects.GameObject;
  /** Visual flavour. Defaults to `'secondary'`. */
  variant?: ButtonVariant;
  /** Size step, used for the default height and the horizontal padding. Defaults to `'md'`. */
  size?: ButtonSize;
  /** Starts disabled; `setDisabled` toggles the same flag. */
  disabled?: boolean;
  /** Toggle mode: activation flips `value` and emits `change` instead of running `onClick`. */
  toggle?: boolean;
  /** Initial toggle value. */
  value?: boolean;
  /** Starts in the loading state: activation is ignored and the label gains an ellipsis. */
  loading?: boolean;
  /** Runs on activation of a non-toggle button. */
  onClick?: (button: Button) => void;
  name?: string;
  /** Tab order hint for the focus manager (lower first). */
  focusOrder?: number;
  /** Accessible name for the DOM mirror (see `Widget.a11yLabel`); defaults to the visible text. */
  label?: string;
}

type ButtonWidgetOptions = Omit<ButtonOptions, keyof LayoutParams | 'name'>;

const BUTTON_KEYS = [
  'text',
  'icon',
  'variant',
  'size',
  'disabled',
  'toggle',
  'value',
  'loading',
  'onClick',
] as const;

/** Events emitted by a button. */
export const BUTTON_EVENTS = {
  /** Fired by a `toggle` button with the new value. */
  CHANGE: 'change',
} as const;

/**
 * The part of a Game Object an icon must expose to be placeable.
 *
 * `Phaser.GameObjects.GameObject` itself carries no size and no transform (those come from optional
 * components), so the button asks for them structurally. A texture-key icon always satisfies it; a
 * hand-made icon should be an `Image`/`Sprite` with a top-left origin.
 *
 * `displayWidth`/`displayHeight` are the *rendered* size (the scale applied), which is what the
 * button caps: an icon the caller already shrank stays shrunk. `setDisplaySize` is how the cap is
 * applied to a textured object; `setScale` covers everything else with a transform (a `Graphics`, a
 * `Container`), so a too-large icon can always be brought inside the button instead of spilling.
 */
interface IconLike extends Phaser.GameObjects.GameObject {
  width?: number;
  height?: number;
  displayWidth?: number;
  displayHeight?: number;
  setPosition?(x: number, y: number): unknown;
  setDisplaySize?(width: number, height: number): unknown;
  setScale?(x: number, y?: number): unknown;
}

/**
 * An icon's own size, as the button reads it once.
 *
 * `displayWidth`/`displayHeight` (the *rendered* size, scale included) win over `width`/`height`, so
 * an icon the caller already sized with `setDisplaySize` keeps that size instead of being treated as
 * the full texture. Everything falls back to `0`, which means "no icon size to work with".
 */
function naturalIconSize(icon: IconLike): Size {
  return {
    width: icon.displayWidth ?? icon.width ?? 0,
    height: icon.displayHeight ?? icon.height ?? 0,
  };
}

/**
 * Breathing room between an icon and the button's own edge.
 *
 * An icon as tall as the button covers the rounded corners of the button's background, which reads as
 * "the button lost its shape". One `spacing.xs` per side is enough to keep the silhouette.
 */
function iconInset(theme: Theme): number {
  return theme.spacing.xs;
}

export class Button extends Widget {
  /** Label text as configured; the displayed text may carry a loading ellipsis. */
  readonly label: Phaser.GameObjects.Text;

  /** Visual flavour. */
  variant: ButtonVariant;
  /** Size step (drives the default height and padding). */
  size: ButtonSize;
  toggle: boolean;
  loading: boolean;
  /** Runs on activation of a non-toggle button. */
  onClick: ((button: Button) => void) | null;

  private readonly bodyGraphics: Phaser.GameObjects.Graphics;
  private iconObject: IconLike | null = null;
  /**
   * The icon's size as it was handed in, kept so every fit is computed from the same starting point.
   *
   * Reading the icon's *current* size instead would compound: the button shrinks the icon to the box
   * it has at that moment, and the next pass would then treat the shrunken size as the natural one —
   * a button that briefly got small would keep a small icon forever after.
   */
  private iconNatural: Size = { width: 0, height: 0 };
  private value: boolean;
  private labelText: string;
  private explicitHeight: boolean;
  private styleKey = '';
  /** Last glyph padding applied to the label (see `text-padding.ts`). */
  private glyphPad = -1;
  private skinCache: { theme: Theme; variant: ButtonVariant; skin: ProceduralSkin } | null = null;

  constructor(scene: Phaser.Scene, options: ButtonOptions = {}) {
    const { layout, widget } = splitWidgetOptions<ButtonWidgetOptions>(
      optionBag(options),
      BUTTON_KEYS,
    );
    super(scene, { layout, ...baseWidgetOptions(options) });

    this.variant = widget.variant ?? 'secondary';
    this.size = widget.size ?? 'md';
    this.toggle = widget.toggle === true;
    this.loading = widget.loading === true;
    this.value = widget.value === true;
    this.labelText = widget.text ?? '';
    this.onClick = widget.onClick ?? null;
    this.explicitHeight = options.height !== undefined;

    if (!this.explicitHeight) {
      this.layoutParams.height = this.theme.controlHeight[this.size];
    }

    this.focusable = true;
    // A toggle button is a checkbox to a screen reader, an ordinary button otherwise. The label and
    // the toggle state are read live through `describeA11y()`.
    this.a11y = { role: this.toggle ? 'checkbox' : 'button' };
    this.onActivate = () => {
      this.handleActivation();
    };

    this.bodyGraphics = new Phaser.GameObjects.Graphics(scene);
    this.add(this.bodyGraphics);

    if (widget.icon !== undefined) {
      this.setIcon(widget.icon);
    }

    this.label = new Phaser.GameObjects.Text(scene, 0, 0, this.labelText, {});
    this.label.setOrigin(0, 0);
    this.add(this.label);

    this.applyThemeStyle();
    this.enablePointerInput();

    if (widget.disabled === true) {
      this.setEnabled(false);
    }
    this.refreshAppearance();
  }

  // ------------------------------------------------------------------ value & flags

  /**
   * A loading button ignores activation completely — and says so, so that the input router does not
   * treat the press as handled.
   */
  override activate(source: Parameters<Widget['activate']>[0] = 'pointer'): boolean {
    if (this.loading) {
      return false;
    }
    return super.activate(source);
  }

  getValue(): boolean {
    return this.value;
  }

  /**
   * Sets the toggle value, reporting a real change on `change`.
   *
   * A toggle's `value` is a data slot (`Button({ toggle: true, value: ref })`), and the binding that
   * keeps the `ref` in step listens on `change`. Writing silently therefore left the widget and the
   * model disagreeing forever — the down-binding only runs when the *source* changes (measured on
   * `#/a11y`: `setValue(false)` switched the button off while the page still published
   * `notify=true`, the slider's V69 in another widget). `change` fires for any committed change;
   * `onClick` stays the user-only callback.
   */
  setValue(value: boolean): this {
    if (this.value === value) {
      return this;
    }
    this.value = value;
    this.appearanceChanged();
    // A toggle's value is its `checked` state to a screen reader.
    this.notifyA11yChanged();
    this.emit(BUTTON_EVENTS.CHANGE, value);
    return this;
  }

  setText(value: string): this {
    if (this.labelText === value) {
      return this;
    }
    this.labelText = value;
    // The visible text is the default accessible name.
    this.notifyA11yChanged();
    this.applyThemeStyle();
    this.markDirty();
    return this;
  }

  /** Live description for the accessibility mirror (`a11y.ts`). */
  override describeA11y(): A11yDescriptor | null {
    const text = this.a11yLabel ?? this.labelText;
    const label = this.loading ? `${text} (loading)` : text;
    return {
      role: this.toggle ? 'checkbox' : 'button',
      label,
      ...(this.toggle ? { checked: this.value } : {}),
      disabled: !this.enabled,
    };
  }

  getText(): string {
    return this.labelText;
  }

  setVariant(variant: ButtonVariant): this {
    if (this.variant === variant) {
      return this;
    }
    this.variant = variant;
    this.applyThemeStyle();
    this.appearanceChanged();
    return this;
  }

  setLoading(value: boolean): this {
    if (this.loading === value) {
      return this;
    }
    this.loading = value;
    this.applyThemeStyle();
    this.appearanceChanged();
    // The loading ellipsis changes the measured width of an auto-width button.
    this.markDirty();
    return this;
  }

  /** Convenience inverse of `setEnabled`. */
  setDisabled(value: boolean): this {
    return this.setEnabled(!value);
  }

  /**
   * Swaps the icon; a string is a texture key and is turned into an `Image` with a top-left origin,
   * a Game Object is used as-is (its own origin is respected, so it should be top-left for the
   * centring maths to line up).
   *
   * Whatever the icon's own size, the button caps it to its own content box (see {@link fitIcon}):
   * an icon is never drawn outside the control that owns it.
   */
  setIcon(icon: string | Phaser.GameObjects.GameObject): this {
    let next: IconLike;
    if (typeof icon === 'string') {
      const image = new Phaser.GameObjects.Image(this.scene, 0, 0, icon);
      image.setOrigin(0, 0);
      next = image;
    } else {
      next = icon;
    }
    if (next === this.iconObject) {
      return this;
    }
    if (this.iconObject) {
      this.remove(this.iconObject, true);
    }
    this.iconObject = next;
    this.iconNatural = naturalIconSize(next);
    // Behind the label but in front of the background graphics.
    this.addAt(next, Math.min(1, this.length));
    this.markDirty();
    return this;
  }

  /** Drops the icon (no-op when there is none). */
  clearIcon(): this {
    if (!this.iconObject) {
      return this;
    }
    this.remove(this.iconObject, true);
    this.iconObject = null;
    this.iconNatural = { width: 0, height: 0 };
    this.markDirty();
    return this;
  }

  /** The Game Object used as the icon, if any. */
  get icon(): Phaser.GameObjects.GameObject | null {
    return this.iconObject;
  }

  // ------------------------------------------------------------------ layout

  override measureContent(_constraint: BoxConstraints): Size {
    const theme = this.theme;
    const padding = theme.spacing[this.size];
    const iconSize = this.fittedIcon(this.measuredIconRoom());
    const gap = iconSize.width > 0 && this.label.width > 0 ? theme.spacing.xs : 0;

    return {
      width: padding * 2 + iconSize.width + gap + this.label.width,
      height: Math.max(iconSize.height, this.label.height),
    };
  }

  protected override onRectChanged(rect: Rect): void {
    const box = contentBox(rect.width, rect.height, this.layoutParams.padding);
    const theme = this.theme;
    const iconSize = this.fittedIcon(this.appliedIconRoom(box));
    const gap = iconSize.width > 0 && this.label.width > 0 ? theme.spacing.xs : 0;
    const total = iconSize.width + gap + this.label.width;

    let x = box.x + centeredOffset(total, box.width);
    if (this.iconObject && iconSize.width > 0) {
      this.applyIconSize(iconSize);
      this.iconObject.setPosition?.(x, box.y + centeredOffset(iconSize.height, box.height));
      x += iconSize.width + gap;
    } else if (this.iconObject) {
      // No room for the icon (the button is smaller than what is already in it): it is dropped rather
      // than drawn over the label. The icon stays attached, so a bigger box brings it back.
      this.applyIconSize({ width: 0, height: 0 });
    }
    this.label.setPosition(x, box.y + centeredOffset(this.label.height, box.height));

    this.refreshAppearance();
  }

  protected override refreshAppearance(): void {
    const theme = this.theme;
    if (!this.explicitHeight) {
      this.layoutParams.height = theme.controlHeight[this.size];
    }

    const width = Math.max(0, this.rect.width);
    const height = Math.max(0, this.rect.height);
    const state = resolveButtonState({
      state: this.visualState,
      loading: this.loading,
      toggle: this.toggle,
      value: this.value,
    });

    this.bodyGraphics.clear();
    this.skinFor(theme).paint(this.bodyGraphics, width, height, state);

    const radius = Math.max(0, Math.min(theme.radius.md, Math.min(width, height) / 2));
    if (this.focused) {
      paintFocusRing(this.bodyGraphics, theme, width, height, radius);
    }

    this.applyThemeStyle();
  }

  // ------------------------------------------------------------------ internals

  private handleActivation(): void {
    const decision = resolveButtonActivation({
      enabled: this.enabled,
      loading: this.loading,
      toggle: this.toggle,
      value: this.value,
    });
    if (decision.ignored) {
      return;
    }
    if (decision.toggles) {
      // `setValue` reports the change itself (`BUTTON_EVENTS.CHANGE`), so emitting here as well would
      // fire twice for one click.
      this.setValue(decision.value);
      return;
    }
    if (decision.invokesClick) {
      this.onClick?.(this);
    }
  }

  /**
   * A loading button keeps its label and gains an ellipsis; colours come from the theme.
   *
   * Both the style and the text are written only when they actually change: a hover or press repaints
   * the background but must not force a canvas text re-render.
   */
  private applyThemeStyle(): void {
    const theme = this.theme;
    const state: WidgetState = resolveButtonState({
      state: this.visualState,
      loading: this.loading,
      toggle: this.toggle,
      value: this.value,
    });
    const color = toCssColor(buttonTextColor(theme, this.variant, state));
    // Same reasoning as `Label`: the baking ratio is part of the style key, so a display whose ratio
    // changed re-bakes the glyph texture instead of keeping the soft one.
    const resolution = this.textResolution;
    const styleKey = `${theme.fontFamily}|${theme.fontSize.md}|${color}|${resolution}`;
    if (styleKey !== this.styleKey) {
      this.styleKey = styleKey;
      this.label.setStyle({
        fontFamily: theme.fontFamily,
        fontSize: theme.fontSize.md,
        color,
        align: 'center',
        resolution,
      });
      // Same allowance as `Label`: without it a button's descender is clipped by the text canvas.
      const pad = glyphPadding(theme.fontSize.md);
      if (pad !== this.glyphPad) {
        this.glyphPad = pad;
        this.label.setPadding(pad, pad, pad, pad);
      }
    }

    const text = buttonLabel(this.labelText, this.loading);
    if (this.label.text !== text) {
      this.label.setText(text);
    }
  }

  /**
   * Room for the icon as far as the *measure* pass knows it: the box this button is being sized for.
   *
   * `layoutParams.width`/`height` are the lengths the caller asked for (the theme's control height
   * when none was given), so a `Button({ icon, height: 20 })` already measures with a 20 px icon
   * instead of reporting a 64 px one and overflowing its own box.
   */
  private measuredIconRoom(): { width: number; height: number } {
    const params = this.layoutParams;
    const inset = iconInset(this.theme);
    return {
      width: typeof params.width === 'number' ? params.width - inset * 2 : Number.POSITIVE_INFINITY,
      height:
        (typeof params.height === 'number' ? params.height : this.theme.controlHeight[this.size]) -
        inset * 2,
    };
  }

  /** Room for the icon once the layout has spoken: the button's *applied* content box. */
  private appliedIconRoom(box: Rect): { width: number; height: number } {
    const gap = this.label.width > 0 && this.iconNatural.width > 0 ? this.theme.spacing.xs : 0;
    const inset = iconInset(this.theme);
    // What is left of the content box after the label, the gap between the two, and the inset that
    // keeps the icon off the button's rounded corners.
    return {
      width: box.width - this.label.width - gap - inset * 2,
      height: box.height - inset * 2,
    };
  }

  /** The icon's display size for `room`: natural size, capped (see {@link fitIcon}). */
  private fittedIcon(room: { width: number; height: number }): Size {
    if (!this.iconObject) {
      return { width: 0, height: 0 };
    }
    return fitIcon(this.iconNatural, room);
  }

  /**
   * Writes the fitted size onto the icon object itself.
   *
   * The layout numbers say where the icon *should* be; this is what makes the renderer agree, so the
   * part of a too-large icon is not simply positioned outside the button — it is never drawn. A size
   * of `0` means "no room" and renders nothing, which is better than a glyph over the label.
   */
  private applyIconSize(size: Size): void {
    const icon = this.iconObject;
    if (!icon || this.iconNatural.width <= 0 || this.iconNatural.height <= 0) {
      return;
    }
    const width = Math.max(0, size.width);
    const height = Math.max(0, size.height);
    if (typeof icon.setDisplaySize === 'function') {
      icon.setDisplaySize(width, height);
      return;
    }
    if (typeof icon.setScale === 'function') {
      icon.setScale(width / this.iconNatural.width, height / this.iconNatural.height);
    }
  }

  private skinFor(theme: Theme): ProceduralSkin {
    const cached = this.skinCache;
    if (cached && cached.theme === theme && cached.variant === this.variant) {
      return cached.skin;
    }
    const skin = new ProceduralSkin(buttonSkinStyles(theme, this.variant));
    this.skinCache = { theme, variant: this.variant, skin };
    return skin;
  }
}
