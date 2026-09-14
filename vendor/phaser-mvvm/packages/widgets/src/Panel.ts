/**
 * `Panel` — a themed container with a procedural background.
 *
 * The panel is what most pages put everything else in: it is a `box` layout container that paints its
 * own background for the current `visualState` with a `ProceduralSkin` (`Graphics`, zero art assets —
 * PLAN §10.3), optionally with a border, rounded corners and a faked elevation.
 *
 * `interactive: true` makes it a clickable card: it gets a pointer hit area and can take keyboard
 * focus. `blockPointer` (default `true`) keeps the hit area even when the panel is not interactive,
 * so the input router can treat it as an interception layer that stops clicks from reaching the game
 * objects behind the UI.
 */

import Phaser from 'phaser';
import type { BoxConstraints, LayoutParams, Rect, Size } from '@phaser-mvvm/layout';
import type { PointerChainOptionHooks, Theme } from '@phaser-mvvm/phaser';
import { ProceduralSkin, Widget } from '@phaser-mvvm/phaser';
import type { A11yDescriptor } from '@phaser-mvvm/phaser';
import { paintElevation, paintFocusRing, panelSkinStyles } from './appearance';
import {
  BOX_CONTAINER_KEYS,
  boxOptionsOf,
  optionBag,
  splitWidgetOptions,
  baseWidgetOptions,
} from './options';

/** Background flavours of a panel; each maps onto theme tokens. */
export type PanelVariant = 'surface' | 'surfaceAlt' | 'overlay' | 'primary' | 'danger' | 'plain';

export interface PanelOptions extends LayoutParams, PointerChainOptionHooks {
  /** Flow direction of the box container. Defaults to `'vertical'`. */
  direction?: 'horizontal' | 'vertical';
  gap?: number;
  rowGap?: number;
  columnGap?: number;
  /** Main-axis distribution. Defaults to `'start'`. */
  justifyContent?: 'start' | 'center' | 'end' | 'space-between' | 'space-around' | 'space-evenly';
  /** Cross-axis alignment. Defaults to `'stretch'`. */
  alignItems?: 'auto' | 'start' | 'center' | 'end' | 'stretch';
  /** Enables multi-line flow of the children (flex-wrap), not text wrapping. Defaults to `false`. */
  wrap?: boolean;
  alignContent?: 'start' | 'center' | 'end' | 'space-between' | 'space-around' | 'space-evenly';
  /** Reverses the visual order of the children. */
  reverse?: boolean;

  /** Background flavour. Defaults to `'surface'`. */
  variant?: PanelVariant;
  /** Corner radius; defaults to `theme.radius.md`. */
  radius?: number;
  /** Draws a border. Defaults to `true` for the surface variants, `false` otherwise. */
  border?: boolean;
  /** Faked drop-shadow strength in design pixels. Defaults to `0` (no shadow). */
  elevation?: number;

  /** Adds a pointer hit area and makes the panel a clickable, focusable card. */
  interactive?: boolean;
  /**
   * Keeps a pointer hit area so the panel blocks clicks from reaching the game objects behind it.
   * Defaults to `true`; the input router decides what an intercepted pointer does.
   */
  blockPointer?: boolean;
  name?: string;
  /** Tab order hint for the focus manager (lower first). */
  focusOrder?: number;
  /** Accessible name for the DOM mirror (see `Widget.a11yLabel`); defaults to the visible text. */
  label?: string;
}

type PanelWidgetOptions = Omit<PanelOptions, keyof LayoutParams | 'name'>;

const PANEL_STYLE_KEYS = [
  'variant',
  'radius',
  'border',
  'elevation',
  'interactive',
  'blockPointer',
] as const;

/** Everything `splitOptions` must move out of the node-level layout params. */
const PANEL_WIDGET_KEYS = [...PANEL_STYLE_KEYS, ...BOX_CONTAINER_KEYS];

export class Panel extends Widget {
  /** Background flavour; see {@link Panel.setVariant} for the reactive slot. */
  private panelVariant: PanelVariant;
  /** Whether the panel is a clickable, focusable card. */
  readonly interactive: boolean;
  /** Whether the panel keeps a hit area to intercept pointer input. */
  readonly blockPointer: boolean;

  private readonly shadowGraphics: Phaser.GameObjects.Graphics;
  private readonly bodyGraphics: Phaser.GameObjects.Graphics;
  private readonly radius: number | null;
  private readonly elevation: number;
  /** What the caller asked for; `undefined` means "follow the variant" (see `setVariant`). */
  private readonly explicitBorder: boolean | undefined;
  private showBorder: boolean;
  private skinCache: { theme: Theme; skin: ProceduralSkin } | null = null;

