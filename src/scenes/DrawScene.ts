/**
 * 定先后 — the draw. A piece spins in the middle of the screen, front 帅 and back 将, and stops on one
 * of them. Whichever face is up is the colour the player plays: 帅 is red and 红先, 将 is black and 黑后.
 *
 * Why a whole turn rather than a coin toss at the moment 开始游戏 is pressed: the outcome decides who
 * moves first, which is the single biggest thing about the game that follows, and a result the player
 * *watched happen* is one they accept. The animation is deliberately unhurried — a constant-speed spin
 * that decelerates into the landing — and the verdict is held on screen for a moment afterwards, so the
 * colour is never a surprise that has to be worked out from the board.
 *
 * The draw happens in `create()` and nowhere else, so the scene is a pure function of one
 * `planSpin()` call: entering it twice cannot produce two different answers.
 */

import Phaser from 'phaser';
import { ref } from '@phaser-mvvm/core';
import type { Widget } from '@phaser-mvvm/phaser';
import { Column, Spacer, Stack, Text, render } from '@phaser-mvvm/widgets/compose';

import { audioDirector, type AudioDirector } from '../audio/AudioDirector';
import { drawVerdict, planSpin, type SpinPlan } from '../core/spin';
import type { Color, GameMode } from '../core/types';
import { drawCurtain } from '../ui/backdrop';
import { C, DESIGN_HEIGHT, DESIGN_WIDTH, TITLE_STACK } from '../ui/palette';
import { applyRenderScale } from '../ui/render-scale';
import { SPIN_DIAMETER, SpinningPiece } from '../ui/SpinningPiece';
import { buildTextures } from '../ui/textures';
import { announceScreen } from './screen';

/** How long the verdict stays on screen before the board takes over. */
const VERDICT_HOLD_MS = 1700;

/** What the menu hands the draw: the way to play. Defaults to 标准 when a scene is started directly. */
export interface DrawSceneData {
  mode?: GameMode;
}

export class DrawScene extends Phaser.Scene {
  private audio!: AudioDirector;
  private piece!: SpinningPiece;
  private pieceSlot: Widget | null = null;

  /** Drawn once, in `create()`. Read by the backdoor to check the animation agrees with the outcome. */
  private plan!: SpinPlan;
  /** The verdict line, revealed when the piece lands. */
  private readonly settled = ref(false);
  private readonly headline = ref('');
  private readonly subtitle = ref('正在定先后…');
  /** Guards the hand-over, so a late timer cannot start the board twice. */
  private handedOver = false;

  /**
   * 标准 or 混斗, handed over by the menu and passed straight on to the board.
   *
   * The draw decides the colour and nothing else, but it sits between the two screens, so it is where
   * the value has to be carried — a scene `start`ed without data comes back to 标准 rather than
   * guessing (which also keeps a direct `scene.start('draw')` from a test meaningful).
   */
  private mode: GameMode = 'standard';

  constructor() {
    super('draw');
  }

  init(data: DrawSceneData = {}): void {
    this.mode = data.mode ?? 'standard';
  }

  preload(): void {
    this.audio = audioDirector(this);
    this.audio.preload(this);
  }

  create(): void {
    announceScreen('draw');
    applyRenderScale(this);
    buildTextures(this);
    // 定先后即对局开始：抽子、宣判、进棋盘全程用对局曲。GameScene 进入时同样
    // setBgm('game')，同状态是 no-op，曲子无缝延续不重播。
    this.audio.setBgm('game');
    this.audio.start(this);
    this.cameras.main.setBackgroundColor(C.backdrop);
    drawCurtain(this, { focusY: 0.46, focusRadius: DESIGN_WIDTH * 2.4 });

    // The one random decision in this scene.
    this.plan = planSpin();
    // Every field below survives a scene *restart* — Phaser reuses the Scene object — so a second visit
    // would otherwise open with the previous verdict already on screen and the hand-over already spent.
    this.pieceSlot = null;
    this.handedOver = false;
    this.settled.value = false;
    this.headline.value = '';
    this.subtitle.value = '正在定先后…';

    this.piece = new SpinningPiece(this, DESIGN_WIDTH / 2, DESIGN_HEIGHT * 0.46, {
      diameter: SPIN_DIAMETER,
      facing: 'red',
    });

    this.buildLayout();

    this.events.on(Phaser.Scenes.Events.POST_UPDATE, this.alignPiece, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.events.off(Phaser.Scenes.Events.POST_UPDATE, this.alignPiece, this);
    });

