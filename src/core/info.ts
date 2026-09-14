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
 *
 * 混斗 keeps the same shape but drops the split: the two armies are dealt as one pool of thirty
 * identities, so a face-down piece is not "red's unknown" or "black's unknown" but simply unknown.
 * {@link mixedPoolFor} / {@link sampleWorldMixed} are that version, and the invariant becomes
 * `|pool| === face-down pieces on the board + face-down pieces someone else captured`.
 */

import type { Board } from './board';
import { ARMY_LIST, type Color, type Identity, type Kind, mixedArmy, other } from './types';
import type { Rng } from './rng';

/** One observer's view of both sides' remaining unknown identities. */
export type Pool = Record<Color, Kind[]>;

/** An identity a capture taught the capturer: what the piece was, and whose it really was. */
export interface Learned {
  color: Color;
  kind: Kind;
}

export interface Knowledge {
  /** Identities a move turned face up, keyed by the colour the piece turned out to *be*. Public. */
  revealed: Record<Color, Kind[]>;
  /**
   * Identities the *observer* learned by capturing a face-down piece.
   *
   * `learned[red]` therefore always holds pieces red took, each tagged with the colour it turned out
   * to have. In 标准 that tag is always `black` — you cannot capture your own pieces — but 混斗 can
   * deal a red piece onto black's half, so a red capture can turn up a red piece, and the tag is what
   * keeps the two modes' pool arithmetic the same shape.
   */
  learned: Record<Color, Learned[]>;
}

export function createKnowledge(): Knowledge {
  return { revealed: { red: [], black: [] }, learned: { red: [], black: [] } };
}

export function cloneKnowledge(knowledge: Knowledge): Knowledge {
  return {
    revealed: { red: [...knowledge.revealed.red], black: [...knowledge.revealed.black] },
    learned: {
      red: knowledge.learned.red.map((entry) => ({ ...entry })),
      black: knowledge.learned.black.map((entry) => ({ ...entry })),
    },
  };
}

/** Records a reveal: the piece moved, so both players watched it turn over. `color` is what it *is*. */
export function noteRevealed(knowledge: Knowledge, color: Color, kind: Kind): void {
  if (kind === 'K') return; // the king is never face down, so it is never part of a pool
  knowledge.revealed[color].push(kind);
}

/**
 * Records that `observer` captured a face-down piece of kind `kind`.
 *
 * Only the observer's bookkeeping changes: the loser still has no idea what they lost, so from their
 * side the identity stays unaccounted for. `color` is the captured piece's true colour, which is the
 * capturer's side in 标准 (its default) and may be either side in 混斗.
 */
export function noteLearned(
  knowledge: Knowledge,
  observer: Color,
  kind: Kind,
  color: Color = other(observer),
): void {
  knowledge.learned[observer].push({ color, kind });
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
      for (const entry of knowledge.learned[observer]) {
        if (entry.color !== color) continue;
        removeOnce(kinds, entry.kind);
      }
    }
    pools[color] = kinds;
  }
  return pools;
}

/**
 * The same idea for 混斗, where the two armies are dealt as **one** pool of thirty identities.
 *
 * The distinction the 标准 pools draw — "mine" versus "theirs" — does not exist while the pieces are
 * face down: a square's identity can be any of the thirty, so the pool is a single multiset and the
 * whole question is which of it is still unaccounted for. Reveals are public (subtracted for every
 * observer); a face-down capture is subtracted only for the capturer, exactly as in 标准.
 */
export function mixedPoolFor(knowledge: Knowledge, observer: Color): Identity[] {
  const pool = mixedArmy();
  const take = (color: Color, kind: Kind): void => {
    const index = pool.findIndex((entry) => entry.color === color && entry.kind === kind);
    if (index >= 0) pool.splice(index, 1);
  };
  for (const color of ['red', 'black'] as const) {
    for (const kind of knowledge.revealed[color]) take(color, kind);
  }
  for (const entry of knowledge.learned[observer]) take(entry.color, entry.kind);
  return pool;
}

/** How many of a side's pieces went down face first without `observer` finding out what they were. */
export function lostUnknownTo(board: Board, knowledge: Knowledge, observer: Color, color: Color): number {
  const pool = poolsFor(knowledge, observer)[color];
  return pool.length - board.hiddenSquares(color).length;
}

/**
 * 混斗's counterpart: how many of the thirty identities `observer` still cannot place anywhere.
 *
 * Conservation is the check that the bookkeeping is honest:
 *
 *     |pool| === face-down pieces still on the board
 *                + face-down pieces somebody *other than the observer* took
 */
export function mixedLostUnknownTo(board: Board, knowledge: Knowledge, observer: Color): number {
  return mixedPoolFor(knowledge, observer).length - board.allHiddenSquares().length;
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

/**
 * 混斗's sampler: the same idea over **one** pool of thirty identities.
 *
 * Two things differ from {@link sampleWorld}, and both come straight from the deal:
 *
 * - every face-down piece draws from the *shared* pool, because the square no longer implies a side —
 *   a square on red's half is just as likely to be hiding a 黑车 as a 红车;
 * - a sample therefore decides a piece's **colour** as well as its kind, which is what makes the
 *   search see the real stake of moving a 暗子: some of the worlds have it turning into a piece that
 *   walks over to the opponent (rule M4).
 *
 * `homeKind` is untouched, so every world still shares one move list (rule R4 remains true, and the
 * PIMC engine leans on that).
 */
export function sampleWorldMixed(
  board: Board,
  pool: readonly Identity[],
  rng: Rng,
  scratch: Identity[],
): void {
  const squares = board.allHiddenSquares();
  if (squares.length === 0) return;
  scratch.length = 0;
  for (const identity of pool) scratch.push(identity);
  rng.shuffle(scratch);
  for (let i = 0; i < squares.length; i++) {
    const square = squares[i] as number;
    const piece = board.at(square);
    const identity = scratch[i];
    if (!piece || identity === undefined) continue;
    board.squares[square] = { ...piece, color: identity.color, kind: identity.kind };
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
