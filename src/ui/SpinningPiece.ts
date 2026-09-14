/**
 * The piece that spins to decide the colours — one view, used twice.
 *
 * The start menu keeps one turning slowly as its emblem, and the draw screen spins one for real and
 * stops it on the side the player takes. Both are the same object because both are the same *thing*:
 * a 帅 on one face and a 将 on the other, turned about a vertical axis.
 *
 * The trick is the oldest one a 2D game has: the piece never actually turns, it *squashes*. `scaleX`
 * follows `|cos θ|` — full width face-on, a thin sliver edge-on — and the face swaps every time `θ`
 * crosses a quarter turn. The geometry (which face, how wide) lives in `src/core/spin.ts`, Phaser-free
 * and tested there; this class only draws the answer.
 *
 * Two details that are not obvious:
 *
 * - **The glyph is never mirrored.** `scaleX` is always positive, so `帅` stays readable at every
 *   angle. The face is chosen by the *sign* of `cos θ` rather than by the sign of the scale, which is
 *   also what lets the piece land on either face without a 180° flip at the end.
 * - **The edge strip sits behind the faces, not in front of them.** A bar wide enough to read when the
 *   piece is edge-on would otherwise draw a dark stripe down the middle of a face that is nearly
 *   face-on; behind them it is simply covered up, and occlusion does the alpha blending for free.
 */

import Phaser from 'phaser';
import { faceAt, faceScale, type SpinPlan } from '../core/spin';
import type { Color } from '../core/types';
import { KIND_NAME } from '../core/types';
import { C, SERIF_STACK, hex } from './palette';
import { BAKE_SCALE } from './render-scale';
import { TEX } from './textures';

/** Diameter of the piece in design pixels. Big enough to be the only thing on the screen. */
export const SPIN_DIAMETER = 188;

/** The disc inside the baked texture is a little smaller than the square it is baked into. */
const DISC_INSET = 40 / 46;

/** How fast the piece starts to look solid again as it comes back round to face the player. */
const EDGE_FADE = 2.2;

export interface SpinningPieceOptions {
  /** Diameter in design pixels. Defaults to {@link SPIN_DIAMETER}. */
  diameter?: number;
  /** Which face is towards the player at rest. Defaults to 帅 (red). */
  facing?: Color;
  /** Draw the soft pool of light behind the piece. Defaults to `true`. */
  glow?: boolean;
}

export class SpinningPiece extends Phaser.GameObjects.Container {
  /** Both faces, grouped so the squash can be applied to them and nothing else. */
  private readonly faces: Phaser.GameObjects.Container;
  private readonly front: Phaser.GameObjects.Container;
  private readonly back: Phaser.GameObjects.Container;
  private readonly edge: Phaser.GameObjects.Image;
  private readonly shade: Phaser.GameObjects.Ellipse;
  private readonly halo: Phaser.GameObjects.Image;

  private readonly diameter: number;
  /** Where the piece sits when it is not mid-spin; the bob is measured from here. */
  private restY: number;
  private facing: Color;
  private radians = 0;
  private spinning = false;

  constructor(
    scene: Phaser.Scene,
    x: number,
    y: number,
    options: SpinningPieceOptions = {},
  ) {
    super(scene, x, y);
    this.diameter = options.diameter ?? SPIN_DIAMETER;
    this.facing = options.facing ?? 'red';
    this.restY = y;

    const disc = this.diameter * DISC_INSET;
    const edgeWidth = this.diameter * 0.15;

    this.shade = scene.add
      .ellipse(0, this.diameter * 0.52, this.diameter * 0.72, this.diameter * 0.15, 0x000000, 0.4)
      .setOrigin(0.5);

    this.halo = scene.add
      .image(0, 0, TEX.glow)
      .setOrigin(0.5)
      .setDisplaySize(this.diameter * 2.3, this.diameter * 2.3)
      .setTint(C.gold)
      .setAlpha(options.glow === false ? 0 : 0.85);

    this.edge = scene.add
      .image(0, 0, TEX.discEdge)
      .setOrigin(0.5)
      .setDisplaySize(edgeWidth, disc)
      .setAlpha(0);

    this.front = this.buildFace(scene, 'red', disc);
    this.back = this.buildFace(scene, 'black', disc);
    this.faces = scene.add.container(0, 0, [this.front, this.back]);

    this.add([this.halo, this.shade, this.edge, this.faces]);
    scene.add.existing(this);

    this.showFacing(this.facing);
  }

  /** One face: the ivory disc in its side's rim, with the character carved into it. */
  private buildFace(scene: Phaser.Scene, color: Color, disc: number): Phaser.GameObjects.Container {
    const plate = scene.add
      .image(0, 0, color === 'red' ? TEX.discRed : TEX.discBlack)
      .setOrigin(0.5)
      .setDisplaySize(disc, disc);
    const glyph = scene.add
      .text(0, 0, KIND_NAME[color].K, {
      // Same reasoning as `PieceView`: a baked glyph has to carry the camera's density.
      resolution: BAKE_SCALE,
        fontFamily: SERIF_STACK,
        // The character fills the same share of the disc as a real carved piece does.
        fontSize: `${Math.round(disc * 0.62)}px`,
        color: hex(color === 'red' ? C.cinnabar : C.ink),
      })
      .setOrigin(0.5, 0.53);
    return scene.add.container(0, 0, [plate, glyph]);
  }

