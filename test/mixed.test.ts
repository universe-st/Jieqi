/**
 * 混斗 (mixed battle) tests — the mode where both armies are dealt as one pool.
 *
 * Each block names the rule it pins down. The two that carry the whole mode are worth stating up front,
 * because everything else here is a consequence of them:
 *
 * - **M2** 自己这边的暗子归属权暂时归自己 — while a piece is face down it belongs to the half of the
 *   board it stands on, so it is that side's to move (and to defend) whoever it turns out to be;
 * - **M4** 翻开若是敌方棋子，归属权变成对方 — turning it over hands it to whoever it really is.
 *
 * The rest of 揭棋 is deliberately unchanged, and the tests say so: the deal still puts the same 32
 * pieces on the same 32 squares, a 暗子 still moves as the piece its square started with (R4), a piece
 * is still only turned over by moving it (R5), and 标准 games are untouched.
 */

import { describe, expect, it } from 'vitest';

import { chooseMove } from '../src/ai';
import { Board } from '../src/core/board';
import {
  createKnowledge,
  mixedLostUnknownTo,
  mixedPoolFor,
  noteLearned,
  noteRevealed,
  sampleWorldMixed,
  type Knowledge,
} from '../src/core/info';
import { landsHangingAs, isHanging } from '../src/core/danger';
import { generateMoves, isKingSafe } from '../src/core/moves';
import { toChineseNotation } from '../src/core/notation';
import { JieqiGame, type MoveEvent } from '../src/core/rules';
import { createRng } from '../src/core/rng';
import {
  ARMY_LIST,
  KING_SQUARE,
  SQUARES,
  START_SQUARES,
  type Color,
  type Identity,
  type Kind,
  type Move,
  squareOf,
} from '../src/core/types';
import { captureLabel, mixedTrayChips } from '../src/vm/tray';
import { emptyBoard, finalize, put, putHidden, resetIds } from './support/position';

/** A hand-built 混斗 board: `mixed` on, so a face-down piece belongs to the half it stands on. */
function mixedBoard(side: Color = 'red'): Board {
  const board = emptyBoard(side);
  board.mixed = true;
  return board;
}

/** Swaps in a hand-built board, the way `rules.test.ts` does — the deal is irrelevant to a diagram. */
function gameOn(board: Board): JieqiGame {
  resetIds();
  const game = JieqiGame.create({ seed: 1, mode: 'mixed' });
  const internal = game as unknown as { board: Board; bump(key: number): void };
  internal.board = board;
  // The repetition rule is about the positions *this game* has been in, so the diagram's own position
  // has to be recorded the same way `create` records the deal.
  internal.bump(board.key);
  return game;
}

function makeMixed(seed = 1): JieqiGame {
  resetIds();
  return JieqiGame.create({ seed, mode: 'mixed' });
}

/** The thirty identities actually on a board, face down ones included. */
function dealtIdentities(board: Board): Identity[] {
  const out: Identity[] = [];
  for (let sq = 0; sq < SQUARES; sq++) {
    const piece = board.at(sq);
    if (piece && piece.kind !== 'K') out.push({ color: piece.color, kind: piece.kind });
  }
  return out;
}

const countOf = (identities: readonly Identity[], color: Color, kind: Kind): number =>
  identities.filter((entry) => entry.color === color && entry.kind === kind).length;

/** What a player can see: every square, with a 暗子 shown as `?` whatever it hides. */
function maskOf(board: Board): string {
  let out = '';
  for (let sq = 0; sq < SQUARES; sq++) {
    const piece = board.at(sq);
    if (!piece) out += '.';
    else if (piece.hidden) out += '?';
    else out += piece.kind;
  }
  return out;
}

const movesOf = (board: Board, color: Color): string[] =>
  generateMoves(board, color, [])
    .map((move) => `${move.from}>${move.to}`)
    .sort();

