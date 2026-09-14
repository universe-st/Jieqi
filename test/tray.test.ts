/**
 * The captured-tray display rule.
 *
 * This is the fix the whole change was about, so it gets driven directly rather than through a
 * screenshot: build a real game, make the three kinds of capture happen, and assert what each tray is
 * allowed to show.
 */

import { describe, expect, it } from 'vitest';

import { JieqiGame, type MoveEvent } from '../src/core/rules';
import { KIND_NAME } from '../src/core/types';
import { resetIds } from './support/position';
import { captureLabel, trayChips } from '../src/vm/tray';

/**
 * Plays a game with the given policy until the predicate is satisfied, and returns the move list.
 *
 * `pick` decides which legal move to make, so a test can steer towards a capture instead of hoping one
 * turns up in a random walk.
 */
function playUntil(
  seed: number,
  predicate: (events: MoveEvent[]) => boolean,
  pick: (game: JieqiGame, moves: { from: number; to: number }[]) => { from: number; to: number },
  limit = 400,
): MoveEvent[] {
  resetIds();
  const game = JieqiGame.create({ seed });
  for (let ply = 0; ply < limit && !game.result; ply++) {
    const moves = game.legalMoves();
    if (moves.length === 0) break;
    game.apply(pick(game, moves));
    const events = game.moveEvents;
    if (predicate(events)) return events;
  }
  return game.moveEvents;
}

/** Prefers a capture, and among those the one that takes a face-down piece. */
function captureFirst(
  game: JieqiGame,
  moves: { from: number; to: number }[],
): { from: number; to: number } {
  const captures = moves.filter((move) => game.board.at(move.to));
  const hidden = captures.filter((move) => game.board.at(move.to)?.hidden);
  const pool = hidden.length > 0 ? hidden : captures.length > 0 ? captures : moves;
  return pool[0] as { from: number; to: number };
}

describe('captured trays', () => {
  it('shows a piece taken face up as a solid face, to both sides', () => {
    const events = playUntil(
      7,
      (list) => list.some((event) => event.captured !== null && event.captured.hidden === false),
      captureFirst,
    );
    const event = events.find((e) => e.captured && !e.captured.hidden) as MoveEvent;
    const captured = event.captured;
    expect(captured).not.toBeNull();
    const loser = (captured as NonNullable<typeof captured>).color;
    const winner = event.color;

    for (const viewer of [winner, loser]) {
      const chips = trayChips(events, viewer, loser);
      const chip = chips.find((c) => c.key.endsWith(`${(captured as NonNullable<typeof captured>).pieceId}`));
      expect(chip?.kind).toBe((captured as NonNullable<typeof captured>).kind);
      expect(chip?.dimmed).toBe(false);
    }
  });

  it('shows the player their own face-down capture, half transparent', () => {
    // Red to move, and a capture of a face-down black piece is available somewhere in the game.
    const events = playUntil(
      3,
      (list) => list.some((event) => event.color === 'red' && event.captured?.hidden === true),
      captureFirst,
    );
    const event = events.find((e) => e.color === 'red' && e.captured?.hidden) as MoveEvent;
    expect(event).toBeDefined();

    const chips = trayChips(events, 'red', 'black');
    const chip = chips.find((c) => c.key.endsWith(`${event.captured?.pieceId}`));
    // The capturer turned it over in their hand, so the face is shown — but faded, to say that it was
    // still hidden at the time.
    expect(chip?.kind).toBe(event.captured?.kind);
    expect(chip?.dimmed).toBe(true);
  });

  it('shows the computer’s face-down capture as a face-down piece, to the player', () => {
    const events = playUntil(
      3,
      (list) => list.some((event) => event.color === 'black' && event.captured?.hidden === true),
      (game, moves) => captureFirst(game, moves),
    );
    const event = events.find((e) => e.color === 'black' && e.captured?.hidden) as MoveEvent;
    expect(event).toBeDefined();

    // The player is red, so the computer's tray is the one holding red pieces.
    const chips = trayChips(events, 'red', 'red');
    const chip = chips.find((c) => c.key.endsWith(`${event.captured?.pieceId}`));
    // The player is the loser here and rule R7 forbids them from looking: nothing about the identity
    // reaches the view, and the chip is drawn as a face-down piece.
    expect(chip?.kind).toBeNull();
    expect(chip?.dimmed).toBe(false);

    // The computer itself would see the face, which is what makes the two trays asymmetric.
    const asComputer = trayChips(events, 'black', 'red');
    const theirs = asComputer.find((c) => c.key.endsWith(`${event.captured?.pieceId}`));
    expect(theirs?.kind).toBe(event.captured?.kind);
    expect(theirs?.dimmed).toBe(true);
  });

  it('turns every face-down chip up once the match is over', () => {
    const events = playUntil(
      3,
      (list) => list.some((event) => event.color === 'black' && event.captured?.hidden === true),
      captureFirst,
    );
    const event = events.find((e) => e.color === 'black' && e.captured?.hidden) as MoveEvent;
    expect(event).toBeDefined();
    const pieceId = event.captured?.pieceId;

    // The same tray and the same viewer — the only thing that changed is that the match is over. R7 stops
    // the loser from looking *while there is still a game to play*, which is also the argument the board's
    // own endgame reveal makes about its remaining 暗子.
    const revealed = trayChips(events, 'red', 'red', { revealHidden: true });
    const chip = revealed.find((c) => c.key.endsWith(`${pieceId}`));
    expect(chip?.kind).toBe(event.captured?.kind);
    // Half transparent: that is how the tray marks a piece that was face down when it was taken.
    expect(chip?.dimmed).toBe(true);

    // …and without the flag it is still the face-down chip the player watched during the game.
    const during = trayChips(events, 'red', 'red').find((c) => c.key.endsWith(`${pieceId}`));
    expect(during?.kind).toBeNull();
    expect(during?.dimmed).toBe(false);
  });

  it('never leaks an identity into a face-down chip', () => {
    // Over a whole game, every chip the player is not entitled to see must carry `kind: null` — the
    // renderer asks for a texture by kind, so a non-null kind here would be a straight leak.
    resetIds();
    const game = JieqiGame.create({ seed: 11 });
    for (let ply = 0; ply < 200 && !game.result; ply++) {
      const moves = game.legalMoves();
      if (moves.length === 0) break;
      game.apply(captureFirst(game, moves));
    }
    const events = game.moveEvents;
    const byPieceId = new Map(
      events.filter((e) => e.captured).map((e) => [e.captured?.pieceId as number, e]),
    );
    for (const capturedColor of ['red', 'black'] as const) {
      const chips = trayChips(events, 'red', capturedColor);
      // One chip per piece that side actually lost — no more, no fewer.
      const losses = events.filter((e) => e.captured?.color === capturedColor);
      expect(chips).toHaveLength(losses.length);
      for (const chip of chips) {
        const pieceId = Number(chip.key.split('-')[1]);
        const captured = byPieceId.get(pieceId)?.captured as NonNullable<MoveEvent['captured']>;
        // The player did the capturing exactly when the move was red's.
        const viewerIsCapturer = byPieceId.get(pieceId)?.color === 'red';
        expect(chip.kind).toBe(captured.hidden && !viewerIsCapturer ? null : captured.kind);
        expect(chip.dimmed).toBe(captured.hidden && viewerIsCapturer);
        expect(chip.color).toBe(capturedColor);
      }
    }
    expect(events.some((e) => e.captured)).toBe(true);
  });

  it('is stable across a rebuild, so the strip is not recreated on every move', () => {
    const events = playUntil(5, (list) => list.filter((e) => e.captured).length >= 2, captureFirst);
    const first = trayChips(events, 'red', 'black');
    const second = trayChips(events, 'red', 'black');
    expect(second.map((c) => c.key)).toEqual(first.map((c) => c.key));
  });
});

