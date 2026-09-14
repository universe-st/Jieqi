/**
 * Core vocabulary of 揭棋 (Jieqi): colours, piece kinds, squares and the geometry constants that the
 * movement rules are written against.
 *
 * This module — like everything else under `src/core` and `src/ai` — must stay free of Phaser and of
 * the DOM so the rules can be unit-tested in plain Node (PLAN §2).
 */

export type Color = 'red' | 'black';

/**
 * How a match is dealt and how a piece changes hands.
 *
 * - `standard` — 揭棋 proper: each side shuffles its own fifteen identities onto its own fifteen
 *   starting squares, so a face-down piece always belongs to the half it stands on *and always was
 *   that side's piece*. Turning it over only tells you what it is.
 * - `mixed` — 混斗: both sides' non-king identities are shuffled together and dealt across the thirty
 *   starting squares in one pool, so the piece under a 暗子 may belong to either side. While it is
 *   face down it counts as the property of the half it stands on (rule M2), which is what lets its
 *   owner-of-the-moment move it; turning it over hands it to whoever it really is (rule M4).
 *
 * Nothing else differs: the kings, the movement of a hidden piece, check, 困毙, 禁止循环追棋 and the
 * draw are all the same in both modes.
 */
export type GameMode = 'standard' | 'mixed';

export const MODE_NAME: Readonly<Record<GameMode, string>> = {
  standard: '标准玩法',
  mixed: '混斗玩法',
};

/**
 * Piece kinds, using the conventional xiangqi letters.
 *
 * `K` 帅/将 · `A` 仕/士 · `E` 相/象 · `H` 马 · `R` 车 · `C` 炮 · `P` 兵/卒
 */
export type Kind = 'K' | 'A' | 'E' | 'H' | 'R' | 'C' | 'P';

/** 9 files (columns) × 10 ranks (rows), red at the bottom. */
export const FILES = 9;
export const RANKS = 10;
export const SQUARES = FILES * RANKS;

/** Flat square index: `y * 9 + x`, with `y = 0` the black back rank and `y = 9` the red back rank. */
export const squareOf = (x: number, y: number): number => y * FILES + x;
export const fileOf = (sq: number): number => sq % FILES;
export const rankOf = (sq: number): number => (sq / FILES) | 0;

export const onBoard = (x: number, y: number): boolean =>
  x >= 0 && x < FILES && y >= 0 && y < RANKS;

export const other = (color: Color): Color => (color === 'red' ? 'black' : 'red');

/**
 * 红先黑后 — red opens every game.
 *
 * A rule of the game, not a detail of the draw: the draw decides which *side* the player takes, and
 * whoever ends up with 黑 answers the first move. So the opening turn is a constant even though the
 * player's colour is not.
 */
export const FIRST_MOVER: Color = 'red';

/**
 * A piece on the board.
 *
 * Two kinds matter and they are *not* the same thing for a hidden piece:
 *
 * - `kind` is the piece's **true identity**. It is known to the engine and to nobody else — not the
 *   player, and not even the AI, because a player never sees their own 暗子 either (rule R7: a hidden
 *   piece captured by the opponent is placed face-down and the owner may not look at it).
 * - `homeKind` is the kind of the **starting square** the piece was dealt to. While the piece is
 *   hidden its movement is entirely determined by this value (rule R4: 暗子按其所在位置走子).
 *
 * Once a hidden piece moves it is revealed (rule R5), `hidden` becomes `false`, and from then on only
 * `kind` drives its movement. `homeKind` is therefore fixed for the piece's whole life.
 *
 * `color` is always the piece's **true** colour, in both modes. Who the piece counts as *right now* is
 * a different question, and it is asked of the board — `Board.ownerAt(sq)`. In 标准 the two always
 * agree; in 混斗 a face-down piece belongs to the half it stands on (rule M2) and only becomes its own
 * side's property once it is turned over (rule M4). Rules code must therefore reach for `ownerAt`
 * whenever it means "whose piece is this", and for `piece.color` only when it means "what is this".
 */
export interface Piece {
  /** Stable identity, used by the view to follow a piece across moves. */
  readonly id: number;
  readonly color: Color;
  /** True identity. Hidden information — never render this for a `hidden` piece. */
  readonly kind: Kind;
  /** Kind of the starting square this piece was dealt to; drives movement while `hidden`. */
  readonly homeKind: Kind;
  /** `true` for 暗子 (face down), `false` for 明子 (face up). */
  readonly hidden: boolean;
}

export interface Move {
  readonly from: number;
  readonly to: number;
}

export const sameMove = (a: Move, b: Move): boolean => a.from === b.from && a.to === b.to;

/** Identity multiset of a side's 16 pieces — the pool a deal is drawn from. */
export const ARMY: Readonly<Record<Kind, number>> = {
  K: 1,
  A: 2,
  E: 2,
  H: 2,
  R: 2,
  C: 2,
  P: 5,
};

/** The 15 non-king identities, in a fixed canonical order (used to build and sample the info pool). */
export const ARMY_LIST: readonly Kind[] = [
  'A', 'A', 'E', 'E', 'H', 'H', 'R', 'R', 'C', 'C', 'P', 'P', 'P', 'P', 'P',
];

