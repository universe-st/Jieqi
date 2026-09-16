/**
 * Regression: the AI must not treat "a revealed piece walking onto a dark piece's line" as a gain.
 *
 * Scenario (user report, 2026-09-16): hard AI played 车吃暗马 and the rook landed on the "mouth" of
 * a dark piece standing on the ROOK's home square. While face down, that piece moves like a rook
 * (rule R4) — the threat is public, not a guess. The per-world search does see the recapture (it is
 * generated in every sampled world); the bug was that root moves cut by alpha-beta reported an upper
 * bound (≈ best − ROOT_SLACK) which the engine averaged as if exact, turning a move truly worth
 * ≈ −700 into a plausible +54…+205. The fix: `Searcher.searchRoot` tags bound scores, and the engine
 * averages exact scores only — a move never searched exactly in any world is provably worse than the
 * best in every world and ranks last.
 */

import { describe, expect, it } from 'vitest';

import { JieqiGame } from '../src/core/rules';
import { createKnowledge } from '../src/core/info';
import { chooseMove, type AiDecision } from '../src/ai';
import type { Board } from '../src/core/board';
import { squareOf } from '../src/core/types';
import { emptyBoard, finalize, put, putHidden, resetIds } from './support/position';

/**
 * Black (AI) to move. Black's rook at (1,4) can take the red dark piece on the HORSE home square
 * (1,9), landing right next to the red dark piece on the ROOK home square (0,9) — which moves like a
 * rook while face down, so the recapture is certain. A quiet alternative (rook to (4,4), 車二平五)
 * exists and must win the choice.
 */
function buildBoard(): Board {
  const board = emptyBoard('black');
  put(board, 'red', 'K', 4, 9);
  put(board, 'black', 'K', 3, 0);
  put(board, 'black', 'R', 1, 4);
  putHidden(board, 'red', 'C', 'H', 1, 9); // the dark piece it captures
  putHidden(board, 'red', 'H', 'R', 0, 9); // the "dark rook" — homeKind R while hidden
  put(board, 'black', 'H', 6, 3);
  put(board, 'black', 'C', 5, 2);
  put(board, 'red', 'H', 2, 7);
  put(board, 'red', 'C', 3, 7);
  return finalize(board);
}

function gameOn(board: Board): JieqiGame {
  resetIds();
  const game = JieqiGame.create({ seed: 1 });
  const internal = game as unknown as { board: Board; knowledge: ReturnType<typeof createKnowledge> };
  internal.board = board;
  internal.knowledge = createKnowledge();
  return game;
}

const CAPTURE = { from: squareOf(1, 4), to: squareOf(1, 9) };

function decide(seed: number): AiDecision {
  const decision = chooseMove(gameOn(buildBoard()), {
    difficulty: 'hard',
    seed,
    epsilon: 0,
    noiseCp: 0,
  });
  if (!decision) throw new Error(`seed ${seed}: no decision`);
  return decision;
}

describe('AI never walks a revealed rook onto a dark piece it can see (recapture by homeKind)', () => {
  const seeds = [11, 222, 3333, 7, 42, 777];
  const decisions = seeds.map((seed) => ({ seed, decision: decide(seed) }));

  it('never chooses the suicide capture while a quiet alternative exists', () => {
    for (const { seed, decision } of decisions) {
      const chosen = decision.move;
      expect(
        chosen.from === CAPTURE.from && chosen.to === CAPTURE.to,
        `seed ${seed}: chose ${decision.notation}`,
      ).toBe(false);
    }
  });

  it('reports the capture honestly — a small loss, never an inflated gain', () => {
    // Before the fix these seeds reported +54 / +205 / +201 (alpha-beta upper bounds averaged as
    // exact). The true value is roughly V(sampled dark piece) − 900 < 0 in every world.
    for (const { seed, decision } of decisions) {
      const cap = decision.candidates.find((c) => c.move.from === CAPTURE.from && c.move.to === CAPTURE.to);
      expect(cap, `seed ${seed}: capture not in candidates`).toBeDefined();
      expect((cap as NonNullable<typeof cap>).score).toBeLessThan(50);
      expect((cap as NonNullable<typeof cap>).score).toBeLessThan(decision.score);
    }
  });
});
