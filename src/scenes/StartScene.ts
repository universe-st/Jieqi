/**
 * 开始界面 — the title screen: 开始游戏 / 难度设置 / 音量设置.
 *
 * Three entries and nothing else, because those are the three things a player can decide before the
 * first move: whether to start, how strong the opponent is, and how loud it is. Everything else — undo,
 * hints, resigning — only means something once there is a position on the board, so it lives in the
 * game's HUD instead.
 *
 * The emblem above the buttons is the same piece the draw spins, turning slowly and for ever: the one
 * rule of this game that is not xiangqi is also the one thing that can be shown at a glance from the
 * title screen, before a word of explanation.
 *
 * The layout is MVVM, like the board's HUD, with one exception: the emblem is an ordinary Phaser
 * container, so it is positioned *after* the first layout by reading the `Spacer` that reserved its
 * place — the same trick `GameScene` uses to align the board, and for the same reason (`UIRoot` reserves
 * the notch's safe area, so a hard-coded y is wrong on a phone with a camera cutout).
 */

import Phaser from 'phaser';
import { ref } from '@phaser-mvvm/core';
import type { Widget } from '@phaser-mvvm/phaser';
import { Button, Column, Spacer, Text, render } from '@phaser-mvvm/widgets/compose';

import type { Difficulty } from '../ai';
import { audioDirector, type AudioDirector } from '../audio/AudioDirector';
import { MODE_NAME, type GameMode } from '../core/types';
import { drawCurtain } from '../ui/backdrop';
import { openDifficultyDialog, openModeDialog, openVolumeDialog } from '../ui/dialogs';
import { C, DESIGN_HEIGHT, DESIGN_WIDTH, TITLE_STACK } from '../ui/palette';
import { applyRenderScale } from '../ui/render-scale';
import { SpinningPiece } from '../ui/SpinningPiece';
import { buildTextures } from '../ui/textures';
import { announceScreen } from './screen';
import { DIFFICULTY_LABEL } from '../vm/GameViewModel';
import {
  loadCaptureHint,
  loadDifficulty,
  loadMode,
  saveCaptureHint,
  saveDifficulty,
  saveMode,
} from '../vm/prefs';

/** Diameter of the emblem. Smaller than the draw's piece, which has the whole screen to itself. */
const EMBLEM_DIAMETER = 148;

export class StartScene extends Phaser.Scene {
  private audio!: AudioDirector;
  private emblem!: SpinningPiece;
  private emblemSlot: Widget | null = null;

  /** Held as a `ref` so the button label follows the dialog without a rebuild. */
  private readonly difficulty = ref<Difficulty>(loadDifficulty());
  /**
   * 吃子提示, set from the same dialog.
   *
   * Kept here as well as on the board because the two screens share one dialog function: the menu has to
   * be able to open it with the checkbox showing what the board would show, or turning the setting on
   * before the first move would silently do nothing.
   */
  private readonly captureHint = ref<boolean>(loadCaptureHint());
  /**
   * 标准 / 混斗 — asked for on the way into every match.
   *
   * Held here as well as passed down (draw → board) so the menu's entry can show what was chosen last
   * time, and so a player who comes back to the menu does not have to remember which one they played.
   */
  private readonly mode = ref<GameMode>(loadMode());
  /** Set the moment a game is asked for, so a second tap cannot start a second one. */
  private leaving = false;

  constructor() {
    super('start');
  }

  preload(): void {
    this.audio = audioDirector(this);
    this.audio.preload(this);
  }

  create(): void {
    announceScreen('start');
    applyRenderScale(this);
    buildTextures(this);
    this.audio.setBgm('menu');
    this.audio.start(this);
    this.cameras.main.setBackgroundColor(C.backdrop);
    drawCurtain(this, { focusY: 0.3 });
    // Phaser reuses the *same* Scene object every time it is started, so nothing set on a previous visit
    // is cleared for free. Coming back from the board and pressing 开始游戏 used to do nothing at all,
    // because `leaving` was still `true` from the first visit.
    this.leaving = false;
    this.emblemSlot = null;

    this.emblem = new SpinningPiece(this, DESIGN_WIDTH / 2, DESIGN_HEIGHT * 0.3, {
      diameter: EMBLEM_DIAMETER,
      facing: 'red',
    }).startIdle();

    this.buildMenu();

    this.events.on(Phaser.Scenes.Events.POST_UPDATE, this.alignEmblem, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.events.off(Phaser.Scenes.Events.POST_UPDATE, this.alignEmblem, this);
    });

