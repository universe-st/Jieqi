/**
 * 迷雾 mode tests — the vision rule (V1–V3), the fogged 将帅碰头 (F1/F2), and the fogged board the
 * search reasons over.
 *
 * The vision functions are pure, so most tests are "build a board, ask what one side can see, read
 * the set". The facing tests are where the rule's sharp edge lives: a clear file the checked side
 * cannot see is *not* a facing, and a facing the checked side *can* see is a flying capture.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { fogCandidates, chooseMove } from '../src/ai/engine';
import {
  canDuelFog,
  generateMoves,
  isKingSafe,
  isKingSafeAfter,
  kingsFaceEachOtherFog,
} from '../src/core/moves';
import { JieqiGame } from '../src/core/rules';
import { foggedBoardFor, isSquareSeen, resetVisionCache, visibleSquares } from '../src/core/vision';
import type { Board } from '../src/core/board';
import type { Piece, Move } from '../src/core/types';
import { emptyBoard, finalize, fromAscii, put, putHidden, mv } from './support/position';
import { SQUARES } from '../src/core/types';

const sq = (name: string): number => {
  const [x, y] = name.split(',').map((part) => Number(part));
  return (y as number) * 9 + (x as number);
};
const squareName = (s: number): string => `${s % 9},${(s / 9) | 0}`;
const names = (board: Board, color: 'red' | 'black'): string[] =>
  [...visibleSquares(board, color)].map(squareName).sort();

/** The quiet two-king backdrop used across the vision diagrams. */
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

/**
 * A fog game whose board has been overwritten with a hand-built position. The game object keeps the
 * deal's fog flag, side and repetition map; the position itself is whatever the test wants.
 */
function fogGameWith(seed: number): JieqiGame {
  const game = JieqiGame.create({ mode: 'fog', seed });
  for (let sq = 0; sq < SQUARES; sq++) game.board.squares[sq] = null;
  return game;
}

