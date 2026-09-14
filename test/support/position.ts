/**
 * Test helpers for building positions by hand.
 *
 * The rules of jieqi hinge on the difference between a piece's *identity* and the *square* it was dealt
 * to, so the builder always lets a test state both — that is the only way to write a test that would
 * fail if `moves.ts` confused the two.
 */

import { Board } from '../../src/core/board';
import { SQUARES, type Color, type Kind, type Piece, squareOf } from '../../src/core/types';

let nextId = 1;

export function resetIds(): void {
  nextId = 1;
}

export function emptyBoard(side: Color = 'red'): Board {
  const board = Board.empty();
  board.side = side;
  return board;
}

export function makePiece(
  color: Color,
  kind: Kind,
  options: { hidden?: boolean; homeKind?: Kind } = {},
): Piece {
  const hidden = options.hidden ?? false;
  return {
    id: nextId++,
    color,
    kind,
    homeKind: options.homeKind ?? kind,
    hidden,
  };
}

export function put(
  board: Board,
  color: Color,
  kind: Kind,
  x: number,
  y: number,
  options: { hidden?: boolean; homeKind?: Kind } = {},
): number {
  const sq = squareOf(x, y);
  board.squares[sq] = makePiece(color, kind, options);
  if (kind === 'K' && !(options.hidden ?? false)) board.kingSq[color] = sq;
  return sq;
}

/** Places a face-down piece whose *identity* is `kind` but which moves as `homeKind`. */
export function putHidden(
  board: Board,
  color: Color,
  kind: Kind,
  homeKind: Kind,
  x: number,
  y: number,
): number {
  return put(board, color, kind, x, y, { hidden: true, homeKind });
}

export function finalize(board: Board): Board {
  board.rehash();
  return board;
}

export function findSquare(board: Board, color: Color, kind: Kind, hidden?: boolean): number {
  for (let sq = 0; sq < SQUARES; sq++) {
    const piece = board.at(sq);
    if (!piece) continue;
    if (piece.color !== color || piece.kind !== kind) continue;
    if (hidden !== undefined && piece.hidden !== hidden) continue;
    return sq;
  }
  return -1;
}

/**
 * Parses a `9×10` grid. Upper case is red, lower case is black, `.` is empty; all pieces revealed.
 * Whitespace inside a row is ignored, so diagrams can be written with spaces between the cells.
 */
export function fromAscii(text: string, side: Color = 'red'): Board {
  const rows = text
    .trim()
    .split('\n')
    .map((line) => line.replace(/\s+/g, ''))
    .filter((line) => line.length > 0);
  if (rows.length !== 10) throw new Error(`fromAscii: expected 10 rows, got ${rows.length}`);
  const board = emptyBoard(side);
  const glyph: Record<string, Kind> = {
    k: 'K',
    a: 'A',
    e: 'E',
    h: 'H',
    r: 'R',
    c: 'C',
    p: 'P',
  };
  rows.forEach((row, y) => {
    if (row.length !== 9) throw new Error(`fromAscii: row ${y} has ${row.length} files`);
    for (let x = 0; x < 9; x++) {
      const ch = row[x] as string;
      if (ch === '.') continue;
      const kind = glyph[ch.toLowerCase()];
      if (!kind) throw new Error(`fromAscii: unknown glyph '${ch}'`);
      put(board, ch === ch.toUpperCase() ? 'red' : 'black', kind, x, y);
    }
  });
  return finalize(board);
}

/** `move(from, to)` shorthand that reads better in assertions. */
export function mv(from: number, to: number): { from: number; to: number } {
  return { from, to };
}

export function squareName(sq: number): string {
  return `${sq % 9},${(sq / 9) | 0}`;
}
