/**
 * Static evaluation, always from **red's** point of view (positive is good for red).
 *
 * Because the search runs inside a *determinized* world, every face-down piece has a concrete identity
 * by the time this is called — so ordinary material counting is the right thing, and jieqi's fog is
 * handled by averaging over worlds upstream instead of by fudging the numbers here (PLAN §3.3).
 *
 * One jieqi-specific consequence is worth spelling out: the value of a face-down piece is the value of
 * what it *is*, while the threat it poses comes from the square it *stands on*. A 车 hiding on a 兵
 * square is 900 points of material that can only shuffle forward one step. The search discovers that
 * mismatch on its own, because it moves the piece by the square and then reveals it.
 */

import type { Board } from '../core/board';
import {
  PIECE_VALUE,
  SQUARES,
  type Color,
  type Kind,
  crossedRiver,
  fileOf,
  rankOf,
} from '../core/types';

/** Centipawn-ish constants for the positional terms. Kept as named values so the weights are legible. */
const W = {
  /** Rooks like the middle files and the enemy half. */
  rookCentre: 4,
  rookAdvance: 2,
  /** Horses are nearly worthless on the rim and strong in the centre. */
  horseCentre: 6,
  horseEdge: 12,
  horseAdvance: 3,
  /** Cannons want the middle and a bit of advancement to find screens. */
  cannonCentre: 4,
  cannonAdvance: 2,
  /** A soldier that has crossed the river is a different animal. */
  pawnCrossed: 24,
  pawnAdvance: 7,
  /** Loose advisors and elephants mean an exposed king. */
  kingLoose: 12,
  /** Every empty square a rook or cannon can see, capped. */
  lineSquare: 2,
  lineCap: 6,
} as const;

/** Distance from the middle file: 4 on file 4, 0 on the rim. */
const centreOf = (x: number): number => 4 - Math.abs(x - 4);

/** 0 on your own back rank, 9 on the opponent's. */
const advanceOf = (color: Color, y: number): number => (color === 'red' ? 9 - y : y);

const VALUE: Readonly<Record<Kind, number>> = PIECE_VALUE;

/**
 * Scores the whole board in one 90-square sweep.
 *
 * Mobility for rooks and cannons is folded into the same sweep rather than being a second pass: in
 * xiangqi a rook with nothing to look at is a rook that is not doing anything, and the open-line term
 * is what stops the search from shuffling them behind their own soldiers.
 */
export function evaluate(board: Board): number {
  let score = 0;
  const guards: Record<Color, number> = { red: 0, black: 0 };

  for (let sq = 0; sq < SQUARES; sq++) {
    const piece = board.at(sq);
    if (!piece) continue;
    const sign = piece.color === 'red' ? 1 : -1;
    const x = fileOf(sq);
    const y = rankOf(sq);
    const centre = centreOf(x);
    const advance = advanceOf(piece.color, y);

    let bonus = 0;
    switch (piece.kind) {
      case 'R':
        bonus = W.rookCentre * centre + W.rookAdvance * advance + W.lineSquare * lineFreedom(board, sq);
        break;
      case 'C':
        bonus = W.cannonCentre * centre + W.cannonAdvance * advance + W.lineSquare * lineFreedom(board, sq);
        break;
      case 'H':
        bonus =
          W.horseCentre * centre +
          W.horseAdvance * advance -
          (x === 0 || x === 8 ? W.horseEdge : 0);
        break;
      case 'P':
        bonus = crossedRiver(piece.color, sq) ? W.pawnCrossed + W.pawnAdvance * (advance - 5) : 0;
        break;
      case 'A':
      case 'E':
        guards[piece.color] += 1;
        break;
      case 'K':
        break;
    }

    score += sign * (VALUE[piece.kind] + bonus);
  }

  // A king with no advisors and no elephants left is a king you can attack; charge for the ones that
  // are gone rather than only crediting the ones still standing.
  score -= (2 - guards.red) * W.kingLoose * 2;
  score += (2 - guards.black) * W.kingLoose * 2;

  return score;
}

/** Empty squares a rook or cannon can see along its four rays, capped so the term stays cheap. */
function lineFreedom(board: Board, sq: number): number {
  const x = fileOf(sq);
  const y = rankOf(sq);
  let count = 0;
  for (const [dx, dy] of ORTHO) {
    let tx = x + dx;
    let ty = y + dy;
    while (count < W.lineCap) {
      if (tx < 0 || tx > 8 || ty < 0 || ty > 9) break;
      if (board.at(ty * 9 + tx)) break;
      count += 1;
      tx += dx;
      ty += dy;
    }
    if (count >= W.lineCap) break;
  }
  return count;
}

const ORTHO: readonly (readonly [number, number])[] = [
  [0, -1],
  [0, 1],
  [-1, 0],
  [1, 0],
];

/** Convenience for callers that think in "score for the side to move" terms (negamax does). */
export function evaluateFor(board: Board, color: Color): number {
  const red = evaluate(board);
  return color === 'red' ? red : -red;
}