describe('视野 (vision)', () => {
  beforeEach(() => {
    resetVisionCache();
  });

  it('a side always sees its own pieces, even one standing alone in enemy country', () => {
    const board = fromAscii(QUIET);
    // A red pawn alone deep in black's back ranks, far from every other red piece.
    put(board, 'red', 'P', 4, 0);
    finalize(board);
    const seen = visibleSquares(board, 'red');
    expect(seen.has(sq('4,0'))).toBe(true);
  });

  it('a piece sees the eight surrounding squares, at the edge clamped to the board', () => {
    const board = fromAscii(QUIET);
    // A pawn has no long rays, so the neighbour ring is the whole of its peripheral vision.
    put(board, 'red', 'P', 0, 5);
    finalize(board);
    const seen = names(board, 'red');
    for (const expected of ['0,4', '1,4', '0,5', '1,5', '0,6', '1,6']) {
      expect(seen).toContain(expected);
    }
    expect(seen).not.toContain('8,5');
  });

  it('a rook sees along its rays to the first blocker, and the blocker itself', () => {
    const board = fromAscii(QUIET);
    put(board, 'red', 'R', 4, 4);
    // A black pawn on the same file stops the ray; the square beyond it is not visible.
    put(board, 'black', 'P', 4, 6);
    finalize(board);
    const seen = visibleSquares(board, 'red');
    for (const expected of ['4,3', '4,5', '4,6']) expect(seen.has(sq(expected))).toBe(true);
    expect(seen.has(sq('4,7'))).toBe(false);
  });

  it('a cannon sees past its screen to the piece beyond, but not the screen itself', () => {
    const board = fromAscii(QUIET);
    put(board, 'red', 'C', 4, 4);
    // A black rook screens the file; the black pawn behind it is the capture target.
    put(board, 'black', 'R', 4, 6);
    put(board, 'black', 'P', 4, 8);
    finalize(board);
    const seen = visibleSquares(board, 'red');
    // The empty squares up to the screen.
    expect(seen.has(sq('4,3'))).toBe(true);
    expect(seen.has(sq('4,5'))).toBe(true);
    // The far-side pawn is visible (it can be captured over the screen)…
    expect(seen.has(sq('4,8'))).toBe(true);
    // …but the screen itself is not a destination, so this ray does not reveal it.
    expect(seen.has(sq('4,6'))).toBe(false);
  });

  it('a hidden piece sees with the vision of the square it stands on (rule V3)', () => {
    const board = fromAscii(QUIET);
    // A hidden piece whose true identity is a rook, but which sits on a pawn square and so moves —
    // and sees — as a pawn: forward one, sideways once it has crossed the river.
    putHidden(board, 'red', 'R', 'P', 4, 3);
    finalize(board);
    const seen = visibleSquares(board, 'red');
    // The pawn's forward step is in vision…
    expect(seen.has(sq('4,2'))).toBe(true);
    // …but the rook's long rays are not: a real rook here would see (4,7) down its file, the hidden
    // pawn does not. (The red king at (4,9) sees (4,8) regardless, which is why the assertion uses
    // (4,7) instead of the king's own doorstep.)
    expect(seen.has(sq('4,7'))).toBe(false);
  });

  it('once revealed, a piece sees as its true identity', () => {
    const board = fromAscii(QUIET);
    putHidden(board, 'red', 'R', 'P', 4, 3);
    const at = board.at(sq('4,3')) as Piece;
    board.squares[sq('4,3')] = { ...at, hidden: false };
    finalize(board);
    const seen = visibleSquares(board, 'red');
    expect(seen.has(sq('4,0'))).toBe(true);
    expect(seen.has(sq('4,8'))).toBe(true);
  });

  it('a horse cannot see past its own leg', () => {
    const board = fromAscii(QUIET);
    put(board, 'red', 'H', 4, 4);
    // A black pawn sits one step up, blocking the horse's two forward jumps.
    put(board, 'black', 'P', 4, 3);
    finalize(board);
    const seen = visibleSquares(board, 'red');
    expect(seen.has(sq('5,2'))).toBe(false);
    expect(seen.has(sq('3,2'))).toBe(false);
    // The unblocked backward jumps still show.
    expect(seen.has(sq('5,6'))).toBe(true);
  });

  it('the fogged board keeps what the player can see and drops what they cannot', () => {
    const board = fromAscii(QUIET);
    // Red's rook at the bottom of the a-file; black's rook on the same file, in its ray.
    put(board, 'red', 'R', 0, 9);
    put(board, 'black', 'R', 0, 2);
    // A black pawn far away, in no red piece's vision.
    put(board, 'black', 'P', 8, 1);
    finalize(board);
    const view = foggedBoardFor(board, 'red');
    expect(view.at(sq('0,2'))).not.toBeNull();
    expect(view.at(sq('8,1'))).toBeNull();
    // Without a believed-king override (the player's display-side boards), the enemy king stays at
    // its true square: what the observer physically sees is the real position.
    expect(view.kingSq.black).toBe(board.kingSq.black);
  });

  it('the AI-side fogged board places the enemy king where it was last seen, not where it is', () => {
    const board = fromAscii(QUIET);
    board.fog = true;
    // Black (the observer) believes the red king is at (4,2); the real king is at (4,9).
    const view = foggedBoardFor(board, 'black', sq('4,2'));
    expect(view.kingSq.red).toBe(sq('4,2'));
    expect(view.at(sq('4,9'))).toBeNull();
    expect(view.at(sq('4,2'))?.kind).toBe('K');
  });

  it('a believed king square the observer can see holding another piece is not overwritten', () => {
    const board = fromAscii(QUIET);
    board.fog = true;
    // The believed square (4,2) holds a black rook — black's own piece, always in its own view, so
    // the AI would *know* the king is not there; the belief stays at the true square instead.
    put(board, 'black', 'R', 4, 2);
    finalize(board);
    const view = foggedBoardFor(board, 'black', sq('4,2'));
    expect(view.kingSq.red).toBe(sq('4,9'));
  });
});

