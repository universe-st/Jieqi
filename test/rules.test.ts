/**
 * Rules tests. Each block names the rule from PLAN §0 that it pins down, because the whole point of
 * this suite is that "揭棋 is not xiangqi with a coin flip" is a claim with evidence behind it.
 */

import { describe, expect, it } from 'vitest';

import { chooseMove } from '../src/ai';
import { Board, HOME_KIND_BY_SQUARE } from '../src/core/board';
import {
  createKnowledge,
  lostUnknownTo,
  noteLearned,
  noteRevealed,
  poolsFor,
  sampleWorld,
} from '../src/core/info';
import { generateMoves, isSquareAttacked } from '../src/core/moves';
import { toChineseNotation } from '../src/core/notation';
import { JieqiGame } from '../src/core/rules';
import { createRng } from '../src/core/rng';
import {
  ARMY_LIST,
  KING_SQUARE,
  SQUARES,
  START_SQUARES,
  type Color,
  type Kind,
  type Move,
  squareOf,
} from '../src/core/types';
import { emptyBoard, finalize, fromAscii, put, putHidden, resetIds } from './support/position';

function makeGame(seed = 1): JieqiGame {
  resetIds();
  return JieqiGame.create({ seed });
}

/** Swaps in a hand-built board. The constructor's deal is irrelevant to these tests. */
function gameOn(board: Board): JieqiGame {
  const game = JieqiGame.create({ seed: 1 });
  (game as unknown as { board: Board }).board = board;
  // The constructor records the position it dealt, because the repetition rule is about the positions
  // *this game* has been in. A hand-built diagram has to be recorded the same way, or 禁止全局同形 would
  // not recognise the very position the diagram starts from.
  (game as unknown as { bump(key: number): void }).bump(board.key);
  return game;
}

/**
 * The oracle for attack detection: occupy the square with an enemy piece and ask whether anybody can
 * capture onto it. Putting a piece *there* is what gives the semantics "could capture something on this
 * square" — it is what makes a cannon require a screen while a rook does not.
 */
function attacksByBruteForce(board: Board, sq: number, byColor: Color): boolean {
  const probe = board.clone();
  const occupant = probe.at(sq);
  probe.squares[sq] = {
    id: -1,
    color: byColor === 'red' ? 'black' : 'red',
    kind: occupant?.kind ?? 'P',
    homeKind: occupant?.homeKind ?? 'P',
    hidden: false,
  };
  return generateMoves(probe, byColor).some((move) => move.to === sq);
}

describe('R1-R3 · dealing', () => {
  it('puts both kings face up on their home squares', () => {
    const game = makeGame(7);
    for (const color of ['red', 'black'] as const) {
      const king = game.board.at(KING_SQUARE[color]);
      expect(king?.kind).toBe('K');
      expect(king?.color).toBe(color);
      expect(king?.hidden).toBe(false);
    }
  });

  it('deals 32 pieces: 16 per side, 30 of them face down, on the starting squares', () => {
    const game = makeGame(11);
    let hidden = 0;
    const occupied = new Set<number>();
    for (const color of ['red', 'black'] as const) {
      const pieces = game.board.piecesOf(color);
      expect(pieces).toHaveLength(16);
      for (const { square, piece } of pieces) {
        occupied.add(square);
        if (piece.hidden) hidden += 1;
      }
    }
    expect(hidden).toBe(30);
    expect(occupied.size).toBe(32);
    for (const color of ['red', 'black'] as const) {
      for (const start of START_SQUARES[color]) expect(occupied.has(start.square)).toBe(true);
    }
  });

  it('keeps the identity multiset intact even though the positions are shuffled', () => {
    // The deal permutes identities across squares; it never changes what a side owns. That is what
    // makes the information pool a clean "army minus what has been revealed".
    for (const seed of [1, 2, 3, 42, 999]) {
      const game = JieqiGame.create({ seed });
      for (const color of ['red', 'black'] as const) {
        expect(game.board.countsByKind(color)).toEqual({ K: 1, A: 2, E: 2, H: 2, R: 2, C: 2, P: 5 });
      }
    }
  });

  it('gives every face-down piece a homeKind equal to the kind of the square it stands on', () => {
    // This invariant is why `homeKind` never needs to be part of the Zobrist key: a hidden piece can
    // never move, so it is always still standing on its home square.
    for (const seed of [5, 17, 250]) {
      const game = JieqiGame.create({ seed });
      for (let sq = 0; sq < SQUARES; sq++) {
        const piece = game.board.at(sq);
        if (!piece || !piece.hidden) continue;
        expect(piece.homeKind).toBe(HOME_KIND_BY_SQUARE.get(sq));
      }
    }
  });

  it('is reproducible from a seed and different across seeds', () => {
    const a = JieqiGame.create({ seed: 4242 });
    const b = JieqiGame.create({ seed: 4242 });
    const c = JieqiGame.create({ seed: 4243 });
    expect(a.board.toAscii()).toBe(b.board.toAscii());
    expect(a.board.key).toBe(b.board.key);
    expect(c.board.toAscii()).not.toBe(a.board.toAscii());
  });
});

