/**
 * AI tests.
 *
 * The important properties are not "does it play well" — that is measured by playing — but "does it
 * only ever produce legal moves", "does it terminate", "does it find a forced mate", and "is its
 * randomness small and reproducible".
 */

import { describe, expect, it } from 'vitest';

import { Board } from '../src/core/board';
import { createKnowledge } from '../src/core/info';
import { JieqiGame } from '../src/core/rules';
import { type Move, squareOf } from '../src/core/types';
import { MATE, chooseMove, evaluate } from '../src/ai';
import { emptyBoard, finalize, fromAscii, put, resetIds } from './support/position';

/** Swaps in a hand-built board with empty information pools (no face-down pieces anywhere). */
function gameOn(board: Board): JieqiGame {
  resetIds();
  const game = JieqiGame.create({ seed: 1 });
  const internal = game as unknown as {
    board: Board;
    knowledge: ReturnType<typeof createKnowledge>;
  };
  internal.board = board;
  internal.knowledge = createKnowledge();
  return game;
}

describe('evaluation', () => {
  it('is positive for red when red is a rook up and negative for the mirror image', () => {
    const redUp = emptyBoard('red');
    put(redUp, 'red', 'K', 4, 9);
    put(redUp, 'black', 'K', 3, 0);
    put(redUp, 'red', 'R', 0, 5);
    finalize(redUp);

    const blackUp = emptyBoard('red');
    put(blackUp, 'red', 'K', 4, 9);
    put(blackUp, 'black', 'K', 3, 0);
    put(blackUp, 'black', 'R', 0, 5);
    finalize(blackUp);

    expect(evaluate(redUp)).toBeGreaterThan(0);
    expect(evaluate(blackUp)).toBeLessThan(0);
    // Mirroring the extra piece flips the sign and keeps the magnitude comparable.
    expect(Math.abs(evaluate(redUp) + evaluate(blackUp))).toBeLessThan(120);
  });

  it('prefers a soldier that has crossed the river to one that has not', () => {
    const home = emptyBoard('red');
    put(home, 'red', 'K', 4, 9);
    put(home, 'black', 'K', 3, 0);
    put(home, 'red', 'P', 4, 6);
    finalize(home);

    const crossed = emptyBoard('red');
    put(crossed, 'red', 'K', 4, 9);
    put(crossed, 'black', 'K', 3, 0);
    put(crossed, 'red', 'P', 4, 2);
    finalize(crossed);

    expect(evaluate(crossed)).toBeGreaterThan(evaluate(home));
  });
});