  /** Which face is currently towards the player. */
  get face(): Color {
    return this.facing;
  }

  /**
   * Places the piece — and remembers where "at rest" now is.
   *
   * The spin's bob is measured from `restY`, so a piece positioned by the layout engine (which only
   * knows where its slot ended up, after the first frame) has to be told, or every spin would drift
   * back towards wherever the piece was built.
   */
  placeAt(x: number, y: number): void {
    this.restY = y;
    this.setPosition(x, y - Math.abs(Math.sin(this.radians)) * this.diameter * 0.05);
  }

  /** How far the piece has turned, in radians. */
  get rotationRadians(): number {
    return this.radians;
  }

  get isSpinning(): boolean {
    return this.spinning;
  }

  /** Swaps the visible face. Cheap enough to call every frame, but it only ever runs on a crossing. */
  private showFacing(face: Color): void {
    this.facing = face;
    this.front.setVisible(face === 'red');
    this.back.setVisible(face === 'black');
  }

  /**
   * Poses the piece at `theta`: which face shows, how wide it is, and the small vertical bob that
   * keeps the squash from reading as a flat scale.
   */
  applyAngle(theta: number): void {
    this.radians = theta;
    const face = faceAt(theta);
    if (face !== this.facing) this.showFacing(face);

    const scale = faceScale(theta);
    this.faces.setScale(scale, 1);
    // Seen edge-on the piece is at its thinnest — that is when the side shows through.
    this.edge.setAlpha(Phaser.Math.Clamp(1 - scale * EDGE_FADE, 0, 1));
    this.y = this.restY - Math.abs(Math.sin(theta)) * this.diameter * 0.05;
    // A slow tilt that returns to zero at every half turn, so it never fights the landing.
    this.setAngle(Math.sin(theta) * 4);
  }

  /**
   * The landing: a shockwave ring and a flash of the light behind the piece.
   *
   * Fired by the caller rather than from inside `spinTo`, because the scene is the one that knows
   * *when* the landing happens relative to the sound and the caption.
   */
  land(): void {
    const ring = this.scene.add
      .image(this.x, this.y, TEX.ring)
      .setOrigin(0.5)
      .setDisplaySize(this.diameter, this.diameter)
      .setTint(this.facing === 'red' ? C.cinnabar : C.goldBright)
      .setAlpha(0.9);
    this.scene.tweens.add({
      targets: ring,
      displayWidth: this.diameter * 3.1,
      displayHeight: this.diameter * 3.1,
      alpha: 0,
      duration: 620,
      ease: 'Cubic.easeOut',
      onComplete: () => ring.destroy(),
    });
    this.scene.tweens.add({
      targets: this.halo,
      alpha: { from: 1, to: 0.85 },
      displayWidth: this.diameter * 3.4,
      displayHeight: this.diameter * 3.4,
      duration: 460,
      yoyo: true,
      ease: 'Quad.easeOut',
    });
    // A small recoil, as if the piece had just been put down.
    this.scene.tweens.add({
      targets: this.faces,
      scaleY: { from: 1.14, to: 1 },
      duration: 320,
      ease: 'Back.easeOut',
    });
  }

  /**
   * Keeps the piece turning for ever, slowly — the menu emblem.
   *
   * One linear tween over a whole revolution, repeating: a constant angular speed, so the face swaps
   * at a steady rhythm and nothing about it looks like it is about to stop.
   */
  startIdle(periodMs = 3600): this {
    const proxy = { theta: 0 };
    this.scene.tweens.add({
      targets: proxy,
      theta: Math.PI * 2,
      duration: periodMs,
      repeat: -1,
      ease: 'Linear',
      onUpdate: () => this.applyAngle(proxy.theta),
    });
    return this;
  }

  /**
   * Spins and stops on `plan.face`.
   *
   * Two tweens, and the hand-over between them is the whole reason the animation reads as physical:
   * a constant-speed glide through every half-turn but the last, then a decelerating final turn that
   * lands. {@link spinPhases} chooses the two durations so the angular speeds match at the join — see
   * the test that asserts it.
   */
  spinTo(plan: SpinPlan): Promise<void> {
    this.spinning = true;
    const glideRadians = Math.PI * (plan.halfTurns - 1);
    return new Promise((resolve) => {
      const glide = { theta: 0 };
      this.scene.tweens.add({
        targets: glide,
        theta: glideRadians,
        duration: plan.phases.glideMs,
        ease: 'Linear',
        onUpdate: () => this.applyAngle(glide.theta),
        onComplete: () => {
          const settle = { theta: glideRadians };
          this.scene.tweens.add({
            targets: settle,
            theta: plan.radians,
            duration: plan.phases.settleMs,
            ease: 'Cubic.easeOut',
            onUpdate: () => this.applyAngle(settle.theta),
            onComplete: () => {
              // Land exactly on the plan rather than wherever the ease ended up: the face the piece
              // shows *is* the colour the player is given, so it may not be a rounding away.
              this.applyAngle(plan.radians);
              this.spinning = false;
              resolve();
            },
          });
        },
      });
    });
  }
}
