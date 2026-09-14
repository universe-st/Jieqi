/**
 * Negamax alpha-beta with iterative-deepening-style root ordering, a transposition table, killer and
 * history heuristics, and a quiescence search over captures.
 *
 * The search deliberately knows nothing about hidden information: it runs inside one *determinized
 * world* (see `pmc.ts`), where every face-down piece has been given a concrete identity. Legality is
 * world-independent — a face-down piece is moved by the square it stands on, which everyone can see —
 * so every world shares the same move list, and only the values differ.
 *
 * 混斗 adds one thing to that world: the identity a face-down piece draws carries a **colour**, so
 * turning it over may hand it to the opponent (rule M4). Inside a world that is simply the truth, and
 * this file plays it out as such — {@link Searcher.generateLegal} filters with the real consequence,
 * which is why a line that hands the opponent a rook scores like the loss it is. The public move list
 * (`rules.legalMoves`) is deliberately more permissive; see `isKingSafeAfter`.
 */

import type { Board } from '../core/board';
import { generateCaptures, generateMoves, isKingSafe } from '../core/moves';
import { type Color, type Move, PIECE_VALUE, other } from '../core/types';
import { evaluateFor } from './evaluate';

/** Score of being checkmated at ply 0. Mate distances are folded in so a faster mate always wins. */
export const MATE = 100000;
const MATE_THRESHOLD = MATE - 1000;
const INF = 1_000_000;
const MAX_PLY = 48;

/**
 * How much worse than the best-so-far a root move may be and still get an exact score. The root raises
 * alpha as it goes (that is where most of the pruning comes from), but a soft alpha keeps the moves
 * near the top — the ones the "small randomness" is allowed to pick from — accurately scored.
 */
const ROOT_SLACK = 120;

const encodeMove = (from: number, to: number): number => from * 90 + to;
const moveFrom = (code: number): number => (code / 90) | 0;
const moveTo = (code: number): number => code % 90;

const FLAG_EXACT = 1;
const FLAG_LOWER = 2;
const FLAG_UPPER = 3;

function toTable(score: number, ply: number): number {
  if (score > MATE_THRESHOLD) return score + ply;
  if (score < -MATE_THRESHOLD) return score - ply;
  return score;
}

function fromTable(score: number, ply: number): number {
  if (score > MATE_THRESHOLD) return score - ply;
  if (score < -MATE_THRESHOLD) return score + ply;
  return score;
}

/**
 * Fixed-size, depth-preferred transposition table.
 *
 * Cleared between worlds: the same position is worth different things depending on what the face-down
 * pieces turned out to be, so carrying entries across a re-sample would poison the search.
 */
class TranspositionTable {
  private static readonly SIZE = 1 << 16;
  private static readonly MASK = TranspositionTable.SIZE - 1;
  // `NaN` is the empty marker: it compares unequal to everything, including itself.
  private keys = new Float64Array(TranspositionTable.SIZE).fill(NaN);
  private scores = new Int32Array(TranspositionTable.SIZE);
  private depths = new Int8Array(TranspositionTable.SIZE);
  private flags = new Int8Array(TranspositionTable.SIZE);
  private moves = new Int32Array(TranspositionTable.SIZE);

  clear(): void {
    this.keys.fill(NaN);
  }

  probe(key: number): { score: number | null; depth: number; flag: number; move: number } {
    const index = (key | 0) & TranspositionTable.MASK;
    if (this.keys[index] !== key) return { score: null, depth: -1, flag: 0, move: -1 };
    const flag = this.flags[index] as number;
    return {
      score: this.scores[index] as number,
      depth: this.depths[index] as number,
      flag,
      move: this.moves[index] as number,
    };
  }

  store(key: number, depth: number, score: number, flag: number, move: number): void {
    const index = (key | 0) & TranspositionTable.MASK;
    const occupied = !Number.isNaN(this.keys[index]);
    if (occupied && (this.depths[index] as number) > depth) return;
    this.keys[index] = key;
    this.scores[index] = score;
    this.depths[index] = depth;
    this.flags[index] = flag;
    this.moves[index] = move;
  }
}

export interface SearchLimits {
  /** Nominal depth of the shallowest search; the root starts here and deepens while budget remains. */
  maxDepth: number;
  /** Hard ceiling on nodes for the whole decision, shared across worlds. */
  nodeBudget: number;
  /** Hard ceiling on wall-clock milliseconds for the whole decision. */
  timeLimitMs: number;
}

export interface SearcherStats {
  nodes: number;
  depthReached: number;
  aborted: boolean;
}

/**
 * One searcher per AI decision. It owns the transposition table and the heuristics, and it is reset
 * between worlds rather than between moves, so the tables stay warm across the whole PIMC loop.
 */
export class Searcher {
  readonly limits: SearchLimits;
  nodes = 0;
  depthReached = 0;
  aborted = false;