describe('R4 · a face-down piece moves as its square, not as itself', () => {
  it('threatens and moves like a rook when it stands on a rook square', () => {
    const board = emptyBoard('red');
    // The king goes to (4,8) so the back rank is clear — otherwise it would block the slide.
    put(board, 'red', 'K', 4, 8);
    put(board, 'black', 'K', 3, 0);
    // Identity 兵, but it stands on the 车 square at (0,9) — exactly what a real deal produces.
    const from = putHidden(board, 'red', 'P', 'R', 0, 9);
    finalize(board);

    const targets = generateMoves(board, 'red')
      .filter((m) => m.from === from)
      .map((m) => m.to);
    expect(targets).toContain(squareOf(0, 0)); // the whole file
    expect(targets).toContain(squareOf(8, 9)); // and the whole back rank
    expect(isSquareAttacked(board, squareOf(0, 4), 'red')).toBe(true);
  });

  it('confines a piece on a pawn square to a single step forward, whatever it really is', () => {
    const board = emptyBoard('red');
    put(board, 'red', 'K', 4, 9);
    put(board, 'black', 'K', 3, 0);
    // Identity 车 — a monster — but on a 兵 square it can only shuffle forward one square.
    const from = putHidden(board, 'red', 'R', 'P', 0, 6);
    finalize(board);

    const targets = generateMoves(board, 'red')
      .filter((m) => m.from === from)
      .map((m) => m.to);
    expect(targets).toEqual([squareOf(0, 5)]);

    // Positive control on a mirror diagram: a 兵 identity on a 车 square slides like a rook.
    const control = emptyBoard('red');
    put(control, 'red', 'K', 4, 9);
    put(control, 'black', 'K', 3, 0);
    const rookSquare = putHidden(control, 'red', 'P', 'R', 8, 9);
    finalize(control);
    const controlTargets = generateMoves(control, 'red')
      .filter((m) => m.from === rookSquare)
      .map((m) => m.to);
    expect(controlTargets).toContain(squareOf(8, 0));
  });

  it('gives a piece on a horse square the horse moves, with the leg rule', () => {
    const board = emptyBoard('red');
    put(board, 'red', 'K', 4, 9);
    put(board, 'black', 'K', 3, 0);
    put(board, 'red', 'P', 1, 8); // a friend standing on the horse's leg
    const from = putHidden(board, 'red', 'C', 'H', 1, 9);
    finalize(board);

    const targets = generateMoves(board, 'red')
      .filter((m) => m.from === from)
      .map((m) => m.to);
    // (0,7) and (2,7) both need the leg on (1,8), which is occupied; only the long jump to (3,8),
    // whose leg is (2,9), survives.
    expect(targets).toEqual([squareOf(3, 8)]);
  });
});