describe('将帅碰头 in fog (F1) — the check half, and 一骑讨 (F6) — the attacker\'s option', () => {
  beforeEach(() => {
    resetVisionCache();
  });

  function facingBoard(redY: number, blackY: number): Board {
    const board = emptyBoard('red');
    board.fog = true;
    put(board, 'red', 'K', 4, redY);
    put(board, 'black', 'K', 4, blackY);
    return finalize(board);
  }

  it('a file swallowed by fog is not a facing, even with nothing between the kings', () => {
    const board = facingBoard(9, 0);
    // Red has no piece that sees the middle of the file: the kings physically face, but the fog
    // keeps the line invisible, so no flying general exists and neither king is in check from it.
    expect(kingsFaceEachOtherFog(board, 'red')).toBe(false);
    expect(kingsFaceEachOtherFog(board, 'black')).toBe(false);
    expect(canDuelFog(board, 'red')).toBe(false);
    expect(isKingSafe(board, 'red')).toBe(true);
    expect(isKingSafe(board, 'black')).toBe(true);
  });

  it('a clear file the checked side can see is a real facing — and only for that side', () => {
    const board = facingBoard(9, 5);
    // Red sees every square of the short line: the king's own neighbour (4,8), a rook at (5,7)
    // looking across to (4,7), and a rook at (5,6) looking across to (4,6).
    put(board, 'red', 'R', 5, 7);
    put(board, 'red', 'R', 5, 6);
    finalize(board);
    expect(kingsFaceEachOtherFog(board, 'red')).toBe(true);
    // The same line opens the 一骑讨 to the attacker: the enemy king is in red's vision.
    expect(canDuelFog(board, 'red')).toBe(true);
    // Black's king sees only its own doorstep of the line — the fog holds the rest — so black does
    // not face anything it can answer, and cannot duel a king it cannot see.
    expect(kingsFaceEachOtherFog(board, 'black')).toBe(false);
    expect(canDuelFog(board, 'black')).toBe(false);
    expect(isKingSafe(board, 'red')).toBe(false);
    expect(isKingSafe(board, 'black')).toBe(true);
  });

  it('the king gains the duel against the enemy king along a visible, clear file (rule F6)', () => {
    const board = facingBoard(9, 4);
    put(board, 'red', 'R', 5, 7);
    put(board, 'red', 'R', 5, 6);
    put(board, 'red', 'R', 5, 5);
    finalize(board);
    expect(kingsFaceEachOtherFog(board, 'red')).toBe(true);
    const moves = generateMoves(board, 'red', []);
    expect(moves.some((m) => m.from === sq('4,9') && m.to === sq('4,4'))).toBe(true);
  });

  it('a won duel removes the enemy king from the board (rule F6 victory)', () => {
    const board = facingBoard(9, 4);
    put(board, 'red', 'R', 5, 7);
    put(board, 'red', 'R', 5, 6);
    put(board, 'red', 'R', 5, 5);
    finalize(board);
    const capture = { from: sq('4,9'), to: sq('4,4') };
    expect(isKingSafeAfter(board, 'red', capture)).toBe(true);
    board.makeMove(capture.from, capture.to);
    expect(board.kingSq.black).toBe(-1);
    expect(isKingSafe(board, 'black')).toBe(false);
  });

  it('moving into a visible facing leaves the king exposed — a blunder under F4, not an illegality', () => {
    const board = facingBoard(9, 4);
    // The blocker: a red rook on the file between the kings.
    put(board, 'red', 'R', 4, 5);
    // After the blocker leaves the file, red sees the whole line (king's neighbour + three rooks).
    put(board, 'red', 'R', 5, 7);
    put(board, 'red', 'R', 5, 6);
    put(board, 'red', 'R', 5, 5);
    finalize(board);
    const rookAway = { from: sq('4,5'), to: sq('3,5') };
    // The file (4,5)…(4,8) is clear and fully visible to red once the rook steps off it: the move
    // leaves the red general facing. Under rule F4 (迷雾 = 吃王棋) that is *legal* — 送将 is no longer
    // an illegality — so `isKingSafeAfter` still reports the exposure (it is a blunder worth the
    // general), but the legality filter no longer exists in fog.
    expect(isKingSafeAfter(board, 'red', rookAway)).toBe(false);
  });

  it('moving into a facing only the mover cannot see stays legal — the fog hides the cost', () => {
    const board = facingBoard(9, 0);
    // The blocker, and nothing that would see the line after it leaves: red's king sees only (4,8)
    // of the long file, the rook at (3,5) sees only (4,5). The rest stays mist.
    put(board, 'red', 'R', 4, 5);
    finalize(board);
    const rookAway = { from: sq('4,5'), to: sq('3,5') };
    expect(kingsFaceEachOtherFog(board, 'red')).toBe(false);
    expect(isKingSafeAfter(board, 'red', rookAway)).toBe(true);
  });
});