    this.cameras.main.fadeIn(320, 0, 0, 0);
    void this.run();
  }

  // ---------------------------------------------------------------------------------------------
  // Layout
  // ---------------------------------------------------------------------------------------------

  private alignPiece(attempt = 0): void {
    const rect = this.pieceSlot?.appliedRect;
    if (!rect || rect.height <= 0) {
      if (attempt < 60) this.time.delayedCall(16, () => this.alignPiece(attempt + 1));
      return;
    }
    this.events.off(Phaser.Scenes.Events.POST_UPDATE, this.alignPiece, this);
    this.piece.placeAt(rect.x + rect.width / 2, rect.y + rect.height / 2);
  }

  private buildLayout(): void {
    render(this.mvvm, () => {
      Column(
        {
          width: 'fill',
          height: 'fill',
          gap: 6,
          alignItems: 'center',
          padding: { left: 26, right: 26, top: 40, bottom: 26 },
        },
        () => {
          Text('定 先 后', {
            size: 40,
            name: 'drawTitle',
            align: 'center',
            style: { fontFamily: TITLE_STACK },
          });
          Text('抽子定先后 · 红先黑后', { size: 'sm', tone: 'muted', align: 'center' });

          this.pieceSlot = Spacer({ width: 'fill', height: SPIN_DIAMETER + 60, name: 'pieceSlot' });
          // The two flexible gaps are weighted 1:2 rather than split evenly, which lifts the verdict up
          // under the piece it belongs to instead of leaving it stranded in the middle of the screen.
          Spacer({ flex: true, grow: 1 });

          // A fixed-height box, so swapping the caption in cannot move the piece that just landed.
          Stack({ width: 'fill', height: 104, align: 'center' }, () => {
            Column({ gap: 4, alignItems: 'center' }, () => {
              Text(() => this.headline.value, {
                size: 34,
                name: 'drawHeadline',
                align: 'center',
                tone: () => (this.settled.value ? 'default' : 'muted'),
              });
              Text(() => this.subtitle.value, {
                size: 'md',
                name: 'drawSubtitle',
                align: 'center',
                tone: 'muted',
              });
            });
          });

          Spacer({ flex: true, grow: 2 });
          Text('棋子停在哪一面，你就执哪一方', {
            size: 'xs',
            tone: 'muted',
            align: 'center',
            wrap: true,
          });
        },
      );
    });
  }

  // ---------------------------------------------------------------------------------------------
  // The draw itself
  // ---------------------------------------------------------------------------------------------

  /**
   * Spin, land, say what it means, hand over.
   *
   * Every step is awaited rather than scheduled, so the sound, the caption and the transition are
   * ordered by the animation instead of by a pile of `delayedCall`s that a slow frame can reorder.
   */
  private async run(): Promise<void> {
    // The piece drops in and gathers itself before it starts to turn.
    this.piece.setScale(0.55).setAlpha(0);
    await this.tween({
      targets: this.piece,
      scale: 1,
      alpha: 1,
      duration: 420,
      ease: 'Back.easeOut',
    });
    await this.wait(120);

    this.audio.play('spin');
    await this.piece.spinTo(this.plan);

    this.audio.play('land');
    this.piece.land();
    this.reveal(this.plan.face);

    await this.wait(VERDICT_HOLD_MS);
    this.handOver(this.plan.face);
  }

  /** Shows the verdict for the face the piece stopped on. */
  private reveal(face: Color): void {
    const verdict = drawVerdict(face);
    this.settled.value = true;
    this.headline.value = verdict.title;
    this.subtitle.value = verdict.detail;
    this.audio.play('omen');
    // Wait for the chime's attack before the board starts arriving, so the two do not overlap.
    this.time.delayedCall(60, () => this.cameras.main.flash(240, 40, 28, 16));
  }

  private handOver(face: Color): void {
    if (this.handedOver) return;
    this.handedOver = true;
    this.cameras.main.fadeOut(320, 0, 0, 0);
    this.cameras.main.once(Phaser.Cameras.Scene2D.Events.FADE_OUT_COMPLETE, () => {
      // The board opens with whoever drew 红; the scene plays the AI's first move if that is not you.
      this.scene.start('game', { player: face, mode: this.mode });
    });
  }

  private tween(config: Phaser.Types.Tweens.TweenBuilderConfig): Promise<void> {
    return new Promise((resolve) => {
      this.tweens.add({ ...config, onComplete: () => resolve() });
    });
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.time.delayedCall(ms, resolve);
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Probes for the acceptance backdoor
  // ---------------------------------------------------------------------------------------------

  /** The colour the piece is going to land on. Known from the first frame; shown at the end. */
  get outcome(): Color {
    return this.plan.face;
  }

  /** The way to play this draw is carrying to the board. */
  get gameMode(): GameMode {
    return this.mode;
  }

  /** How the spin was dressed up, for the acceptance run to compare against the animation. */
  get spinPlan(): Readonly<SpinPlan> {
    return this.plan;
  }

  /** Which face the piece is presenting right now — the animation's own answer, not the plan's. */
  get shownFace(): Color {
    return this.piece.face;
  }

  /** How far the piece has turned, in radians. */
  get pieceRotation(): number {
    return this.piece.rotationRadians;
  }

  get isSettled(): boolean {
    return this.settled.value;
  }

  /** The line under the piece, exactly as rendered. */
  get verdictText(): string {
    return `${this.headline.value} ${this.subtitle.value}`.trim();
  }
}
