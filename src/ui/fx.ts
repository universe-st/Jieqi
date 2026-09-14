/**
 * Animation helpers.
 *
 * These are the effects that belong to no single widget — impacts, dust, banners, falling petals — and
 * the one utility that keeps the game loop honest when an animation does not finish.
 */

import Phaser from 'phaser';
import { C, DESIGN_HEIGHT, DESIGN_WIDTH, TITLE_STACK, hex } from './palette';
import { BAKE_SCALE } from './render-scale';
import { TEX } from './textures';

/**
 * Resolves when `promise` does, or after `ms` — whichever comes first.
 *
 * Every animation in this game gates the turn loop, so a single tween that never completes (a scene
 * restart, a killed tween, a tab that was backgrounded mid-move) would freeze the whole match. This is
 * the seatbelt: the visual may be cut short, but the game always moves on.
 */
export function withTimeout<T>(promise: Promise<T>, ms = 2600): Promise<T | void> {
  return Promise.race([
    promise,
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    }),
  ]);
}

/** A landing or capture impact: an expanding ring plus a handful of flying sparks. */
export function impact(
  scene: Phaser.Scene,
  x: number,
  y: number,
  color: number,
  options: { sparks?: number; spread?: number; depth?: number } = {},
): void {
  const sparks = options.sparks ?? 9;
  const spread = options.spread ?? 46;
  const depth = options.depth ?? 40;

  const ring = scene.add
    .image(x, y, TEX.ring)
    .setOrigin(0.5)
    .setTint(color)
    .setDepth(depth)
    .setScale(0.25)
    .setAlpha(0.95);
  scene.tweens.add({
    targets: ring,
    scale: 1.5,
    alpha: 0,
    duration: 420,
    ease: 'Cubic.easeOut',
    onComplete: () => ring.destroy(),
  });

  for (let i = 0; i < sparks; i++) {
    const angle = (i / sparks) * Math.PI * 2 + Math.random() * 0.5;
    const distance = spread * (0.5 + Math.random() * 0.7);
    const spark = scene.add
      .image(x, y, TEX.spark)
      .setOrigin(0.5)
      .setTint(color)
      .setDepth(depth + 1)
      .setScale(0.6 + Math.random() * 0.7);
    scene.tweens.add({
      targets: spark,
      x: x + Math.cos(angle) * distance,
      y: y + Math.sin(angle) * distance,
      alpha: 0,
      scale: 0.1,
      duration: 320 + Math.random() * 220,
      ease: 'Quad.easeOut',
      onComplete: () => spark.destroy(),
    });
  }
}

/** A soft puff of dust when a piece touches down. */
export function dust(scene: Phaser.Scene, x: number, y: number, depth = 30): void {
  for (let i = 0; i < 5; i++) {
    const angle = Math.PI + Math.random() * Math.PI;
    const dot = scene.add
      .image(x, y + 6, TEX.spark)
      .setOrigin(0.5)
      .setTint(C.goldDim)
      .setDepth(depth)
      .setAlpha(0.5)
      .setScale(0.5 + Math.random() * 0.6);
    scene.tweens.add({
      targets: dot,
      x: x + Math.cos(angle) * (12 + Math.random() * 22),
      y: y + Math.sin(angle) * (6 + Math.random() * 10),
      alpha: 0,
      scale: 0.1,
      duration: 380 + Math.random() * 200,
      ease: 'Quad.easeOut',
      onComplete: () => dot.destroy(),
    });
  }
}

/**
 * The 将军 / 胜负 banner: a vertical seal-style slab that slams in, holds, and dissolves.
 *
 * Returns a promise so the caller can sequence it against the animations it is announcing.
 */
