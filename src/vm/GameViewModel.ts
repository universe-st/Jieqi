/**
 * The ViewModel: plain data plus `ref`s, no Phaser, no widget references.
 *
 * The scene writes these fields and the HUD reads them, which is what keeps the view declarative — the
 * layout code never has to go and find a widget to poke. Everything here is *public* information only:
 * the trays deliberately record an unknown identity as 暗 rather than filling in what the engine knows.
 *
 * Since the draw can hand the player either colour, "player" and "computer" are the axes the HUD is
 * built on and 红/黑 are only how those two sides are painted. That is why the tray fields are named
 * after their owner rather than their colour: naming them `redTray`/`blackTray` was correct only while
 * the player was always red.
 */

import { computed, ref } from '@phaser-mvvm/core';
import type { Difficulty } from '../ai';
import type { GameResult } from '../core/rules';
import { FIRST_MOVER, COLOR_NAME, other, type Color } from '../core/types';
import type { CapturedChip } from './tray';

export interface MoveLogRow {
  key: string;
  index: number;
  color: Color;
  notation: string;
}

export const DIFFICULTY_LABEL: Record<Difficulty, string> = {
  easy: '简单',
  normal: '普通',
  hard: '困难',
};

export class GameViewModel {
  /** The colour the player drew — 帅 (red) or 将 (black). Set once, before the deal. */
  readonly player = ref<Color>(FIRST_MOVER);
  /** The other one. Derived, so the two can never disagree. */
  readonly ai = computed<Color>(() => other(this.player.value));
  /** Whose turn it is. */
  readonly turn = ref<Color>(FIRST_MOVER);
  /** One line under the board: hints, check announcements, results. */
  readonly status = ref('');
  /** True while the AI is searching — drives the thinking indicator. */
  readonly thinking = ref(false);
  /** 0…1 progress through the AI's sampled worlds, for the thinking bar. */
  readonly thinkingProgress = ref(0);
  readonly difficulty = ref<Difficulty>('normal');
  /**
   * 吃子提示 — mark the pieces that can be taken for free (our own in red, the opponent's in green).
   *
   * A view setting, not a rule: nothing in `src/core` reads it, and the board is asked for the marks
   * only while it is on.
   */
  readonly captureHint = ref(false);
  readonly moves = ref<MoveLogRow[]>([]);
  /** Chips in the player's tray — pieces of the computer's colour that the player has taken. */
  readonly playerTray = ref<CapturedChip[]>([]);
  /** Chips in the computer's tray — pieces of the player's colour that the computer has taken. */
  readonly aiTray = ref<CapturedChip[]>([]);
  readonly result = ref<GameResult | null>(null);
  readonly hint = ref('');
  /** True while an animation or a search is in flight; the buttons and the board go dead. */
  readonly busy = ref(false);

  readonly difficultyLabel = computed(() => DIFFICULTY_LABEL[this.difficulty.value]);
  readonly turnLabel = computed(() => (this.turn.value === 'red' ? '红方行棋' : '黑方行棋'));
  /** Who the two panels are about. Colour-dependent, because the player's colour is drawn, not fixed. */
  readonly playerName = computed(() => `你 · ${COLOR_NAME[this.player.value]}`);
  readonly aiName = computed(() => `电脑 · ${COLOR_NAME[this.ai.value]}`);
  /** 先行 / 后行, from the player's point of view. */
  readonly seatLabel = computed(() =>
    this.player.value === FIRST_MOVER ? '先行' : '后行',
  );
  /** How many pieces each side has taken, for the label beside the tray. */
  readonly playerTrayCount = computed(() => this.playerTray.value.length);
  readonly aiTrayCount = computed(() => this.aiTray.value.length);
  readonly finished = computed(() => this.result.value !== null);
  readonly canUndo = computed(
    () => !this.busy.value && this.moves.value.length > 0 && !this.finished.value,
  );
  /** The player may act when it is their turn and nothing is animating. */
  readonly canAct = computed(
    () => !this.busy.value && this.turn.value === this.player.value && !this.finished.value,
  );
  readonly isPlayersTurn = computed(() => this.turn.value === this.player.value);
  readonly thinkingText = computed(() =>
    this.thinking.value
      ? `思考中 ${Math.round(this.thinkingProgress.value * 100)}%`
      : this.finished.value
        ? '对局结束'
        : this.turnLabel.value,
  );

  /** Sets the drawn colour. Called before the board is dealt, so nothing has to be rebuilt. */
  setPlayer(color: Color): void {
    this.player.value = color;
  }

  /**
   * What the status line says when nobody has moved yet.
   *
   * 红先黑后 means it is only "your move" when you *are* red; when the draw gave the player 将, the
   * board opens with the computer thinking, and saying "红方先行，请落子" there would be a lie the player
   * can see through on the first frame.
   */
  private turnNotice(): string {
    if (this.turn.value === this.player.value) return `${COLOR_NAME[this.turn.value]}先行，请落子`;
    return `电脑执${COLOR_NAME[this.turn.value]}先行…`;
  }

  reset(status?: string): void {
    this.turn.value = FIRST_MOVER;
    this.status.value = status ?? this.turnNotice();
    this.thinking.value = false;
    this.thinkingProgress.value = 0;
    this.moves.value = [];
    this.playerTray.value = [];
    this.aiTray.value = [];
    this.result.value = null;
    this.hint.value = '';
    this.busy.value = false;
  }

  pushMove(row: MoveLogRow): void {
    this.moves.value = [...this.moves.value, row];
  }
}