  private readonly tt = new TranspositionTable();
  private readonly killers = new Int32Array(MAX_PLY * 2).fill(-1);
  private readonly history = new Int32Array(90 * 90);
  private readonly path: number[] = [];
  private deadline = 0;
  private depth = 3;
  /**
   * One move list per ply.
   *
   * A single shared list would be silently clobbered by the recursive call that is iterating it — the
   * child's `generateLegal` clears the parent's array mid-loop. Indexing by ply makes that impossible.
   */
  private readonly movePool: Move[][] = Array.from({ length: MAX_PLY }, () => []);
  private readonly capturePool: Move[][] = Array.from({ length: MAX_PLY }, () => []);

  constructor(limits: SearchLimits) {
    this.limits = limits;
  }

  /** Called once per decision. */
  begin(unlimited = false): void {
    this.nodes = 0;
    this.aborted = false;
    this.depthReached = 0;
    this.deadline = unlimited ? Number.POSITIVE_INFINITY : Date.now() + this.limits.timeLimitMs;
    this.history.fill(0);
  }

  /** Called once per sampled world: the heuristics are per-world, only the node budget is global. */
  beginWorld(): void {
    this.tt.clear();
    this.killers.fill(-1);
    this.history.fill(0);
  }

  private outOfBudget(): boolean {
    if (this.aborted) return true;
    if (this.nodes >= this.limits.nodeBudget) {
      this.aborted = true;
      return true;
    }
    if ((this.nodes & 1023) === 0 && Date.now() > this.deadline) {
      this.aborted = true;
      return true;
    }
    return false;
  }

  stats(): SearcherStats {
    return { nodes: this.nodes, depthReached: this.depthReached, aborted: this.aborted };
  }

  /**
   * Scores every root move in `moves`, in the order given by `order` (indices into `moves`).
   *
   * The order comes from the running average of previous worlds, so the most promising move is
   * searched first and prunes the rest — while {@link ROOT_SLACK} keeps the near-misses accurately
   * scored, which is what the sampling average actually needs.
   */
  searchRoot(board: Board, color: Color, moves: readonly Move[], order: readonly number[]): number[] {
    const scores = new Array<number>(moves.length).fill(-INF);
    const opponent = other(color);
    this.path.length = 0;
    this.path.push(board.key);

    let alpha = -INF;
    for (const index of order) {
      if (this.aborted) break;
      const move = moves[index] as Move;
      const undo = board.makeMove(move.from, move.to);
      const value = -this.negamax(board, opponent, this.depth - 1, -INF, -alpha + ROOT_SLACK, 1);
      board.unmakeMove(undo);
      if (this.aborted) break;
      scores[index] = value;
      if (value > alpha) alpha = value;
    }

    // Moves the budget never reached are ranked just behind everything that was searched, so an early
    // abort degrades the answer instead of producing garbage.
    const fallback = alpha === -INF ? 0 : alpha - 400;
    for (let i = 0; i < scores.length; i++) {
      if (scores[i] === -INF) scores[i] = fallback;
    }
    this.path.length = 0;
    return scores;
  }

  /** Searches one world at the given depth and returns the per-move scores. */
  scoreWorld(
    board: Board,
    color: Color,
    moves: readonly Move[],
    order: readonly number[],
    depth: number,
  ): number[] {
    this.depth = Math.max(1, Math.min(MAX_PLY - 2, depth));
    this.depthReached = Math.max(this.depthReached, this.depth);
    return this.searchRoot(board, color, moves, order);
  }

  private negamax(
    board: Board,
    color: Color,
    depth: number,
    alpha: number,
    beta: number,
    ply: number,
  ): number {
    this.nodes += 1;
    if (this.outOfBudget()) return 0;

    // Repeating a position that already occurred on this line is a draw. Only every other ply can
    // repeat, because the side to move alternates.
    const key = board.key;
    for (let i = this.path.length - 2; i >= 0; i -= 2) {
      if (this.path[i] === key) return 0;
    }

    if (depth <= 0) return this.quiesce(board, color, alpha, beta, ply);

    const entry = this.tt.probe(key);
    let ttMove = entry.move;
    if (entry.score !== null && entry.depth >= depth) {
      const score = fromTable(entry.score, ply);
      if (entry.flag === FLAG_EXACT) return score;
      if (entry.flag === FLAG_LOWER && score >= beta) return score;
      if (entry.flag === FLAG_UPPER && score <= alpha) return score;
    }

    const moves = this.generateLegal(board, color, ply);
    if (moves.length === 0) {
      // No legal move loses the game here: 将死 and 困毙 are both a loss (rule R10).
      return -MATE + ply;
    }

    this.orderMoves(board, moves, ttMove, ply);
    this.path.push(key);

    const originalAlpha = alpha;
    let best = -INF;
    let bestMove = -1;

    for (const move of moves) {
      const victim = board.at(move.to);
      const undo = board.makeMove(move.from, move.to);
      const score = -this.negamax(board, other(color), depth - 1, -beta, -alpha, ply + 1);
      board.unmakeMove(undo);
      if (this.aborted) break;

      if (score > best) {
        best = score;
        bestMove = encodeMove(move.from, move.to);
      }
      if (score > alpha) alpha = score;
      if (alpha >= beta) {
        if (!victim) {
          const slot = ply * 2;
          if (this.killers[slot] !== bestMove) {
            this.killers[slot + 1] = this.killers[slot] as number;
            this.killers[slot] = bestMove;
          }
          const h = move.from * 90 + move.to;
          this.history[h] = (this.history[h] as number) + depth * depth;
        }
        break;
      }
    }

    this.path.pop();

    if (!this.aborted) {
      const flag =
        best <= originalAlpha ? FLAG_UPPER : best >= beta ? FLAG_LOWER : FLAG_EXACT;
      this.tt.store(key, depth, toTable(best, ply), flag, bestMove);
    }
    return best;
  }