export function banner(
  scene: Phaser.Scene,
  text: string,
  subtitle: string | undefined,
  color: number,
  options: { holdMs?: number; depth?: number } = {},
): Promise<void> {
  const holdMs = options.holdMs ?? 900;
  const depth = options.depth ?? 200;
  const centreX = DESIGN_WIDTH / 2;
  const centreY = DESIGN_HEIGHT * 0.42;

  const plate = scene.add
    .rectangle(centreX, centreY, DESIGN_WIDTH, 118, C.backdrop, 0.82)
    .setDepth(depth)
    .setScale(1, 0.1)
    .setAlpha(0);
  const rule = scene.add
    .rectangle(centreX, centreY, DESIGN_WIDTH, 2, color, 0.9)
    .setDepth(depth + 1)
    .setAlpha(0)
    .setScale(1, 1);
  const title = scene.add
    .text(centreX, centreY - (subtitle ? 14 : 0), text, {
      fontFamily: TITLE_STACK,
      fontSize: '52px',
      color: hex(color),
      // Twice the bake density, because this one is also drawn at `setScale(1.8)` below: Phaser bakes the
      // glyphs at `fontSize × resolution` and the scale magnifies them afterwards.
      resolution: BAKE_SCALE * 2,
    })
    .setOrigin(0.5)
    .setDepth(depth + 2)
    .setAlpha(0)
    .setScale(1.8);

  const parts: Phaser.GameObjects.GameObject[] = [plate, rule, title];
  if (subtitle) {
    const sub = scene.add
      .text(centreX, centreY + 34, subtitle, {
        fontFamily: TITLE_STACK,
        fontSize: '18px',
        color: hex(C.gold),
        resolution: BAKE_SCALE,
      })
      .setOrigin(0.5)
      .setDepth(depth + 2)
      .setAlpha(0);
    parts.push(sub);
  }

  return new Promise((resolve) => {
    scene.tweens.add({ targets: plate, alpha: 1, scaleY: 1, duration: 200, ease: 'Cubic.easeOut' });
    scene.tweens.add({ targets: rule, alpha: 1, duration: 260, delay: 60 });
    scene.tweens.add({
      targets: title,
      alpha: 1,
      scale: 1,
      duration: 320,
      delay: 60,
      ease: 'Back.easeOut',
    });
    scene.tweens.add({ targets: parts.slice(3), alpha: 1, duration: 260, delay: 240 });

    scene.time.delayedCall(holdMs, () => {
      scene.tweens.add({
        targets: parts,
        alpha: 0,
        duration: 340,
        ease: 'Quad.easeIn',
        onComplete: () => {
          for (const part of parts) part.destroy();
          resolve();
        },
      });
      scene.tweens.add({ targets: title, y: title.y - 26, duration: 340 });
    });
  });
}

/** Falling petals for the endgame. Purely decorative; every object removes itself. */
export function petalFall(scene: Phaser.Scene, count = 40, depth = 190): void {
  for (let i = 0; i < count; i++) {
    const x = Math.random() * DESIGN_WIDTH;
    const startY = -30 - Math.random() * 180;
    const petal = scene.add
      .image(x, startY, Math.random() < 0.5 ? TEX.petalRed : TEX.petalGold)
      .setOrigin(0.5)
      .setDepth(depth)
      .setScale(0.7 + Math.random() * 0.8)
      .setAlpha(0.9)
      .setAngle(Math.random() * 360);
    const fall = 2600 + Math.random() * 2200;
    scene.tweens.add({
      targets: petal,
      y: DESIGN_HEIGHT + 40,
      duration: fall,
      delay: Math.random() * 900,
      ease: 'Sine.easeIn',
      onComplete: () => petal.destroy(),
    });
    scene.tweens.add({
      targets: petal,
      x: x + (Math.random() * 120 - 60),
      duration: fall / 2,
      yoyo: true,
      repeat: 1,
      ease: 'Sine.easeInOut',
    });
    scene.tweens.add({
      targets: petal,
      angle: petal.angle + (Math.random() < 0.5 ? -360 : 360),
      duration: fall,
      delay: Math.random() * 900,
    });
  }
}

/** A brief wash of colour over the whole canvas. */
export function screenWash(scene: Phaser.Scene, color: number, alpha = 0.35): void {
  const wash = scene.add
    .rectangle(DESIGN_WIDTH / 2, DESIGN_HEIGHT / 2, DESIGN_WIDTH, DESIGN_HEIGHT, color, alpha)
    .setDepth(180);
  scene.tweens.add({
    targets: wash,
    alpha: 0,
    duration: 520,
    ease: 'Quad.easeOut',
    onComplete: () => wash.destroy(),
  });
}