    this.cameras.main.fadeIn(320, 0, 0, 0);
  }

  // ---------------------------------------------------------------------------------------------
  // Layout
  // ---------------------------------------------------------------------------------------------

  /** Pins the emblem to the slot the layout reserved. Retries until the first layout has run. */
  private alignEmblem(attempt = 0): void {
    const rect = this.emblemSlot?.appliedRect;
    if (!rect || rect.height <= 0) {
      if (attempt < 60) this.time.delayedCall(16, () => this.alignEmblem(attempt + 1));
      return;
    }
    this.events.off(Phaser.Scenes.Events.POST_UPDATE, this.alignEmblem, this);
    this.emblem.placeAt(rect.x + rect.width / 2, rect.y + rect.height / 2);
  }

  private buildMenu(): void {
    render(this.mvvm, () => {
      Column(
        {
          width: 'fill',
          height: 'fill',
          gap: 4,
          alignItems: 'center',
          padding: { left: 26, right: 26, top: 32, bottom: 20 },
        },
        () => {
          Text('揭 棋', {
            size: 60,
            name: 'menuTitle',
            align: 'center',
            style: { fontFamily: TITLE_STACK },
          });
          Text('暗子开局 · 翻开方见真章', { size: 'sm', tone: 'muted', align: 'center' });
          // The emblem is a Phaser object, not a widget: this reserves its place in the flow.
          this.emblemSlot = Spacer({ width: 'fill', height: 226, name: 'emblemSlot' });
          Spacer({ flex: true });

          Column({ width: 'fill', gap: 10, alignItems: 'center' }, () => {
            Button('开始游戏', {
              variant: 'primary',
              size: 'lg',
              width: 226,
              name: 'startButton',
              onClick: () => this.beginGame(),
            });
            // What the last match was played as. The dialog is where it changes; this is only so the
            // choice is visible before pressing 开始游戏 again.
            Text(() => `玩法 · ${MODE_NAME[this.mode.value]}`, {
              size: 'xs',
              tone: 'muted',
              name: 'modeLabel',
            });
            Button(() => `难度设置 · ${DIFFICULTY_LABEL[this.difficulty.value]}`, {
              variant: 'secondary',
              size: 'md',
              width: 226,
              name: 'menuDifficultyButton',
              onClick: () => this.openDifficulty(),
            });
            // Just the entry's name. What the two channels are set to is the dialog's business: a reading
            // the player cannot edit, sitting on a control they can, is stale the moment the dialog moves
            // it — and the menu would have to be told to re-read the mixer to keep up.
            Button('音量设置', {
              variant: 'secondary',
              size: 'md',
              width: 226,
              name: 'menuVolumeButton',
              onClick: () => this.openVolume(),
            });
          });

          Spacer({ flex: true });
          Spacer({ height: 10 });
          Text('抽子定先后 · 停于帅面执红先行，停于将面执黑后行', {
            size: 'xs',
            tone: 'muted',
            align: 'center',
            wrap: true,
          });
          Text('红先黑后 · 人机对弈', { size: 'xs', tone: 'muted', align: 'center' });
        },
      );
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Menu actions
  // ---------------------------------------------------------------------------------------------

  /**
   * 开始游戏 — ask 标准 or 混斗, then hand over to the draw, which decides the colours.
   *
   * `mode` short-circuits the question and is what the acceptance backdoor drives: a run that wants a
   * 混斗 board should not have to click through a dialog to get one, and a run that wants to test *the
   * dialog* can still press `mode_mixed` with a real mouse (the buttons are named).
   */
  beginGame(mode?: GameMode): void {
    if (this.leaving) return;
    this.audio.play('click');
    if (mode) {
      this.startWith(mode);
      return;
    }
    openModeDialog(this.mvvm, this.mode.value, (picked) => {
      this.mode.value = picked;
      saveMode(picked);
      this.audio.play('pick');
      this.startWith(picked);
    });
  }

  /** The hand-over itself: fade, then 定先后 with the chosen mode riding along. */
  private startWith(mode: GameMode): void {
    if (this.leaving) return;
    this.leaving = true;
    this.cameras.main.fadeOut(240, 0, 0, 0);
    this.cameras.main.once(Phaser.Cameras.Scene2D.Events.FADE_OUT_COMPLETE, () => {
      this.scene.start('draw', { mode });
    });
  }

  openDifficulty(): void {
    this.audio.play('click');
    openDifficultyDialog(
      this.mvvm,
      this.difficulty.value,
      (value) => {
        this.difficulty.value = value;
        saveDifficulty(value);
        this.audio.play('pick');
      },
      {
        value: this.captureHint.value,
        onToggle: (on) => {
          this.captureHint.value = on;
          saveCaptureHint(on);
          this.audio.play('pick');
        },
      },
    );
  }

  /** 音量设置 — the shared mixer, which is where the two channels' values are shown and set. */
  openVolume(): void {
    this.audio.play('click');
    openVolumeDialog(this.mvvm, this.audio);
  }

  // ---------------------------------------------------------------------------------------------
  // Probes for the acceptance backdoor
  // ---------------------------------------------------------------------------------------------

  /** The level the menu is currently set to — what the difficulty entry reads back. */
  get selectedDifficulty(): Difficulty {
    return this.difficulty.value;
  }

  setDifficulty(value: Difficulty): void {
    this.difficulty.value = value;
    saveDifficulty(value);
  }

  /** 吃子提示 as the menu sees it — the same value the board will come up with. */
  get captureHintSetting(): boolean {
    return this.captureHint.value;
  }

  setCaptureHintSetting(on: boolean): void {
    this.captureHint.value = on;
    saveCaptureHint(on);
  }

  /** 标准 / 混斗 as the menu is set to — what the next 开始游戏 will deal. */
  get selectedMode(): GameMode {
    return this.mode.value;
  }

  setMode(value: GameMode): void {
    this.mode.value = value;
    saveMode(value);
  }

  /** True once 开始游戏 has been pressed and the scene is on its way out. */
  get isLeaving(): boolean {
    return this.leaving;
  }
}