describe('一骑讨 (rule F6, 2026-09-15) — the risky flying general', () => {
  beforeEach(() => {
    resetVisionCache();
  });

  function duelBoard(redY: number, blackY: number): Board {
    const board = emptyBoard('red');
    board.fog = true;
    put(board, 'red', 'K', 4, redY);
    put(board, 'black', 'K', 4, blackY);
    return finalize(board);
  }

  it('a visible piece on the file blocks the attempt', () => {
    const board = duelBoard(9, 5);
    // The rook on the rank sees the black king at (4,5) along its ray; the hidden black piece at
    // (4,6) is made visible by the rook at (3,6) — a *visible* blocker, so no duel is offered.
    put(board, 'red', 'R', 0, 5);
    putHidden(board, 'black', 'P', 'R', 4, 6);
    put(board, 'red', 'R', 3, 6);
    finalize(board);
    expect(canDuelFog(board, 'red')).toBe(false);
    expect(generateMoves(board, 'red', []).some((m) => m.from === sq('4,9') && m.to === sq('4,5'))).toBe(false);
  });

  it('a hidden piece on the file is the gamble — the attempt is offered, the true line decides', () => {
    const board = duelBoard(9, 5);
    // The rook at (0,5) sees the black king at (4,5) along its rank ray. The hidden black piece at
    // (4,6) stands on the file but in fog — no red vision touches it — so red may attempt the duel
    // and must gamble on whether the file is really clear.
    put(board, 'red', 'R', 0, 5);
    putHidden(board, 'black', 'P', 'R', 4, 6);
    finalize(board);
    expect(canDuelFog(board, 'red')).toBe(true);
    const moves = generateMoves(board, 'red', []);
    expect(moves.some((m) => m.from === sq('4,9') && m.to === sq('4,5'))).toBe(true);
    // Resolution against the truth: the hidden piece is there, so the charging red king dies on it;
    // the enemy king never moved.
    board.makeMove(sq('4,9'), sq('4,5'));
    expect(board.kingSq.red).toBe(-1);
    expect(board.kingSq.black).toBe(sq('4,5'));
    expect(board.at(sq('4,6'))).not.toBeNull();
  });

  it('apply() reports a won duel: enemy king captured, game over, red wins', () => {
    const game = fogGameWith(13);
    const board = game.board;
    put(board, 'red', 'K', 4, 9);
    put(board, 'black', 'K', 4, 4);
    put(board, 'red', 'R', 5, 7);
    put(board, 'red', 'R', 5, 6);
    put(board, 'red', 'R', 5, 5);
    finalize(board);
    const duel = mv(sq('4,9'), sq('4,4'));
    expect(game.isSelectable(duel)).toBe(true);
    const event = game.apply(duel);
    expect(event.duel).not.toBeNull();
    expect(event.duel?.won).toBe(true);
    expect(event.duel?.line).toEqual([sq('4,5'), sq('4,6'), sq('4,7'), sq('4,8')]);
    expect(event.duel?.blocker).toBeNull();
    expect(event.captured?.kind).toBe('K');
    expect(game.board.kingSq.black).toBe(-1);
    expect(game.result?.winner).toBe('red');
  });

  it('apply() reports a lost duel: charging king dies on the hidden blocker, black wins', () => {
    const game = fogGameWith(14);
    const board = game.board;
    put(board, 'red', 'K', 4, 9);
    put(board, 'black', 'K', 4, 5);
    put(board, 'red', 'R', 0, 5);
    putHidden(board, 'black', 'P', 'R', 4, 6);
    finalize(board);
    const duel = mv(sq('4,9'), sq('4,5'));
    expect(game.isSelectable(duel)).toBe(true);
    const event = game.apply(duel);
    expect(event.duel).not.toBeNull();
    expect(event.duel?.won).toBe(false);
    expect(event.duel?.blocker).toBe(sq('4,6'));
    expect(event.captured).toBeNull();
    expect(game.board.kingSq.red).toBe(-1);
    expect(game.board.kingSq.black).toBe(sq('4,5'));
    expect(game.result?.winner).toBe('black');
    expect(game.result?.text).toContain('被吃');
  });

  it('undo restores a lost duel completely', () => {
    const game = fogGameWith(15);
    const board = game.board;
    put(board, 'red', 'K', 4, 9);
    put(board, 'black', 'K', 4, 5);
    put(board, 'red', 'R', 0, 5);
    putHidden(board, 'black', 'P', 'R', 4, 6);
    finalize(board);
    game.apply(mv(sq('4,9'), sq('4,5')));
    expect(game.board.kingSq.red).toBe(-1);
    game.undo();
    expect(game.board.kingSq.red).toBe(sq('4,9'));
    expect(game.board.kingSq.black).toBe(sq('4,5'));
    expect(game.board.at(sq('4,6'))).not.toBeNull();
    expect(game.result).toBeNull();
    expect(game.history.length).toBe(0);
  });

  it('fogCandidates offers the AI the duel when its view shows the enemy king clear', () => {
    const game = fogGameWith(16);
    const board = game.board;
    // The AI (red) sees the black king at (4,5) along the rank; the file to it is clear in its view.
    put(board, 'red', 'K', 4, 9);
    put(board, 'black', 'K', 4, 5);
    put(board, 'red', 'R', 0, 5);
    finalize(board);
    game.kingSeen.red = sq('4,5');
    const candidates = fogCandidates(game, 'red');
    expect(candidates.some((m) => m.from === sq('4,9') && m.to === sq('4,5'))).toBe(true);
  });

  it('双方仅剩将帅判和 (2026-09-15)', () => {
    const game = fogGameWith(17);
    const board = game.board;
    for (let s = 0; s < SQUARES; s++) board.squares[s] = null;
    put(board, 'red', 'K', 4, 9);
    put(board, 'black', 'K', 4, 0);
    finalize(board);
    const result = game.computeResult();
    expect(result).not.toBeNull();
    expect(result?.winner).toBeNull();
    expect(result?.text).toContain('仅剩将帅');
  });

  it('a king plus one soldier is not a draw yet — only bare kings are', () => {
    const game = fogGameWith(18);
    const board = game.board;
    for (let s = 0; s < SQUARES; s++) board.squares[s] = null;
    put(board, 'red', 'K', 4, 9);
    put(board, 'black', 'K', 4, 0);
    put(board, 'black', 'P', 1, 1);
    finalize(board);
    expect(game.computeResult()).toBeNull();
  });
});

