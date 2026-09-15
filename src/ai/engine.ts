/**
 * The AI: Perfect-Information Monte Carlo over determinized worlds, plus a deliberately small amount of
 * randomness on top (requirement 4 — a smart opponent that does not play the same game every time).
 *
 * ## Why PIMC rather than a plain minimax
 *
 * Jieqi is a game of **imperfect information**: neither player can see any face-down piece, not even
 * their own (rule R7 — a piece captured face down is removed without being turned over, so its owner
 * never learns what it was). A minimax over "the position" is therefore meaningless: a player does not
 * know which position they are in, only which *set* of positions they might be in.
 *
 * So the engine samples concrete worlds consistent with what is knowable — each face-down piece draws
 * an identity from its owner's remaining pool (see `core/info.ts`) — searches each world exactly, and
 * averages. The pleasant consequence is that jieqi's fog is handled by the *shape* of the algorithm
 * rather than by a fudge factor in the evaluation.
 *
 * Two things make this sound rather than merely plausible:
 *
 * 1. **Legality is world-independent.** A face-down piece is moved by the square it stands on, not by
 *    what it is, so every world shares one move list. No sampled world can produce an illegal move.
 * 2. **The pool already encodes what has been learned.** Revealing a piece removes its identity from
 *    the pool; losing one face down removes nothing, leaving an entry that can never be pinned down.
 *
 * 混斗 keeps both properties and changes only *what a world decides*: there the two armies are dealt as
 * one pool, so a sample hands each face-down piece a colour as well as a kind (`sampleWorldMixed`).
 * Legality is still world-independent — a 暗子 moves by its square, and ownership-by-half is public —
 * so every world shares one root move list, and what differs is the price of turning a piece over:
 * in some worlds the piece walks over to the opponent as soon as it is revealed (rule M4).
 *
 * ## Where the randomness comes from
 *
 * Three independent, all-small sources (PLAN §3.4): the sampling spread itself, uniform noise added to
 * each move's averaged score, and a rare epsilon-greedy pick from the near-best moves. Every one of
 * them is seeded, so an acceptance run can reproduce a game exactly.
 */

import type { Board } from '../core/board';
import { sampleWorld, sampleWorldMixed } from '../core/info';
import { generateMoves } from '../core/moves';
import { toChineseNotation } from '../core/notation';
import type { JieqiGame } from '../core/rules';
import { createRng, randomSeed, type Rng } from '../core/rng';
import { SQUARES, type Color, type Identity, type Kind, type Move, other, sameMove } from '../core/types';
import { foggedBoardFor, isSquareSeen, visibleSquares } from '../core/vision';
import { Searcher } from './search';

export type Difficulty = 'easy' | 'normal' | 'hard';

export interface DifficultyPreset {
  /** How many consistent worlds to average over. More worlds = a better estimate of the expectation. */
  worlds: number;
  /** Search depth inside each world. */
  depth: number;
  nodeBudget: number;
  timeLimitMs: number;
  /** Uniform noise, in centipawns, added to each move's averaged score. */
  noiseCp: number;
  /** Probability of taking a near-best move instead of the best one. */
  epsilon: number;
  /** How far behind the best a move may be, in centipawns, and still be "near-best". */
  slack: number;
}

/**
 * The three levels differ in search effort *and* in how much wobble they are allowed. `normal` is the
 * intended opponent: a full search every move, with noise well under a tenth of a pawn so it
 * occasionally prefers a different-but-fine plan without ever playing a howler.
 */
export const DIFFICULTY: Record<Difficulty, DifficultyPreset> = {
  easy: {
    worlds: 6,
    depth: 2,
    nodeBudget: 120_000,
    timeLimitMs: 400,
    noiseCp: 45,
    epsilon: 0.15,
    slack: 110,
  },
  normal: {
    worlds: 10,
    depth: 3,
    nodeBudget: 300_000,
    timeLimitMs: 700,
    noiseCp: 12,
    epsilon: 0.05,
    slack: 55,
  },
  // Measured on a desktop: easy 25 ms, normal 372 ms, hard ~0.8 s per move. Hard is only comfortable
  // because the world loop yields between samples — see `chooseMoveAsync`.
  hard: {
    worlds: 12,
    depth: 4,
    nodeBudget: 300_000,
    timeLimitMs: 900,
    noiseCp: 4,
    epsilon: 0.015,
    slack: 30,
  },
};