describe('M1–M3 · the 混斗 deal', () => {
  it('puts both kings face up on their home squares, exactly as 标准 does', () => {
    const game = makeMixed(7);
    for (const color of ['red', 'black'] as const) {
      const king = game.board.at(KING_SQUARE[color]);
      expect(king?.kind).toBe('K');
      expect(king?.color).toBe(color);
      expect(king?.hidden).toBe(false);
    }
    expect(game.board.mixed).toBe(true);
    expect(game.mode).toBe('mixed');
  });

  it('deals the same 32 pieces onto the same 32 starting squares', () => {
    for (const seed of [3, 11, 250]) {
      const game = makeMixed(seed);
      const occupied = new Set<number>();
      let hidden = 0;
      for (let sq = 0; sq < SQUARES; sq++) {
        const piece = game.board.at(sq);
        if (!piece) continue;
        occupied.add(sq);
        if (piece.hidden) hidden += 1;
      }
      expect(occupied.size).toBe(32);
      expect(hidden).toBe(30);
      for (const color of ['red', 'black'] as const) {
        for (const start of START_SQUARES[color]) expect(occupied.has(start.square)).toBe(true);
      }
    }
  });

  it('shuffles both armies into one pool without losing or inventing a piece', () => {
    // The deal is a permutation of thirty identities across thirty squares; the *counts* are what say
    // the pool was neither dropped nor duplicated, and `countsByKind` reads true colours, which is
    // exactly the question here.
    for (const seed of [1, 2, 3, 42, 999]) {
      const game = makeMixed(seed);
      for (const color of ['red', 'black'] as const) {
        expect(game.board.countsByKind(color)).toEqual({ K: 1, A: 2, E: 2, H: 2, R: 2, C: 2, P: 5 });
      }
      const identities = dealtIdentities(game.board);
      expect(identities).toHaveLength(30);
      for (const color of ['red', 'black'] as const) {
        for (const kind of ARMY_LIST) {
          expect(countOf(identities, color, kind)).toBe(
            ARMY_LIST.filter((entry) => entry === kind).length,
          );
        }
      }
    }
  });

  it('keeps rule R4: a face-down piece still has the homeKind of the square it stands on', () => {
    const game = makeMixed(5);
    for (let sq = 0; sq < SQUARES; sq++) {
      const piece = game.board.at(sq);
      if (!piece || !piece.hidden) continue;
      const start = [...START_SQUARES.red, ...START_SQUARES.black].find((s) => s.square === sq);
      expect(piece.homeKind).toBe(start?.kind);
    }
  });

  it('really does mix the halves — pieces turn up on the other side', () => {
    // The point of the mode, and the one thing 标准 can never produce: a piece whose true colour is not
    // the colour of the half it was dealt to. Asserted over enough seeds that it cannot be luck.
    let displaced = 0;
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const game = makeMixed(seed);
      for (let sq = 0; sq < SQUARES; sq++) {
        const piece = game.board.at(sq);
        if (!piece || !piece.hidden) continue;
        if (game.board.ownerAt(sq) !== piece.color) displaced += 1;
      }
    }
    expect(displaced).toBeGreaterThan(0);
    // 30 pieces over two halves: about half of them start out on the wrong one.
    expect(displaced).toBeGreaterThan(60);
  });

  it('leaves 标准 alone: the same seed still deals each army onto its own half', () => {
    const game = JieqiGame.create({ seed: 3 });
    expect(game.mode).toBe('standard');
    expect(game.board.mixed).toBe(false);
    for (let sq = 0; sq < SQUARES; sq++) {
      const piece = game.board.at(sq);
      if (piece) expect(piece.color).toBe(game.board.ownerAt(sq));
    }
  });
});

