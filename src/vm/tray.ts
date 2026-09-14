/**
 * The captured-piece trays, as data.
 *
 * This is the one place that decides what a tray is allowed to show, and it is deliberately a pure
 * function over the move list rather than a method on the scene: the rule has three branches and they
 * are the whole feature, so they belong somewhere a test can drive directly.
 *
 * The rule (R7 read carefully — 己方暗子被吃后，自己是不能看到暗子是什么棋):
 *
 * | how the piece left the board            | what the losing side's tray shows |
 * | --------------------------------------- | --------------------------------- |
 * | face up, in front of everybody          | the real face, solid              |
 * | face down, **taken by the viewer**      | the real face, half transparent   |
 * | face down, **taken by the opponent**    | a face-down piece — identity hidden |
 *
 * The middle row is the part that is easy to get wrong: the rule stops the *loser* from looking, but
 * the capturer turned the piece over in their hand.
 *
 * The last row is a rule about *time* rather than about sides, and it is the one exception: while the
 * match is running, the loser's tray keeps its face-down chips face down; once it is over,
 * {@link TrayOptions.revealHidden} turns them all up (dimmed), which is the tray's half of the same
 * endgame reveal the board does with its remaining 暗子.
 */

import type { CapturedInfo, MoveEvent } from '../core/rules';
import { KIND_NAME, type Color, type Kind, other } from '../core/types';

export interface CapturedChip {
  key: string;
  /** Colour of the piece that was taken, i.e. the side that lost it. */
  color: Color;
  /** The identity to draw, or `null` for a chip that must be shown face down. */
  kind: Kind | null;
  /** Draw the face half-transparent, because the viewer took this one while it was still hidden. */
  dimmed: boolean;
}

/**
 * Builds the tray of pieces taken **from** `capturedColor`, as `viewer` should see it.
 *
 * The tray belongs to whoever did the capturing, which is always `other(capturedColor)` — so the
 * viewer is either the capturer (and gets to see hidden captures) or the loser (and does not).
 *
 * `revealHidden` lifts the last row of that table once the match is over: R7 stops the *loser* from
 * having a look while there is still a game to play, and there is nothing left to protect after the
 * result. Same argument as the board turning its remaining 暗子 over — and the chip that comes back is
 * the dimmed one, which is already the tray's way of saying "this was taken face down".
 */
export interface TrayOptions {
  /** Show the identity of pieces that were captured while face down, whatever the viewer's side. */
  revealHidden?: boolean;
}

export function trayChips(
  events: readonly MoveEvent[],
  viewer: Color,
  capturedColor: Color,
  options: TrayOptions = {},
): CapturedChip[] {
  const capturer = other(capturedColor);
  const viewerIsCapturer = capturer === viewer;
  const revealed = options.revealHidden === true;
  const chips: CapturedChip[] = [];
  let index = 0;
  for (const event of events) {
    const captured = event.captured;
    if (!captured || captured.color !== capturedColor) continue;
    const maySee = !captured.hidden || viewerIsCapturer || revealed;
    chips.push({
      // The piece id keeps the key stable across a rebuild, so the list reuses its rows instead of
      // rebuilding the strip every time a move is made.
      key: `c${index++}-${captured.pieceId}`,
      color: captured.color,
      kind: maySee ? captured.kind : null,
      // Half transparent exactly when a face is being shown for a piece that was face down when it was
      // taken: the mark that separates "nobody played this one face up" from the pieces everybody
      // watched leave. A chip with no face has nothing to fade — its back is already the statement.
      dimmed: captured.hidden && maySee,
    });
  }
  return chips;
}

/**
 * The one-line capture notice in the move feed, as `viewer` may read it.
 *
 * The same per-observer rule as {@link trayChips}: the kind is named only when the piece was face up
 * in front of everybody, or when the viewer is the capturer who turned it over in their hand. The
 * loser of a face-down piece just reads 吃暗子 (rule R7: 己方暗子被吃后，自己是不能看到暗子是什么棋).
 */
export function captureLabel(captured: CapturedInfo, viewer: Color): string {
  const maySee = !captured.hidden || other(captured.color) === viewer;
  return maySee ? `吃${KIND_NAME[captured.color][captured.kind]}` : '吃暗子';
}