describe('R9 / R8 · advisors and elephants, before and after being revealed', () => {
  it('keeps a face-down advisor inside the palace', () => {
    const board = emptyBoard('red');
    put(board, 'red', 'K', 4, 9);
    put(board, 'black', 'K', 3, 0);
    const from = putHidden(board, 'red', 'R', 'A', 3, 9); // stands on a 仕 square
    finalize(board);

    const targets = generateMoves(board, 'red')
      .filter((m) => m.from === from)
      .map((m) => m.to);
    expect(targets).toEqual([squareOf(4, 8)]); // the only in-palace diagonal neighbour
  });

  it('lets a revealed advisor leave the palace and cross the river', () => {
    const board = emptyBoard('red');
    put(board, 'red', 'K', 4, 9);
    put(board, 'black', 'K', 3, 0);
    const from = put(board, 'red', 'A', 3, 5); // outside the palace, on the river bank
    finalize(board);

    const targets = generateMoves(board, 'red')
      .filter((m) => m.from === from)
      .map((m) => m.to);
    expect([...targets].sort((a, b) => a - b)).toEqual(
      [squareOf(2, 4), squareOf(2, 6), squareOf(4, 4), squareOf(4, 6)].sort((a, b) => a - b),
    );
  });

  it('keeps a face-down elephant on its own side of the river', () => {
    const board = emptyBoard('red');
    put(board, 'red', 'K', 4, 9);
    put(board, 'black', 'K', 3, 0);
    const from = putHidden(board, 'red', 'P', 'E', 2, 6);
    finalize(board);

    const targets = generateMoves(board, 'red')
      .filter((m) => m.from === from)
      .map((m) => m.to);
    // From (2,6) the four jumps are (0,4), (4,4), (0,8) and (4,8); the first two are across the river.
    expect([...targets].sort((a, b) => a - b)).toEqual(
      [squareOf(0, 8), squareOf(4, 8)].sort((a, b) => a - b),
    );
    expect(targets.every((sq) => Math.floor(sq / 9) >= 5)).toBe(true); // never past the river
  });

  it('lets a revealed elephant jump across the river', () => {
    const board = emptyBoard('red');
    put(board, 'red', 'K', 4, 9);
    put(board, 'black', 'K', 3, 0);
    const from = put(board, 'red', 'E', 2, 6);
    finalize(board);

    const targets = generateMoves(board, 'red')
      .filter((m) => m.from === from)
      .map((m) => m.to);
    expect(targets).toContain(squareOf(4, 4)); // across the river
    expect(targets).toContain(squareOf(0, 4));
  });
});

describe('R5 · moving a face-down piece turns it over', () => {
  it('reveals the piece, and the identity leaves the pool', () => {
    const game = makeGame(3);
    const moves = game.legalMoves('red').filter((m) => game.board.at(m.from)?.hidden);
    expect(moves.length).toBeGreaterThan(0);
    const move = moves[0] as Move;
    const trueKind = game.board.at(move.from)?.kind as Kind;
    const before = game.poolsFor('red').red.filter((k) => k === trueKind).length;

    const event = game.apply(move);

    expect(event.wasHidden).toBe(true);
    // Both players watch the piece turn over, so the revealed identity is public knowledge — and it
    // leaves the pool for *both* observers.
    expect(event.revealedKind).toBe(trueKind);
    expect(game.board.at(move.to)?.hidden).toBe(false);
    for (const observer of ['red', 'black'] as const) {
      const pool = game.poolsFor(observer).red;
      expect(pool).toHaveLength(14);
      expect(pool.filter((k) => k === trueKind)).toHaveLength(before - 1);
    }
  });

  it('does not reveal a piece that was already face up', () => {
    const game = makeGame(3);
    const revealed = game.legalMoves('red').find((m) => game.board.at(m.from)?.hidden === false);
    expect(revealed).toBeDefined();
    const event = game.apply(revealed as Move);
    expect(event.wasHidden).toBe(false);
    expect(event.revealedKind).toBeNull();
    expect(game.poolsFor('red').red).toHaveLength(15);
  });
});

