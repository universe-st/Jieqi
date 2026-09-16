/**
 * A `Button` whose background is a perfect circle.
 *
 * The phaser-mvvm `Button` paints its skin with the theme's `radius.md`, so no matter how its box is
 * sized it comes out a rounded rect. This subclass repaints the body with a skin whose radius is the
 * theme's `pill` token: the skin clamps the radius to half of the smaller side, so a **square** box
 * (equal `width` and `height`) paints a perfect circle.
 *
 * It exists for the ？ help button: next to 悔棋/提示/认输 the floating ghost glyph reads as
 * decoration rather than as one of the action buttons, and a circle in the same `secondary` tokens
 * (surface fill + border) makes it read as part of the family.
 *
 * Two deliberate differences from the base button:
 * - The label style is applied once by the base constructor and is not re-applied here, so a
 *   `disabled` circle button keeps its text colour. The ？ button is never disabled; if that ever
 *   changes, repaint the label with `buttonTextColor(theme, variant, state)` on state change.
 * - `variant` is ignored by the paint; the circle always uses the `secondary` tokens.
 */

import Phaser from 'phaser';
import { ProceduralSkin, currentUiScene, emitWidget } from '@phaser-mvvm/phaser';
import {
  Button,
  buttonSkinStyles,
  paintFocusRing,
  resolveButtonState,
  type ButtonOptions,
} from '@phaser-mvvm/widgets';

export interface CircleButtonOptions extends Omit<ButtonOptions, 'text'> {}

export class CircleButtonWidget extends Button {
  /** Radius is baked once; colours are resolved from the current theme on every paint. */
  private circleSkin: ProceduralSkin | null = null;

  constructor(scene: Phaser.Scene, options: CircleButtonOptions = {}) {
    super(scene, options);
  }

  protected override refreshAppearance(): void {
    const theme = this.theme;
    const width = Math.max(0, this.rect.width);
    const height = Math.max(0, this.rect.height);
    const state = resolveButtonState({
      state: this.visualState,
      loading: this.loading,
      toggle: this.toggle,
      value: this.getValue(),
    });

    // `bodyGraphics` is private to the base `Button`; the cast is the one sanctioned way to reach a
    // private member (the same pattern the test suite uses).
    const gfx = (this as unknown as { bodyGraphics: Phaser.GameObjects.Graphics }).bodyGraphics;
    gfx.clear();

    // Radius `pill` (999) is clamped by the skin to half of the smaller side — a perfect circle on a
    // square box, an ellipse clipped to the box otherwise. Keep width === height.
    if (!this.circleSkin) {
      this.circleSkin = new ProceduralSkin(buttonSkinStyles(theme, 'secondary', theme.radius.pill));
    }
    this.circleSkin.paint(gfx, width, height, state);

    if (this.focusVisible) {
      paintFocusRing(gfx, theme, width, height, Math.min(width, height) / 2);
    }
  }
}

/**
 * Compose-style factory for {@link CircleButtonWidget} — the `Button('…', …)` DSL equivalent that
 * builds the circle variant. Pass equal `width` and `height` for a true circle.
 */
export function CircleButton(label: string, options: CircleButtonOptions = {}): CircleButtonWidget {
  const scene = currentUiScene();
  const button = new CircleButtonWidget(scene, { ...options, text: label } as ButtonOptions);
  scene.add.existing(button);
  emitWidget(button);
  return button;
}