describe('M2 · a face-down piece belongs to the half it stands on', () => {
  it('lets a side move a 暗子 on its own half that is really the opponent\u2019s piece', () => {
    const board = mixedBoard('red');
    put(board, 'red', 'K', 4, 9);
    put(board, 'black', 'K', 3, 0);
    // A 兵 square on red's half — and the piece under it is black's 车.
    const pawnSquare = squareOf(4, 6);
    putHidden(board, 'black', 'R', 'P', 4, 6);
    finalize(board);

    const red = movesOf(board, 'red').filter((move) => move.startsWith(`${pawnSquare}>`));
    // It moves as a 兵 (R4 is untouched): one step forward, and nowhere else.
    expect(red).toEqual([`${pawnSquare}>${squareOf(4, 5)}`]);
    // And black cannot touch it — it is standing on red's half.
    expect(movesOf(board, 'black').some((move) => move.startsWith(`${pawnSquare}>`))).toBe(false);
    expect(board.ownerAt(pawnSquare)).toBe('red');
  });

  it('reads ownership off the square while face down, and off the piece once it is up', () => {
    const board = mixedBoard('red');
    put(board, 'red', 'K', 4, 9);
    put(board, 'black', 'K', 3, 0);
    putHidden(board, 'black', 'R', 'P', 4, 6);
    finalize(board);
    const square = squareOf(4, 6);

    expect(board.ownerAt(square)).toBe('red');
    expect(board.hiddenSquares('red')).toEqual([square]);
    expect(board.hiddenSquares('black')).toEqual([]);
    expect(board.piecesOf('red').some((entry) => entry.square === square)).toBe(true);
    expect(board.piecesOf('black').some((entry) => entry.square === square)).toBe(false);

    // Turned over, the same square belongs to the piece: this is the whole of rule M4.
    const piece = board.at(square);
    if (!piece) throw new Error('missing piece');
    board.squares[square] = { ...piece, hidden: false };
    finalize(board);
    expect(board.ownerAt(square)).toBe('black');
    expect(board.piecesOf('black').some((entry) => entry.square === square)).toBe(true);
  });

  it('does not let the hidden identity change which moves are on offer', () => {
    // Legality must not be a peephole. The same position is dealt twice with the two 暗子 swapped —
    // same squares, same homeKinds, different truth — and the legal move lists have to be identical.
    const build = (blackIsRook: boolean): Board => {
      const board = mixedBoard('red');
      put(board, 'red', 'K', 4, 9);
      put(board, 'black', 'K', 3, 0);
      putHidden(board, blackIsRook ? 'black' : 'red', blackIsRook ? 'R' : 'P', 'P', 4, 6);
      putHidden(board, blackIsRook ? 'red' : 'black', blackIsRook ? 'P' : 'R', 'P', 5, 6);
      finalize(board);
      return board;
    };

    const asIs = build(true);
    const swapped = build(false);
    // Identical as far as anybody at the board can tell: same pieces on the same squares, and nothing
    // visible says which of the two 暗子 is which.
    expect(maskOf(asIs)).toBe(maskOf(swapped));

    for (const color of ['red', 'black'] as const) {
      expect(movesOf(asIs, color)).toEqual(movesOf(swapped, color));
    }
    const one = gameOn(build(true));
    const two = gameOn(build(false));
    expect(one.legalMoves('red').map((m: Move) => `${m.from}>${m.to}`)).toEqual(
      two.legalMoves('red').map((m: Move) => `${m.from}>${m.to}`),
    );
  });
});

