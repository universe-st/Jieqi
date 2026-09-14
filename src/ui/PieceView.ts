/**
 * One playing piece.
 *
 * The view is deliberately *not* told what a face-down piece is — {@link PieceView.showHidden} takes no
 * identity at all, and {@link PieceView.flipTo} is the only way an identity ever reaches it. Keeping
 * hidden information out of the view's type signature is the cheapest way to make sure a careless
 * `console.log` or a stray label can never leak it.
 */

import Phaser from 'phaser';
import type { Color, Kind } from '../core/types';
import { KIND_NAME } from '../core/types';
import { C, PIECE_RADIUS, SERIF_STACK, hex } from './palette';
import { BAKE_SCALE } from './render-scale';
import { PIECE_DISPLAY, TEX } from './textures';

const FLIP_HALF_MS = 105;

/**
 * Opacity of a piece that was still face down when the match ended.
 *
 * The reveal at the end of a game is a *record*, not a move: it says what was there, and it has to do so
 * without pretending those pieces were played face up. Half-transparent is the whole of that idea —
 * legible at a glance, and visibly not the same as a piece that earned its face. The captured chips make
 * the same statement at 0.72 (`ui/textures.ts`); a board piece is four times the size and carries its own
 * ivory disc, so it stays readable a little further down.
 */
export const REVEALED_ALPHA = 0.6;

export class PieceView extends Phaser.GameObjects.Container {
  readonly pieceId: number;
  readonly color: Color;
  /** The disc + label, grouped so the reveal animation can scale only them and leave the shadow. */
  private readonly disc: Phaser.GameObjects.Container;
  private readonly back: Phaser.GameObjects.Image;
  private readonly front: Phaser.GameObjects.Image;
  private readonly label: Phaser.GameObjects.Text;
  private readonly shadow: Phaser.GameObjects.Ellipse;
  private readonly sweep: Phaser.GameObjects.Image;
  private facing: 'back' | 'front';
  /** In-flight flip, so a second `flipTo` mid-animation joins the first instead of fighting it. */
  private flipPromise: Promise<void> | null = null;

  constructor(
    scene: Phaser.Scene,
    x: number,
    y: number,
    pieceId: number,
    color: Color,
    options: { hidden: boolean },
  ) {
    super(scene, x, y);
    this.pieceId = pieceId;
    this.color = color;
    this.facing = options.hidden ? 'back' : 'front';

    this.shadow = scene.add
      .ellipse(1.5, PIECE_RADIUS * 0.66, PIECE_RADIUS * 1.9, PIECE_RADIUS * 0.78, 0x000000, 0.34)
      .setOrigin(0.5);

    // The discs are baked at BAKE_SCALE samples per design pixel (`textures.ts`), so they have to be told
    // how big the picture is — otherwise the extra density would just make the piece bigger.
    this.back = scene.add
      .image(0, 0, TEX.discBack)
      .setOrigin(0.5)
      .setDisplaySize(PIECE_DISPLAY, PIECE_DISPLAY);
    this.front = scene.add
      .image(0, 0, color === 'red' ? TEX.discRed : TEX.discBlack)
      .setOrigin(0.5)
      .setDisplaySize(PIECE_DISPLAY, PIECE_DISPLAY);
    this.label = scene.add
      .text(0, 0, '', {
        fontFamily: SERIF_STACK,
        fontSize: '25px',
        color: hex(color === 'red' ? C.cinnabar : C.ink),
        // Glyphs are rasterised once, into a canvas of their own: at 1× a zoomed camera could only magnify
        // the 25px bitmap. Phaser keeps the object's layout size and divides the frame by this at render
        // time, so nothing about the piece's geometry moves.
        resolution: BAKE_SCALE,
      })
      .setOrigin(0.5, 0.53);

    // The reveal flash. It lives inside the body so it collapses with the flip rather than hanging in
    // mid-air at the widest point. Softened in 1.2.4: it used to bloom to PIECE_RADIUS×2.8 at alpha 0.9
    // and read as a harsh flash on a crisp display — now it is a small glint that hugs the piece.
    this.sweep = scene.add
      .image(0, 0, TEX.glow)
      .setOrigin(0.5)
      .setDisplaySize(PIECE_RADIUS * 2.0, PIECE_RADIUS * 2.0)
      .setAlpha(0);

    this.disc = scene.add.container(0, 0, [this.back, this.front, this.label, this.sweep]);
    this.add([this.shadow, this.disc]);
    scene.add.existing(this);

    this.back.setVisible(this.facing === 'back');
    this.front.setVisible(this.facing === 'front');
    this.label.setVisible(this.facing === 'front');
  }