  constructor(scene: Phaser.Scene, options: PanelOptions = {}, children: readonly Widget[] = []) {
    // `splitOptions` drops `name` and `undefined` values, so `name` is read off the original bag.
    const { layout, widget } = splitWidgetOptions<PanelWidgetOptions>(
      optionBag(options),
      PANEL_WIDGET_KEYS,
    );
    super(scene, { layout, ...baseWidgetOptions(options) });

    this.panelVariant = widget.variant ?? 'surface';
    this.interactive = widget.interactive === true;
    this.blockPointer = widget.blockPointer !== false;
    this.radius = typeof widget.radius === 'number' ? Math.max(0, widget.radius) : null;
    this.elevation = typeof widget.elevation === 'number' ? Math.max(0, widget.elevation) : 0;
    this.explicitBorder = widget.border;
    this.showBorder = widget.border ?? defaultBorderFor(this.panelVariant);

    const box = boxOptionsOf(widget);
    this.container = {
      type: 'box',
      options: { ...box, direction: box.direction ?? 'vertical' },
    };

    this.shadowGraphics = new Phaser.GameObjects.Graphics(scene);
    this.bodyGraphics = new Phaser.GameObjects.Graphics(scene);
    this.add(this.shadowGraphics);
    this.add(this.bodyGraphics);

    if (this.interactive) {
      this.focusable = true;
      // A clickable card acts like a button to a screen reader; a plain panel is decoration and gets
      // no mirror node at all (`Widget.a11y` stays `null`).
      this.a11y = { role: 'button' };
    }
    if (this.interactive || this.blockPointer) {
      this.enablePointerInput();
    }

    for (const child of children) {
      this.addWidget(child);
    }

    this.refreshAppearance();
  }

  /** Background flavour; the reactive slot `Panel({ variant: () => … })` writes through {@link setVariant}. */
  get variant(): PanelVariant {
    return this.panelVariant;
  }

  /**
   * Changes the background flavour.
   *
   * Reactive since round 84: a surface that turns `danger` while a form is invalid, or `primary` once
   * it is saved, is state like any other. The skin cache is keyed by theme only, so it is dropped here,
   * and a border the caller did not ask for explicitly follows the new variant exactly as it would have
   * at construction time.
   */
  setVariant(variant: PanelVariant): this {
    if (variant === this.panelVariant) {
      return this;
    }
    this.panelVariant = variant;
    this.showBorder = this.explicitBorder ?? defaultBorderFor(variant);
    this.skinCache = null;
    this.refreshAppearance();
    return this;
  }

  /** Live description for the accessibility mirror: a clickable card without text needs a label. */
  override describeA11y(): A11yDescriptor | null {
    if (!this.interactive) {
      // A plain panel is usually a decoration, and a decoration is not mirrored — but one that was given
      // a `label` is a named group (the base rule), which is how a modal body ends up as `role="dialog"`
      // with a name: the mirror asks the widget first and synthesizes the dialog only when it says
      // nothing at all.
      return super.describeA11y();
    }
    return {
      role: 'button',
      label: this.a11yLabel ?? this.name ?? 'card',
      disabled: !this.enabled,
    };
  }

  /** An empty panel has no intrinsic size: its box comes from `width`/`height` and its padding. */
  override measureContent(_constraint: BoxConstraints): Size {
    return { width: 0, height: 0 };
  }

  protected override onRectChanged(_rect: Rect): void {
    // Everything this panel paints depends on its size.
    this.refreshAppearance();
  }

  protected override refreshAppearance(): void {
    const width = Math.max(0, this.rect.width);
    const height = Math.max(0, this.rect.height);
    const theme = this.theme;
    const radius = this.cornerRadius(theme, width, height);

    paintElevation(this.shadowGraphics, theme, width, height, radius, this.elevation);

    this.bodyGraphics.clear();
    if (this.variant !== 'plain') {
      this.skinFor(theme).paint(this.bodyGraphics, width, height, this.visualState);
    }
    if (this.focused) {
      paintFocusRing(this.bodyGraphics, theme, width, height, radius);
    }
  }

  private cornerRadius(theme: Theme, width: number, height: number): number {
    const wanted = this.radius ?? theme.radius.md;
    return Math.max(0, Math.min(wanted, Math.min(width, height) / 2));
  }

  /** The skin is rebuilt only when the theme changes; state changes reuse it. */
  private skinFor(theme: Theme): ProceduralSkin {
    if (this.skinCache?.theme === theme) {
      return this.skinCache.skin;
    }
    const skin = new ProceduralSkin(
      panelSkinStyles(theme, this.variant, this.radius ?? theme.radius.md, this.showBorder),
    );
    this.skinCache = { theme, skin };
    return skin;
  }
}

/** The default border for a flavour: the filled surfaces get one, `plain` and `danger` do not. */
function defaultBorderFor(variant: PanelVariant): boolean {
  return variant === 'surface' || variant === 'surfaceAlt' || variant === 'overlay';
}