describe('M4 · turning a 暗子 over may hand it to the opponent', () => {
  it('gives the piece to the side it really belongs to, where it landed', () => {
    const board = mixedBoard('red');
    put(board, 'red', 'K', 4, 9);
    put(board, 'black', 'K', 3, 0);
    // File 0, so the 车 that comes up does not also look at the 帅: that case is M5's, below.
    const from = squareOf(0, 6);
    const to = squareOf(0, 5);
    putHidden(board, 'black', 'R', 'P', 0, 6);
    finalize(board);
    const game = gameOn(board);

    expect(game.legalMoves('red')).toContainEqual({ from, to });
    const event = game.apply({ from, to });

    expect(event.wasHidden).toBe(true);
    expect(event.revealedKind).toBe('R');
    expect(event.revealedColor).toBe('black');
    expect(event.color).toBe('red');
    expect(event.selfCheck).toBe(false);

    const landed = game.board.at(to);
    expect(landed?.hidden).toBe(false);
    expect(landed?.color).toBe('black');
    expect(game.board.ownerAt(to)).toBe('black');
    // The mover lost it and the opponent gained it: red is down to its 帅, black is a 车 up.
    expect(game.board.piecesOf('red')).toHaveLength(1);
    expect(game.board.piecesOf('black')).toHaveLength(2);
    // Black is to move, and the rook it has just been handed is black's to play.
    expect(game.sideToMove).toBe('black');
    expect(game.legalMoves('black')).toContainEqual({ from: to, to: squareOf(0, 4) });
  });

  it('leaves a piece that turns out to be its mover\u2019s own where it was', () => {
    const board = mixedBoard('red');
    put(board, 'red', 'K', 4, 9);
    put(board, 'black', 'K', 3, 0);
    const from = squareOf(0, 6);
    const to = squareOf(0, 5);
    putHidden(board, 'red', 'R', 'P', 0, 6);
    finalize(board);
    const game = gameOn(board);

    const event = game.apply({ from, to });
    expect(event.revealedColor).toBe('red');
    expect(event.selfCheck).toBe(false);
    expect(game.board.ownerAt(to)).toBe('red');
    // 帅 + 车, and black still has nothing but its own 将.
    expect(game.board.piecesOf('red')).toHaveLength(2);
    expect(game.board.piecesOf('black')).toHaveLength(1);
  });

  it('is public: both observers lose the identity from the pool, whichever side it went to', () => {
    const board = mixedBoard('red');
    put(board, 'red', 'K', 4, 9);
    put(board, 'black', 'K', 3, 0);
    putHidden(board, 'black', 'R', 'P', 4, 6);
    finalize(board);
    const game = gameOn(board);

    expect(game.mixedPoolFor('red').filter((e) => e.kind === 'R' && e.color === 'black')).toHaveLength(2);
    game.apply({ from: squareOf(4, 6), to: squareOf(4, 5) });

    for (const observer of ['red', 'black'] as const) {
      const pool = game.mixedPoolFor(observer);
      expect(pool.filter((entry) => entry.kind === 'R' && entry.color === 'black')).toHaveLength(1);
      // Red's own army is untouched: what red turned over was never red's piece.
      expect(pool.filter((entry) => entry.kind === 'R' && entry.color === 'red')).toHaveLength(2);
    }
  });

  it('reads the move from the mover\u2019s side, and the revealed face from the piece\u2019s', () => {
    const board = mixedBoard('red');
    put(board, 'red', 'K', 4, 9);
    put(board, 'black', 'K', 3, 0);
    // A red 兵 square at (4,6), hiding a black 卒.
    putHidden(board, 'black', 'P', 'P', 4, 6);
    finalize(board);
    const game = gameOn(board);

    const move = { from: squareOf(4, 6), to: squareOf(4, 5) };
    // The notation is the mover's: red played a 暗兵 forward one — not a 暗卒.
    expect(toChineseNotation(board, move)).toBe('暗兵五进一');
    const event = game.apply(move);
    // …while the face that came up is the black 卒 it really was.
    expect(event.revealedColor).toBe('black');
    expect(event.revealedKind).toBe('P');
  });

  it('still only turns a piece over by moving it (R5): a 暗子 never moves while face down', () => {
    // `homeKind` is only meaningful while the piece is still standing on its deal square, so a hidden
    // piece that had moved would be a contradiction — and it is the invariant the whole 暗子 movement
    // rule rests on. Tracked by piece id, which is what survives a move.
    const game = makeMixed(21);
    const bornOn = new Map<number, number>();
    for (let sq = 0; sq < SQUARES; sq++) {
      const piece = game.board.at(sq);
      if (piece?.hidden) bornOn.set(piece.id, sq);
    }

    let plies = 0;
    while (!game.result && plies < 80) {
      const moves = game.selectableMoves();
      if (moves.length === 0) break;
      const hiddenMoves = moves.filter((move) => game.board.at(move.from)?.hidden);
      game.apply(hiddenMoves[0] ?? (moves[0] as Move));
      plies += 1;
    }
    expect(plies).toBeGreaterThan(4);

    for (let sq = 0; sq < SQUARES; sq++) {
      const piece = game.board.at(sq);
      if (!piece || !piece.hidden) continue;
      expect(bornOn.get(piece.id)).toBe(sq);
    }
  });
});

