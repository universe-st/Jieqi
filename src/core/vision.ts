/**
 * 迷雾 mode (rules V1–V3) — what each side can see, and the fogged views built from it.
 *
 * ## Vision (rule V1/V2)
 *
 * A piece's vision is its own square, the eight squares around it (up/down/left/right and the four
 * diagonals), and every square it can reach in one move. Two pieces are worth spelling out:
 *
 * - the **cannon** sees the empty squares along its four rays *and* the first piece beyond a screen —
 *   it captures over a piece, so it can see the thing on the far side (rule V2's own example) — but
 *   not the screen itself;
 * - the **king**, in 迷雾 mode, sees the enemy king along a clear, *visible* file, because the flying
 *   general lets it take it (rule F2).
 *
 * A face-down piece sees with the vision of the square it stands on (rule V3) — `movementOf()` is the
 * shared source of truth for "how does this piece move right now", and vision mirrors it exactly. Once
 * a piece is turned over it sees with its true identity, the same way it moves with it.
 *
 * ## Why the engine computes vision from the truth
 *
 * `visibleSquares` reads the engine's board — every piece, every identity, every square — because
 * visibility is a *physical* question (which pieces stand where, and what each one's movement pattern
 * can reach) that both players answer with the same rule about the same world. The fog the UI draws is
 * exactly this set, and nothing on screen is ever allowed to reach past it.
 *
 * ## The cache
 *
 * Vision is a pure function of the position, and the position's Zobrist key is a pure function of it
 * too — a hidden piece's `homeKind` is fixed by the starting square it stands on, so two positions
 * with the same key always have the same homeKinds and hence the same vision. The search revisits a
 * position thousands of times across its sampled worlds, so the per-key cache is what keeps the fogged
 * AI's per-node facing checks free instead of recomputing the whole union every ply.
 */

import type { Board } from './board';
import {
  SQUARES,
  type Color,
  type Piece,
  crossedRiver,
  fileOf,
  forwardStep,
  inPalace,
  movementOf,
  onBoard,
  other,
  ownHalf,
  rankOf,
  squareOf,
} from './types';

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

const MAX_CACHE = 8192;

/**
 * `board.key → the full vision of both colours`, computed once per position.
 *
 * The key excludes `homeKind`, but that is sound: a face-down piece never moves, so it always stands
 * on its starting square, and `homeKind` is exactly the kind of that square — a function of the
 * arrangement the key *does* encode. Two same-key positions therefore have the same homeKinds and the
 * same vision, which is the whole reason a shared cache cannot go stale. (The only way to break that
 * is a hand-built board that puts a hidden piece on a square it was never dealt to — the real game
 * cannot produce one.)
 */
const visionCache = new Map<number, [Uint8Array, Uint8Array]>();

/** Test hook: the cache is global and keyed only by position, so hand-built boards that give a
 * hidden piece a `homeKind` its square was never dealt must not let one test read another's vision. */
export function resetVisionCache(): void {
  visionCache.clear();
}

function visionEntry(board: Board): [Uint8Array, Uint8Array] {
  const key = board.key;
  const hit = visionCache.get(key);
  if (hit) return hit;
  const red = new Uint8Array(SQUARES);
  const black = new Uint8Array(SQUARES);
  computeVisionInto(board, 'red', red);
  computeVisionInto(board, 'black', black);
  const entry: [Uint8Array, Uint8Array] = [red, black];
  if (visionCache.size >= MAX_CACHE) visionCache.clear();
  visionCache.set(key, entry);
  return entry;
}

function computeVisionInto(board: Board, color: Color, out: Uint8Array): void {
  for (let sq = 0; sq < SQUARES; sq++) {
    if (board.ownerAt(sq) !== color) continue;
    const piece = board.at(sq);
    if (!piece) continue;
    addPieceVision(board, sq, piece, out);
  }
  // Rule F2: a king that faces the enemy king along a clear, *visible* file can take it, so the enemy
  // king's square is part of the king's vision. Evaluated against the base `out` only, so it adds the
  // one square the facing condition earns and never feeds back into itself.
  if (board.fog) {
    const king = board.kingSq[color];
    const foe = board.kingSq[other(color)];
    if (king >= 0 && foe >= 0 && fileOf(king) === fileOf(foe)) {
      const lo = Math.min(rankOf(king), rankOf(foe));
      const hi = Math.max(rankOf(king), rankOf(foe));
      let clear = true;
      for (let y = lo + 1; y < hi; y++) {
        const at = squareOf(fileOf(king), y);
        if (board.at(at) || out[at] === 0) {
          clear = false;
          break;
        }
      }
      if (clear) out[foe] = 1;
    }
  }
}

/**
 * The squares `color` can see, as a `Set`. Cheap enough to call per move for the UI; the search's hot
 * paths use {@link isSquareSeen} instead, which allocates nothing.
 */
export function visibleSquares(board: Board, color: Color): Set<number> {
  const entry = visionEntry(board);
  const bits = entry[color === 'red' ? 0 : 1];
  const out = new Set<number>();
  for (let sq = 0; sq < SQUARES; sq++) {
    if (bits[sq] !== 0) out.add(sq);
  }
  return out;
}

/** Is a single square within `color`'s vision? Allocation-free, for the rules' hot paths. */
export function isSquareSeen(board: Board, color: Color, sq: number): boolean {
  const entry = visionEntry(board);
  return entry[color === 'red' ? 0 : 1][sq] !== 0;
}

