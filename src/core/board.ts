/**
 * The board: a 90-slot array plus everything the engine needs to make and unmake a move in constant
 * time (king squares and an incremental Zobrist key).
 *
 * Make/unmake instead of copy-on-write is what makes a 240k-node search affordable on a phone; the UI
 * layer never needs this and uses `clone()` once per real move.
 */

import {
  ARMY_LIST,
  FILES,
  SQUARES,
  START_SQUARES,
  type Color,
  type Kind,
  type Piece,
  other,
  squareOf,
} from './types';

/** Zobrist halves are kept as two `int32`s and folded into one exact 53-bit double on demand. */
export interface ZobristKey {
  readonly h1: number;
  readonly h2: number;
}

const KIND_INDEX: Readonly<Record<Kind, number>> = {
  K: 0,
  A: 1,
  E: 2,
  H: 3,
  R: 4,
  C: 5,
  P: 6,
};
/** (colour × kind) × hidden — 28 distinct piece codes. */
export const CODE_COUNT = 2 * 7 * 2;

export function codeOf(piece: Piece): number {
  const color = piece.color === 'red' ? 0 : 1;
  return ((color * 7 + (KIND_INDEX[piece.kind] as number)) << 1) | (piece.hidden ? 1 : 0);
}

function buildZobrist(): { z1: Int32Array; z2: Int32Array; side1: number; side2: number } {
  // A fixed seed: the keys must be identical on every run, otherwise a saved game or a golden test
  // would depend on load order.
  let s = 0x9e3779b9 >>> 0;
  const next = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) | 0;
  };
  const z1 = new Int32Array(SQUARES * CODE_COUNT);
  const z2 = new Int32Array(SQUARES * CODE_COUNT);
  for (let i = 0; i < z1.length; i++) {
    z1[i] = next();
    z2[i] = next();
  }
  return { z1, z2, side1: next(), side2: next() };
}

const Z = buildZobrist();

/**
 * Which kind belongs to which starting square, for both colours. Used to assert the invariant that a
 * hidden piece is always still standing on its home square (it can never move while face down), which
 * is also why `homeKind` does not need to be part of the Zobrist key.
 */
export const HOME_KIND_BY_SQUARE: ReadonlyMap<number, Kind> = new Map(
  [...START_SQUARES.red, ...START_SQUARES.black].map((s) => [s.square, s.kind]),
);

/** Everything needed to put the board back exactly as it was before a move. */
export interface Undo {
  readonly from: number;
  readonly to: number;
  readonly movedBefore: Piece;
  readonly captured: Piece | null;
  readonly prevSide: Color;
  readonly prevKingRed: number;
  readonly prevKingBlack: number;
  readonly prevH1: number;
  readonly prevH2: number;
}

export class Board {
  readonly squares: (Piece | null)[] = new Array<null>(SQUARES).fill(null);
  side: Color = 'red';
  kingSq: Record<Color, number> = { red: -1, black: -1 };
  h1 = 0;
  h2 = 0;

  static empty(): Board {
    return new Board();
  }

  /**
   * Deals a fresh game: the king face up on its home square (rule R2), the other fifteen identities
   * shuffled face down onto that side's fifteen remaining starting squares (rule R3).
   *
   * `shuffled` supplies the order; the caller owns the randomness so a seed reproduces a game.
   */
  static deal(shuffled: Readonly<Record<Color, readonly Kind[]>>, nextIdStart = 1): Board {
    const board = new Board();
    let id = nextIdStart;
    for (const color of ['red', 'black'] as const) {
      const starts = START_SQUARES[color];
      const pool = shuffled[color];
      let poolIndex = 0;
      for (const start of starts) {
        if (start.kind === 'K') {
          board.squares[start.square] = {
            id: id++,
            color,
            kind: 'K',
            homeKind: 'K',
            hidden: false,
          };
          board.kingSq[color] = start.square;
          continue;
        }
        const kind = pool[poolIndex++];
        if (kind === undefined) throw new Error(`${color}: deal pool exhausted`);
        board.squares[start.square] = { id: id++, color, kind, homeKind: start.kind, hidden: true };
      }
    }
    board.side = 'red';
    board.rehash();
    return board;
  }

  clone(): Board {
    const copy = new Board();
    for (let i = 0; i < SQUARES; i++) copy.squares[i] = this.squares[i] ?? null;
    copy.side = this.side;
    copy.kingSq = { red: this.kingSq.red, black: this.kingSq.black };
    copy.h1 = this.h1;
    copy.h2 = this.h2;
    return copy;
  }

  at(sq: number): Piece | null {
    return this.squares[sq] ?? null;
  }

  get key(): number {
    // Fold two int32 halves into an exact double: 32 + 21 = 53 significant bits.
    return this.h1 * 2097152 + (this.h2 >>> 11);
  }

  get keyPair(): ZobristKey {
    return { h1: this.h1, h2: this.h2 };
  }

