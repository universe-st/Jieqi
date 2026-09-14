/**
 * Shared appearance maths for the widget library.
 *
 * Every colour used here is derived from the active `Theme` (PLAN §4.6): the widget library never
 * hard-codes a hex value, so a theme switch repaints correctly without extra bookkeeping. Tokens the
 * theme does not name (a `danger` button's hover shade, for example) are derived from the token it
 * does name with `shadeColor`.
 *
 * This module type-imports Phaser and imports only `color.ts` at runtime, so its decisions stay
 * unit-testable in Node.
 */

import type Phaser from 'phaser';
import type { SkinStyles, Theme, WidgetState } from '@phaser-mvvm/phaser';
import type { ButtonVariant } from './Button';
import type { PanelVariant } from './Panel';
import { shadeColor } from './color';

/** Fills a rectangle, rounded when a radius is given. */
export function fillBox(
  graphics: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  if (width <= 0 || height <= 0) {
    return;
  }
  if (radius > 0) {
    graphics.fillRoundedRect(x, y, width, height, radius);
  } else {
    graphics.fillRect(x, y, width, height);
  }
}

/**
 * Strokes the keyboard-focus ring (PLAN §10.3: a `Graphics` outline, so the library needs no art).
 *
 * The ring is drawn inside the widget's rect and inset by half of its own width, which keeps it
 * inside the layout box and therefore inside any clipping the parent applies.
 */
export function paintFocusRing(
  graphics: Phaser.GameObjects.Graphics,
  theme: Theme,
  width: number,
  height: number,
  radius: number,
): void {
  const lineWidth = Math.max(1, theme.focusRingWidth);
  const inset = lineWidth / 2;
  const boxWidth = width - lineWidth;
  const boxHeight = height - lineWidth;
  if (boxWidth <= 0 || boxHeight <= 0) {
    return;
  }

  graphics.lineStyle(lineWidth, theme.colors.focusRing, 1);
  const corner = Math.max(0, radius - inset);
  if (corner > 0) {
    graphics.strokeRoundedRect(inset, inset, boxWidth, boxHeight, corner);
  } else {
    graphics.strokeRect(inset, inset, boxWidth, boxHeight);
  }
}

/**
 * Paints a soft drop shadow behind a panel.
 *
 * Phaser's `Graphics` has no blur, so the shadow is faked with a few translucent, progressively
 * larger rounded rects stacked under the panel body. Zero assets, deterministic output, and the
 * panel's own fill covers the middle of the stack.
 */
export function paintElevation(
  graphics: Phaser.GameObjects.Graphics,
  theme: Theme,
  width: number,
  height: number,
  radius: number,
  elevation: number,
): void {
  graphics.clear();
  if (elevation <= 0 || width <= 0 || height <= 0) {
    return;
  }

  const layers = Math.min(4, Math.max(1, Math.round(elevation)));
  const color = theme.colors.overlay;
  for (let layer = layers; layer >= 1; layer--) {
    const spread = (layer / layers) * elevation;
    graphics.fillStyle(color, 0.05);
    fillBox(
      graphics,
      -spread,
      spread * 0.5,
      width + spread * 2,
      height + spread * 1.5,
      Math.max(0, radius + spread * 0.5),
    );
  }
}

/**
 * Per-state background styles for a panel of the given variant.
 *
 * Like the button skins, no `focused` state is declared: the focus ring is stroked separately by the
 * panel (`paintFocusRing`), and `ProceduralSkin` reuses `normal` for any state it does not name.
 */
export function panelSkinStyles(
  theme: Theme,
  variant: PanelVariant,
  radius: number,
  border: boolean,
): SkinStyles {
  const borderColor = border ? theme.colors.border : null;
  const strongBorder = border ? theme.colors.borderStrong : null;
  const plain = { fill: theme.colors.surface, fillAlpha: 0, border: null } as const;

  switch (variant) {
    case 'plain':
      return {
        normal: { ...plain },
        hover: { ...plain, fill: theme.colors.surfaceHover, fillAlpha: 0.5 },
        pressed: { ...plain, fill: theme.colors.surfaceAlt, fillAlpha: 0.7 },
        disabled: { ...plain },
      };
    case 'overlay':
      return {
        normal: { fill: theme.colors.overlay, fillAlpha: 0.8, border: null, radius },
      };
    case 'primary':
    case 'danger': {
      const base = variant === 'primary' ? theme.colors.primary : theme.colors.danger;
      const hover = variant === 'primary' ? theme.colors.primaryHover : shadeColor(base, 0.12);
      const pressed = variant === 'primary' ? theme.colors.primaryPressed : shadeColor(base, -0.16);
      return {
        normal: { fill: base, border: null, radius },
        hover: { fill: hover, border: null, radius },
        pressed: { fill: pressed, border: null, radius },
        disabled: { fill: theme.colors.surfaceAlt, border: borderColor, radius },
      };
    }
    case 'surfaceAlt':
      return {
        normal: { fill: theme.colors.surfaceAlt, border: borderColor, radius },
        hover: { fill: theme.colors.surfaceHover, border: strongBorder, radius },
        pressed: { fill: theme.colors.surface, border: strongBorder, radius },
        disabled: { fill: theme.colors.surfaceAlt, border: borderColor, radius },
      };
    case 'surface':
    default:
      return {
        normal: { fill: theme.colors.surface, border: borderColor, radius },
        hover: { fill: theme.colors.surfaceHover, border: strongBorder, radius },
        pressed: { fill: theme.colors.surfaceAlt, border: strongBorder, radius },
        disabled: { fill: theme.colors.surfaceAlt, border: borderColor, radius },
      };
  }
}