  /**
   * Quiescence: keep taking captures until the position is quiet.
   *
   * Without it the evaluation is fooled by every hanging piece. It also resolves the one thing an
   * alpha-beta over determinized worlds must not get wrong — a king being captured, which is scored as
   * mate rather than as a very good capture.
   */
  private quiesce(board: Board, color: Color, alpha: number, beta: number, ply: number): number {
    this.nodes += 1;
    if (this.outOfBudget()) return 0;
    if (ply >= MAX_PLY - 1) return evaluateFor(board, color);

    const stand = evaluateFor(board, color);
    if (stand >= beta) return beta;
    if (stand > alpha) alpha = stand;

    // Captures are generated pseudo-legally on purpose — the legality filter below is what makes it
    // correct, and generating legal moves first would cost more than it saves.
    const scratch = this.capturePool[ply] as Move[];
    scratch.length = 0;
    generateCaptures(board, color, scratch);
    if (scratch.length === 0) return alpha;

    scratch.sort((a, b) => captureScore(board, b) - captureScore(board, a));

    for (const move of scratch) {
      const victim = board.at(move.to);
      // The opponent's king cannot legally be captured in a search that filters at every node, so this
      // only fires when a shallow line let one through: treat it as the mate it is.
      if (victim && victim.kind === 'K') return MATE - ply - 1;

      const undo = board.makeMove(move.from, move.to);
      if (!isKingSafe(board, color)) {
        board.unmakeMove(undo);
        continue;
      }
      const score = -this.quiesce(board, other(color), -beta, -alpha, ply + 1);
      board.unmakeMove(undo);
      if (this.aborted) return 0;

      if (score >= beta) return beta;
      if (score > alpha) alpha = score;
    }
    return alpha;
  }

  private generateLegal(board: Board, color: Color, ply: number): Move[] {
    const out = this.movePool[ply] as Move[];
    out.length = 0;
    const pseudo = generateMoves(board, color, []);
    for (const move of pseudo) {
      const undo = board.makeMove(move.from, move.to);
      const safe = isKingSafe(board, color);
      board.unmakeMove(undo);
      if (safe) out.push(move);
    }
    return out;
  }

  private orderMoves(board: Board, moves: Move[], ttMove: number, ply: number): void {
    const scores = new Array<number>(moves.length);
    const slot = Math.min(ply, MAX_PLY - 1) * 2;
    for (let i = 0; i < moves.length; i++) {
      const move = moves[i] as Move;
      const code = encodeMove(move.from, move.to);
      if (code === ttMove) {
        scores[i] = 1_000_000;
        continue;
      }
      const victim = board.at(move.to);
      if (victim) {
        const attacker = board.at(move.from);
        // Most valuable victim, least valuable attacker.
        scores[i] =
          100_000 + PIECE_VALUE[victim.kind] * 8 - (attacker ? PIECE_VALUE[attacker.kind] : 0);
        continue;
      }
      if (this.killers[slot] === code || this.killers[slot + 1] === code) {
        scores[i] = 90_000;
        continue;
      }
      scores[i] = this.history[move.from * 90 + move.to] as number;
    }
    // Insertion sort: the lists are short and this keeps the move array itself untouched.
    for (let i = 1; i < moves.length; i++) {
      const move = moves[i] as Move;
      const score = scores[i] as number;
      let j = i - 1;
      while (j >= 0 && (scores[j] as number) < score) {
        moves[j + 1] = moves[j] as Move;
        scores[j + 1] = scores[j] as number;
        j -= 1;
      }
      moves[j + 1] = move;
      scores[j + 1] = score;
    }
  }
}

function captureScore(board: Board, move: Move): number {
  const victim = board.at(move.to);
  const attacker = board.at(move.from);
  if (!victim) return 0;
  return PIECE_VALUE[victim.kind] * 8 - (attacker ? PIECE_VALUE[attacker.kind] : 0);
}

export { INF, moveFrom, moveTo };
