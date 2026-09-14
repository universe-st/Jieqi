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
 *    with consequences (the hint would push the player to defend a piece nobody can take). The reading
 *    is `isKingSafeAfter`, i.e. the same public one the move list uses, so in 混斗 clause 3 does not
 *    peek at what a 暗子 would turn out to be either.
 *
 * ## Why this leaks nothing
 *
 * None of the three clauses touches a hidden identity. A face-down piece moves by the square it stands
 * on (rule R4), and legality is computed from `movementOf()`, which is public for every piece on the
 * board — so the same board a player sees is enough to compute this honestly. The overlay is an aid,
 * not a peek: it cannot see a 暗子 either.
 */

import type { Board } from './board';
import { generateMoves, isSquareAttacked, isKingSafeAfter } from './moves';
import { type Color, type Move, other } from './types';

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
  if (!piece) return false;
  // Owner, not `piece.color`: in 混斗 a 暗子 on my half is mine, and the question "can the *other* side
  // take it" has to be asked about the side that can actually move it (rule M2).
  return isHangingFor(board, square, board.ownerAt(square) ?? piece.color);
}

/**
 * The same question asked about a *named* owner rather than about whatever the board says.
 *
 * This is what the board's target rings use: "if I move there, would **my** piece be hanging?" has to
 * be answered about the mover, because in 混斗 the piece that arrives may turn out to be the
 * opponent's — and asking `isHanging` then would both answer the wrong question (is the piece I just
 * handed over capturable by me?) and leak the hidden identity through the colour of a ring.
 */
export function isHangingFor(board: Board, square: number, owner: Color): boolean {
  const piece = board.at(square);
  if (!piece || piece.kind === 'K') return false;

  const enemy = other(owner);
  const threatened = generateMoves(board, enemy, []).some(
    (move) => move.to === square && isKingSafeAfter(board, enemy, move),
  );
  if (!threatened) return false;

  // Defended: a friendly piece covers the square, so taking would only trade into a recapture. The
  // attack map is the right question here — "would there be a piece to take back with" — which is the
  // same semantics the rules tests use as their oracle.
  return !isSquareAttacked(board, square, owner);
}

/**
 * Would the piece **land** hanging if `mover` played `move`? The board's red/green target rings.
 *
 * The difference from `isHanging` is the only thing this function exists for: it is asked *before* the
 * move, about the piece the mover is holding, so the arrival is judged as the **mover's** piece —
 * which in 混斗 is a decision, because the piece may turn out to be the opponent's (rule M4). Judging
 * it afterwards would answer a different question (is the piece I just handed over capturable by me?)
 * and would let the colour of a ring read a 暗子's identity off the board.
 */
export function landsHangingAs(board: Board, move: Move, mover: Color): boolean {
  const undo = board.makeMove(move.from, move.to);
  const moved = board.at(move.to);
  const borrowed = moved && moved.color !== mover ? { ...moved, color: mover } : null;
  if (borrowed) board.squares[move.to] = borrowed;
  const hanging = isHangingFor(board, move.to, mover);
  if (borrowed && moved) board.squares[move.to] = moved;
  board.unmakeMove(undo);
  return hanging;
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
    const threatened = enemyMoves.some((move) => move.to === square && isKingSafeAfter(board, enemy, move));
    if (!threatened) continue;
    if (isSquareAttacked(board, square, color)) continue;
    out.push(square);
  }
  return out;
}