describe('M5 · 反将自身: a reveal can check the side that moved it', () => {
  /**
   * The position the rule is about: red plays the 暗子 on its own 兵 square, and it turns out to be a
   * 黑车 that now looks straight down the file at the 红帅.
   */
  function selfCheckBoard(): Board {
    const board = mixedBoard('red');
    put(board, 'red', 'K', 4, 9);
    put(board, 'black', 'K', 3, 0);
    putHidden(board, 'black', 'R', 'P', 4, 6);
    finalize(board);
    return board;
  }

  const from = squareOf(4, 6);
  const to = squareOf(4, 5);

  it('allows the move — legality is judged on what the board shows, not on the coin', () => {
    const game = gameOn(selfCheckBoard());
    expect(game.legalMoves('red')).toContainEqual({ from, to });
    expect(game.selectableMoves('red')).toContainEqual({ from, to });
  });

  it('reports the check against the mover, and hands the general to the opponent', () => {
    const game = gameOn(selfCheckBoard());
    const event = game.apply({ from, to });

    expect(event.selfCheck).toBe(true);
    // The mover is the one in check — the move did *not* check the opponent.
    expect(event.gaveCheck).toBe(false);
    expect(game.inCheck('red')).toBe(true);
    expect(game.inCheck('black')).toBe(false);

    // 禁止立即吃将: the handed-over rook may not take the 帅 on the immediate reply — red gets a turn
    // to answer (move the general away, block, or take the checker). The move exists (it is legal in
    // the ordinary sense) but the rule names it, exactly like 禁止循环追棋.
    const captureKing = { from: to, to: squareOf(4, 9) };
    expect(game.legalMoves('black')).toContainEqual(captureKing);
    expect(game.wouldEatGeneral(captureKing)).toBe(true);
    expect(game.isSelectable(captureKing)).toBe(false);
    expect(game.selectableMoves('black')).not.toContainEqual(captureKing);
    // The game's own door refuses it too, so it can never enter the history.
    expect(() => game.apply(captureKing)).toThrow(/禁止立即吃将/);
    expect(game.ply).toBe(1);

    // The ban is on the general-capture, not on black's whole turn: black still has ordinary moves.
    expect(game.selectableMoves('black').length).toBeGreaterThan(0);
  });

  it('spends the 禁止立即吃将 rule after the reply is played', () => {
    const game = gameOn(selfCheckBoard());
    game.apply({ from, to });

    // Black answers with a quiet king move — not the flipped rook, which stays where it is checking.
    const kingSq = game.board.kingSq.black;
    const reply = game.selectableMoves('black').find(
      (m) => m.from === kingSq && game.board.at(m.to) === null,
    ) as Move;
    game.apply(reply);

    // The general was not taken on the reply, red still has to answer the check, and the rule — which
    // guards only that immediate reply — is spent.
    expect(game.board.at(squareOf(4, 9))?.kind).toBe('K');
    expect(game.inCheck('red')).toBe(true);
    expect(game.inCheck('black')).toBe(false);
    expect(game.wouldEatGeneral({ from, to })).toBe(false);
  });

  it('counts a general that is no longer on the board as attacked', () => {
    const board = mixedBoard('red');
    put(board, 'red', 'K', 4, 9);
    put(board, 'black', 'K', 3, 0);
    finalize(board);
    expect(isKingSafe(board, 'red')).toBe(true);

    // Take the 帅 off the board without touching `kingSq`: the stale square must not read as safe.
    board.squares[squareOf(4, 9)] = null;
    expect(board.kingSq.red).toBe(squareOf(4, 9));
    expect(isKingSafe(board, 'red')).toBe(false);
  });
});

describe('混斗 and the 吃子提示 reading', () => {
  it('rings a target by the mover\u2019s safety, not by whoever the piece turns out to be', () => {
    // The board rings a target red when *my* piece would land hanging. Asking that after the reveal
    // would be a different question entirely — the arrival is the opponent's by then — and its colour
    // would say out loud which 暗子 are the enemy's.
    const board = mixedBoard('red');
    put(board, 'red', 'K', 4, 9);
    put(board, 'black', 'K', 3, 0);
    put(board, 'black', 'R', 0, 0); // bears down the file, with nothing in between
    putHidden(board, 'black', 'R', 'P', 0, 6);
    finalize(board);
    const move = { from: squareOf(0, 6), to: squareOf(0, 5) };

    // Read as red's piece — what the player is about to do — it is hanging: a black 车 can take it and
    // nothing red covers the square.
    expect(landsHangingAs(board, move, 'red')).toBe(true);

    // Play it, and the truth comes out: the same square now holds a 车 that is black's own, defended by
    // the rook behind it and attacked by nobody. `isHanging` reads that reality; `landsHangingAs` never
    // did.
    const game = gameOn(board);
    game.apply(move);
    expect(game.board.ownerAt(squareOf(0, 5))).toBe('black');
    expect(isHanging(game.board, squareOf(0, 5))).toBe(false);
  });
});

