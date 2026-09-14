/**
 * Pseudo-legal move generation and square-attack detection.
 *
 * The one rule that makes jieqi jieqi lives here — rule R4: a **hidden** piece moves according to the
 * starting square it stands on, not according to what it actually is. Combined with R5 (a hidden piece
 * is turned face up as part of its move) this means:
 *
 *   - a hidden piece never moves twice, so `piece.homeKind` is valid for its whole hidden life;
 *   - the *legality* of a move never depends on hidden information, only its *consequences* do.
 *
 * That second consequence is why the search can be an ordinary alpha-beta over sampled worlds: every
 * world shares the same move set and differs only in what things are worth and what a reveal turns up.
 */

import {
  FILES,
  RANKS,
  type Color,
  type Kind,
  type Move,
  type Piece,
  crossedRiver,
  fileOf,
  forwardStep,
  inPalace,
  movementOf,
  onBoard,
  ownHalf,
  rankOf,
  squareOf,
} from './types';
import type { Board } from './board';

const ORTHO: readonly (readonly [number, number])[] = [
  [0, -1],
  [0, 1],
  [-1, 0],
  [1, 0],
];

const DIAGONAL: readonly (readonly [number, number])[] = [
  [-1, -1],
  [-1, 1],
  [1, -1],
  [1, 1],
];

/** The eight squares a horse can jump to, as `[mx, my]` offsets from its own square. */
const HORSE: readonly (readonly [number, number])[] = [
  [-1, -2],
  [1, -2],
  [-2, -1],
  [2, -1],
  [-2, 1],
  [2, 1],
  [-1, 2],
  [1, 2],
];

function addTarget(board: Board, from: number, x: number, y: number, color: Color, out: Move[]): void {
  if (!onBoard(x, y)) return;
  const to = squareOf(x, y);
  const occupant = board.at(to);
  if (occupant && occupant.color === color) return;
  out.push({ from, to });
}

/** Pushes `x, y` when it is on the board and empty — the "quiet" half of a cannon's or rook's line. */
function addIfEmpty(board: Board, from: number, x: number, y: number, out: Move[]): boolean {
  if (!onBoard(x, y)) return false;
  const to = squareOf(x, y);
  if (board.at(to)) return false;
  out.push({ from, to });
  return true;
}

/**
 * Pseudo-legal destinations of the piece on `from`.
 *
 * "Pseudo-legal" means the move is not yet checked for leaving one's own king in check — that filter
 * lives in `rules.ts`.
 */