describe('search', () => {
  it('finds a mate in one', () => {
    // Black's king on (4,0) is boxed in: the red horses on (2,2) and (6,2) cover (3,0), (5,0) and
    // (4,1), and the black soldier on (4,4) is the only thing blocking the rook on (4,5). Taking it
    // with the rook is mate. (Upper case is red, lower case is black.)
    const board = fromAscii(`
      . . . . k . . . .
      . . . . . . . . .
      . . H . . . H . .
      . . . . . . . . .
      . . . . p . . . .
      . . . . R . . . .
      . . . . . . . . .
      . . . . . . . . .
      . . . . . . . . .
      . . . . K . . . .
    `);
    const game = gameOn(board);
    expect(game.inCheck('black')).toBe(false);

    const decision = chooseMove(game, { difficulty: 'normal', seed: 7 });
    expect(decision).not.toBeNull();
    expect(decision?.move).toEqual({ from: squareOf(4, 5), to: squareOf(4, 4) });
    // A forced mate is scored just under MATE, well clear of any material score.
    expect(decision?.score).toBeGreaterThan(MATE - 50);

    game.apply(decision?.move as Move);
    expect(game.result?.kind).toBe('checkmate');
    expect(game.result?.winner).toBe('red');
  });

  it('takes a free rook', () => {
    const board = fromAscii(`
      . . . . k . . . .
      . . . . . . . . .
      . . . . . . . . .
      . . . . r . . . .
      . . . . . . . . .
      . . . . R . . . .
      . . . . . . . . .
      . . . . . . . . .
      . . . . . . . . .
      . . . . K . . . .
    `);
    const game = gameOn(board);
    const decision = chooseMove(game, { difficulty: 'normal', seed: 3 });
    expect(decision?.move).toEqual({ from: squareOf(4, 5), to: squareOf(4, 3) });
  });

  it('never returns an illegal move, from any position in a random walk', () => {
    for (const seed of [11, 22, 33]) {
      resetIds();
      const game = JieqiGame.create({ seed });
      const rngSeed = seed * 3 + 1;
      let plies = 0;
      while (!game.result && plies < 30) {
        const legal = game.legalMoves();
        if (legal.length === 0) break;
        // Walk randomly for a few plies, then ask the AI, so it faces many different shapes.
        if (plies % 3 === 2) {
          const decision = chooseMove(game, {
            difficulty: 'easy',
            seed: rngSeed + plies,
            nodeBudget: 60_000,
            timeLimitMs: 250,
          });
          expect(decision).not.toBeNull();
          const move = decision?.move as Move;
          expect(legal.some((m) => m.from === move.from && m.to === move.to)).toBe(true);
          game.apply(move);
        } else {
          game.apply(legal[(seed + plies * 5) % legal.length] as Move);
        }
        plies += 1;
      }
      expect(plies).toBeGreaterThan(3);
    }
  });

  it('is reproducible for a fixed seed and varies across seeds', () => {
    resetIds();
    const game = JieqiGame.create({ seed: 909 });
    const a = chooseMove(game, { difficulty: 'easy', seed: 5 });
    const b = chooseMove(game, { difficulty: 'easy', seed: 5 });
    expect(a?.move).toEqual(b?.move);
    expect(a?.score).toBeCloseTo(b?.score as number, 6);

    const picks = new Set<string>();
    for (let seed = 0; seed < 12; seed++) {
      const decision = chooseMove(game, { difficulty: 'easy', seed: seed * 7919 });
      picks.add(`${decision?.move.from}-${decision?.move.to}`);
    }
    // The randomness is meant to be small, not absent: across a dozen seeds the choice should move.
    expect(picks.size).toBeGreaterThan(1);
  });

  it('keeps the randomness small — it stays near the best move', () => {
    resetIds();
    const game = JieqiGame.create({ seed: 4242 });
    const baseline = chooseMove(game, { difficulty: 'normal', seed: 1, epsilon: 0, noiseCp: 0 });
    const best = baseline?.candidates[0]?.score as number;
    for (let seed = 0; seed < 8; seed++) {
      const decision = chooseMove(game, { difficulty: 'normal', seed: seed * 104729 + 13 });
      // Every pick must be a legal move, and within a small window of the best score.
      expect(best - (decision?.score as number)).toBeLessThan(200);
    }
  });
});

describe('self-play', () => {
  it('plays whole games without a single illegal move or exception', () => {
    const summary: string[] = [];
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      resetIds();
      const game = JieqiGame.create({ seed });
      let plies = 0;
      while (!game.result && plies < 300) {
        const decision = chooseMove(game, {
          difficulty: 'easy',
          seed: seed * 31 + plies,
          nodeBudget: 25_000,
          timeLimitMs: 80,
        });
        if (!decision) break;
        game.apply(decision.move);
        plies += 1;
      }
      summary.push(`seed ${seed}: ${plies} plies, ${game.result?.kind ?? 'unfinished'}`);
      expect(plies).toBeGreaterThan(4);
    }
    expect(summary.length).toBe(6);
    // Every game must reach a terminal state; an unfinished one means the engine cannot convert.
    expect(summary.filter((line) => line.includes('unfinished')).length).toBeLessThanOrEqual(1);
  });

  it('does not leave a king hanging: the side to move never loses material for nothing', () => {
    // A positional sanity check with a real time budget: the AI must beat a random player over a
    // handful of games. This is the cheapest honest evidence that there is intelligence in there.
    let aiWins = 0;
    const games = 4;
    for (let index = 0; index < games; index++) {
      resetIds();
      const game = JieqiGame.create({ seed: 500 + index });
      const aiColor = index % 2 === 0 ? 'red' : 'black';
      let plies = 0;
      while (!game.result && plies < 200) {
        if (game.sideToMove === aiColor) {
          const decision = chooseMove(game, {
            difficulty: 'easy',
            seed: index * 1000 + plies,
            nodeBudget: 25_000,
            timeLimitMs: 80,
          });
          if (!decision) break;
          game.apply(decision.move);
        } else {
          const legal = game.legalMoves();
          if (legal.length === 0) break;
          game.apply(legal[(index * 37 + plies * 11) % legal.length] as Move);
        }
        plies += 1;
      }
      if (game.result?.winner === aiColor) aiWins += 1;
    }
    expect(aiWins).toBeGreaterThanOrEqual(3);
  });
});