describe('迷雾 = 吃王棋 (rule F4, 2026-09-15)', () => {
  beforeEach(() => {
    resetVisionCache();
  });

  it('送将 is legal: a move that leaves the general exposed is playable in fog', () => {
    const game = fogGameWith(5);
    const board = game.board;
    // Kings face down the e-file with a red rook blocking; three more rooks make the line visible
    // once the blocker steps off it — the exact position the F1 test above reads as a real facing.
    put(board, 'red', 'K', 4, 9);
    put(board, 'black', 'K', 4, 0);
    put(board, 'red', 'R', 4, 5);
    put(board, 'red', 'R', 5, 7);
    put(board, 'red', 'R', 5, 6);
    put(board, 'red', 'R', 5, 5);
    finalize(board);
    const rookAway = mv(sq('4,5'), sq('3,5'));
    // The old 送将 filter would refuse this; under F4 the general may be exposed — the game accepts
    // the move and the player lives (or dies) with the cost.
    expect(game.isLegal(rookAway)).toBe(true);
    expect(game.isSelectable(rookAway)).toBe(true);
    const event = game.apply(rookAway);
    expect(event.move.from).toBe(sq('4,5'));
  });

  it('a general actually captured wins the game on the spot — no checkmate ceremony', () => {
    const game = fogGameWith(6);
    const board = game.board;
    // Black's general sits in the open; a red rook has a clear file straight to it.
    put(board, 'red', 'K', 4, 9);
    put(board, 'black', 'K', 4, 0);
    put(board, 'red', 'R', 4, 5);
    finalize(board);
    const capture = mv(sq('4,5'), sq('4,0'));
    expect(game.isLegal(capture)).toBe(true);
    game.apply(capture);
    expect(game.board.kingSq.black).toBe(-1);
    expect(game.result).not.toBeNull();
    expect(game.result?.winner).toBe('red');
    expect(game.result?.text).toContain('被吃');
  });

  it('a checkmate-shaped position does not end the game — the general must fall, not be "mated"', () => {
    const game = fogGameWith(8);
    const board = game.board;
    // Red's general cornered in its palace, three black rooks covering every escape: in standard
    // xiangqi this is 将死. In fog the king may simply expose itself (送将合法), so play continues.
    put(board, 'red', 'K', 4, 9);
    put(board, 'black', 'K', 4, 0);
    put(board, 'black', 'R', 4, 1);
    put(board, 'black', 'R', 3, 1);
    put(board, 'black', 'R', 5, 1);
    finalize(board);
    expect(game.inCheck('red')).toBe(true);
    expect(game.legalMoves('red').length).toBeGreaterThan(0);
    expect(game.computeResult()).toBeNull();
  });

  it('the same position in a standard game is still 将死 — F4 changes fog, not xiangqi', () => {
    const game = JieqiGame.create({ seed: 10 });
    const board = game.board;
    for (let sq = 0; sq < SQUARES; sq++) board.squares[sq] = null;
    put(board, 'red', 'K', 4, 9);
    put(board, 'black', 'K', 4, 0);
    put(board, 'black', 'R', 4, 1);
    put(board, 'black', 'R', 3, 1);
    put(board, 'black', 'R', 5, 1);
    finalize(board);
    expect(game.inCheck('red')).toBe(true);
    expect(game.legalMoves('red').length).toBe(0);
    expect(game.computeResult()?.kind).toBe('checkmate');
    expect(game.computeResult()?.winner).toBe('black');
  });
});

