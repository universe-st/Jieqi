/**
 * Which of the three screens is on show.
 *
 * Phaser can answer "is scene X running?" but not "which one is the player looking at": a hand-over has
 * two scenes running for the length of a cross fade, and the outgoing one is still perfectly alive while
 * the incoming one fades up. Anything that has to be right at that boundary — the acceptance backdoor's
 * `screen()`, and every board query that must refuse to answer while the menu is up — needs the answer
 * to be a value rather than an inference.
 *
 * So each scene declares itself at the top of `create()`, which is the exact frame its picture is
 * mounted. That also gives the answer *before* a scene's own state exists (`GameScene` has no engine
 * until it deals), so "which screen" and "is this screen ready" stay separate questions.
 *
 * Deliberately not a Phaser `Registry` entry: this is scene bookkeeping, not game state, and it must be
 * readable from the debug backdoor without knowing anything about the scene tree.
 */

export type ScreenName = 'start' | 'draw' | 'game';

let current: ScreenName | null = null;

/** Called by a scene as it mounts. */
export function announceScreen(name: ScreenName): void {
  current = name;
}

/** The screen on show, or `null` before the first one has mounted. */
export function currentScreen(): ScreenName | null {
  return current;
}