  /** True while the piece is face down. */
  get isHidden(): boolean {
    return this.facing === 'back';
  }

  /** Shows the uniform back. Needs no identity — by design. */
  showHidden(): void {
    this.facing = 'back';
    this.back.setVisible(true);
    this.front.setVisible(false);
    this.label.setVisible(false);
    this.disc.setScale(1, 1);
    this.disc.setPosition(0, 0);
  }

  /** Shows a face-up identity. */
  showFace(kind: Kind): void {
    this.facing = 'front';
    this.label.setText(KIND_NAME[this.color][kind]);
    this.back.setVisible(false);
    this.front.setVisible(true);
    this.label.setVisible(true);
    this.disc.setScale(1, 1);
  }

  /**
   * Turns the piece face up.
   *
   * `scaleX` down to nothing, swap the face, and back out again — the oldest trick a 2D game has for
   * faking a third dimension, and the one moment in jieqi that has earned it.
   */
  flipTo(kind: Kind): Promise<void> {
    if (this.facing === 'front') {
      this.showFace(kind);
      return Promise.resolve();
    }
    if (this.flipPromise) return this.flipPromise;
    const running = new Promise<void>((resolve) => {
      this.scene.tweens.add({
        targets: this.disc,
        scaleX: 0,
        duration: FLIP_HALF_MS,
        ease: 'Sine.easeIn',
        onComplete: () => {
          this.showFace(kind);
          this.sweep.setAlpha(0.5).setScale(0.3);
          this.scene.tweens.add({
            targets: this.sweep,
            alpha: 0,
            scale: 1.3,
            duration: FLIP_HALF_MS + 110,
            ease: 'Cubic.easeOut',
          });
          this.scene.tweens.add({
            targets: this.disc,
            scaleX: 1,
            duration: FLIP_HALF_MS + 35,
            ease: 'Sine.easeOut',
            onComplete: () => resolve(),
          });
        },
      });
    });
    this.flipPromise = running.finally(() => {
      this.flipPromise = null;
    });
    return this.flipPromise;
  }

  /**
   * Turns a still-hidden piece face up and leaves it dimmed — the end-of-match reveal.
   *
   * {@link flipTo} is normally the only way an identity reaches this view, and it is called from exactly
   * one place: a move that turned the piece over. This is the second caller, and it is safe for one
   * reason only — the match is over, so the board is no longer a secret to be kept, it is a record of
   * what was there. The dimming is what keeps that honest: a piece nobody ever turned over still reads
   * as a piece nobody ever turned over, not as one that was played face up.
   *
   * `delayMs` staggers the wave across the board. Resolves when this piece has finished turning.
   */
  revealHidden(kind: Kind, delayMs = 0): Promise<void> {
    // Already face up: nothing to reveal, and nothing to dim either — this is only ever about 暗子.
    if (this.facing === 'front') return Promise.resolve();
    return new Promise((resolve) => {
      this.scene.time.delayedCall(delayMs, () => {
        void this.flipTo(kind).then(() => {
          this.scene.tweens.add({
            targets: this,
            alpha: REVEALED_ALPHA,
            duration: 260,
            ease: 'Quad.easeOut',
            onComplete: () => resolve(),
          });
        });
      });
    });
  }

