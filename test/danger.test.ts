/**
 * 吃子提示 tests — the three clauses of "this piece can be taken for nothing".
 *
 * The predicate is small, so the interesting part is not that it finds a hanging rook but that it
 * refuses the near-misses: a defended piece, a piece whose capture would cost the capturer their own
 * general (送将), and a general at all — which is 将军, not material. Each of those is a test below, and
 * each one names the clause it is exercising so a future change to the rule has to argue with it.
 */

import { describe, expect, it } from 'vitest';

import { hangingSquares, isHanging } from '../src/core/danger';
import { generateMoves, isSquareAttacked } from '../src/core/moves';
import { squareOf } from '../src/core/types';
import { emptyBoard, finalize, fromAscii, put, putHidden } from './support/position';

/** Red king bottom-centre, black king off to one side: a legal, quiet backdrop for every diagram. */
const QUIET = `
  . . . k . . . . .
  . . . . . . . . .
  . . . . . . . . .
  . . . . . . . . .
  . . . . . . . . .
  . . . . . . . . .
  . . . . . . . . .
  . . . . . . . . .
  . . . . . . . . .
  . . . . K . . . .
`;

describe('吃子提示', () => {
  it('clause 1: reports a piece an enemy rook can take and nothing defends', () => {
    const board = fromAscii(QUIET);
    put(board, 'black', 'R', 0, 4); // lowercase r in a diagram, placed here so the square is explicit
    const horse = put(board, 'red', 'H', 0, 5);
    finalize(board);

    expect(isHanging(board, horse)).toBe(true);
    expect(hangingSquares(board, 'red')).toEqual([horse]);
    // The rook is looking down an empty file, so nothing threatens it back.
    expect(hangingSquares(board, 'black')).toEqual([]);
  });

  it('clause 2: clears the piece as soon as a friendly piece defends the square', () => {
    const board = fromAscii(QUIET);
    put(board, 'black', 'R', 0, 4);
    const horse = put(board, 'red', 'H', 0, 5);
    // The same rook the diagram above used, one square further down: now the capture only trades.
    put(board, 'red', 'R', 0, 6);
    finalize(board);

    expect(isHanging(board, horse)).toBe(false);
    expect(hangingSquares(board, 'red')).not.toContain(horse);
  });

  it('clause 3: a capture that would expose the capturer to 将 is not a threat', () => {
    // Black's general stands on the a-file behind its own rook, and a red rook at the bottom of that
    // file is aimed straight through it: the black rook is *pinned*. The red horse beside it is
    // therefore not takeable — stepping off the file would give the general away.
    const pinned = emptyBoard('red');
    put(pinned, 'black', 'K', 0, 0);
    put(pinned, 'red', 'K', 4, 9);
    put(pinned, 'black', 'R', 0, 4);
    put(pinned, 'red', 'R', 0, 8);
    const horse = put(pinned, 'red', 'H', 1, 4);
    finalize(pinned);

    // The capture is in the move list, so the `false` below is clause 3 doing the work and not the
    // generator quietly leaving the move out.
    expect(generateMoves(pinned, 'black').some((move) => move.to === horse)).toBe(true);
    expect(isHanging(pinned, horse)).toBe(false);
    expect(hangingSquares(pinned, 'red')).not.toContain(horse);

    // Take the pin away and the very same horse is free: nothing about the horse changed, only the
    // rook behind the black one.
    const free = emptyBoard('red');
    put(free, 'black', 'K', 0, 0);
    put(free, 'red', 'K', 4, 9);
    put(free, 'black', 'R', 0, 4);
    const exposed = put(free, 'red', 'H', 1, 4);
    finalize(free);

    expect(isHanging(free, exposed)).toBe(true);
  });

  it('never reports a general, on either side', () => {
    // A black rook staring at the red 帅 with nothing in between: that is 将军 — an attack on the king
    // and nothing defending it — and yet not a "hanging piece". The board announces 将军 with a glow of
    // its own, and in a legal position a general is never simply taken.
    const board = fromAscii(QUIET);
    put(board, 'black', 'R', 4, 4);
    finalize(board);

    expect(isSquareAttacked(board, squareOf(4, 9), 'black')).toBe(true);
    expect(isHanging(board, squareOf(4, 9))).toBe(false);
    expect(hangingSquares(board, 'red')).toEqual([]);
    // The black rook is not hanging either — nothing attacks it.
    expect(hangingSquares(board, 'black')).toEqual([]);
  });

  it('reads a threat by the square a face-down piece stands on (rule R4)', () => {
    // A black 暗子 dealt to a 车 square: it is *really* a 兵, and it will never move, so nobody ever
    // learns that — but its threat is a rook's threat, and this is the whole of R4.
    const board = fromAscii(QUIET);
    const disguised = putHidden(board, 'black', 'P', 'R', 0, 0);
    const horse = put(board, 'red', 'H', 0, 5);
    finalize(board);
    expect(disguised).toBe(squareOf(0, 0));

    expect(isHanging(board, horse)).toBe(true);
    expect(hangingSquares(board, 'red')).toEqual([horse]);

    // The control: the same piece revealed as the pawn it is reaches one square and no further.
    const honest = fromAscii(QUIET);
    put(honest, 'black', 'P', 0, 0);
    const safe = put(honest, 'red', 'H', 0, 5);
    finalize(honest);
    expect(isHanging(honest, safe)).toBe(false);
  });

  it('answers for both sides in one pass', () => {
    const board = fromAscii(QUIET);
    put(board, 'red', 'R', 0, 4); // threatens down the a-file
    put(board, 'black', 'H', 0, 5); // the piece it threatens, undefended
    put(board, 'black', 'R', 8, 7); // threatens down the i-file
    put(board, 'red', 'H', 8, 8); // the piece *that* threatens, undefended
    finalize(board);

    expect(hangingSquares(board, 'red')).toEqual([squareOf(8, 8)]);
    expect(hangingSquares(board, 'black')).toEqual([squareOf(0, 5)]);
  });
});
