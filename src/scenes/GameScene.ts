/**
 * The game scene: it owns the rules, the board view, the HUD and the turn loop.
 *
 * The split it enforces is the one phaser-mvvm recommends — **the HUD is MVVM, the board is Phaser**.
 * State lives in a `JieqiGame` and a `GameViewModel`; the board is a `BoardView` of ordinary game
 * objects; the panels, buttons and move log are composables reading the ViewModel's `ref`s.
 *
 * ## Which side is which
 *
 * The player's colour is **not** fixed: the 定先后 draw (`DrawScene`) hands it in as `init` data, and
 * everything here is written against `vm.player` / `vm.ai` rather than against 红 and 黑. The one thing
 * that *is* fixed is the turn order (红先黑后), so when the player draws 将 the AI opens and this scene
 * plays its first move as soon as the board has been dealt.
 */

import Phaser from 'phaser';
import type { Widget } from '@phaser-mvvm/phaser';
import {
  Button,
  Column,
  Image,
  List,
  Panel,
  Row,
  Scroll,
  Spacer,
  Stack,
  Text,
  render,
} from '@phaser-mvvm/widgets/compose';

import { DIFFICULTY, analyse, chooseMoveAsync, type Difficulty, type ScoredMove } from '../ai';
import { audioDirector, type AudioDirector } from '../audio/AudioDirector';
import type { Board } from '../core/board';
import { hangingSquares, landsHangingAs } from '../core/danger';
import { generateMoves, isKingSafeAfter, isSquareAttacked } from '../core/moves';
import { JieqiGame, type DuelInfo, type MoveEvent } from '../core/rules';
import { randomSeed } from '../core/rng';
import {
  COLOR_NAME,
  FIRST_MOVER,
  type Color,
  type GameMode,
  type Move,
  KIND_NAME,
} from '../core/types';
import { foggedBoardFor, visibleSquares } from '../core/vision';
import { BoardView, type BoardCue, type DangerMark } from '../ui/BoardView';
import { CircleButton } from '../ui/CircleButton';
import { openDifficultyDialog, openModeHelpDialog, openVolumeDialog } from '../ui/dialogs';
import { banner, petalFall, screenWash, withTimeout } from '../ui/fx';
import { BOARD_HEIGHT, BOARD_WIDTH, C, DESIGN_WIDTH, HUD_TOP_HEIGHT } from '../ui/palette';
import { applyRenderScale } from '../ui/render-scale';
import { CHIP_DISPLAY, TEX, buildTextures, chipTexture } from '../ui/textures';
import { DIFFICULTY_LABEL, GameViewModel } from '../vm/GameViewModel';
import { loadCaptureHint, loadDifficulty, saveCaptureHint, saveDifficulty } from '../vm/prefs';
import { announceScreen } from './screen';
import { captureLabel, mixedTrayChips, trayChips, type CapturedChip } from '../vm/tray';

/** What the draw screen hands the board. Absent when a scene is started directly (tests, backdoor). */
export interface GameSceneData {
  /** The colour the player drew. Defaults to 红, which is also who moves first. */
  player?: Color;
  /** 标准 or 混斗, chosen at the menu. Defaults to 标准. */
  mode?: GameMode;
}

export class GameScene extends Phaser.Scene {
  readonly vm = new GameViewModel();

  /** Music and sound effects. The one shared director, attached in `preload()`. */
  private audio!: AudioDirector;

  /** The match. Named `jieqi` because `Scene` already owns a `game` — the Phaser one. */
  private jieqi!: JieqiGame;
  private board!: BoardView;
  private boardSlot: Widget | null = null;
  private selected: number | null = null;
  private legalForSelected: Move[] = [];
  /** Squares where the selected piece's move would expose its own general (送将) — shown as red X's. */
  private sendsCheck: ReadonlySet<number> = new Set();
  private busyDepth = 0;
  private aiNonce = 0;
  /** `this.time.now` of the last refusal banner (禁止循环追棋 / 禁止立即吃将 / 送将), so a run of taps does not stack them. */
  private lastRefusalAt = -Infinity;
  /**
   * 迷雾: the player's vision on the current position, or an empty set outside fog mode.
   *
   * Refreshed by {@link applyFog} the moment a position changes, so the status line, the move log
   * and the check announcements can all ask "could the player see this?" without recomputing.
   */
  private fogVisible: ReadonlySet<number> = new Set();
  /**
   * 迷雾: whether each ply's move was visible to the player when it was played. The move log shows
   * only what the player actually saw, so an AI move played in fog leaves no trace in the log.
   */
  private visiblePlies: boolean[] = [];

  constructor() {
    super('game');
  }

  /** Takes the drawn colour from the draw screen before anything is built. */
  init(data: GameSceneData = {}): void {
    this.vm.setPlayer(data.player ?? FIRST_MOVER);
    this.vm.mode.value = data.mode ?? 'standard';
    this.vm.difficulty.value = loadDifficulty();
    this.vm.captureHint.value = loadCaptureHint();
    // A scene that was left mid-move comes back with the previous match's bookkeeping still in place —
    // Phaser restarts the same object rather than building a new one. `busyDepth` is the dangerous one:
    // left above zero, the board would come back up permanently locked.
    this.busyDepth = 0;
    this.selected = null;
    this.legalForSelected = [];
    this.sendsCheck = new Set();
    this.aiNonce = 0;
    this.lastRefusalAt = -Infinity;
    this.visiblePlies = [];
    this.fogVisible = new Set();
  }

  /** Queues the soundtrack. The board art needs no loading — it is baked from code in `create()`. */
  preload(): void {
    this.audio = audioDirector(this);
    this.audio.preload(this);
  }

  create(): void {
    announceScreen('game');
    applyRenderScale(this);
    buildTextures(this);
    // The board runs the original game track; the menu track was playing up to here.
    this.audio.setBgm('game');
    this.audio.start(this);
    this.cameras.main.setBackgroundColor(C.backdrop);

    // Placed properly once the HUD says where its slot ended up (see `alignBoard`), so it lines up on
    // a notched phone as well as on a desktop browser that reports no insets at all.
    this.board = new BoardView(this, (DESIGN_WIDTH - BOARD_WIDTH) / 2, HUD_TOP_HEIGHT, {
      onSquare: (square) => this.onSquare(square),
      // The board says *when*; the scene decides what that sounds like.
      onCue: (cue: BoardCue) => this.audio.play(cue),
      // Your own army is always the one at the bottom of the screen: draw the board from black's side
      // when the draw handed the player 将. The engine's coordinates do not move — only the picture.
      flipped: this.player === 'black',
    });

    this.buildHud();
    this.events.on(Phaser.Scenes.Events.POST_UPDATE, this.alignBoard, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.events.off(Phaser.Scenes.Events.POST_UPDATE, this.alignBoard, this);
    });