  /** The same reveal with no animation — how `BoardView.reconcile` puts the state back. */
  showRevealed(kind: Kind): void {
    this.showFace(kind);
    this.setAlpha(REVEALED_ALPHA);
  }

  /** Slides the piece to a square with a small arc and a shadow that follows underneath. */
  glideTo(x: number, y: number): Promise<void> {
    const distance = Phaser.Math.Distance.Between(this.x, this.y, x, y);
    const duration = Phaser.Math.Clamp(distance * 2.6, 190, 430);
    return new Promise((resolve) => {
      this.scene.tweens.add({
        targets: this,
        x,
        y,
        duration,
        ease: 'Sine.easeInOut',
        onComplete: () => {
          this.disc.setY(0);
          this.shadow.setAlpha(0.34).setScale(1, 1);
          resolve();
        },
      });
      // The arc and the shadow separation are what make the piece look picked up rather than slid.
      this.scene.tweens.add({
        targets: this.disc,
        y: -Math.min(14, 5 + distance * 0.09),
        duration: duration / 2,
        yoyo: true,
        ease: 'Quad.easeOut',
      });
      this.scene.tweens.add({
        targets: this.shadow,
        alpha: 0.18,
        scaleX: 0.82,
        scaleY: 0.82,
        duration: duration / 2,
        yoyo: true,
      });
    });
  }

  /** Flies in from off-board during the deal. */
  dropIn(x: number, y: number, delay: number, fromY: number): Promise<void> {
    this.setPosition(x, fromY);
    this.setScale(0.72);
    this.setAlpha(0);
    return new Promise((resolve) => {
      this.scene.tweens.add({
        targets: this,
        y,
        alpha: 1,
        scale: 1,
        duration: 420,
        delay,
        ease: 'Back.easeOut',
        onComplete: () => resolve(),
      });
      // A little rotation on the way in, so the pieces do not look like they are on rails.
      this.setAngle(this.color === 'red' ? -22 : 22);
      this.scene.tweens.add({
        targets: this,
        angle: 0,
        duration: 460,
        delay,
        ease: 'Cubic.easeOut',
      });
    });
  }

  /** Lifts the piece off the board while it is selected, and settles it back afterwards. */
  setLifted(on: boolean): void {
    if (on) this.parentContainer?.bringToTop(this);
    this.scene.tweens.add({
      targets: this.disc,
      y: on ? -6 : 0,
      duration: 140,
      ease: 'Quad.easeOut',
    });
    this.scene.tweens.add({
      targets: this.shadow,
      alpha: on ? 0.5 : 0.34,
      scaleX: on ? 1.14 : 1,
      scaleY: on ? 1.14 : 1,
      duration: 140,
    });
  }

  /** A short pulse, used for the general when it is put in check. */
  alarmPulse(): void {
    const glow = this.scene.add
      .image(this.x, this.y, TEX.glowRed)
      .setOrigin(0.5)
      .setDisplaySize(PIECE_RADIUS * 4.6, PIECE_RADIUS * 4.6)
      .setAlpha(0.95);
    this.scene.tweens.add({
      targets: glow,
      alpha: 0,
      scale: 1.8,
      duration: 700,
      ease: 'Cubic.easeOut',
      onComplete: () => glow.destroy(),
    });
    this.scene.tweens.add({
      targets: this.disc,
      scale: 1.14,
      duration: 140,
      yoyo: true,
      repeat: 1,
      ease: 'Quad.easeOut',
    });
  }

  /** Spins away as it is captured. */
  spinAway(): Promise<void> {
    return new Promise((resolve) => {
      this.scene.tweens.add({
        targets: this,
        angle: this.color === 'red' ? -220 : 220,
        scale: 0.12,
        alpha: 0,
        duration: 430,
        ease: 'Back.easeIn',
        onComplete: () => {
          this.setVisible(false);
          resolve();
        },
      });
      this.scene.tweens.add({ targets: this.shadow, alpha: 0, duration: 240 });
    });
  }
}
