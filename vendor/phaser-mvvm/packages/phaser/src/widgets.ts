/**
 * Minimal M0 widgets.
 *
 * These exist to validate the render + layout pipeline end to end. The full widget library
 * (Panel, Button, TextField, ScrollView, …) lands in `@phaser-mvvm/widgets` at milestones M4–M7.
 */

import Phaser from 'phaser';
import type { BoxConstraints, LayoutParams, Rect, Size } from '@phaser-mvvm/layout';
import { type PointerChainOptionHooks, Widget } from './Widget';

export interface RectWidgetOptions extends LayoutParams, PointerChainOptionHooks {
  color?: number;
  alpha?: number;
  name?: string;
}

/** A solid rectangle. Useful as a layout probe and as the base for future Panel/Button skins. */
export class RectWidget extends Widget {
  readonly shape: Phaser.GameObjects.Rectangle;

  constructor(scene: Phaser.Scene, options: RectWidgetOptions = {}) {
    const { color, alpha, name, ...layout } = options;
    super(scene, { layout: { width: 100, height: 100, ...layout }, name });

    this.shape = new Phaser.GameObjects.Rectangle(
      scene,
      0,
      0,
      (layout.width as number | undefined) ?? 100,
      (layout.height as number | undefined) ?? 100,
      color ?? 0x2f6feb,
      alpha ?? 1,
    );
    this.add(this.shape);
  }

  setColor(color: number): this {
    this.shape.setFillStyle(color);
    return this;
  }

  override measureContent(_constraint: BoxConstraints): Size {
    return { width: this.shape.width, height: this.shape.height };
  }

  protected override onRectChanged(rect: Rect): void {
    this.shape.setPosition(rect.width / 2, rect.height / 2);
    this.shape.setSize(rect.width, rect.height);
  }
}

export interface LabelWidgetOptions extends LayoutParams, PointerChainOptionHooks {
  text?: string;
  style?: Phaser.Types.GameObjects.Text.TextStyle;
  name?: string;
}

/** A text label backed by `Phaser.GameObjects.Text`. */
export class LabelWidget extends Widget {
  readonly text: Phaser.GameObjects.Text;

  constructor(scene: Phaser.Scene, options: LabelWidgetOptions = {}) {
    const { text, style, name, ...layout } = options;
    super(scene, { layout, name });

    this.text = new Phaser.GameObjects.Text(scene, 0, 0, text ?? '', {
      fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
      fontSize: '16px',
      color: '#e6edf3',
      // The display's own ratio, so the glyph texture is not upsampled again by the browser; a
      // caller-supplied `style.resolution` still wins (it comes after this).
      resolution: this.textResolution,
      ...style,
    });
    this.text.setOrigin(0, 0);
    this.add(this.text);
  }

  setText(value: string): this {
    this.text.setText(value);
    this.markDirty();
    return this;
  }

  getText(): string {
    return this.text.text;
  }

  override measureContent(constraint: BoxConstraints): Size {
    if (Number.isFinite(constraint.maxWidth) && constraint.maxWidth > 0) {
      this.text.setWordWrapWidth(constraint.maxWidth);
    }
    return { width: this.text.width, height: this.text.height };
  }

  protected override onRectChanged(rect: Rect): void {
    this.text.setPosition(0, 0);
    if (typeof this.layoutParams.width === 'number') {
      this.text.setWordWrapWidth(Math.max(1, rect.width));
    }
  }
}
