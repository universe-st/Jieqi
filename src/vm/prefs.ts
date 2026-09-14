/**
 * Preferences that outlive a match — and a page reload.
 *
 * Deliberately separate from the `AudioDirector`, which owns its own store: the mixer has to be
 * readable *before* any scene exists (the menu shows it) and the difficulty has to be readable by the
 * ViewModel that the board is built from. One `localStorage` key each keeps both of them honest about
 * what they own, and neither has to import the other.
 *
 * Storage can fail in both directions on a phone — private browsing throws on write, and a value can
 * come back as anything at all after a version change — so both ends are guarded and anything
 * unreadable falls back to the default rather than to `undefined`.
 */

import type { Difficulty } from '../ai';
import type { GameMode } from '../core/types';

const STORAGE_KEY = 'jieqi.prefs.v1';
const HINT_KEY = 'jieqi.hints.v1';
const MODE_KEY = 'jieqi.mode.v1';

export const DEFAULT_DIFFICULTY: Difficulty = 'normal';

/**
 * 标准玩法 is the default, and the safe one: 混斗 changes what a 暗子 *is* — the same square can hand
 * either side a piece — so it is a choice a player makes at 开始游戏 rather than something the board
 * springs on them. It is remembered once made, because a player who wants 混斗 wants it every time.
 */
export const DEFAULT_MODE: GameMode = 'standard';

export function isGameMode(value: unknown): value is GameMode {
  return value === 'standard' || value === 'mixed';
}

/**
 * The way to play, stored under its own key for the same reason 吃子提示 is: one key per setting means
 * the difficulty's writer cannot silently drop the mode, and vice versa.
 */
export function loadMode(): GameMode {
  try {
    const raw = localStorage.getItem(MODE_KEY);
    if (!raw) return DEFAULT_MODE;
    const parsed = JSON.parse(raw) as { mode?: unknown };
    return isGameMode(parsed.mode) ? parsed.mode : DEFAULT_MODE;
  } catch {
    return DEFAULT_MODE;
  }
}

export function saveMode(value: GameMode): void {
  try {
    localStorage.setItem(MODE_KEY, JSON.stringify({ mode: value }));
  } catch {
    // As everywhere else here: a preference that cannot be saved must not stop a game.
  }
}

/**
 * 吃子提示 defaults to **off**.
 *
 * It is an aid, not a rule: it hands the player a reading of a position that a stronger player would
 * simply calculate, so it stays a thing you turn on rather than a thing the board decides to tell you.
 * The default also has to be a *stable* answer — a fresh install, a corrupted store and a store that
 * cannot be read all land here.
 */
export const DEFAULT_CAPTURE_HINT = false;

/** The order the difficulty dialog lists them in, weakest first. */
export const DIFFICULTIES: readonly Difficulty[] = ['easy', 'normal', 'hard'];

export function isDifficulty(value: unknown): value is Difficulty {
  return value === 'easy' || value === 'normal' || value === 'hard';
}

export function loadDifficulty(): Difficulty {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_DIFFICULTY;
    const parsed = JSON.parse(raw) as { difficulty?: unknown };
    return isDifficulty(parsed.difficulty) ? parsed.difficulty : DEFAULT_DIFFICULTY;
  } catch {
    // No store, a corrupt store, or a quota error reading it: the default level is always playable.
    return DEFAULT_DIFFICULTY;
  }
}

export function saveDifficulty(value: Difficulty): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ difficulty: value }));
  } catch {
    // A preference that cannot be saved is not a reason to interrupt play.
  }
}

/**
 * 吃子提示 — whether the board marks the pieces that can be taken for free.
 *
 * Stored under its own key rather than beside the difficulty, because the two are written by different
 * moments of the same dialog: a `saveDifficulty` that rewrote a shared blob would silently drop the
 * checkbox, and vice versa. One key per setting is the cheapest way for neither writer to be able to
 * break the other.
 */
export function loadCaptureHint(): boolean {
  try {
    const raw = localStorage.getItem(HINT_KEY);
    if (!raw) return DEFAULT_CAPTURE_HINT;
    const parsed = JSON.parse(raw) as { captureHint?: unknown };
    return typeof parsed.captureHint === 'boolean' ? parsed.captureHint : DEFAULT_CAPTURE_HINT;
  } catch {
    // Same three failures as the difficulty, same answer: unbeatable defaults.
    return DEFAULT_CAPTURE_HINT;
  }
}

export function saveCaptureHint(value: boolean): void {
  try {
    localStorage.setItem(HINT_KEY, JSON.stringify({ captureHint: value }));
  } catch {
    // As above: a setting that cannot be persisted must not stop the game.
  }
}