describe('混斗 information pool', () => {
  it('conserves the thirty identities for both observers over a whole game', () => {
    for (const seed of [2, 9, 31]) {
      const game = makeMixed(seed);
      let guard = 0;
      while (!game.result && guard < 300) {
        guard += 1;
        const moves = game.selectableMoves();
        if (moves.length === 0) break;
        game.apply(moves[(seed + guard * 7) % moves.length] as Move);

        for (const observer of ['red', 'black'] as const) {
          // Faces-down pieces somebody *other* than the observer took are the only ones still unknown
          // to them: everything else is either on the board or was turned over in their hand.
          const unknown = game.moveEvents.filter(
            (event) =>
              event.captured?.hidden === true && event.color !== observer,
          ).length;
          expect(mixedLostUnknownTo(game.board, game.knowledge, observer)).toBe(unknown);
          expect(mixedPoolFor(game.knowledge, observer)).toHaveLength(
            game.board.allHiddenSquares().length + unknown,
          );
        }
      }
      expect(guard).toBeGreaterThan(1);
    }
  });

  it('shrinks the shared pool for a reveal and only for the capturer of a face-down piece', () => {
    const knowledge: Knowledge = createKnowledge();
    expect(mixedPoolFor(knowledge, 'red')).toHaveLength(30);
    noteRevealed(knowledge, 'black', 'R');
    expect(mixedPoolFor(knowledge, 'red')).toHaveLength(29);
    expect(mixedPoolFor(knowledge, 'black')).toHaveLength(29);
    // A face-down capture can teach a colour the 标准 rules never could: red takes a red 炮.
    noteLearned(knowledge, 'red', 'C', 'red');
    expect(mixedPoolFor(knowledge, 'red')).toHaveLength(28);
    expect(mixedPoolFor(knowledge, 'black')).toHaveLength(29);
    expect(mixedPoolFor(knowledge, 'red').filter((e) => e.color === 'red' && e.kind === 'C')).toHaveLength(1);
  });

  it('samples worlds that keep the squares and deal the pool without replacement', () => {
    const game = makeMixed(8);
    const rng = createRng(1234);
    const scratch: Identity[] = [];
    const squares = game.board.allHiddenSquares();
    expect(squares.length).toBe(30);

    sampleWorldMixed(game.board, game.mixedPoolFor('red'), rng, scratch);

    const seen = new Set<string>();
    for (const sq of squares) {
      const piece = game.board.at(sq);
      if (!piece) throw new Error(`square ${sq} emptied by sampling`);
      expect(piece.hidden).toBe(true);
      const start = [...START_SQUARES.red, ...START_SQUARES.black].find((s) => s.square === sq);
      expect(piece.homeKind).toBe(start?.kind);
      seen.add(`${piece.color}:${piece.kind}`);
    }
    // Every identity is used at most as often as the army carries it — no duplicates invented.
    for (const color of ['red', 'black'] as const) {
      for (const kind of ARMY_LIST) {
        const carried = ARMY_LIST.filter((entry) => entry === kind).length;
        const used = [...seen].filter((key) => key === `${color}:${kind}`).length;
        expect(used).toBeLessThanOrEqual(carried);
      }
    }
  });

  it('varies whose piece a 暗子 is from world to world — the stake the search is averaging over', () => {
    // This is the whole reason 混斗 needs its own sampler: with one shared pool, "is this square red's
    // 车 or black's 车" is exactly what a world decides, so a move that turns it over is worth its
    // average over those worlds rather than one of them.
    const game = makeMixed(8);
    const rng = createRng(99);
    const scratch: Identity[] = [];
    const square = game.board.allHiddenSquares()[0] as number;

    const seen = new Set<string>();
    for (let world = 0; world < 60; world++) {
      sampleWorldMixed(game.board, game.mixedPoolFor('red'), rng, scratch);
      const piece = game.board.at(square);
      if (piece) seen.add(`${piece.color}:${piece.kind}`);
    }
    expect(seen.size).toBeGreaterThan(4);
    expect([...seen].some((key) => key.startsWith('red:'))).toBe(true);
    expect([...seen].some((key) => key.startsWith('black:'))).toBe(true);
  });
});