export interface AiOptions extends Partial<DifficultyPreset> {
  difficulty?: Difficulty;
  /** Seed for world sampling and the noise. Omit for a fresh one. */
  seed?: number;
}

export interface ScoredMove {
  move: Move;
  /** Chinese notation of the move in the position it was played in. */
  notation: string;
  /** Mean score across the sampled worlds, from the mover's point of view, before noise. */
  score: number;
  /** The same, after the noise was added — this is what the choice was made on. */
  noisy: number;
}

export interface AiDecision {
  move: Move;
  notation: string;
  score: number;
  nodes: number;
  worlds: number;
  depth: number;
  elapsedMs: number;
  /** Every root move with its score, best first. Exposed for the acceptance backdoor and for debugging. */
  candidates: ScoredMove[];
  /** Which of the three randomness sources, if any, changed the answer. */
  reason: 'best' | 'noise' | 'epsilon';
}

/**
 * Picks a move for the side to move.
 *
 * Returns `null` when the game is already over or the side has no move — the caller decides what that
 * means, because in jieqi "no move" is a *loss*, not a draw (rule R10).
 */
export function chooseMove(game: JieqiGame, options: AiOptions = {}): AiDecision | null {
  const plan = prepare(game, options);
  if (!plan) return null;
  const iterator = searchWorlds(plan);
  let step = iterator.next();
  while (!step.done) step = iterator.next();
  return step.value;
}

/**
 * The same decision, but it hands the browser a frame between sampled worlds.
 *
 * PIMC is already a loop over independent samples, which makes it trivially yieldable — and yielding
 * matters, because the search itself is synchronous and a hard-level move is most of a second. One
 * world is tens of milliseconds on a phone, so the "thinking" animation keeps moving and the app never
 * looks hung. `options.worlds` therefore doubles as the granularity of the hitch.
 */
export async function chooseMoveAsync(
  game: JieqiGame,
  options: AiOptions = {},
  onProgress?: (worldsDone: number, totalWorlds: number) => void,
): Promise<AiDecision | null> {
  const plan = prepare(game, options);
  if (!plan) return null;
  const iterator = searchWorlds(plan);
  let step = iterator.next();
  while (!step.done) {
    onProgress?.(step.value, plan.settings.worlds);
    await nextFrame();
    step = iterator.next();
  }
  return step.value;
}