/**
 * Per-state background styles of a text input (`TextField`/`TextArea`).
 *
 * A text field is a panel that is always editable, so the states read differently from a button: the
 * fill barely moves between `normal`/`hover` (a field that flashes on hover is distracting), the
 * pointer states only strengthen the border, `focused` shows the focus ring colour — and `error`
 * paints the `danger` border, which outranks focus because `WidgetState` resolves `error` first.
 *
 * `readOnly` borrows the muted `surfaceAlt` fill so a locked field is recognisable at a glance.
 */
export function textInputSkinStyles(
  theme: Theme,
  radius: number = theme.radius.sm,
  readOnly = false,
): SkinStyles {
  const fill = readOnly ? theme.colors.surfaceAlt : theme.colors.surface;
  return {
    normal: { fill, border: theme.colors.border, radius },
    hover: { fill, border: theme.colors.borderStrong, radius },
    pressed: { fill, border: theme.colors.borderStrong, radius },
    focused: { fill, border: theme.colors.focusRing, radius },
    disabled: { fill: theme.colors.surfaceAlt, border: theme.colors.border, radius },
    error: { fill, border: theme.colors.danger, radius },
  };
}

/**
 * Per-state background styles for a button of the given variant.
 *
 * The `focused` state is deliberately absent: the focus indication is the explicit `Graphics` ring
 * drawn by the widget (`paintFocusRing`, PLAN §10.3), and `ProceduralSkin` falls back to `normal` for
 * states a skin does not name — so a focused button keeps its normal fill and gains exactly one ring
 * instead of two overlapping ones.
 */
export function buttonSkinStyles(
  theme: Theme,
  variant: ButtonVariant,
  radius: number = theme.radius.md,
): SkinStyles {
  switch (variant) {
    case 'ghost': {
      const transparent = { fill: theme.colors.surface, fillAlpha: 0, border: null, radius };
      return {
        normal: { ...transparent },
        hover: { fill: theme.colors.surfaceHover, fillAlpha: 0.9, border: null, radius },
        pressed: { fill: theme.colors.surfaceAlt, border: null, radius },
        disabled: { ...transparent },
      };
    }
    case 'danger': {
      const base = theme.colors.danger;
      return {
        normal: { fill: base, border: null, radius },
        hover: { fill: shadeColor(base, 0.12), border: null, radius },
        pressed: { fill: shadeColor(base, -0.16), border: null, radius },
        disabled: { fill: theme.colors.surfaceAlt, border: null, radius },
      };
    }
    case 'secondary':
      return {
        normal: { fill: theme.colors.surface, border: theme.colors.border, radius },
        hover: { fill: theme.colors.surfaceHover, border: theme.colors.borderStrong, radius },
        pressed: { fill: theme.colors.surfaceAlt, border: theme.colors.borderStrong, radius },
        disabled: { fill: theme.colors.surfaceAlt, border: theme.colors.border, radius },
      };
    case 'primary':
    default:
      return {
        normal: { fill: theme.colors.primary, border: null, radius },
        hover: { fill: theme.colors.primaryHover, border: null, radius },
        pressed: { fill: theme.colors.primaryPressed, border: null, radius },
        disabled: { fill: theme.colors.surfaceAlt, border: null, radius },
      };
  }
}

/** Label colour of a button: `onPrimary` on the filled variants, `text` elsewhere. */
export function buttonTextColor(theme: Theme, variant: ButtonVariant, state: WidgetState): number {
  if (state === 'disabled') {
    return theme.colors.textDisabled;
  }
  return variant === 'primary' || variant === 'danger' ? theme.colors.onPrimary : theme.colors.text;
}