describe('混斗 trays', () => {
  /** A capture event, with only the fields the tray rule reads actually meaning anything. */
  function captureEvent(
    capturer: Color,
    captured: { color: Color; hidden: boolean; kind: Kind; pieceId: number },
  ): MoveEvent {
    return {
      move: { from: 0, to: 1 },
      color: capturer,
      pieceId: 99,
      moverKind: 'R',
      wasHidden: false,
      revealedKind: null,
      revealedColor: null,
      selfCheck: false,
      captured: { square: 1, ...captured },
      gaveCheck: false,
      notation: 'test',
    };
  }

  const blackRook = { color: 'black' as Color, hidden: false, kind: 'R' as Kind, pieceId: 1 };
  const redCannon = { color: 'red' as Color, hidden: false, kind: 'C' as Kind, pieceId: 2 };
  const hiddenBlackPawn = { color: 'black' as Color, hidden: true, kind: 'P' as Kind, pieceId: 3 };
  const hiddenRedHorse = { color: 'red' as Color, hidden: true, kind: 'H' as Kind, pieceId: 4 };

  it('files a chip under whoever did the taking, whatever colour it turned out to be', () => {
    // Black takes a red 炮, and red takes a black 车 *and* a red 马 — the last one only 混斗 can do.
    const events = [
      captureEvent('black', redCannon),
      captureEvent('red', blackRook),
      captureEvent('red', hiddenRedHorse),
    ];

    expect(mixedTrayChips(events, 'red', 'red').map((chip) => chip.color)).toEqual(['black', 'red']);
    expect(mixedTrayChips(events, 'red', 'black').map((chip) => chip.color)).toEqual(['red']);
    // A face-down piece the capturer took is theirs to see (dimmed); the other side sees a back.
    const mine = mixedTrayChips(events, 'red', 'red');
    expect(mine[1]?.kind).toBe('H');
    expect(mine[1]?.dimmed).toBe(true);
    expect(mixedTrayChips(events, 'black', 'red')[1]?.kind).toBeNull();
  });

  it('names a captured 暗子 for the capturer only, and never lets the loser look', () => {
    const taken = captureEvent('red', hiddenBlackPawn);
    const capture = taken.captured;
    if (!capture) throw new Error('missing capture');

    expect(captureLabel(capture, 'red', 'red')).toBe('吃卒');
    expect(captureLabel(capture, 'black', 'red')).toBe('吃暗子');
    // 混斗's twist: red may take a red piece, and red — the capturer — turned it over.
    const ownColour = captureEvent('red', hiddenRedHorse).captured;
    if (!ownColour) throw new Error('missing capture');
    expect(captureLabel(ownColour, 'red', 'red')).toBe('吃马');
    expect(captureLabel(ownColour, 'black', 'red')).toBe('吃暗子');
  });
});

describe('混斗 and the AI', () => {
  it('picks legal moves and plays a whole game without an exception', () => {
    for (const seed of [4, 17]) {
      resetIds();
      const game = JieqiGame.create({ seed, mode: 'mixed' });
      let plies = 0;
      while (!game.result && plies < 80) {
        const decision = chooseMove(game, { difficulty: 'easy', seed: seed * 31 + plies });
        if (!decision) break;
        // Every move it offers has to be one the rules actually allow.
        expect(game.selectableMoves()).toContainEqual(decision.move);
        game.apply(decision.move);
        plies += 1;
      }
      expect(plies).toBeGreaterThan(10);
    }
  });

  it('has moves to choose from on a hand-built 混斗 diagram, and never offers an illegal one', () => {
    const board = mixedBoard('red');
    put(board, 'red', 'K', 4, 9);
    put(board, 'black', 'K', 3, 0);
    putHidden(board, 'red', 'R', 'P', 4, 6);
    putHidden(board, 'black', 'R', 'P', 0, 6);
    finalize(board);
    const game = gameOn(board);

    const decision = chooseMove(game, { difficulty: 'easy', seed: 5 });
    expect(decision).not.toBeNull();
    if (!decision) return;
    expect(game.legalMoves('red')).toContainEqual(decision.move);
  });
});