export function generatePieceMoves(board: Board, from: number, out: Move[]): void {
  const piece = board.at(from);
  if (!piece) return;
  const color = piece.color;
  const { kind, mode } = movementOf(piece);
  const x = fileOf(from);
  const y = rankOf(from);

  switch (kind) {
    case 'K': {
      for (const [dx, dy] of ORTHO) {
        const tx = x + dx;
        const ty = y + dy;
        if (!onBoard(tx, ty)) continue;
        if (!inPalace(color, squareOf(tx, ty))) continue;
        addTarget(board, from, tx, ty, color, out);
      }
      return;
    }

    case 'A': {
      for (const [dx, dy] of DIAGONAL) {
        const tx = x + dx;
        const ty = y + dy;
        if (!onBoard(tx, ty)) continue;
        // Rule R9: a *hidden* 仕/士 is bound by the classic palace; rule R8 lifts that only once the
        // piece is face up.
        if (mode === 'classic' && !inPalace(color, squareOf(tx, ty))) continue;
        addTarget(board, from, tx, ty, color, out);
      }
      return;
    }

    case 'E': {
      for (const [dx, dy] of DIAGONAL) {
        const tx = x + dx * 2;
        const ty = y + dy * 2;
        if (!onBoard(tx, ty)) continue;
        const target = squareOf(tx, ty);
        // Rule R9/R8: an unrevealed 相/象 is confined to its own half; a revealed one may cross.
        if (mode === 'classic' && !ownHalf(color, target)) continue;
        // Elephant eye.
        if (board.at(squareOf(x + dx, y + dy))) continue;
        addTarget(board, from, tx, ty, color, out);
      }
      return;
    }

    case 'H': {
      for (const [dx, dy] of HORSE) {
        const tx = x + dx;
        const ty = y + dy;
        if (!onBoard(tx, ty)) continue;
        // Horse leg: the orthogonal neighbour in the direction of the two-step.
        const legX = Math.abs(dx) === 2 ? x + dx / 2 : x;
        const legY = Math.abs(dy) === 2 ? y + dy / 2 : y;
        if (board.at(squareOf(legX, legY))) continue;
        addTarget(board, from, tx, ty, color, out);
      }
      return;
    }

    case 'R': {
      for (const [dx, dy] of ORTHO) {
        let tx = x + dx;
        let ty = y + dy;
        while (addIfEmpty(board, from, tx, ty, out)) {
          tx += dx;
          ty += dy;
        }
        if (onBoard(tx, ty)) addTarget(board, from, tx, ty, color, out);
      }
      return;
    }

    case 'C': {
      for (const [dx, dy] of ORTHO) {
        let tx = x + dx;
        let ty = y + dy;
        while (addIfEmpty(board, from, tx, ty, out)) {
          tx += dx;
          ty += dy;
        }
        if (!onBoard(tx, ty)) continue;
        // Exactly one screen: step past it and take the first thing we find.
        tx += dx;
        ty += dy;
        while (onBoard(tx, ty)) {
          const blocker = board.at(squareOf(tx, ty));
          if (blocker) {
            if (blocker.color !== color) out.push({ from, to: squareOf(tx, ty) });
            break;
          }
          tx += dx;
          ty += dy;
        }
      }
      return;
    }

    case 'P': {
      const forward = forwardStep(color);
      addTarget(board, from, x, y + forward, color, out);
      if (crossedRiver(color, from)) {
        addTarget(board, from, x - 1, y, color, out);
        addTarget(board, from, x + 1, y, color, out);
      }
      return;
    }
  }
}

/** All pseudo-legal moves for `color`. */
export function generateMoves(board: Board, color: Color, out: Move[] = []): Move[] {
  for (let sq = 0; sq < board.squares.length; sq++) {
    const piece = board.at(sq);
    if (piece && piece.color === color) generatePieceMoves(board, sq, out);
  }
  return out;
}

/** Captures only — used by the quiescence search. */
export function generateCaptures(board: Board, color: Color, out: Move[] = []): Move[] {
  const all = generateMoves(board, color, []);
  for (const move of all) if (board.at(move.to)) out.push(move);
  return out;
}

/**
 * Is `sq` attacked by any piece of `byColor`?
 *
 * Written as a targeted outward scan rather than "generate every move and look for `sq`", because the
 * search calls it for every node: a rook along four rays plus a cannon behind it, the eight horse
 * squares with their legs, the pawn's three possible origins, and the diagonal steppers.
 *
 * A hidden attacker is evaluated with `homeKind` — the same movement rule that governs its moves.
 */
