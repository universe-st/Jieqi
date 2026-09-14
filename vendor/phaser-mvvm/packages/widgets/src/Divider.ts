/**
 * `Divider` — a one-pixel rule between or inside sections.
 *
 * The line is a single `Graphics.fillRect` in the theme's `border` colour, and its geometry is pure
 * layout: the main axis `fill`s its parent (or is set explicitly) while the cross axis is one pixel
 * (`thickness`), so a divider needs no art and no measurement pass of its own.
 */

import Phaser from 'phaser';
import type { BoxConstraints, LayoutParams, Rect, Size } from '@phaser-mvvm/layout';
import type { PointerChainOptionHooks, ThemeColorName } from '@phaser-mvvm/phaser';
import { Widget, colorOf } from '@phaser-mvvm/phaser';
import { optionBag, splitWidgetOptions, baseWidgetOptions } from './options';

export type DividerOrientation = 'horizontal' | 'vertical';

export interface DividerOptions extends LayoutParams, PointerChainOptionHooks {
  /** `'horizontal'` draws a rule along x, `'vertical'` along y. Defaults to `'horizontal'`. */
  orientation?: DividerOrientation;
  /** Theme token or literal colour. Defaults to `theme.colors.border`. */
  color?: ThemeColorName | number;
  /** Line thickness in design pixels; the cross-axis size. Defaults to `theme.borderWidth`. */
  thickness?: number;
  name?: string;
  /** Tab order hint for the focus manager (lower first). */
  focusOrder?: number;
  /** Accessible name for the DOM mirror (see `Widget.a11yLabel`); defaults to the visible text. */
  label?: string;
}

type DividerWidgetOptions = Omit<DividerOptions, keyof LayoutParams | 'name'>;

const DIVIDER_KEYS = ['orientation', 'color', 'thickness'] as const;

export class Divider extends Widget {
  readonly orientation: DividerOrientation;
  readonly thickness: number;
  readonly lineColor: ThemeColorName | number | undefined;

  private readonly lineGraphics: Phaser.GameObjects.Graphics;

  constructor(scene: Phaser.Scene, options: DividerOptions = {}) {
    const { layout, widget } = splitWidgetOptions<DividerWidgetOptions>(
      optionBag(options),
      DIVIDER_KEYS,
    );
    super(scene, { layout, ...baseWidgetOptions(options) });

    this.orientation = widget.orientation ?? 'horizontal';
    this.thickness = Math.max(1, Math.round(widget.thickness ?? this.theme.borderWidth));
    this.lineColor = widget.color;

    // The main axis stretches, the cross axis is the line itself. An explicit length wins.
    const horizontal = this.orientation === 'horizontal';
    if (horizontal) {
      if (options.width === undefined) {
        this.layoutParams.width = 'fill';
      }
      if (options.height === undefined) {
        this.layoutParams.height = this.thickness;
      }
    } else {
      if (options.width === undefined) {
        this.layoutParams.width = this.thickness;
      }
      if (options.height === undefined) {
        this.layoutParams.height = 'fill';
      }
    }

    this.lineGraphics = new Phaser.GameObjects.Graphics(scene);
    this.add(this.lineGraphics);
    this.refreshAppearance();
  }

  /**
   * The cross axis is the line; the main axis has no intrinsic size (it `fill`s its parent), so `0` is
   * reported there and the engine resolves it against the parent's content box.
   */
  override measureContent(_constraint: BoxConstraints): Size {
    return this.orientation === 'horizontal'
      ? { width: 0, height: this.thickness }
      : { width: this.thickness, height: 0 };
  }

  protected override onRectChanged(_rect: Rect): void {
    this.refreshAppearance();
  }

  protected override refreshAppearance(): void {
    const theme = this.theme;
    const width = Math.max(0, this.rect.width);
    const height = Math.max(0, this.rect.height);

    this.lineGraphics.clear();
    if (width <= 0 || height <= 0) {
      return;
    }
    this.lineGraphics.fillStyle(colorOf(theme, this.lineColor, theme.colors.border), 1);
    this.lineGraphics.fillRect(0, 0, width, height);
  }
}
