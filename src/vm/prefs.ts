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

const STORAGE_KEY = 'jieqi.prefs.v1';
const HINT_KEY = 'jieqi.hints.v1';

export const DEFAULT_DIFFICULTY: Difficulty = 'normal';

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