/**
 * The board as `color` sees it: every piece the observer cannot see is gone, and the empty squares
 * it cannot see are its unknowns.
 *
 * The enemy king is the one piece with a position the observer may still reason about: it starts on
 * its home square, and once it has been seen the observer keeps *that* square until it is seen again
 * (`JieqiGame.kingSeen`). Pass that believed square in as `enemyKingAt` and the fogged board places
 * the king there instead of at its true square — a king hiding in the mist is then genuinely hidable.
 * Without the argument (the player's display-side fogged boards, the hints), the true square is kept,
 * because what the observer physically *sees* is the real position, not their belief.
 *
 * Everything else the observer cannot account for is treated as absent — the AI that reasons over
 * this board treats those squares as empty, which is the "看不见的敌子当作未知" contract the mode
 * promises.
 */
export function foggedBoardFor(board: Board, color: Color, enemyKingAt?: number): Board {
  const view = board.clone();
  const foe = other(color);
  for (let sq = 0; sq < SQUARES; sq++) {
    const piece = view.at(sq);
    if (!piece || piece.kind === 'K') continue;
    if (view.ownerAt(sq) !== foe) continue;
    if (!isSquareSeen(board, color, sq)) view.squares[sq] = null;
  }
  if (enemyKingAt !== undefined) {
    const trueSq = view.kingSq[foe];
    // Move the king to the believed square only when it is free — a square the observer can see
    // holding another piece is a square they know the king is not on, so the belief simply stays put.
    if (trueSq >= 0 && trueSq !== enemyKingAt && !view.at(enemyKingAt)) {
      const king = view.at(trueSq);
      if (king) {
        view.squares[trueSq] = null;
        view.squares[enemyKingAt] = king;
        view.kingSq[foe] = enemyKingAt;
      }
    }
  }
  view.rehash();
  return view;
}

/** Adds one piece's vision into the dense `out` bitmap. */
function addPieceVision(board: Board, sq: number, piece: Piece, out: Uint8Array): void {
  // A side always sees the pieces it controls — nobody plays a piece they cannot see.
  out[sq] = 1;
  const x = fileOf(sq);
  const y = rankOf(sq);

  // Rule V1: the eight surrounding squares are always visible.
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const tx = x + dx;
      const ty = y + dy;
      if (onBoard(tx, ty)) out[squareOf(tx, ty)] = 1;
    }
  }

  // Rule V2: every square the piece can reach in one move. The pattern is the movement rule itself
  // (rule V3 — a hidden piece sees with the square's own kind), so a destination is visible whenever
  // the piece could move there: empty, or occupied by an enemy it could capture.
  const { kind, mode } = movementOf(piece);
  const color = board.ownerAt(sq) ?? piece.color;
  const mark = (tx: number, ty: number): void => {
    if (onBoard(tx, ty)) out[squareOf(tx, ty)] = 1;
  };

  switch (kind) {
    case 'K': {
      for (const [dx, dy] of ORTHO) {
        const tx = x + dx;
        const ty = y + dy;
        if (onBoard(tx, ty) && inPalace(color, squareOf(tx, ty))) mark(tx, ty);
      }
      return;
    }
    case 'A': {
      for (const [dx, dy] of DIAGONAL) {
        const tx = x + dx;
        const ty = y + dy;
        if (!onBoard(tx, ty)) continue;
        if (mode === 'classic' && !inPalace(color, squareOf(tx, ty))) continue;
        mark(tx, ty);
      }
      return;
    }
    case 'E': {
      for (const [dx, dy] of DIAGONAL) {
        const tx = x + dx * 2;
        const ty = y + dy * 2;
        if (!onBoard(tx, ty)) continue;
        const target = squareOf(tx, ty);
        if (mode === 'classic' && !ownHalf(color, target)) continue;
        if (board.at(squareOf(x + dx, y + dy))) continue; // elephant eye
        mark(tx, ty);
      }
      return;
    }
    case 'H': {
      for (const [ax, ay] of HORSE) {
        const tx = x + ax;
        const ty = y + ay;
        if (!onBoard(tx, ty)) continue;
        const legX = Math.abs(ax) === 2 ? x + ax / 2 : x;
        const legY = Math.abs(ay) === 2 ? y + ay / 2 : y;
        if (board.at(squareOf(legX, legY))) continue; // horse leg
        mark(tx, ty);
      }
      return;
    }
    case 'R': {
      for (const [dx, dy] of ORTHO) {
        let tx = x + dx;
        let ty = y + dy;
        while (onBoard(tx, ty)) {
          mark(tx, ty);
          if (board.at(squareOf(tx, ty))) break; // the first blocker is where the ray stops
          tx += dx;
          ty += dy;
        }
      }
      return;
    }
    case 'C': {
      for (const [dx, dy] of ORTHO) {
        let tx = x + dx;
        let ty = y + dy;
        // The empty squares along the ray — where the cannon can move to.
        while (onBoard(tx, ty) && !board.at(squareOf(tx, ty))) {
          mark(tx, ty);
          tx += dx;
          ty += dy;
        }
        if (!onBoard(tx, ty)) continue;
        // The screen is skipped; the first piece *beyond* it is a capture target, and visible.
        tx += dx;
        ty += dy;
        while (onBoard(tx, ty)) {
          if (board.at(squareOf(tx, ty))) {
            mark(tx, ty);
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
      mark(x, y + forward);
      if (crossedRiver(color, sq)) {
        mark(x - 1, y);
        mark(x + 1, y);
      }
      return;
    }
  }
}
