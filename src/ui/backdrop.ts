/**
 * The furniture the two non-board screens share: the start menu and the 定先后 draw.
 *
 * Both are the same picture — a dark curtain, a gold seal frame, a pool of light in the middle — so
 * both call this rather than each drawing their own. Everything here sits behind the widgets and the
 * spinning piece, at a depth nothing else competes for.
 */

import Phaser from 'phaser';
import { C, DESIGN_HEIGHT, DESIGN_WIDTH, TITLE_STACK, hex } from './palette';
import { BAKE_SCALE } from './render-scale';
import { TEX } from './textures';

const CURTAIN_DEPTH = -20;

export interface CurtainOptions {
  /** Distance from the canvas edge to the outer frame line, in design pixels. */
  inset?: number;
  /** Where the pool of light sits vertically, as a fraction of the screen height. */
  focusY?: number;
  /** Radius of that pool, in design pixels. */
  focusRadius?: number;
}

/**
 * Paints the backdrop: the curtain, the two soft lights, and a routed gold frame.
 *
 * The lights are two faded radial glows rather than a gradient because everything in this game is a
 * baked `Graphics` command list — there is no shader anywhere, and a hand-rolled gradient is exactly
 * the sort of thing that would need one.
 */
export function drawCurtain(scene: Phaser.Scene, options: CurtainOptions = {}): void {
  const inset = options.inset ?? 16;
  const focusY = options.focusY ?? 0.34;
  const focusRadius = options.focusRadius ?? DESIGN_WIDTH * 1.9;

  const g = scene.add.graphics().setDepth(CURTAIN_DEPTH);
  g.fillStyle(C.backdrop, 1);
  g.fillRect(0, 0, DESIGN_WIDTH, DESIGN_HEIGHT);

  // Wood grain bands: wide, barely-there vertical strokes, so the curtain is a surface and not a void.
  for (let i = 0; i < 18; i++) {
    const x = (i / 17) * DESIGN_WIDTH;
    g.fillStyle(i % 2 === 0 ? C.woodDeep : C.wood, 0.05);
    g.fillRect(x - 6, 0, 12 + (i % 3) * 5, DESIGN_HEIGHT);
  }

  // The gold frame, drawn twice the way the board's own border is.
  g.lineStyle(2.4, C.goldDim, 0.55);
  g.strokeRect(inset, inset, DESIGN_WIDTH - inset * 2, DESIGN_HEIGHT - inset * 2);
  g.lineStyle(1, C.goldDim, 0.3);
  g.strokeRect(inset + 5, inset + 5, DESIGN_WIDTH - (inset + 5) * 2, DESIGN_HEIGHT - (inset + 5) * 2);

  // Corner ticks: four short gold strokes that read as a seal mounting.
  const arm = 26;
  const corners: [number, number, number, number][] = [
    [inset, inset, 1, 1],
    [DESIGN_WIDTH - inset, inset, -1, 1],
    [inset, DESIGN_HEIGHT - inset, 1, -1],
    [DESIGN_WIDTH - inset, DESIGN_HEIGHT - inset, -1, -1],
  ];
  g.lineStyle(2.6, C.gold, 0.75);
  for (const [x, y, sx, sy] of corners) {
    g.lineBetween(x, y, x + sx * arm, y);
    g.lineBetween(x, y, x, y + sy * arm);
  }

  // The pool of light the piece or the title sits in.
  scene.add
    .image(DESIGN_WIDTH / 2, DESIGN_HEIGHT * focusY, TEX.glow)
    .setOrigin(0.5)
    .setDisplaySize(focusRadius * 2, focusRadius * 2)
    .setTint(C.gold)
    .setAlpha(0.5)
    .setDepth(CURTAIN_DEPTH + 1);
}

/** A line of the biggest type in the game — the 定先后 heading — in gold, centred. */
export function curtainTitle(
  scene: Phaser.Scene,
  y: number,
  text: string,
  options: { size?: number; color?: number; depth?: number } = {},
): Phaser.GameObjects.Text {
  return scene.add
    .text(DESIGN_WIDTH / 2, y, text, {
      fontFamily: TITLE_STACK,
      fontSize: `${options.size ?? 56}px`,
      color: hex(options.color ?? C.gold),
      // Baked glyphs, so they carry the camera's density (`ui/render-scale`).
      resolution: BAKE_SCALE,
    })
    .setOrigin(0.5)
    .setDepth(options.depth ?? 5);
}