describe('R6 / R7 · capturing, and what a capture tells you', () => {
  it('reports the identity of a captured face-up piece', () => {
    const board = emptyBoard('red');
    // The kings sit on different files: with both on file 4 and nothing between, the flying-general
    // rule would make every red move illegal and the test would prove nothing.
    put(board, 'red', 'K', 4, 9);
    put(board, 'black', 'K', 3, 0);
    put(board, 'red', 'R', 0, 5);
    put(board, 'black', 'H', 0, 3);
    finalize(board);
    const game = gameOn(board);

    const event = game.apply({ from: squareOf(0, 5), to: squareOf(0, 3) });
    expect(event.captured?.hidden).toBe(false);
    expect(event.captured?.kind).toBe('H');
  });

  it('tells the capturer what a face-down piece was, and tells the loser nothing', () => {
    const board = emptyBoard('red');
    put(board, 'red', 'K', 4, 9);
    put(board, 'black', 'K', 3, 0);
    put(board, 'red', 'R', 0, 5);
    putHidden(board, 'black', 'C', 'P', 0, 3); // really a 炮 — and black loses it face down
    finalize(board);
    const game = gameOn(board);

    const event = game.apply({ from: squareOf(0, 5), to: squareOf(0, 3) });

    // The event carries the truth; it is the *renderer's* job to decide who may see it.
    expect(event.captured?.hidden).toBe(true);
    expect(event.captured?.kind).toBe('C');
    // The capturing rook is standing where the face-down piece used to be.
    expect(game.board.at(squareOf(0, 3))?.kind).toBe('R');

    // Red captured it, so red's books balance: one fewer 炮 to worry about among black's unknowns.
    const asRed = game.poolsFor('red').black;
    expect(asRed).toHaveLength(ARMY_LIST.length - 1);
    expect(asRed.filter((k) => k === 'C')).toHaveLength(1);

    // Black lost it and may not look, so from black's side the identity is still out there — the pool
    // is untouched and the piece is simply one that can never be pinned down again.
    const asBlack = game.poolsFor('black').black;
    expect(asBlack).toHaveLength(ARMY_LIST.length);
    expect(asBlack.filter((k) => k === 'C')).toHaveLength(2);
    expect(lostUnknownTo(game.board, game.knowledge, 'black', 'black')).toBe(ARMY_LIST.length);
  });
});