export function isSquareAttacked(board: Board, sq: number, byColor: Color): boolean {
  const x = fileOf(sq);
  const y = rankOf(sq);

  // --- Rooks, cannons and the flying general, along the four orthogonal rays. -------------------
  for (const [dx, dy] of ORTHO) {
    let tx = x + dx;
    let ty = y + dy;
    let distance = 1;
    let screen: Piece | null = null;

    while (onBoard(tx, ty)) {
      const piece = board.at(squareOf(tx, ty));
      if (piece) {
        if (!screen) {
          screen = piece;
          if (piece.color === byColor) {
            const { kind } = movementOf(piece);
            if (kind === 'R') return true;
            // A king captures onto an adjacent square of its own palace — and nowhere else. The
            // long-range 白脸将 rule is deliberately *not* folded in here: it is a prohibition on the
            // two kings facing each other, not an attack on the squares between them, and conflating
            // the two makes this function stop meaning "something could be captured here".
            if (kind === 'K' && distance === 1 && inPalace(piece.color, sq)) return true;
          }
        } else if (piece.color === byColor && movementOf(piece).kind === 'C') {
          return true;
        } else {
          break; // second blocker: nothing beyond it can reach `sq`
        }
      }
      tx += dx;
      ty += dy;
      distance++;
    }
  }

  // --- Horses. ---------------------------------------------------------------------------------
  for (const [ax, ay] of HORSE) {
    const kx = x + ax;
    const ky = y + ay;
    if (!onBoard(kx, ky)) continue;
    const knight = board.at(squareOf(kx, ky));
    if (!knight || knight.color !== byColor || movementOf(knight).kind !== 'H') continue;
    // Leg for a horse standing at `k` and jumping to `sq`: one step out of `k` along the long axis.
    const legX = Math.abs(ax) === 2 ? x + ax / 2 : x + ax;
    const legY = Math.abs(ay) === 2 ? y + ay / 2 : y + ay;
    if (board.at(squareOf(legX, legY))) continue;
    return true;
  }

  // --- Pawns. ----------------------------------------------------------------------------------
  const behind = y - forwardStep(byColor);
  if (onBoard(x, behind)) {
    const pawn = board.at(squareOf(x, behind));
    if (pawn && pawn.color === byColor && movementOf(pawn).kind === 'P') return true;
  }
  for (const dx of [-1, 1]) {
    const px = x + dx;
    if (!onBoard(px, y)) continue;
    const pawnSquare = squareOf(px, y);
    const pawn = board.at(pawnSquare);
    if (!pawn || pawn.color !== byColor || movementOf(pawn).kind !== 'P') continue;
    if (crossedRiver(byColor, pawnSquare)) return true;
  }

  // --- Advisors. -------------------------------------------------------------------------------
  for (const [ax, ay] of DIAGONAL) {
    const px = x + ax;
    const py = y + ay;
    if (!onBoard(px, py)) continue;
    const attackerSquare = squareOf(px, py);
    const advisor = board.at(attackerSquare);
    if (!advisor || advisor.color !== byColor) continue;
    const { kind, mode } = movementOf(advisor);
    if (kind !== 'A') continue;
    if (mode === 'classic' && (!inPalace(byColor, attackerSquare) || !inPalace(byColor, sq))) continue;
    return true;
  }

  // --- Elephants. ------------------------------------------------------------------------------
  for (const [ax, ay] of DIAGONAL) {
    const px = x + ax * 2;
    const py = y + ay * 2;
    if (!onBoard(px, py)) continue;
    const attackerSquare = squareOf(px, py);
    const elephant = board.at(attackerSquare);
    if (!elephant || elephant.color !== byColor) continue;
    const { kind, mode } = movementOf(elephant);
    if (kind !== 'E') continue;
    if (mode === 'classic' && (!ownHalf(byColor, attackerSquare) || !ownHalf(byColor, sq))) continue;
    // The eye is the midpoint of the jump: (x + ax, y + ay), one step out from the *target*.
    if (board.at(squareOf(x + ax, y + ay))) continue;
    return true;
  }

  return false;
}

/** Convenience: the kind that governs how the piece on `from` moves right now. */
export function effectiveKind(board: Board, from: number): Kind | null {
  const piece = board.at(from);
  return piece ? movementOf(piece).kind : null;
}

/**
 * The 白脸将 / flying-general rule: two kings on one file with nothing between them.
 *
 * The position is illegal for whoever has to move, which is exactly what makes stepping a blocker out
 * of the way illegal — but note that it is *not* an attack on the squares in between, so it lives here
 * rather than inside {@link isSquareAttacked}.
 */
export function kingsFaceEachOther(board: Board): boolean {
  const red = board.kingSq.red;
  const black = board.kingSq.black;
  if (red < 0 || black < 0) return false;
  const x = fileOf(red);
  if (x !== fileOf(black)) return false;
  const lo = Math.min(rankOf(red), rankOf(black));
  const hi = Math.max(rankOf(red), rankOf(black));
  for (let y = lo + 1; y < hi; y++) {
    if (board.at(squareOf(x, y))) return false;
  }
  return true;
}

/**
 * Is `color`'s king un-attacked right now? This is the single predicate move legality is built on, so
 * it has to cover both ways a king can be taken: an ordinary attack, and the kings facing each other.
 */
export function isKingSafe(board: Board, color: Color): boolean {
  const king = board.kingSq[color];
  if (king < 0) return false;
  if (isSquareAttacked(board, king, color === 'red' ? 'black' : 'red')) return false;
  return !kingsFaceEachOther(board);
}

export { FILES, RANKS };