  rehash(): void {
    let h1 = 0;
    let h2 = 0;
    for (let sq = 0; sq < SQUARES; sq++) {
      const piece = this.squares[sq];
      if (!piece) continue;
      const index = sq * CODE_COUNT + codeOf(piece);
      h1 ^= Z.z1[index] as number;
      h2 ^= Z.z2[index] as number;
      if (piece.kind === 'K') this.kingSq[piece.color] = sq;
    }
    if (this.side === 'black') {
      h1 ^= Z.side1;
      h2 ^= Z.side2;
    }
    this.h1 = h1;
    this.h2 = h2;
  }

  /** Applies a move. The caller must pass a pseudo-legal move; legality is checked in `rules.ts`. */
  makeMove(from: number, to: number): Undo {
    const moved = this.squares[from];
    if (!moved) throw new Error(`makeMove: no piece on square ${from}`);
    const captured = this.squares[to] ?? null;

    const undo: Undo = {
      from,
      to,
      movedBefore: moved,
      captured,
      prevSide: this.side,
      prevKingRed: this.kingSq.red,
      prevKingBlack: this.kingSq.black,
      prevH1: this.h1,
      prevH2: this.h2,
    };

    this.h1 ^= Z.z1[from * CODE_COUNT + codeOf(moved)] as number;
    this.h2 ^= Z.z2[from * CODE_COUNT + codeOf(moved)] as number;
    if (captured) {
      this.h1 ^= Z.z1[to * CODE_COUNT + codeOf(captured)] as number;
      this.h2 ^= Z.z2[to * CODE_COUNT + codeOf(captured)] as number;
    }

    // Rule R5: a hidden piece is turned face up as part of its move, and loses its square-based
    // movement from that moment on.
    const next: Piece = moved.hidden ? { ...moved, hidden: false } : moved;

    this.squares[from] = null;
    this.squares[to] = next;
    this.h1 ^= Z.z1[to * CODE_COUNT + codeOf(next)] as number;
    this.h2 ^= Z.z2[to * CODE_COUNT + codeOf(next)] as number;

    if (next.kind === 'K') this.kingSq[next.color] = to;

    this.side = other(this.side);
    this.h1 ^= Z.side1;
    this.h2 ^= Z.side2;

    return undo;
  }

  unmakeMove(undo: Undo): void {
    this.squares[undo.from] = undo.movedBefore;
    this.squares[undo.to] = undo.captured;
    this.side = undo.prevSide;
    this.kingSq.red = undo.prevKingRed;
    this.kingSq.black = undo.prevKingBlack;
    this.h1 = undo.prevH1;
    this.h2 = undo.prevH2;
  }

  /** Every piece of `color` still on the board, with its square. */
  piecesOf(color: Color): { square: number; piece: Piece }[] {
    const out: { square: number; piece: Piece }[] = [];
    for (let sq = 0; sq < SQUARES; sq++) {
      const piece = this.squares[sq];
      if (piece && piece.color === color) out.push({ square: sq, piece });
    }
    return out;
  }

  pieceById(id: number): { square: number; piece: Piece } | null {
    for (let sq = 0; sq < SQUARES; sq++) {
      const piece = this.squares[sq];
      if (piece && piece.id === id) return { square: sq, piece };
    }
    return null;
  }

  /** Counts of a side's pieces by *true* identity — engine-side only, never shown to a player. */
  countsByKind(color: Color): Record<Kind, number> {
    const counts: Record<Kind, number> = { K: 0, A: 0, E: 0, H: 0, R: 0, C: 0, P: 0 };
    for (const { piece } of this.piecesOf(color)) counts[piece.kind] += 1;
    return counts;
  }

  /** Squares of a side's faces-down pieces, in ascending square order (canonical for sampling). */
  hiddenSquares(color: Color): number[] {
    const out: number[] = [];
    for (let sq = 0; sq < SQUARES; sq++) {
      const piece = this.squares[sq];
      if (piece && piece.color === color && piece.hidden) out.push(sq);
    }
    return out;
  }

  /** Renders the board as ten 9-character rows, using the *engine's* view (identities revealed). */
  toAscii(): string {
    const glyph: Record<Kind, string> = { K: 'k', A: 'a', E: 'e', H: 'h', R: 'r', C: 'c', P: 'p' };
    const rows: string[] = [];
    for (let y = 0; y < 10; y++) {
      let row = '';
      for (let x = 0; x < FILES; x++) {
        const piece = this.at(squareOf(x, y));
        if (!piece) {
          row += '.';
          continue;
        }
        const letter = glyph[piece.kind];
        row += piece.color === 'red' ? letter.toUpperCase() : letter;
      }
      rows.push(row);
    }
    return rows.join('\n');
  }
}

/** The fifteen identities a side shuffles onto its fifteen non-king starting squares. */
export function armyList(): Kind[] {
  return [...ARMY_LIST];
}