describe('information pool', () => {
  it('conserves size for every observer', () => {
    // |pool(observer, colour)| = face-down pieces of `colour` still on the board
    //                          + face-down pieces of `colour` that somebody *other than the observer*
    //                            captured (the observer would have learned the ones they took)
    for (const seed of [2, 9, 31]) {
      resetIds();
      const game = JieqiGame.create({ seed });
      let guard = 0;
      while (!game.result && guard < 400) {
        guard += 1;
        const moves = game.selectableMoves();
        if (moves.length === 0) break;
        game.apply(moves[(seed + guard * 7) % moves.length] as Move);
        for (const observer of ['red', 'black'] as const) {
          const pools = game.poolsFor(observer);
          for (const color of ['red', 'black'] as const) {
            const expected =
              game.board.hiddenSquares(color).length +
              lostUnknownTo(game.board, game.knowledge, observer, color);
            expect(pools[color]).toHaveLength(expected);
          }
        }
      }
      expect(guard).toBeGreaterThan(1);
    }
  });

  it('shrinks the pool by exactly one each time a hidden piece is revealed, for both observers', () => {
    const knowledge = createKnowledge();
    expect(poolsFor(knowledge, 'red').red).toHaveLength(15);
    noteRevealed(knowledge, 'red', 'R');
    expect(poolsFor(knowledge, 'red').red).toHaveLength(14);
    noteRevealed(knowledge, 'red', 'R');
    expect(poolsFor(knowledge, 'red').red).toHaveLength(13);
    expect(poolsFor(knowledge, 'red').black).toHaveLength(15);
    noteRevealed(knowledge, 'red', 'K'); // the king is never face down, so never in a pool
    expect(poolsFor(knowledge, 'red').red).toHaveLength(13);
  });

  it('lets a capture shrink only the capturer\'s view of the opponent', () => {
    const knowledge = createKnowledge();
    noteLearned(knowledge, 'red', 'R'); // red takes a black 车 face down
    expect(poolsFor(knowledge, 'red').black).toHaveLength(14);
    expect(poolsFor(knowledge, 'red').red).toHaveLength(15);
    // Black is none the wiser about its own loss, and red's army is untouched either way.
    expect(poolsFor(knowledge, 'black').black).toHaveLength(15);
    expect(poolsFor(knowledge, 'black').red).toHaveLength(15);
  });

  it('samples worlds without disturbing the home squares', () => {
    resetIds();
    const game = JieqiGame.create({ seed: 8 });
    const rng = createRng(1234);
    const scratch: Kind[] = [];
    const hiddenSquares = game.board.hiddenSquares('red');
    expect(hiddenSquares.length).toBeGreaterThan(0);

    sampleWorld(game.board, game.poolsFor('red'), rng, scratch);

    for (const sq of hiddenSquares) {
      const piece = game.board.at(sq);
      // Movement is untouched by sampling: `homeKind` still describes the square.
      expect(piece?.homeKind).toBe(HOME_KIND_BY_SQUARE.get(sq));
      expect(piece?.hidden).toBe(true);
      expect(game.poolsFor('red')[piece?.color as Color]).toContain(piece?.kind as Kind);
    }
  });
});