describe('capture label (the move-feed notice)', () => {
  it('names the kind for a piece taken face up, to both sides', () => {
    const events = playUntil(
      7,
      (list) => list.some((event) => event.captured !== null && event.captured.hidden === false),
      captureFirst,
    );
    const event = events.find((e) => e.captured && !e.captured.hidden) as MoveEvent;
    const captured = event.captured as NonNullable<MoveEvent['captured']>;
    const loser = captured.color;
    const winner = event.color;
    expect(captureLabel(captured, loser)).toBe(`吃${KIND_NAME[captured.color][captured.kind]}`);
    expect(captureLabel(captured, winner)).toBe(`吃${KIND_NAME[captured.color][captured.kind]}`);
  });

  it('shows the capturer what they turned over — the player capturing a hidden piece', () => {
    const events = playUntil(
      3,
      (list) => list.some((event) => event.color === 'red' && event.captured?.hidden === true),
      captureFirst,
    );
    const event = events.find((e) => e.color === 'red' && e.captured?.hidden) as MoveEvent;
    const captured = event.captured as NonNullable<MoveEvent['captured']>;
    // Red did the capturing, so the human (red) is entitled to the identity…
    expect(captureLabel(captured, 'red')).toBe(`吃${KIND_NAME[captured.color][captured.kind]}`);
    // …while the computer (black), the loser, is not.
    expect(captureLabel(captured, 'black')).toBe('吃暗子');
  });

  it('never reveals to the player what the computer took from them while it was face down', () => {
    const events = playUntil(
      3,
      (list) => list.some((event) => event.color === 'black' && event.captured?.hidden === true),
      captureFirst,
    );
    const event = events.find((e) => e.color === 'black' && e.captured?.hidden) as MoveEvent;
    const captured = event.captured as NonNullable<MoveEvent['captured']>;
    // Black captured red's 暗子: the player (red, the loser) only reads 吃暗子 — the bug this test
    // guards against is the label spelling out the identity.
    expect(captureLabel(captured, 'red')).toBe('吃暗子');
    // The computer itself would know what it took.
    expect(captureLabel(captured, 'black')).toBe(`吃${KIND_NAME[captured.color][captured.kind]}`);
  });
});
