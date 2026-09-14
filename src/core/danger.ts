/**
 * 吃子提示 — which pieces are hanging, for the optional board overlay.
 *
 * A piece is in danger when **all three** of these hold:
 *
 * 1. **Some enemy piece can move onto its square.** "Can move" is read off the real move list, so the
 *    cannon's screen, the horse's leg and the elephant's eye are all accounted for by construction.
 * 2. **No friendly piece defends that square**, so the capture cannot be answered by a recapture.
 * 3. **The capture is legal for the enemy** — taking the piece would not leave the enemy's own general
 *    attacked. 送将 is the whole of clause 3: a capture that loses the general is not a threat, it is a
 *    blunder the opponent is not allowed to make, and calling such a piece "in danger" would be a lie
 *    with consequences (the hint would push the player to defend a piece nobody can take).
 *
 * ## Why this leaks nothing
 *
 * None of the three clauses touches a hidden identity. A face-down piece moves by the square it stands
 * on (rule R4), and legality is computed from `movementOf()`, which is public for every piece on the
 * board — so the same board a player sees is enough to compute this honestly. The overlay is an aid,
 * not a peek: it cannot see a 暗子 either.
 */

import type { Board } from './board';
import { generateMoves, isSquareAttacked, isKingSafe } from './moves';
import { type Color, type Move, other } from './types';

/** Does `color` keep their own general after playing `move`? The 送将 test of clause 3. */
function keepsKingSafe(board: Board, color: Color, move: Move): boolean {
  const undo = board.makeMove(move.from, move.to);
  const safe = isKingSafe(board, color);
  board.unmakeMove(undo);
  return safe;
}

/**
 * Is the piece standing on `square` hanging — capturable for free by the other side?
 *
 * The general is never reported. A general that is attacked is 将军, which the board already announces
 * with a glow of its own, and in a legal position a general can never simply be taken — an overlay that
 * drew a second ring around it would be saying "you may lose your general next move", which is not what
 * is happening.
 */
export function isHanging(board: Board, square: number): boolean {
  const piece = board.at(square);
  if (!piece || piece.kind === 'K') return false;

  const enemy = other(piece.color);
  const threatened = generateMoves(board, enemy, []).some(
    (move) => move.to === square && keepsKingSafe(board, enemy, move),
  );
  if (!threatened) return false;

  // Defended: a friendly piece covers the square, so taking would only trade into a recapture. The
  // attack map is the right question here — "would there be a piece to take back with" — which is the
  // same semantics the rules tests use as their oracle.
  return !isSquareAttacked(board, square, piece.color);
}

/**
 * The squares of `color`'s hanging pieces, ascending.
 *
 * One pass for the whole side rather than 16 {@link isHanging} calls: the enemy move list is generated
 * once, and every candidate is then a scan of it.
 */
export function hangingSquares(board: Board, color: Color): number[] {
  const enemy = other(color);
  const enemyMoves = generateMoves(board, enemy, []);
  const out: number[] = [];
  for (const { square, piece } of board.piecesOf(color)) {
    if (piece.kind === 'K') continue;
    const threatened = enemyMoves.some((move) => move.to === square && keepsKingSafe(board, enemy, move));
    if (!threatened) continue;
    if (isSquareAttacked(board, square, color)) continue;
    out.push(square);
  }
  return out;
}