describe('attack detection', () => {
  it('agrees with brute-force move generation over thousands of random positions', () => {
    let checked = 0;
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      resetIds();
      const game = JieqiGame.create({ seed });
      const rng = createRng(seed * 97 + 5);
      for (let ply = 0; ply < 50 && !game.result; ply++) {
        const moves = game.legalMoves();
        if (moves.length === 0) break;
        game.apply(moves[rng.int(moves.length)] as Move);

        for (const color of ['red', 'black'] as const) {
          for (let sq = 0; sq < SQUARES; sq++) {
            expect(
              isSquareAttacked(game.board, sq, color),
              `seed=${seed} ply=${ply} color=${color} square=${sq % 9},${(sq / 9) | 0}`,
            ).toBe(attacksByBruteForce(game.board, sq, color));
            checked += 1;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(5000);
  });
});

describe('check, mate and stalemate', () => {
  it('sees a rook check down an open file, and not through a blocker', () => {
    const board = emptyBoard('red');
    put(board, 'red', 'K', 4, 9);
    put(board, 'black', 'K', 3, 0);
    const rook = put(board, 'black', 'R', 4, 5);
    finalize(board);
    const game = gameOn(board);

    expect(game.inCheck('red')).toBe(true);

    // A red pawn on the file between the rook and the king kills the check.
    put(board, 'red', 'P', 4, 7);
    finalize(board);
    expect(game.inCheck('red')).toBe(false);

    // And with no rook at all it is quiet too.
    board.squares[rook] = null;
    board.squares[squareOf(4, 7)] = null;
    board.rehash();
    expect(game.inCheck('red')).toBe(false);
  });

  it('applies the flying-general rule along a file', () => {
    const board = emptyBoard('red');
    put(board, 'red', 'K', 4, 9);
    put(board, 'black', 'K', 4, 0);
    finalize(board);
    const game = gameOn(board);

    // Nothing between the two kings: an illegal position for whoever has to move.
    expect(game.inCheck('red')).toBe(true);
    expect(game.inCheck('black')).toBe(true);

    put(board, 'red', 'P', 4, 5);
    finalize(board);
    expect(game.inCheck('red')).toBe(false);
    expect(game.inCheck('black')).toBe(false);
  });

  it('scores 困毙 (stalemate) as a loss for the side to move, not a draw', () => {
    // Black to move, no legal move, and *not* in check — xiangqi's stalemate.
    //
    //   the pawns on (3,1) and (5,1) have crossed the river, so they cover (3,0), (5,0) and (4,1);
    //   the pawn on (4,5) blocks the file, so the flying general does not rescue black.
    const board = fromAscii(`
      . . . . k . . . .
      . . . P . P . . .
      . . . . . . . . .
      . . . . . . . . .
      . . . . . . . . .
      . . . . P . . . .
      . . . . . . . . .
      . . . . . . . . .
      . . . . . . . . .
      . . . . K . . . .
    `);
    board.side = 'black';
    const game = gameOn(board);

    expect(game.inCheck('black')).toBe(false);
    expect(game.legalMoves('black')).toHaveLength(0);

    const result = game.computeResult();
    expect(result?.kind).toBe('stalemate');
    expect(result?.winner).toBe('red');
  });

  it('scores 将死 (checkmate) as a loss for the side to move', () => {
    // The black king on (4,0) is checked by the rook on (4,1); that rook is defended by the pawn on
    // (4,2); (3,0) is covered from (0,0) and (5,0) from (8,0).
    const board = fromAscii(`
      R . . . k . . . R
      . . . . R . . . .
      . . . . P . . . .
      . . . . . . . . .
      . . . . . . . . .
      . . . . . . . . .
      . . . . . . . . .
      . . . . . . . . .
      . . . . . . . . .
      . . . . K . . . .
    `);
    board.side = 'black';
    const game = gameOn(board);

    expect(game.inCheck('black')).toBe(true);
    expect(game.legalMoves('black')).toHaveLength(0);

    const result = game.computeResult();
    expect(result?.kind).toBe('checkmate');
    expect(result?.winner).toBe('red');
  });

  it('never lets a move expose your own king', () => {
    // Red king on (4,9), black rook on (4,5), and a single red horse on (4,8) plugging the file.
    const board = emptyBoard('red');
    put(board, 'red', 'K', 4, 9);
    const horse = put(board, 'red', 'H', 4, 8);
    // Black's king sits on file 3 so that the file-4 pin is the *only* constraint in play — otherwise
    // the flying general would deny every move on its own and the test would prove nothing.
    put(board, 'black', 'K', 3, 0);
    const rook = put(board, 'black', 'R', 4, 5);
    finalize(board);
    const game = gameOn(board);

    expect(game.inCheck('red')).toBe(false);

    // Every horse jump leaves file 4, so the pin makes all of them illegal.
    expect(game.legalMoves('red').filter((m) => m.from === horse)).toHaveLength(0);

    // (3,9) would line the red king up with black's king on file 3 with nothing between them, and
    // (4,8) is occupied by the horse, so the only king step left is (5,9).
    const kingMoves = game.legalMoves('red').filter((m) => m.from === squareOf(4, 9));
    expect([...kingMoves].map((m) => m.to)).toEqual([squareOf(5, 9)]);

    // Positive control: without the rook the very same horse is free again.
    board.squares[rook] = null;
    board.rehash();
    expect(game.legalMoves('red').filter((m) => m.from === horse).length).toBeGreaterThan(0);
  });
});

describe('notation', () => {
  it('writes a revealed piece with its own name and an ordinary xiangqi move', () => {
    const board = emptyBoard('red');
    put(board, 'red', 'K', 4, 9);
    put(board, 'black', 'K', 3, 0);
    // Red counts files 1-9 from its own right, i.e. from x=8 leftwards — so x=7 is 二。
    const cannon = put(board, 'red', 'C', 7, 7);
    finalize(board);
    expect(toChineseNotation(board, { from: cannon, to: squareOf(4, 7) })).toBe('炮二平五');
    // And the other cannon, on x=1, is 八.
    const other = put(board, 'red', 'C', 1, 7);
    finalize(board);
    expect(toChineseNotation(board, { from: other, to: squareOf(4, 7) })).toBe('炮八平五');
  });

  it('marks a face-down piece with 暗 and names it after its square', () => {
    const board = emptyBoard('red');
    put(board, 'red', 'K', 4, 9);
    put(board, 'black', 'K', 3, 0);
    // A real 车 standing on the 兵 square: the player sees 暗兵 and it steps forward — exactly the
    // first move the QQ strategy page recommends.
    const hidden = putHidden(board, 'red', 'R', 'P', 4, 6);
    finalize(board);
    expect(toChineseNotation(board, { from: hidden, to: squareOf(4, 5) })).toBe('暗兵五进一');
  });

  it('uses 前/后 when two same-named pieces share a file', () => {
    const board = emptyBoard('red');
    put(board, 'red', 'K', 4, 9);
    put(board, 'black', 'K', 3, 0);
    const front = putHidden(board, 'red', 'C', 'P', 0, 5); // nearer black
    putHidden(board, 'red', 'H', 'P', 0, 6);
    finalize(board);
    expect(toChineseNotation(board, { from: front, to: squareOf(0, 4) }).startsWith('前暗兵')).toBe(
      true,
    );
  });

  it('counts squares for straight movers and names a file for crooked ones', () => {
    const board = emptyBoard('red');
    put(board, 'red', 'K', 4, 9);
    put(board, 'black', 'K', 3, 0);
    const rook = put(board, 'red', 'R', 0, 9);
    const horse = put(board, 'red', 'H', 1, 9);
    finalize(board);
    expect(toChineseNotation(board, { from: rook, to: squareOf(0, 4) })).toBe('车九进五');
    expect(toChineseNotation(board, { from: horse, to: squareOf(2, 7) })).toBe('马八进七');
  });
});

describe('undo', () => {
  it('restores the board, the Zobrist key, the knowledge and the clocks', () => {
    resetIds();
    const game = JieqiGame.create({ seed: 12 });
    const before = game.board.toAscii();
    const beforeKey = game.board.key;
    const poolBefore = [...game.poolsFor('red').red];

    const move = game.legalMoves().find((m) => game.board.at(m.from)?.hidden) as Move;
    game.apply(move);
    expect(game.board.key).not.toBe(beforeKey);
    expect(game.ply).toBe(1);

    game.undo();
    expect(game.board.toAscii()).toBe(before);
    expect(game.board.key).toBe(beforeKey);
    expect(game.poolsFor('red').red).toEqual(poolBefore);
    expect(game.ply).toBe(0);
    expect(game.halfMoveClock).toBe(0);
    expect(game.result).toBeNull();
  });

  it('rewinds a whole move list, one Zobrist key at a time', () => {
    resetIds();
    const game = JieqiGame.create({ seed: 21 });
    const rng = createRng(5);
    const keys: number[] = [game.board.key];
    for (let i = 0; i < 25; i++) {
      const moves = game.legalMoves();
      if (moves.length === 0) break;
      game.apply(moves[rng.int(moves.length)] as Move);
      keys.push(game.board.key);
    }
    expect(keys.length).toBeGreaterThan(5);
    for (let i = keys.length - 1; i > 0; i--) {
      game.undo();
      expect(game.board.key).toBe(keys[i - 1]);
    }
    expect(game.ply).toBe(0);
  });
});

/**
 * 禁止全局同形 — a move that walks the position back to one this game has already been in is refused.
 *
 * Two things are being pinned down here, and the difference between them is the whole rule:
 *
 *  - it is the **first** repetition that is forbidden, not the third (the old 长将/长捉 guard); and
 *  - the refusal happens at three levels, each of which has to hold on its own: `selectableMoves()`
 *    (what the AI is allowed to pick from), `apply()` (the game's own door), and — in the UI —
 *    the warning that names the rule instead of silently ignoring the tap.
 */
describe('禁止全局同形', () => {
  /**
   * A bare position with room for an honest cycle: both kings, and one rook each on a file of its own.
   * Red rook on the a-file, black rook on the i-file, so neither move in the cycle is a capture and
   * neither side is ever in check.
   */
  function cycleBoard(): Board {
    const board = emptyBoard('red');
    put(board, 'red', 'K', 4, 9);
    put(board, 'black', 'K', 3, 0);
    put(board, 'red', 'R', 0, 5);
    put(board, 'black', 'R', 8, 5);
    return finalize(board);
  }

  /** The four plies that bring the position back: R a6→a5, r i6→i5, R a5→a6, r i5→i6. */
  const CYCLE: Move[] = [
    { from: squareOf(0, 5), to: squareOf(0, 4) },
    { from: squareOf(8, 5), to: squareOf(8, 4) },
    { from: squareOf(0, 4), to: squareOf(0, 5) },
    { from: squareOf(8, 4), to: squareOf(8, 5) },
  ];

  it('refuses the second occurrence of a position, not the third', () => {
    resetIds();
    const game = gameOn(cycleBoard());
    const opening = game.board.key;

    game.apply(CYCLE[0] as Move);
    game.apply(CYCLE[1] as Move);
    game.apply(CYCLE[2] as Move);
    // Three plies in, the fourth brings back the opening position *exactly* — including the side to
    // move, which is what makes it the same position rather than the same arrangement.
    expect(game.repetitionCount(opening)).toBe(1);
    const closing = CYCLE[3] as Move;
    expect(game.legalMoves()).toContainEqual(closing);
    expect(game.wouldRepeat(closing)).toBe(true);
    expect(game.isSelectable(closing)).toBe(false);
    expect(game.selectableMoves()).not.toContainEqual(closing);
    // ...and the game itself refuses it, so a repetition can never enter the history.
    expect(() => game.apply(closing)).toThrow(/禁止全局同形/);
    expect(game.ply).toBe(3);
  });

  it('leaves every other move of the same side alone, and re-opens what an undo takes back', () => {
    resetIds();
    const game = gameOn(cycleBoard());
    for (const move of CYCLE.slice(0, 3)) game.apply(move);

    // Black has moves to choose from; only the one that recreates the opening position is forbidden.
    expect(game.selectableMoves().length).toBeGreaterThan(1);
    expect(game.selectableMoves()).not.toContainEqual(CYCLE[3]);

    // 悔棋 is not a move: it forgets the position it rewinds out of, so what was forbidden a moment ago
    // can be played again — the record is of the positions this game has *actually* been in.
    game.undo(); // red's a5→a6, which had produced the position the cycle was about to close
    expect(game.isSelectable(CYCLE[2] as Move)).toBe(true);
    game.apply(CYCLE[2] as Move);
    // And with the cycle rebuilt, the closing move is refused again.
    expect(game.wouldRepeat(CYCLE[3] as Move)).toBe(true);
  });

  it('never lets the AI choose a forbidden move', () => {
    resetIds();
    const game = gameOn(cycleBoard());
    for (const move of CYCLE.slice(0, 3)) game.apply(move);

    // The AI's root list *is* `selectableMoves`, so the forbidden move is not merely unlikely — it is
    // not in the list the search ever sees.
    const decision = chooseMove(game, { difficulty: 'easy', seed: 7 });
    const forbidden = CYCLE[3] as Move;
    expect(decision).not.toBeNull();
    expect(decision?.move).not.toEqual(forbidden);
    expect(decision?.candidates.map((entry) => entry.move)).not.toContainEqual(forbidden);
    expect(game.isSelectable((decision as { move: Move }).move)).toBe(true);
  });
});