describe('迷雾 AI (fogged candidates and worlds)', () => {
  beforeEach(() => {
    resetVisionCache();
  });

  it('the fogged view never offers the AI a capture aimed into the mist', () => {
    const board = fromAscii(QUIET);
    board.fog = true;
    // Black's rook on the a-file, a red pawn in its ray (visible: first blocker), and a red pawn
    // behind it that the ray cannot reach — and no black piece's vision touches it either.
    put(board, 'black', 'R', 0, 2);
    put(board, 'red', 'P', 0, 5);
    put(board, 'red', 'P', 0, 7);
    finalize(board);
    const view = foggedBoardFor(board, 'black');
    // The unseen pawn is gone from the picture…
    expect(view.at(sq('0,7'))).toBeNull();
    // …and the move list built on that picture contains no move aimed at its square.
    const moves = generateMoves(view, 'black', []);
    expect(moves.some((m) => m.to === sq('0,7'))).toBe(false);
    expect(moves.some((m) => m.to === sq('0,5'))).toBe(true);
  });

  it('chooseMove runs on a fog deal and returns a decision', () => {
    const game = JieqiGame.create({ mode: 'fog', seed: 7 });
    expect(game.mode).toBe('fog');
    expect(game.board.fog).toBe(true);
    const candidates = fogCandidates(game, 'red');
    expect(candidates.length).toBeGreaterThan(0);
    const decision = chooseMove(game, { difficulty: 'easy', seed: 3 });
    expect(decision).not.toBeNull();
    if (decision) {
      expect(candidates.some((c) => c.from === decision.move.from && c.to === decision.move.to)).toBe(true);
    }
  });

  it('kingSeen tracks the enemy king by last sight, never by omniscience (rule F3)', () => {
    const game = JieqiGame.create({ mode: 'fog', seed: 9 });
    // Everyone knows the deal: each side's belief opens on the enemy king's home square.
    expect(game.kingSeen.red).toBe(sq('4,0'));
    expect(game.kingSeen.black).toBe(sq('4,9'));
    // Play some real moves; the invariant that defines the rule: whenever an observer currently sees
    // the enemy king, its belief is that exact square — and when the king is out of sight the belief
    // is allowed to be stale (that staleness is the whole point of letting it hide).
    for (let i = 0; i < 14; i++) {
      const moves = game.selectableMoves();
      if (moves.length === 0) break;
      game.apply(moves[0] as Move);
      for (const observer of ['red', 'black'] as const) {
        const foe = observer === 'red' ? 'black' : 'red';
        const kingSq = game.board.kingSq[foe];
        if (kingSq < 0) continue;
        if (isSquareSeen(game.board, observer, kingSq)) {
          expect(game.kingSeen[observer]).toBe(kingSq);
        }
      }
    }
  });

  it('fog self-play never wedges: the scene retry loop always finds a real-legal move', () => {
    // The scene's 迷雾 retry walks the scored candidates until the real board accepts one, falling
    // back to the real move list. This reproduces that loop for whole games: a fog decision is legal
    // on the AI's *view*, which reality may contradict, so the loop — not `chooseMove` — is what has
    // to keep the game moving. The property under test is that a live side always finds a playable
    // move; how long a game runs is the AI's business, not a wedge.
    for (const seed of [11, 22, 33]) {
      const game = JieqiGame.create({ mode: 'fog', seed });
      let plies = 0;
      while (!game.result && plies < 300) {
        const decision = chooseMove(game, { difficulty: 'easy', seed: seed * 1000 + plies });
        let chosen: Move | null = decision?.move ?? null;
        if (chosen && !game.isSelectable(chosen)) {
          chosen =
            decision?.candidates.find((candidate) => game.isSelectable(candidate.move))?.move ??
            game.selectableMoves()[0] ??
            null;
        }
        // A genuinely dead side may have nothing (and `computeResult` will say so); a live side must
        // always find something, or the game would sit on an unanswered turn.
        if (!chosen) {
          expect(game.selectableMoves().length).toBe(0);
          game.computeResult();
          break;
        }
        game.apply(chosen);
        plies += 1;
      }
      if (!game.result) expect(plies).toBe(300); // hit the cap, not wedged — the loop kept advancing
    }
  });
});