/** Hands control back to the browser so a tween or a spinner keeps animating. */
function nextFrame(): Promise<void> {
  if (typeof requestAnimationFrame === 'function') {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function stripUndefined(options: AiOptions): Partial<DifficultyPreset> {
  const out: Partial<DifficultyPreset> = {};
  const keys: (keyof DifficultyPreset)[] = [
    'worlds',
    'depth',
    'nodeBudget',
    'timeLimitMs',
    'noiseCp',
    'epsilon',
    'slack',
  ];
  for (const key of keys) {
    const value = options[key];
    if (typeof value === 'number') out[key] = value;
  }
  return out;
}

interface SearchPlan {
  game: JieqiGame;
  color: Color;
  moves: Move[];
  settings: DifficultyPreset;
  rng: Rng;
}

function prepare(game: JieqiGame, options: AiOptions): SearchPlan | null {
  const preset = DIFFICULTY[options.difficulty ?? 'normal'];
  const settings: DifficultyPreset = { ...preset, ...stripUndefined(options) };
  const color = game.sideToMove;
  // 迷雾 mode: the root list is what the AI can *attempt* on its fogged view — every move its own
  // pieces could make if the unseen enemy pieces were not there. Playing one that reality blocks is
  // handled by the scene's retry loop, which walks the candidates until the real board accepts one.
  const moves = game.mode === 'fog' ? fogCandidates(game, color) : game.selectableMoves(color);
  if (moves.length === 0) return null;
  return { game, color, moves, settings, rng: createRng(options.seed ?? randomSeed()) };
}

/**
 * The whole decision as a generator that yields the number of completed worlds.
 *
 * Both drivers above consume it: the synchronous one drains it in a tight loop, the asynchronous one
 * breathes between yields. Keeping one implementation means the two cannot disagree about the answer.
 */
function* searchWorlds(plan: SearchPlan): Generator<number, AiDecision, void> {
  const { game, color, moves, settings, rng } = plan;
  const startedAt = Date.now();
  const fog = game.mode === 'fog' ? buildFogPlan(game, color) : null;
  const working: Board = fog ? fog.base.clone() : game.board.clone();
  const scratch: Kind[] = [];
  const scratchSquares: number[] = [];
  const mixedScratch: Identity[] = [];
  const searcher = new Searcher({
    maxDepth: settings.depth,
    nodeBudget: settings.nodeBudget,
    timeLimitMs: settings.timeLimitMs,
  });
  searcher.begin();

  const totals = new Array<number>(moves.length).fill(0);
  const counts = new Array<number>(moves.length).fill(0);
  let order: number[] = moves.map((_, index) => index);
  let worlds = 0;

  for (let w = 0; w < settings.worlds; w++) {
    // Re-derive a fresh, equally plausible world for every sample, from *this* player's point of
    // view: the pool includes what the opponent has lost face down (still unknown) but excludes the
    // face-down pieces this player has captured and turned over in their hand.
    //
    // 混斗 samples the same way over **one** pool of thirty identities: a 暗子's identity and its
    // colour are both unknown, so a world decides whose piece it is as well as what it is. That is
    // what puts the real cost of moving a 暗子 into the search's average — in some worlds it walks
    // over to the enemy the moment it is turned over (rule M4).
    //
    // 迷雾 samples *positions* too: the enemy pieces the AI cannot see are placed on sampled fogged
    // squares with sampled identities, so every world is a complete position with the full material
    // accounted for, and the price of a move is averaged over where the hidden army might be.
    let world: Board;
    if (fog) {
      world = sampleFogWorld(fog, rng, scratch, scratchSquares);
    } else {
      world = working;
      if (game.mode === 'mixed') {
        sampleWorldMixed(world, game.mixedPoolFor(color), rng, mixedScratch);
      } else {
        sampleWorld(world, game.poolsFor(color), rng, scratch);
      }
      world.side = color;
      world.rehash();
    }

    searcher.beginWorld();
    const scores = searcher.scoreWorld(world, color, moves, order, settings.depth);

    // A world cut short by the budget reports placeholder scores for its unsearched moves; folding
    // those into the average would drag good moves down. Keep a partial first world, drop later ones.
    const usable = !searcher.aborted || worlds === 0;
    if (usable) {
      for (let i = 0; i < moves.length; i++) {
        totals[i] = (totals[i] as number) + (scores[i] as number);
        counts[i] = (counts[i] as number) + 1;
      }
      worlds += 1;
    }
    if (searcher.aborted) break;

    order = rankByAverage(order, totals, counts);
    yield worlds;
  }

  const averages = moves.map((_, index) => {
    const count = counts[index] as number;
    return count === 0 ? -1_000_000 : (totals[index] as number) / count;
  });

  const ranked = moves.map((_, index) => ({ index, average: averages[index] as number }));
  ranked.sort((a, b) => b.average - a.average);

  // Source 2: uniform noise on every move's average. Small enough that it reorders moves that were
  // already close, and cannot promote a move that is genuinely worse.
  const noisy = ranked.map((entry) => entry.average + (rng.next() * 2 - 1) * settings.noiseCp);
  let chosen = 0;
  for (let i = 1; i < noisy.length; i++) {
    if ((noisy[i] as number) > (noisy[chosen] as number)) chosen = i;
  }
  let reason: AiDecision['reason'] = chosen === 0 ? 'best' : 'noise';

  // Source 3: rarely, and only among moves that are within `slack` of the best, play something else.
  const best = ranked[0] as { index: number; average: number };
  if (rng.next() < settings.epsilon) {
    const near = ranked.filter((entry) => best.average - entry.average <= settings.slack);
    if (near.length > 1) {
      const pick = near[rng.int(near.length)] as { index: number; average: number };
      const position = ranked.indexOf(pick);
      if (position !== chosen) {
        chosen = position;
        reason = 'epsilon';
      }
    }
  }

  const selected = ranked[chosen] as { index: number; average: number };
  const move = moves[selected.index] as Move;

  return {
    move,
    notation: toChineseNotation(game.board, move),
    score: selected.average,
    nodes: searcher.nodes,
    worlds,
    depth: searcher.depthReached,
    elapsedMs: Date.now() - startedAt,
    candidates: ranked.map((entry, position) => ({
      move: moves[entry.index] as Move,
      notation: toChineseNotation(game.board, moves[entry.index] as Move),
      score: entry.average,
      noisy: noisy[position] as number,
    })),
    reason,
  };
}

/** One enemy piece the AI cannot see: it exists (or is suspected to) but its square is unknown. */
interface UnseenPiece {
  readonly id: number;
  readonly color: Color;
  /** `null` while the piece is still face down — its identity is sampled like any other 暗子's. */
  readonly kind: Kind | null;
  readonly homeKind: Kind;
  readonly hidden: boolean;
}

/**
 * Everything the fogged search needs, computed once per decision: the fogged geometry (enemy pieces
 * the AI cannot see removed), the list of those pieces, and the pools their identities draw from.
 */
interface FogPlan {
  /** The real board — the source of the AI's vision. */
  readonly real: Board;
  readonly color: Color;
  /** Fogged geometry: the real board minus every unseen enemy piece. */
  readonly base: Board;
  /** The enemy pieces to re-place, each with its true colour and (if revealed) identity. */
  readonly unseen: UnseenPiece[];
  readonly ownPool: Kind[];
  readonly enemyPool: Kind[];
}

/**
 * The moves the AI can *attempt* in 迷雾 mode: generated on its fogged view, so a square it cannot
 * see is never known to be a capture — it is just a place it could try to go. Legality is judged on
 * the fogged view the same way the player's moves are judged on the real one, and the 禁止循环追棋
 * guard is read off the real game.
 */
export function fogCandidates(game: JieqiGame, color: Color): Move[] {
  // The enemy king sits where the AI last saw it, not where it really is (rule F3): a candidate list
  // built around the true square would let the AI aim at a king it cannot see.
  const view = foggedBoardFor(game.board, color, game.kingSeen[color]);
  const pseudo = generateMoves(view, color, []);
  const out: Move[] = [];
  for (const move of pseudo) {
    // 迷雾 = 吃王棋 (rule F4): no king-safety filter — any move the piece can geometrically make is
    // legal, so the only guard left is the repetition rule.
    if (game.wouldRepeat(move)) continue;
    out.push(move);
  }
  return out;
}

function buildFogPlan(game: JieqiGame, color: Color): FogPlan {
  const real = game.board;
  const seen = visibleSquares(real, color);
  const unseen: UnseenPiece[] = [];
  for (let sq = 0; sq < SQUARES; sq++) {
    const piece = real.at(sq);
    if (!piece || piece.kind === 'K') continue;
    if (real.ownerAt(sq) !== other(color)) continue;
    if (seen.has(sq)) continue;
    unseen.push({
      id: piece.id,
      color: piece.color,
      kind: piece.hidden ? null : piece.kind,
      homeKind: piece.homeKind,
      hidden: piece.hidden,
    });
  }
  const pools = game.poolsFor(color);
  return {
    real,
    color,
    base: foggedBoardFor(real, color, game.kingSeen[color]),
    unseen,
    ownPool: pools[color],
    enemyPool: pools[other(color)],
  };
}

/** Samples the identities of `color`'s face-down pieces from `pool`, without replacement. */
function assignHiddenKinds(board: Board, color: Color, pool: Kind[], rng: Rng, scratch: Kind[]): void {
  const squares = board.hiddenSquares(color);
  if (squares.length === 0) return;
  scratch.length = 0;
  for (const kind of pool) scratch.push(kind);
  rng.shuffle(scratch);
  for (let i = 0; i < squares.length; i++) {
    const square = squares[i];
    const kind = scratch[i];
    if (square === undefined || kind === undefined) continue;
    const piece = board.at(square);
    if (piece) board.squares[square] = { ...piece, kind };
  }
}

/**
 * One concrete world for the fogged search: the fogged geometry, every visible 暗子's identity
 * sampled from its pool, and the unseen enemy pieces placed on *sampled* fogged squares with sampled
 * identities. Each world is a complete position the ordinary search can play out; what differs
 * between worlds is where the hidden enemy army actually is, so the price of a move is averaged over
 * the enemy's possible deployments instead of being read off one lucky guess.
 */
function sampleFogWorld(plan: FogPlan, rng: Rng, scratch: Kind[], scratchSquares: number[]): Board {
  const world = plan.base.clone();
  const enemy = other(plan.color);

  // The AI's own 暗子: all visible, identities from its own pool.
  assignHiddenKinds(world, plan.color, plan.ownPool, rng, scratch);

  // The enemy's 暗子: the visible ones keep their real squares; the unseen ones are placed below.
  // One shuffle serves both, so a kind is never dealt twice.
  scratch.length = 0;
  for (const kind of plan.enemyPool) scratch.push(kind);
  rng.shuffle(scratch);
  const visibleHidden = world.hiddenSquares(enemy);
  let index = 0;
  for (const sq of visibleHidden) {
    const piece = world.at(sq);
    const kind = scratch[index++];
    if (piece && kind !== undefined) world.squares[sq] = { ...piece, kind };
  }

  // The squares the hidden army might occupy: fogged, and empty in the AI's picture of the board.
  scratchSquares.length = 0;
  for (let sq = 0; sq < SQUARES; sq++) {
    if (isSquareSeen(plan.real, plan.color, sq)) continue;
    if (plan.base.at(sq)) continue;
    scratchSquares.push(sq);
  }
  rng.shuffle(scratchSquares);

  let hiddenIndex = 0;
  for (let i = 0; i < plan.unseen.length; i++) {
    const entry = plan.unseen[i];
    const slot = scratchSquares[i];
    if (entry === undefined || slot === undefined) continue;
    const kind = entry.kind ?? scratch[index + hiddenIndex++];
    if (kind === undefined) continue;
    world.squares[slot] = {
      id: entry.id,
      color: entry.color,
      kind,
      homeKind: entry.homeKind,
      hidden: entry.hidden,
    };
  }

  world.side = plan.color;
  world.rehash();
  return world;
}

/** Orders root indices by their running average, best first — this is what makes the pruning pay off. */
function rankByAverage(order: readonly number[], totals: number[], counts: number[]): number[] {
  return [...order].sort((a, b) => {
    const countA = counts[a] as number;
    const countB = counts[b] as number;
    const avgA = countA === 0 ? -Infinity : (totals[a] as number) / countA;
    const avgB = countB === 0 ? -Infinity : (totals[b] as number) / countB;
    return avgB - avgA;
  });
}

/** Scores every legal move and returns them best-first, without playing anything. Used by the UI hint. */
export function analyse(game: JieqiGame, options: AiOptions = {}): ScoredMove[] {
  const decision = chooseMove(game, { ...options, epsilon: 0, noiseCp: 0 });
  return decision?.candidates ?? [];
}

export { sameMove };