/** A concrete piece identity: what a piece *is*, and whose it truly is. */
export interface Identity {
  readonly color: Color;
  readonly kind: Kind;
}

/** Red's fifteen then black's fifteen — the thirty identities a 混斗 deal shuffles into one pool. */
export function mixedArmy(): Identity[] {
  const out: Identity[] = [];
  for (const color of ['red', 'black'] as const) {
    for (const kind of ARMY_LIST) out.push({ color, kind });
  }
  return out;
}

/** One starting square of the standard xiangqi setup, tagged with the kind that belongs there. */
export interface StartSquare {
  readonly square: number;
  readonly kind: Kind;
}

const backRank: readonly Kind[] = ['R', 'H', 'E', 'A', 'K', 'A', 'E', 'H', 'R'];

function sideStartSquares(
  backRankY: number,
  cannonY: number,
  pawnY: number,
): readonly StartSquare[] {
  const out: StartSquare[] = [];
  backRank.forEach((kind, x) => out.push({ square: squareOf(x, backRankY), kind }));
  out.push({ square: squareOf(1, cannonY), kind: 'C' });
  out.push({ square: squareOf(7, cannonY), kind: 'C' });
  for (let x = 0; x < FILES; x += 2) out.push({ square: squareOf(x, pawnY), kind: 'P' });
  return out;
}

/** All 16 starting squares of a side, in the standard xiangqi setup. */
export const START_SQUARES: Readonly<Record<Color, readonly StartSquare[]>> = {
  black: sideStartSquares(0, 2, 3),
  red: sideStartSquares(9, 7, 6),
};

/** The king's home square: 将 at (4,0) for black, 帅 at (4,9) for red. */
export const KING_SQUARE: Readonly<Record<Color, number>> = {
  black: squareOf(4, 0),
  red: squareOf(4, 9),
};

/** Palace files are shared; the ranks differ per colour. */
export const PALACE_MIN_X = 3;
export const PALACE_MAX_X = 5;

export const inPalace = (color: Color, sq: number): boolean => {
  const x = fileOf(sq);
  const y = rankOf(sq);
  if (x < PALACE_MIN_X || x > PALACE_MAX_X) return false;
  return color === 'red' ? y >= 7 : y <= 2;
};

/** River: black owns ranks 0–4, red owns ranks 5–9. */
export const ownHalf = (color: Color, sq: number): boolean =>
  color === 'red' ? rankOf(sq) >= 5 : rankOf(sq) <= 4;

/** Has a piece of `color` on `sq` crossed the river? Drives the 兵/卒 sideways step. */
export const crossedRiver = (color: Color, sq: number): boolean => !ownHalf(color, sq);

/**
 * Which side of the board a square belongs to — 黑's half is ranks 0–4, 红's is ranks 5–9.
 *
 * This is rule M2's whole definition: in 混斗 a face-down piece counts as belonging to the half it
 * stands on. It works as "the side that dealt this square" because a face-down piece never moves
 * (rule R4/R5: a hidden piece is turned over as part of its move), so it is always still standing on
 * one of the thirty starting squares, fifteen per half.
 */
export const sideOfSquare = (sq: number): Color => (ownHalf('black', sq) ? 'black' : 'red');

/** One step forward, which is towards the opponent: red marches up the board, black down. */
export const forwardStep = (color: Color): number => (color === 'red' ? -1 : 1);

/** Chinese names, indexed by colour because 帅/将 and friends differ. */
export const KIND_NAME: Readonly<Record<Color, Record<Kind, string>>> = {
  red: { K: '帥', A: '仕', E: '相', H: '馬', R: '車', C: '炮', P: '兵' },
  black: { K: '將', A: '士', E: '象', H: '馬', R: '車', C: '炮', P: '卒' },
};

export const COLOR_NAME: Readonly<Record<Color, string>> = { red: '红方', black: '黑方' };

/**
 * Material values in centipawn-like units. A revealed piece is worth this much; a hidden piece is
 * worth the *expectation* over the identities still in its owner's pool, which the AI gets for free
 * by averaging over sampled worlds (see `src/ai/pmc.ts`).
 */
export const PIECE_VALUE: Readonly<Record<Kind, number>> = {
  K: 60000,
  R: 900,
  C: 450,
  H: 400,
  A: 200,
  E: 200,
  P: 100,
};

/**
 * Movement flavour of a piece, which is the only thing that differs between a hidden and a revealed
 * piece of the same `kind`.
 *
 * - `classic`: the standard xiangqi restriction (advisors stay in the palace, elephants stay on
 *   their own side).
 * - `roaming`: the 揭棋 relaxation of rule R8 — a *revealed* 仕/士 or 相/象 may leave the palace and
 *   cross the river.
 */
export type MovementMode = 'classic' | 'roaming';

/** The kind that governs how a piece moves right now, plus how freely it may roam. */
export function movementOf(piece: Piece): { kind: Kind; mode: MovementMode } {
  if (piece.hidden) return { kind: piece.homeKind, mode: 'classic' };
  // Revealed advisors and elephants are the only pieces whose movement differs from classic xiangqi.
  const roaming = piece.kind === 'A' || piece.kind === 'E';
  return { kind: piece.kind, mode: roaming ? 'roaming' : 'classic' };
}
