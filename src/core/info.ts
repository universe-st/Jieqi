/**
 * What each side knows — and, crucially, that the two sides do **not** know the same things.
 *
 * Nobody sees a face-down piece while it stands on the board, and a player never learns what their own
 * face-down piece was once it has been captured (rule R7: 己方暗子被吃后，自己是不能看到暗子是什么棋).
 * But the *capturer* turns the piece over in their hand — the rule only forbids the loser from looking.
 * So the honest model is per-observer:
 *
 *     pool(observer, colour) = that colour's fifteen identities
 *                              − the ones a move turned face up (public: both players watched)
 *                              − the ones this observer learned by capturing a face-down piece
 *
 * The second subtraction only ever applies to the *opponent's* pool — you cannot capture your own
 * pieces — which is exactly the asymmetry the rule describes.
 *
 * Invariant (asserted in the tests): for every observer,
 *
 *     |pool(observer, colour)| === hiddenOnBoard(colour)
 *                                + hidden pieces of `colour` captured by anyone *but* the observer
 */

import type { Board } from './board';
import { ARMY_LIST, type Color, type Kind, other } from './types';
import type { Rng } from './rng';

/** One observer's view of both sides' remaining unknown identities. */
export type Pool = Record<Color, Kind[]>;

export interface Knowledge {
  /** Identities a move turned face up. Public — a reveal is the one thing everybody sees. */
  revealed: Record<Color, Kind[]>;
  /**
   * Identities the *observer* learned by capturing a face-down piece.
   *
   * `learned[red]` therefore always holds kinds belonging to black, and vice versa.
   */
  learned: Record<Color, Kind[]>;
}

export function createKnowledge(): Knowledge {
  return { revealed: { red: [], black: [] }, learned: { red: [], black: [] } };
}

export function cloneKnowledge(knowledge: Knowledge): Knowledge {
  return {
    revealed: { red: [...knowledge.revealed.red], black: [...knowledge.revealed.black] },
    learned: { red: [...knowledge.learned.red], black: [...knowledge.learned.black] },
  };
}

/** Records a reveal: the piece moved, so both players watched it turn over. */
export function noteRevealed(knowledge: Knowledge, color: Color, kind: Kind): void {
  if (kind === 'K') return; // the king is never face down, so it is never part of a pool
  knowledge.revealed[color].push(kind);
}

/**
 * Records that `observer` captured a face-down piece of kind `kind`.
 *
 * Only the observer's bookkeeping changes: the loser still has no idea what they lost, so from their
 * side the identity stays unaccounted for.
 */
export function noteLearned(knowledge: Knowledge, observer: Color, kind: Kind): void {
  knowledge.learned[observer].push(kind);
}

function removeOnce(kinds: Kind[], kind: Kind): boolean {
  const index = kinds.indexOf(kind);
  if (index < 0) return false;
  kinds.splice(index, 1);
  return true;
}

/** The remaining unknown identities, as `observer` sees them. */
export function poolsFor(knowledge: Knowledge, observer: Color): Pool {
  const pools: Pool = { red: [], black: [] };
  for (const color of ['red', 'black'] as const) {
    const kinds = [...ARMY_LIST];
    for (const kind of knowledge.revealed[color]) removeOnce(kinds, kind);
    // Only the other side's pool can shrink from what this observer captured.
    if (color !== observer) {
      for (const kind of knowledge.learned[observer]) removeOnce(kinds, kind);
    }
    pools[color] = kinds;
  }
  return pools;
}

/** How many of a side's pieces went down face first without `observer` finding out what they were. */
export function lostUnknownTo(board: Board, knowledge: Knowledge, observer: Color, color: Color): number {
  const pool = poolsFor(knowledge, observer)[color];
  return pool.length - board.hiddenSquares(color).length;
}

/**
 * Draws one concrete world consistent with what `observer` knows: every face-down piece is assigned an
 * identity from its owner's remaining pool, without replacement.
 *
 * `world` is mutated in place — the search calls this in a tight loop.
 */
export function sampleWorld(board: Board, pool: Pool, rng: Rng, scratch: Kind[]): void {
  for (const color of ['red', 'black'] as const) {
    const squares = board.hiddenSquares(color);
    if (squares.length === 0) continue;
    // Shuffle a scratch copy: the pool itself has to survive the sampling unchanged.
    scratch.length = 0;
    for (const kind of pool[color]) scratch.push(kind);
    rng.shuffle(scratch);
    for (let i = 0; i < squares.length; i++) {
      const square = squares[i] as number;
      const piece = board.at(square);
      const kind = scratch[i];
      if (!piece || kind === undefined) continue;
      // `homeKind` is untouched on purpose: movement is still decided by the square, not by whatever
      // identity this particular sample hands the piece.
      board.squares[square] = { ...piece, kind };
    }
  }
}

/** How surprising a side's remaining pool is, on average — the HUD's "what is left out there". */
export function expectedValue(pool: Pool, color: Color): number {
  const kinds = pool[color];
  if (kinds.length === 0) return 0;
  return kinds.reduce((sum, kind) => sum + KIND_WEIGHT[kind], 0) / kinds.length;
}

const KIND_WEIGHT: Record<Kind, number> = {
  K: 0,
  R: 900,
  C: 450,
  H: 400,
  A: 200,
  E: 200,
  P: 100,
};

export { other };