    void this.startNewGame(randomSeed());
  }

  /**
   * Wraps a button's handler so every activation clicks, whatever produced it.
   *
   * Phaser-mvvm routes a pointer tap, `Enter`/`Space` and a gamepad button through the same
   * `onActivate`, so wrapping `onClick` covers all four input paths with one line at each call site.
   */
  private tap(run: () => void): () => void {
    return () => {
      this.audio.play('click');
      run();
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Layout
  // ---------------------------------------------------------------------------------------------

  /** Pins the board to the rect the HUD reserved for it. Retries until the first layout has run. */
  private alignBoard(attempt = 0): void {
    const rect = this.boardSlot?.appliedRect;
    if (!rect || rect.height <= 0) {
      if (attempt < 60) this.time.delayedCall(16, () => this.alignBoard(attempt + 1));
      return;
    }
    this.events.off(Phaser.Scenes.Events.POST_UPDATE, this.alignBoard, this);
    this.board.root.setPosition(rect.x + (rect.width - BOARD_WIDTH) / 2, rect.y);
  }

  private buildHud(): void {
    const vm = this.vm;
    render(this.mvvm, () => {
      Column({ width: 'fill', height: 'fill', gap: 0 }, () => {
        this.buildTopBar(vm);
        this.boardSlot = Spacer({ width: 'fill', height: BOARD_HEIGHT, name: 'boardSlot' });
        this.buildBottom(vm);
      });
    });
  }

  /**
   * A captured-piece tray: a row of chips, never a line of text.
   *
   * Each chip is a small disc, so a tray reads as "these pieces are off the board" at a glance rather
   * than as a string of characters to decode. What the chip shows is decided upstream in
   * {@link trayOf}, because only the rules layer knows who is allowed to see what.
   */
  private trayStrip(items: () => CapturedChip[], name: string, emptyLabel: string): void {
    List(
      {
        items,
        key: (chip) => chip.key,
        width: 'fill',
        height: CHIP_DISPLAY,
        gap: 2,
        container: { direction: 'horizontal', alignItems: 'center' },
        name,
        empty: () => {
          Row({ width: 'fill', height: CHIP_DISPLAY, alignItems: 'center' }, () => {
            Text(emptyLabel, { size: 'xs', tone: 'muted' });
          });
        },
      },
      (chip) => {
        Stack({ width: CHIP_DISPLAY, height: CHIP_DISPLAY }, () => {
          Image({
            texture: chip.kind
              ? chipTexture(chip.color, chip.kind, chip.dimmed)
              : TEX.chipBack,
            width: CHIP_DISPLAY,
            height: CHIP_DISPLAY,
          });
        });
      },
    );
  }

  /** Title, difficulty, volume, and the opponent's panel. */
  private buildTopBar(vm: GameViewModel): void {
    Column(
      {
        width: 'fill',
        height: HUD_TOP_HEIGHT,
        gap: 6,
        padding: { left: 12, right: 12, top: 8, bottom: 6 },
      },
      () => {
        Row({ width: 'fill', alignItems: 'center', gap: 8 }, () => {
          Text('揭 棋', { size: 'lg', name: 'title' });
          // 混斗 changes what a 暗子 *is*, so the board says which game this is rather than leaving the
          // player to work it out from a piece that walked over to the other side.
          Text(() => vm.modeBadge.value, { size: 'xs', tone: 'muted', name: 'modeBadge' });
          Spacer({ flex: true });
          Text(() => vm.thinkingText.value, {
            size: 'sm',
            tone: () => (vm.thinking.value ? 'warning' : 'muted'),
            name: 'thinkingLabel',
          });
          Button(() => DIFFICULTY_LABEL[vm.difficulty.value], {
            size: 'sm',
            variant: 'ghost',
            name: 'difficultyButton',
            onClick: this.tap(() => this.openDifficultyDialog()),
          });
          Button(() => (this.audio.muted ? '静音' : '音量'), {
            size: 'sm',
            variant: 'ghost',
            name: 'volumeButton',
            onClick: this.tap(() => this.openVolumeDialog()),
          });
        });

        Panel(
          {
            variant: 'surface',
            radius: 10,
            padding: { left: 10, right: 10, top: 6, bottom: 6 },
            width: 'fill',
            height: 'fill',
            gap: 3,
          },
          () => {
            Row({ width: 'fill', alignItems: 'center', gap: 8 }, () => {
              // The avatar follows the drawn colour: the computer is 红 whenever the player is 黑.
              Image({
                texture: () => (vm.ai.value === 'red' ? TEX.discRed : TEX.discBlack),
                width: 26,
                height: 26,
                name: 'aiAvatar',
              });
              Text(() => vm.aiName.value, { size: 'md', name: 'aiName' });
              Spacer({ flex: true });
              Text(() => vm.aiTrayLabel.value, { size: 'xs', tone: 'muted' });
            });
            this.trayStrip(
              () => vm.aiTray.value,
              'aiTray',
              '被电脑吃掉的棋子会摆在这里',
            );
          },
        );
      },
    );
  }

  private buildBottom(vm: GameViewModel): void {
    Column(
      {
        width: 'fill',
        height: 'fill',
        gap: 6,
        padding: { left: 12, right: 12, top: 6, bottom: 8 },
      },
      () => {
        Panel(
          {
            variant: 'surfaceAlt',
            radius: 10,
            padding: { left: 10, right: 10, top: 6, bottom: 6 },
            width: 'fill',
            gap: 3,
          },
          () => {
            Row({ width: 'fill', alignItems: 'center', gap: 8 }, () => {
              Image({
                texture: () => (vm.player.value === 'red' ? TEX.discRed : TEX.discBlack),
                width: 26,
                height: 26,
                name: 'playerAvatar',
              });
              Text(() => vm.playerName.value, { size: 'md', name: 'playerName' });
              Text(() => vm.seatLabel.value, { size: 'xs', tone: 'muted', name: 'seatLabel' });
              Spacer({ flex: true });
              Text(() => vm.playerTrayLabel.value, { size: 'xs', tone: 'muted' });
            });
            this.trayStrip(() => vm.playerTray.value, 'playerTray', '你吃掉的棋子会摆在这里');
            Text(() => vm.status.value, { size: 'sm', tone: 'muted', name: 'statusLabel' });
          },
        );

        Row({ width: 'fill', gap: 5 }, () => {
          Button('悔棋', {
            variant: 'secondary',
            size: 'sm',
            width: 60,
            name: 'undoButton',
            disabled: () => !vm.canUndo.value,
            onClick: this.tap(() => void this.undo()),
          });
          Button('提示', {
            variant: 'secondary',
            size: 'sm',
            width: 60,
            name: 'hintButton',
            disabled: () => !vm.canAct.value,
            onClick: this.tap(() => void this.showHint()),
          });
          Button('认输', {
            variant: 'danger',
            size: 'sm',
            width: 60,
            name: 'resignButton',
            disabled: () => vm.finished.value,
            onClick: this.tap(() => this.confirm('认输', '确定要认输吗？', () => this.resign())),
          });
          Spacer({ flex: true });
          // 玩法介绍 — one tap from the board in every mode: the ？ explains the current mode's rules.
          // A circle base (not a ghost glyph) so it reads as one of the action buttons in this row.
          CircleButton('？', {
            size: 'sm',
            width: 32,
            height: 32,
            name: 'helpButton',
            label: '玩法介绍',
            onClick: this.tap(() => this.openModeHelp()),
          });
          Button('菜单', {
            variant: 'ghost',
            size: 'sm',
            width: 60,
            name: 'menuButton',
            onClick: this.tap(() =>
              this.confirm('回到菜单', '当前对局将结束，回到开始界面。', () => this.backToMenu()),
            ),
          });
          Button('新局', {
            variant: 'primary',
            size: 'sm',
            width: 60,
            name: 'newGameButton',
            onClick: this.tap(() =>
              // Says which game is being re-dealt: 新局 keeps the mode, so a player who wants to go
              // back to 标准 has to leave through 菜单.
              this.confirm(
                '重新定先后',
                `当前对局将结束，重新抽子决定执子方（玩法保持：${this.vm.modeLabel.value}）。`,
                () => this.redraw(),
              ),
            ),
          });
        });

        Panel(
          {
            variant: 'surface',
            radius: 10,
            padding: { left: 8, right: 8, top: 4, bottom: 4 },
            width: 'fill',
            height: 'fill',
          },
          () => {
            Scroll({ direction: 'vertical', width: 'fill', height: 'fill', name: 'logScroll' }, () => {
              List(
                {
                  items: () => vm.moves.value,
                  key: (row) => row.key,
                  width: 'fill',
                  name: 'moveList',
                  container: { gap: 2 },
                  // A long game runs to a few hundred rows; virtualising keeps the layout cost flat and
                  // only builds the handful that are actually on screen.
                  virtualize: true,
                  itemExtent: 26,
                  overscan: 4,
                  empty: () => {
                    Row({ width: 'fill', height: 26, alignItems: 'center' }, () => {
                      Text('棋谱', { size: 'xs', tone: 'muted' });
                    });
                  },
                },
                (row) => {
                  Row({ width: 'fill', height: 24, alignItems: 'center', gap: 6 }, () => {
                    Text(`${row.index}.`, { size: 'xs', tone: 'muted', width: 30 });
                    Text(row.notation, { size: 'sm', tone: row.color === 'red' ? 'default' : 'muted' });
                  });
                },
              );
            });
          },
        );
      },
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Game flow
  // ---------------------------------------------------------------------------------------------

  /**
   * Deals a fresh board and, when the player drew 黑, lets the computer open.
   *
   * 红先黑后 is why the AI's move is part of *starting* a game rather than something the turn loop
   * discovers later: with the player on 将 there is nobody else to make the first move.
   */
  async startNewGame(seed: number): Promise<void> {
    this.enter();
    try {
      this.jieqi = JieqiGame.create({ seed, mode: this.vm.mode.value });
      this.selected = null;
      this.legalForSelected = [];
      this.sendsCheck = new Set();
      this.visiblePlies = [];
      this.fogVisible = new Set();
      this.board.clearHighlights();
      this.vm.reset();
      this.syncVm();
      // The opening mist is the first thing the player sees: it is drawn *before* the deal, so a
      // piece landing on a fogged square is hidden from the very first frame (deal() hides fogged
      // views as it spawns them), and `reconcile` after the deal applies the same hiding to the
      // settled views — before the computer ever opens, so an AI move into the mist is never shown.
      this.applyFog();
      await withTimeout(this.board.deal(this.jieqi.board), 3000);
      this.board.reconcile(this.jieqi.board);
    } finally {
      this.leave();
    }
    if (!this.jieqi.result && this.jieqi.sideToMove === this.ai) await this.runAi();
    this.refreshDanger();
  }

  // ---------------------------------------------------------------------------------------------
  // 迷雾 (fog of war)
  // ---------------------------------------------------------------------------------------------

  /** True while this match is 迷雾. The board flag and the mode agree by construction. */
  private get fogMode(): boolean {
    return this.jieqi.mode === 'fog';
  }

  /**
   * Rolls the mist to the current position's truth: recompute the player's vision and hand it to the
   * board. Called the moment a position changes — *before* the move animation, so a piece arriving
   * on a newly visible square lands in the clear — and once at the end of a match with `null`, which
   * lifts the fog for the full reveal.
   */
  private applyFog(): void {
    if (!this.fogMode) {
      this.board.setFog(null);
      return;
    }
    this.fogVisible = visibleSquares(this.jieqi.board, this.player);
    this.board.setFog(this.fogVisible);
  }

  /**
   * 吃子提示/送将/落点危险 are all judged on the player's *view* in 迷雾 mode: an enemy piece the
   * player cannot see is not a threat they should be warned about, and marking a piece as capturable
   * because of a hidden attacker would be exactly the "提示玩家看不到的信息" the mode forbids. The
   * fogged board — the real board minus every enemy piece outside the player's vision — is that view.
   */
  private dangerBoard(): Board {
    return this.fogMode ? foggedBoardFor(this.jieqi.board, this.player) : this.jieqi.board;
  }

  /** The squares the player can see right now — the acceptance run reads this. */
  visibleSquaresNow(): number[] {
    return [...visibleSquares(this.jieqi.board, this.player)];
  }

  /**
   * 迷雾: is the check on `side`'s general one the player can actually *see*?
   *
   * The gate is the checking piece, not the checked king: a general attacked by a piece hidden in the
   * mist is a check the player cannot attribute, so it is not announced at all (rule F5, user
   * 2026-09-15). At least one visible checker is enough to announce. Non-fog matches are always
   * visible.
   */
  private isCheckVisible(side: Color): boolean {
    if (!this.fogMode) return true;
    const king = this.jieqi.board.kingSq[side];
    if (king < 0) return false;
    const enemy = side === 'red' ? 'black' : 'red';
    for (const move of generateMoves(this.jieqi.board, enemy, [])) {
      if (move.to === king && this.fogVisible.has(move.from)) return true;
    }
    return false;
  }

  /**
   * 吃子提示: reads the position and hands the board the marks to draw.
   *
   * Called after every change of position and whenever the checkbox moves. The two clauses of the hint
   * live in `src/core/danger.ts` where they are unit-tested; this only decides *whose* pieces are whose
   * on screen, which is a question about the player and the computer, not about 红 and 黑. In 迷雾 the
   * reading is over the player's fogged view (see {@link dangerBoard}).
   *
   * Marks are cleared the moment the position is disturbed (see {@link clearDanger}), so a glow can
   * never survive the piece that earned it.
   */
  private refreshDanger(): void {
    if (!this.vm.captureHint.value || this.jieqi.result) {
      this.board.setDangerMarks([]);
      return;
    }
    const board = this.dangerBoard();
    const marks: DangerMark[] = [
      ...hangingSquares(board, this.player).map((square) => ({ square, tone: 'own' as const })),
      ...hangingSquares(board, this.ai).map((square) => ({ square, tone: 'foe' as const })),
    ];
    this.board.setDangerMarks(marks);
  }

  /** Drops the 吃子提示 marks: the board is about to change under them. */
  private clearDanger(): void {
    this.board.setDangerMarks([]);
  }

  private syncVm(): void {
    const vm = this.vm;
    vm.turn.value = this.jieqi.sideToMove;
    // The move log is the record of what the player actually *saw*, so in 迷雾 an AI move played in
    // fog (invisible to the player) leaves no row. The row index stays the true ply number, so a log
    // that skips a ply reads as "one move happened out of sight", which is exactly what happened.
    vm.moves.value = this.jieqi.moveEvents
      .map((event, index) => {
        const visible = !this.fogMode || (this.visiblePlies[index] ?? true);
        return {
          visible,
          row: {
            key: `${index}-${event.move.from}-${event.move.to}`,
            index: index + 1,
            color: event.color,
            notation: event.notation,
          },
        };
      })
      .filter((entry) => entry.visible)
      .map((entry) => entry.row);
    // 标准 fills a tray by the *colour of the pieces in it* (only the enemy's can be taken); 混斗 fills
    // it by *who did the taking*, because a red piece can end up in red's own tray there. Either way
    // the two trays are the two sides of the board.
    const mixed = this.jieqi.mode === 'mixed';
    vm.playerTray.value = this.trayOf(mixed ? this.player : this.ai, mixed);
    vm.aiTray.value = this.trayOf(mixed ? this.ai : this.player, mixed);
    vm.result.value = this.jieqi.result;
  }

  /**
   * The player's view of one tray. The rule itself lives in `src/vm/tray.ts`, where it is tested.
   *
   * `key` is the captured colour in 标准 and the capturer in 混斗 — the two modes ask the same question
   * ("which pieces belong in this strip, and what may the player see?") with a different name for the
   * side, and `mixed` is what picks which reading is meant.
   */
  private trayOf(key: Color, mixed: boolean): CapturedChip[] {
    const options = {
      // 对局结束，暗子的身份不再需要保密：摊开的棋盘上已经写着它们是什么了（见 BoardView.revealHidden）。
      revealHidden: this.jieqi.result !== null,
    };
    return mixed
      ? mixedTrayChips(this.jieqi.moveEvents, this.player, key, options)
      : trayChips(this.jieqi.moveEvents, this.player, key, options);
  }

  /** The colour the draw handed the player. */
  private get player(): Color {
    return this.vm.player.value;
  }

  /** The other side. */
  private get ai(): Color {
    return this.vm.ai.value;
  }

  private get locked(): boolean {
    return this.busyDepth > 0;
  }

  private enter(): void {
    this.busyDepth += 1;
    this.vm.busy.value = true;
    this.board.setLocked(true);
  }

  private leave(): void {
    this.busyDepth = Math.max(0, this.busyDepth - 1);
    this.vm.busy.value = this.locked;
    this.board.setLocked(this.locked);
  }

  /** A tap on the board: select, reselect, or play. */
  private onSquare(square: number): void {
    if (this.locked || this.jieqi.result) return;
    if (this.jieqi.sideToMove !== this.player) return;

    const piece = this.jieqi.board.at(square);
    const target = this.legalForSelected.find((move) => move.to === square);

    if (this.selected !== null && target) {
      void this.play(target, true);
      return;
    }
    // 送将提示: the square is on the piece's movement pattern but the move would expose the general.
    // Refuse by name, exactly like 禁止循环追棋, and leave the selection standing so another square is
    // one tap away.
    if (this.selected !== null && this.sendsCheck.has(square)) {
      this.refuseCheckGiveaway();
      return;
    }
    // 迷雾: a tap into the mist must not drop the piece. The player cannot see whether a fogged
    // square is a target — that is the whole point of the fog — so probing one that is not should
    // leave the selection standing instead of silently undoing it, or every wrong guess would cost a
    // re-select. (A fogged square can never hold the player's own piece: a side always sees what it
    // controls, so the guard below cannot skip a legitimate pick-up.)
    if (this.fogMode && this.selected !== null && !this.fogVisible.has(square)) return;
    // Ownership, not `piece.color`: in 混斗 a 暗子 on the player's half is theirs to pick up whoever it
    // turns out to be (rule M2) — and the engine would refuse the move anyway, which would read as a
    // dead piece rather than as the mode working.
    if (piece && this.jieqi.board.ownerAt(square) === this.player) {
      this.selected = square;
      this.legalForSelected = this.jieqi
        .legalMoves(this.player)
        .filter((move) => move.from === square);
      // 迷雾 = 吃王棋: 送将不是非法着法 (rule F4), so there is no red-X warning — the general may
      // be exposed, and losing it is the price the player chooses.
      this.sendsCheck = this.fogMode ? new Set() : this.sendsCheckOf(square);
      this.board.setSelection(square);
      this.board.setLegalTargets(
        this.legalForSelected.map((move) => ({
          square: move.to,
          // 迷雾 judges the landing on the player's view: a red ring must not whisper "an enemy you
          // cannot see attacks this square".
          danger: landsHangingAs(this.dangerBoard(), move, this.player),
        })),
      );
      this.board.setSendsCheck(this.sendsCheck);
      // The label follows the same reading: a 暗子 is named after its square, in the mover's colour
      // naming, so a 暗卒 on red's half is offered as a 暗兵.
      const label = piece.hidden
        ? KIND_NAME[this.player][piece.homeKind]
        : KIND_NAME[piece.color][piece.kind];
      // Targets that 禁止循环追棋 or 禁止立即吃将 forbid are offered like any other — tapping one is how
      // the player finds out, and refusing by name beats hiding a square and leaving them to wonder why
      // it is not there — but the count says up front that some of them are not available. In 迷雾 the
      // count is over the targets the player can actually see: "可走 N 处" must never leak where the
      // hidden pieces stand by reporting a rook's true range through the mist.
      const offered = this.fogMode
        ? this.legalForSelected.filter((move) => this.fogVisible.has(move.to))
        : this.legalForSelected;
      const forbidden = offered.filter((move) => this.jieqi.wouldRepeat(move)).length;
      const eatGen = offered.filter((move) => this.jieqi.wouldEatGeneral(move)).length;
      const repeatNote = forbidden > 0 ? `，其中 ${forbidden} 处禁止循环追棋` : '';
      const eatNote = eatGen > 0 ? `，其中 ${eatGen} 处禁止立即吃将` : '';
      this.vm.status.value = `${piece.hidden ? '暗' : ''}${label} · 可走 ${offered.length} 处${repeatNote}${eatNote}`;
      this.audio.play('pick');
      return;
    }
    this.clearSelection();
  }

  /**
   * Same entry point the board's hit area uses.
   *
   * Public so the acceptance backdoor can simulate a tap without reaching for a private member; it is
   * deliberately the *same* method the pointer handler calls, so a scripted tap exercises the real
   * select-then-move logic rather than a parallel implementation of it.
   */
  tapSquare(square: number): void {
    this.onSquare(square);
  }

  private clearSelection(): void {
    this.selected = null;
    this.legalForSelected = [];
    this.sendsCheck = new Set();
    this.board.setSelection(null);
    this.board.setLegalTargets([]);
    this.board.setSendsCheck(this.sendsCheck);
    if (this.jieqi.result) return;
    if (this.jieqi.inCheck(this.jieqi.sideToMove)) {
      // Same visibility gate as `announceCheck`: never report a check the player cannot see.
      if (this.isCheckVisible(this.jieqi.sideToMove)) {
        this.vm.status.value = '被将军！';
        return;
      }
    }
    this.vm.status.value =
      this.jieqi.sideToMove === this.player
        ? `${this.jieqi.sideToMove === 'red' ? '红方' : '黑方'}先行，请落子`
        : `电脑执${this.jieqi.sideToMove === 'red' ? '红' : '黑'}行棋…`;
  }

  /** The squares a move of the piece on `square` could reach but must not: it would expose the general. */
  private sendsCheckOf(square: number): ReadonlySet<number> {
    // 迷雾 judges on the player's view (see {@link dangerBoard}): a red X must not leak that an
    // unseen enemy piece stands between the move and the general's safety.
    const board = this.dangerBoard();
    const out = new Set<number>();
    for (const move of generateMoves(board, this.player, [])) {
      if (move.from !== square) continue;
      // The same reading the legal move list uses, which in 混斗 deliberately ignores what a 暗子 turns
      // out to be: 送将 is about the general the player can see exposed, not about the coin landing.
      if (!isKingSafeAfter(board, this.player, move)) out.add(move.to);
    }
    return out;
  }


  /** Plays a move and then, if the game has not ended, lets the AI answer. */
  async play(move: Move, byPlayer: boolean): Promise<void> {
    if (this.jieqi.result) return;
    // 禁止立即吃将 (混斗). Refused here, by name, ahead of the repetition guard — a tap that would take
    // the general with the piece the last move just handed over.
    if (this.jieqi.wouldEatGeneral(move)) {
      this.refuseEatGeneral(byPlayer);
      return;
    }
    // 禁止循环追棋. The move is legal in the ordinary sense — it is in the list the board just offered —
    // so it is refused *here*, by name, rather than being quietly dropped out of the targets: a player
    // who taps and gets nothing back has no way to tell a rule from a bug.
    if (!this.jieqi.isSelectable(move)) {
      this.refuseRepeat(byPlayer);
      return;
    }
    this.enter();
    try {
      this.clearDanger();
      this.clearSelection();
      const event = this.jieqi.apply(move);
      // Roll the mist to the new position *before* the animation: a piece arriving on a square the
      // new vision reveals lands in the clear, and one moving into fog is swallowed as it travels.
      this.applyFog();
      // 迷雾 一骑讨 (rule F6): a duel is its own show — banner, reveal of the file, golden charge —
      // and it always ends the game, so the ordinary move animation is skipped for it.
      if (event.duel) {
        await withTimeout(this.playDuel(event), 7500);
      } else {
        await withTimeout(this.board.playMove(this.jieqi.board, event));
      }
      this.afterMove(event);
      if (await this.finishIfOver()) return;
      if (this.jieqi.sideToMove === this.ai) await this.runAi();
    } catch (error) {
      // A dropped move must never wedge the game: reconcile and let the player try again.
      this.applyFog();
      this.board.reconcile(this.jieqi.board);
      this.vm.status.value = byPlayer ? '这一步走不了，请另选一步' : '对手走子异常';
      throw error;
    } finally {
      this.refreshDanger();
      this.leave();
    }
  }

  /**
   * Tells the player that moving to the tapped square would 送将 — expose their own general.
   *
   * The move is *not* in the legal list the board offered (a legal move never leaves the general
   * attacked), so it is refused here by name, the way 禁止循环追棋 is — a player who taps and gets
   * nothing back has no way to tell a rule from a bug. The selection is left standing.
   */
  private refuseCheckGiveaway(): void {
    this.vm.status.value = '移动会送将：这一步会让己方将帅暴露在攻击之下，不能走';
    const now = this.time.now;
    if (now - this.lastRefusalAt < 900) return;
    this.lastRefusalAt = now;
    this.audio.play('omen');
    void banner(this, '移动会送将', '请另选一步', C.check, { holdMs: 760 });
  }

  /**
   * Tells the player that 禁止循环追棋 is what stopped their move.
   *
   * Says *why* as well as *what*: "禁止循环追棋" on its own is a rule name, and the thing the player
   * needs to know is which mistake they are making — walking the position back to one it has already
   * been in twice, which is exactly what a perpetual chase would do. The selection is deliberately left
   * standing: the piece is still picked up, so the player can simply choose another square.
   */
  private refuseRepeat(byPlayer: boolean): void {
    if (!byPlayer) {
      // The engine's own moves are filtered before they are ever chosen, so reaching here means a bug —
      // say so instead of pretending the computer obeyed the rule.
      this.vm.status.value = '对手的着法被禁止循环追棋拦下（内部错误）';
      return;
    }
    this.vm.status.value = '禁止循环追棋：这一步会让局面重复循环，请另选一步';
    // The selection stays up, so the same forbidden square is one tap away from being tried again. One
    // banner per refusal, not one per tap: the reason is already on screen.
    const now = this.time.now;
    if (now - this.lastRefusalAt < 900) return;
    this.lastRefusalAt = now;
    this.audio.play('omen');
    void banner(this, '禁止循环追棋', '局面重复 · 请另选一步', C.danger, { holdMs: 760 });
  }

  /**
   * Tells the player that 禁止立即吃将 is what stopped their move.
   *
   * 混斗 only: the piece they just picked up was handed to them by the *opponent's* flip and is checking
   * the opponent's general — taking that general on the spot would end the game before the flipped side
   * got a single turn to answer. The rule gives them that turn, so this tap is refused by name. The
   * selection stays up, like 禁止循环追棋.
   */
  private refuseEatGeneral(byPlayer: boolean): void {
    if (!byPlayer) {
      this.vm.status.value = '对手的着法被禁止立即吃将拦下（内部错误）';
      return;
    }
    this.vm.status.value = '禁止立即吃将：翻出的敌方棋子这一手不能直接吃将，请先解将';
    const now = this.time.now;
    if (now - this.lastRefusalAt < 900) return;
    this.lastRefusalAt = now;
    this.audio.play('omen');
    void banner(this, '禁止立即吃将', '请先解将 · 另选一步', C.check, { holdMs: 760 });
  }

  /**
   * 迷雾 一骑讨 (rule F6): the whole spectacle of a king flying at the enemy king.
   *
   * Sequence (user 2026-09-15): banner 一骑讨！ → the file between the generals is revealed (the mist
   * lifts, the hidden pieces on it surface) → the king charges with a golden aura. A clear run takes
   * the enemy general and wins; a blocker is hit and the charging king dies. Either way the game is
   * over, and `finishIfOver` lands the 胜/负 verdict afterwards.
   */
  private async playDuel(event: MoveEvent): Promise<void> {
    const duel = event.duel as DuelInfo;
    this.audio.play('check');
    const duelBanner = banner(this, '一骑讨！', '将帅对决 · 一决生死', C.gold, { holdMs: 800 });
    // The reveal is the second beat: let the banner slam in, then lift the mist off the file so the
    // player sees the field the king is about to charge into.
    await new Promise<void>((resolve) => this.time.delayedCall(400, resolve));
    const revealSet = new Set<number>(this.fogVisible);
    for (const sq of duel.line) revealSet.add(sq);
    this.board.setFog(revealSet);
    this.board.reconcile(this.jieqi.board);
    await duelBanner;
    await this.board.playDuelCharge(this.jieqi.board, event);
  }

  private afterMove(event: MoveEvent): void {
    // 迷雾 一骑讨 (rule F6): the duel's animation already told the whole story — the reveal showed
    // the file, the charge showed who fell. The status line closes it; nothing else needs announcing
    // (a duel always ends the game, so the victory/defeat banner follows immediately).
    if (event.duel) {
      this.visiblePlies.push(true);
      this.syncVm();
      this.board.setLastMove(event.move);
      this.vm.status.value = event.duel.won
        ? '一骑讨成功，直取敌帅！'
        : '一骑讨失败，将帅阵亡';
      return;
    }
    // 迷雾: a move played where the player cannot see it — the to-square is outside their vision —
    // is announced with one neutral line and nothing else. No notation (it would name the square the
    // piece went to), no 翻出X (the flip happened in the mist), no capture name; the log row is
    // suppressed by the same flag in `syncVm`.
    const visible = !this.fogMode || this.fogVisible.has(event.move.to);
    this.visiblePlies.push(visible);
    this.syncVm();
    if (!visible) {
      // The player saw nothing of the move — and in the worst case the whole visible board is
      // unchanged, in which case this announcement is the *only* thing telling them the opponent
      // played at all. Saying so out loud is therefore mandatory, not optional — and it is said as
      // loudly as 将军 (user 1.5.2): banner + wash + cue sound, so a glance catches it even when the
      // board shows no change at all.
      this.vm.status.value = '对方已落子（迷雾中，看不清具体走法）';
      // No last-move marker either: drawing the from/to squares of a move the player cannot see
      // would hand them the very square the fog is hiding (user 1.5.6).
      this.board.setLastMove(null);
      if (!this.jieqi.result) {
        this.audio.play('place');
        screenWash(this, C.fog, 0.14);
        void banner(this, '对方已落子', '迷雾中 · 看不清具体走法', C.fog, { holdMs: 880 });
      }
      this.announceCheck();
      return;
    }
    const parts: string[] = [`${event.color === 'red' ? '红' : '黑'} ${event.notation}`];
    if (event.wasHidden && event.revealedKind) {
      // The face is named by what the piece *is*, not by who moved it: 混斗 can turn a mover's 暗兵
      // into the opponent's 卒, and calling that a 兵 would be the board lying about its own picture.
      const revealed = event.revealedColor ?? event.color;
      const name = KIND_NAME[revealed][event.revealedKind];
      if (this.jieqi.mode !== 'mixed') parts.push(`翻出${name}`);
      else if (revealed === event.color) parts.push(`翻出己方${name}`);
      else parts.push(`翻出敌方${name} · 易主`);
    }
    if (event.captured) {
      // Rule R7 per observer: name the kind only when the player is entitled to it — the piece was
      // face up in front of everybody, or the player is the capturer who turned it over. The loser of
      // a face-down piece must not learn what their own 暗子 was, so that capture reads 吃暗子.
      parts.push(captureLabel(event.captured, this.player, event.color));
    }
    this.vm.status.value = parts.join(' · ');
    this.board.setLastMove(event.move);
    // 混斗 only: the piece the player just played was not theirs. Said out loud, because the picture —
    // a 卒 appearing in red's half — is easy to miss, and what it means is not: the piece is the
    // opponent's from here on. The computer's own hand-overs are left to the status line, so the
    // banner stays something the player only ever sees about their own moves.
    const handedOver =
      event.wasHidden && event.revealedColor !== null && event.revealedColor !== event.color;
    if (handedOver && !event.selfCheck && event.color === this.player && event.revealedKind) {
      const gone = KIND_NAME[event.revealedColor as Color][event.revealedKind];
      void banner(this, '易 主', `${gone}已归${COLOR_NAME[event.revealedColor as Color]}`, C.gold, {
        holdMs: 700,
      });
    }
    // 混斗 only: the piece just handed itself to the opponent and is checking the side that moved it.
    // Announced ahead of the ordinary 将军, because it is the more surprising of the two — and the
    // general it points at is the *mover's*, not the side to move.
    if (event.selfCheck) {
      this.announceSelfCheck(event);
      return;
    }
    this.announceCheck();
  }

  /**
   * 反将自身 — a reveal that handed the opponent a check on the side that played it.
   *
   * Only 混斗 can produce this (rule M4): the piece stood on the mover's half, so it was the mover's to
   * move, but it turned out to belong to the opponent and it now attacks the general of the side that
   * has just played it. The move stands — that bet is what the mode is made of — and the board says so,
   * because a 将军 glow with no explanation on the wrong side of the board reads as a bug.
   */
  private announceSelfCheck(event: MoveEvent): void {
    const kingSquare = this.jieqi.board.kingSq[event.color];
    this.board.setCheckSquare(kingSquare >= 0 ? kingSquare : null);
    const loser = COLOR_NAME[event.color];
    this.vm.status.value = `${loser}翻出的棋子归对方所有，反被将军！`;
    if (this.jieqi.result) return;
    this.audio.play('check');
    screenWash(this, C.check, 0.18);
    const mine = event.color === this.player;
    void banner(this, '反 将', mine ? '翻出敌方棋子 · 请解将' : '电脑翻出敌子 · 反将自身', C.check, {
      holdMs: 760,
    });
  }

  /** Flashes the banner and highlights the general when somebody is in check. */
  private announceCheck(): void {
    if (this.jieqi.result) return;
    const side = this.jieqi.sideToMove;
    if (!this.jieqi.inCheck(side)) {
      this.board.setCheckSquare(null);
      return;
    }
    const kingSquare = this.jieqi.board.kingSq[side];
    // 迷雾 (rule F5): a check only announces when the player can see a checking piece. A general
    // attacked by a piece hidden in the mist is a check the player cannot attribute, so neither the
    // glow, the status nor the banner says anything — the fog keeps its own secrets.
    const visible = this.isCheckVisible(side);
    this.board.setCheckSquare(visible && kingSquare >= 0 ? kingSquare : null);
    if (!visible) return;
    this.vm.status.value = `${side === 'red' ? '红方' : '黑方'}被将军！`;
    this.audio.play('check');
    screenWash(this, C.check, 0.18);
    // Who is being told to answer: the player, or the computer that just put them in check.
    const mine = side === this.player;
    void banner(this, '将 军', mine ? '请解将' : '电脑将军', C.check, { holdMs: 620 });
  }

  /** Shows the endgame banner if the game is over. Returns true when it is. */
  private async finishIfOver(): Promise<boolean> {
    const result = this.jieqi.result;
    if (!result) return false;
    this.clearSelection();
    this.clearDanger();
    this.board.setCheckSquare(null);
    this.syncVm();
    this.vm.status.value = result.text;

    const playerWon = result.winner === this.player;
    const colour = result.winner === null ? C.gold : playerWon ? C.jade : C.check;
    // A drawn game has no dedicated track — the game music keeps playing and only the draw sting
    // announces it. A win or a loss switches the whole loop to the state's own track, which is the
    // ending's music, so the one-shot victory sting is skipped rather than played over it.
    if (result.winner === null) {
      this.audio.play('draw');
    } else {
      this.audio.setBgm(playerWon ? 'win' : 'lose');
    }
    petalFall(this, playerWon ? 54 : 26);
    await banner(
      this,
      result.winner === null ? '和 棋' : playerWon ? '胜' : '负',
      result.text,
      colour,
      { holdMs: 1500 },
    );
    // 对局结束，棋盘不再是秘密。Deliberately *after* the banner rather than under it: the reveal is the
    // second beat of the ending — the result first, then what was actually on the board all along. The
    // status line says so, because dimmed pieces with no explanation read as a rendering fault. In 迷雾
    // the fog lifts in the same breath: the whole board — every piece, every flip — becomes the record.
    this.board.revealHidden(this.jieqi.board);
    this.board.setFog(null);
    this.vm.status.value = `${result.text} · 所有暗子已翻开`;
    return true;
  }

  /** One AI turn: sample worlds (yielding between them), pick a move, play it. */
  private async runAi(): Promise<void> {
    if (this.jieqi.result || this.jieqi.sideToMove !== this.ai) return;
    this.enter();
    this.clearDanger();
    this.vm.thinking.value = true;
    this.vm.thinkingProgress.value = 0;
    try {
      const decision = await chooseMoveAsync(
        this.jieqi,
        { difficulty: this.vm.difficulty.value, seed: randomSeed() ^ (this.aiNonce += 0x9e37) },
        (done, total) => {
          this.vm.thinkingProgress.value = total === 0 ? 1 : done / total;
        },
      );
      // `null` means the AI's fogged view offers nothing at all — a dead position rather than a move
      // to force through.
      if (!decision) {
        this.jieqi.computeResult();
        await this.finishIfOver();
        return;
      }
      // 迷雾: the decision is legal on the AI's *fogged* view, but the real board may refuse it — an
      // unseen piece blocks the path, or the real position checks the AI in a way it cannot see. Walk
      // the scored candidates until the real board accepts one; only if none do, fall back to the real
      // move list, and only then treat the position as dead. A blocked probe is a wasted turn, never a
      // loss the AI did not know it was taking.
      let chosen: Move | null = decision.move;
      if (!this.jieqi.isSelectable(chosen)) {
        chosen =
          decision.candidates.find((candidate) => this.jieqi.isSelectable(candidate.move))?.move ??
          this.jieqi.selectableMoves()[0] ??
          null;
      }
      if (!chosen || !this.jieqi.isSelectable(chosen)) {
        this.jieqi.computeResult();
        await this.finishIfOver();
        return;
      }
      const event = this.jieqi.apply(chosen);
      this.applyFog();
      if (event.duel) {
        await withTimeout(this.playDuel(event), 7500);
      } else {
        await withTimeout(this.board.playMove(this.jieqi.board, event));
      }
      this.afterMove(event);
      await this.finishIfOver();
    } finally {
      this.vm.thinking.value = false;
      this.vm.thinkingProgress.value = 0;
      this.refreshDanger();
      this.leave();
    }
  }

  // ---------------------------------------------------------------------------------------------
  // HUD actions
  // ---------------------------------------------------------------------------------------------

  /**
   * The strength of the opponent — and 吃子提示, which is the same dialog.
   *
   * The same dialog the start menu opens, so "困难" means one thing in both places; the choice is
   * persisted by the dialog's callback and applied to the *next* search, which is what makes it safe to
   * change while the computer is thinking. The checkbox is different in one way: it describes the
   * picture, not the engine, so it takes effect on the spot.
   */
  private openDifficultyDialog(): void {
    if (this.locked) return;
    openDifficultyDialog(
      this.mvvm,
      this.vm.difficulty.value,
      (value) => {
        this.vm.difficulty.value = value;
        saveDifficulty(value);
        this.vm.status.value = `难度：${DIFFICULTY_LABEL[value]}（${DIFFICULTY[value].worlds} 个世界 · 深度 ${DIFFICULTY[value].depth}）`;
      },
      {
        value: this.vm.captureHint.value,
        onToggle: (on) => {
          this.vm.captureHint.value = on;
          saveCaptureHint(on);
          this.refreshDanger();
          this.vm.status.value = on ? '吃子提示：开（我方红光，敌方绿光）' : '吃子提示：关';
        },
      },
    );
  }

  /**
   * ？ — the current mode's rules, in a scrollable dialog.
   *
   * The same content the start menu's 玩法 dialog hints at, in full: the board asks "what am I
   * playing?" and the dialog answers with that mode's actual rules, not a one-liner.
   */
  private openModeHelp(): void {
    if (this.locked) return;
    openModeHelpDialog(this.mvvm, this.vm.mode.value);
  }

  /**
   * 菜单 — end this match and go back to the title screen.
   *
   * Leaves through the same door as {@link redraw}; what differs is only where the fade lands.
   */
  backToMenu(): void {
    this.leaveBoard('start');
  }

  /**
   * 新局 — end this match and **draw again**.
   *
   * Not "reshuffle and keep your colour": the side you play is the one thing in this game that is not
   * decided by the board, so a new match has to decide it again. The board hands back to the 定先后
   * screen — the same scene the menu's 开始游戏 reaches, running the same animation — and comes back
   * with whatever that draw says, which may well be the other colour.
   */
  redraw(): void {
    this.leaveBoard('draw');
  }

  /** Fades out and hands the screen to `key`, stopping this scene. */
  private leaveBoard(key: 'start' | 'draw'): void {
    this.audio.play('click');
    this.cameras.main.fadeOut(280, 0, 0, 0);
    this.cameras.main.once(Phaser.Cameras.Scene2D.Events.FADE_OUT_COMPLETE, () => {
      // 新局 redraws the colour but not the rules: the mode is a decision about the game, and coming
      // back through 定先后 should not quietly change it back to 标准. 菜单 → 开始游戏 asks again.
      this.scene.start(key, key === 'draw' ? { mode: this.vm.mode.value } : undefined);
    });
  }

  /** Takes back the player's last move together with the AI's reply. */
  async undo(): Promise<void> {
    if (this.locked || this.jieqi.result || this.jieqi.ply === 0) return;
    this.enter();
    this.clearDanger();
    let toAi = false;
    try {
      this.clearSelection();
      // Taking a move back means rewinding to *your* turn: if it is yours already, the computer's reply
      // and your own move both have to go. The same two steps are right whichever colour you drew.
      const steps = this.jieqi.sideToMove === this.player ? 2 : 1;
      for (let i = 0; i < steps; i++) {
        const event = this.jieqi.undo();
        if (!event) break;
        // Each undone ply forfeits its visibility record, so the log agrees with the replayed board.
        this.visiblePlies.pop();
        await withTimeout(this.board.playUndo(this.jieqi.board, event));
      }
      // 迷雾: fog first, then reconcile — the piece views' visibility is applied against the fog of
      // the position we are rewinding *to*, not the one we just left.
      this.applyFog();
      this.board.reconcile(this.jieqi.board);
      this.board.setLastMove(null);
      // Same visibility gate as `announceCheck`: no glow around a check the player cannot see.
      const checked = this.jieqi.inCheck(this.jieqi.sideToMove)
        ? this.jieqi.board.kingSq[this.jieqi.sideToMove]
        : -1;
      this.board.setCheckSquare(
        checked >= 0 && this.isCheckVisible(this.jieqi.sideToMove) ? checked : null,
      );
      this.syncVm();
      this.vm.status.value = '已悔棋';
      this.audio.play('undo');
      // Undoing the computer's opening move leaves the computer to move again — a player who drew 黑
      // would otherwise sit in front of a board that is waiting for nobody.
      toAi = !this.jieqi.result && this.jieqi.sideToMove === this.ai;
    } finally {
      this.refreshDanger();
      this.leave();
    }
    if (toAi) await this.runAi();
  }

  /** Asks the engine for a suggestion and flashes it on the board. */
  async showHint(): Promise<ScoredMove[]> {
    if (this.locked || this.jieqi.result || this.jieqi.sideToMove !== this.player) return [];
    this.enter();
    try {
      this.vm.status.value = '正在计算…';
      const candidates = analyse(this.jieqi, {
        difficulty: 'normal',
        seed: randomSeed(),
        nodeBudget: 90_000,
      });
      // 迷雾: never suggest a move whose destination the player cannot see — the notation would name
      // the very square the mist is hiding.
      const best = this.fogMode
        ? candidates.find((candidate) => this.fogVisible.has(candidate.move.to))
        : candidates[0];
      if (!best) return [];
      this.board.setSelection(best.move.from);
      this.board.setLegalTargets([{ square: best.move.to }]);
      this.selected = best.move.from;
      this.legalForSelected = this.jieqi
        .legalMoves(this.player)
        .filter((move) => move.from === best.move.from);
      this.vm.status.value = `建议：${best.notation}（评分 ${Math.round(best.score)}）`;
      return candidates;
    } finally {
      this.leave();
    }
  }

  resign(): void {
    if (this.jieqi.result) return;
    this.enter();
    this.jieqi.resign(this.player);
    this.clearSelection();
    this.syncVm();
    void this.finishIfOver().finally(() => this.leave());
  }

  /**
   * The mixer — the shared dialog, so the board and the menu offer the same one.
   *
   * A drag is heard while it happens: the music channel immediately, the effects channel on the next
   * cue (and on the short preview the slider fires, so "is this too quiet?" has an answer without
   * leaving the dialog).
   */
  openVolumeDialog(): void {
    if (this.locked) return;
    openVolumeDialog(this.mvvm, this.audio);
  }

  /** A yes/no dialog, built with the DSL and hosted by the plugin's modal stack. */
  private confirm(title: string, body: string, onYes: () => void): void {
    if (this.locked) return;
    this.mvvm.modal.open(
      () => {
        Panel({ variant: 'surface', radius: 12, padding: 16, width: 300, gap: 12 }, () => {
          Text(title, { size: 'lg' });
          Text(body, { size: 'sm', tone: 'muted' });
          Row({ gap: 8, justifyContent: 'end', width: 'fill' }, () => {
            Button('取消', {
              variant: 'ghost',
              size: 'sm',
              // Named so an acceptance run can press them with a real mouse click, like every other
              // control in the game.
              name: 'confirmCancel',
              onClick: this.tap(() => this.mvvm.modal.closeTop()),
            });
            Button('确定', {
              variant: 'primary',
              size: 'sm',
              name: 'confirmOk',
              onClick: this.tap(() => {
                this.mvvm.modal.closeTop();
                onYes();
              }),
            });
          });
        });
      },
      { name: 'confirm', scrim: 0.6 },
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Probes for the acceptance backdoor
  // ---------------------------------------------------------------------------------------------

  get engine(): JieqiGame {
    return this.jieqi;
  }

  /** The colour the draw handed the player. */
  get playerColor(): Color {
    return this.player;
  }

  /** The colour the computer plays. */
  get aiColor(): Color {
    return this.ai;
  }

  /** 标准 or 混斗 — what this match was dealt as. */
  get gameMode(): GameMode {
    return this.vm.mode.value;
  }

  get isBusy(): boolean {
    return this.locked || this.vm.thinking.value;
  }

  get selection(): number | null {
    return this.selected;
  }

  squarePoint(square: number): { x: number; y: number } {
    return this.board.squareToScene(square);
  }

  squaresUnderAttack(color: Color): number[] {
    const out: number[] = [];
    for (let sq = 0; sq < 90; sq++) if (isSquareAttacked(this.jieqi.board, sq, color)) out.push(sq);
    return out;
  }

  /**
   * The squares 吃子提示 is currently ringing, as `{ own, foe }` square lists.
   *
   * Answers from the same predicate the overlay draws from, so an acceptance run reads the rule rather
   * than a screenshot of it — and reads it whether or not the checkbox is on, which is what lets the two
   * be compared.
   */
  dangerSquares(): { own: number[]; foe: number[] } {
    const board = this.dangerBoard();
    return {
      own: hangingSquares(board, this.player),
      foe: hangingSquares(board, this.ai),
    };
  }

  /** 迷雾 state the acceptance backdoor reads: how many squares the board is actually fogging. */
  get fogTileCount(): number {
    return this.board.fogTileCount;
  }

  /** True while this match is 迷雾. */
  get isFogMode(): boolean {
    return this.jieqi.mode === 'fog';
  }

  /** How many rings the board is actually drawing right now. */
  get dangerMarkCount(): number {
    return this.board.dangerMarkCount;
  }

  /** 吃子提示 on/off, through the same setter the dialog's checkbox uses. */
  get captureHint(): boolean {
    return this.vm.captureHint.value;
  }

  setCaptureHint(on: boolean): void {
    this.vm.captureHint.value = on;
    saveCaptureHint(on);
    this.refreshDanger();
  }

  /** Every legal move of the side to move, split by whether 禁止循环追棋 allows it. */
  repetitionProbe(): { allowed: string[]; forbidden: string[] } {
    const label = (move: Move): string => `${move.from}-${move.to}`;
    const allowed: string[] = [];
    const forbidden: string[] = [];
    for (const move of this.jieqi.legalMoves()) {
      (this.jieqi.wouldRepeat(move) ? forbidden : allowed).push(label(move));
    }
    return { allowed, forbidden };
  }

  /**
   * True once the turn loop is idle and the pieces have stopped moving — what an acceptance run waits
   * on. Deliberately *not* "zero tweens": the pulsing move hints and the check glow never end, and the
   * sparks from a capture legitimately outlive the move that threw them.
   */
  get settled(): boolean {
    return !this.isBusy && !this.board.animating;
  }

  /** Diagnostic only: how many tweens the scene is carrying right now, decorations included. */
  get tweenCount(): number {
    return this.tweens.getTweens().length;
  }

  /** Waits for `settled`, or gives up after `ms` so a stuck tween cannot hang the harness. */
  async settle(ms = 10000): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (this.settled) return true;
      await new Promise<void>((resolve) => setTimeout(resolve, 40));
    }
    return this.settled;
  }

  /** Plays one ply with the AI *for whichever side is to move* — the self-play the harness drives. */
  async playAiPly(difficulty: Difficulty = 'easy'): Promise<boolean> {
    if (this.locked || this.jieqi.result) return false;
    if (this.jieqi.sideToMove === this.ai) {
      await this.runAi();
      return true;
    }
    const decision = await chooseMoveAsync(
      this.jieqi,
      { difficulty, seed: randomSeed() ^ (this.aiNonce += 0x85eb) },
      () => undefined,
    );
    if (!decision) return false;
    await this.play(decision.move, false);
    return true;
  }
}
