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
 * ## Where the randomness comes from
 *
 * Three independent, all-small sources (PLAN §3.4): the sampling spread itself, uniform noise added to
 * each move's averaged score, and a rare epsilon-greedy pick from the near-best moves. Every one of
 * them is seeded, so an acceptance run can reproduce a game exactly.
 */

import type { Board } from '../core/board';
import { sampleWorld } from '../core/info';
import { toChineseNotation } from '../core/notation';
import type { JieqiGame } from '../core/rules';
import { createRng, randomSeed, type Rng } from '../core/rng';
import { type Color, type Kind, type Move, sameMove } from '../core/types';
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
  const moves = game.selectableMoves(color);
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
  const working: Board = game.board.clone();
  const scratch: Kind[] = [];
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
    sampleWorld(working, game.poolsFor(color), rng, scratch);
    working.side = color;
    working.rehash();

    searcher.beginWorld();
    const scores = searcher.scoreWorld(working, color, moves, order, settings.depth);

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
