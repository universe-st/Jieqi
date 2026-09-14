/**
 * The game: legality, check, terminal results, and the *public* record of what happened.
 *
 * A deliberate distinction runs through this file — the engine knows every hidden piece's identity, the
 * players do not, and {@link MoveEvent} is the boundary. It carries only what a player at the board
 * would have seen: the identity a piece turned into when it was revealed, and nothing at all about a
 * face-down piece that was captured (rule R7: it is removed face down and its owner may not look).
 */

import { Board, type Undo } from './board';
import {
  cloneKnowledge,
  createKnowledge,
  noteLearned,
  noteRevealed,
  poolsFor,
  type Knowledge,
  type Pool,
} from './info';
import { generateMoves, isKingSafe } from './moves';
import { toChineseNotation } from './notation';
import { createRng, randomSeed } from './rng';
import { ARMY_LIST, type Color, type Kind, type Move, other, sameMove } from './types';

export type ResultKind =
  | 'checkmate'
  | 'stalemate'
  | 'resign'
  | 'perpetual'
  | 'idle'
  | 'agreement';

export interface GameResult {
  /** `null` for a draw. */
  winner: Color | null;
  kind: ResultKind;
  /** Human-readable Chinese reason, shown verbatim by the UI. */
  text: string;
}

export interface CapturedInfo {
  pieceId: number;
  square: number;
  /** Needed by the view to put the right disc back on the board when a move is undone. */
  color: Color;
  /** `true` when the piece was taken face down, so only the capturer ever saw it. */
  hidden: boolean;
  /**
   * The piece's true identity — always.
   *
   * It is *not* public when `hidden`: rule R7 stops the loser from looking, but the capturer turns the
   * piece over in their hand. Whoever renders this has to decide per side what to show, and the engine
   * refuses to make that decision for them (see the trays in `GameScene`).
   */
  kind: Kind;
}

export interface MoveEvent {
  readonly move: Move;
  readonly color: Color;
  readonly pieceId: number;
  /** True identity of the piece that moved — engine only. The mover may still have been in the dark. */
  readonly moverKind: Kind;
  readonly wasHidden: boolean;
  /** What the piece turned into when it was flipped. Public: both players saw it. */
  readonly revealedKind: Kind | null;
  readonly captured: CapturedInfo | null;
  /** Did this move put the opponent in check? Drives the 将军 animation. */
  readonly gaveCheck: boolean;
  readonly notation: string;
}

interface HistoryRecord {
  event: MoveEvent;
  boardUndo: Undo;
  knowledgeBefore: Knowledge;
  halfMoveClockBefore: number;
  resultBefore: GameResult | null;
  /** Zobrist key of the position *after* the move, so undo can decrement its repetition count. */
  repetitionKey: number;
  lastMoveBefore: Move | null;
}

export interface GameOptions {
  /** Plies without a capture before the game is drawn. QQ's 空步判和 is 40 回合 = 80 plies. */
  idlePlies?: number;
  /** Seed for the deal. Omit for a `Math.random`-derived one. */
  seed?: number;
}

/**
 * A full game of jieqi, with undo history.
 *
 * `legalMoves()` is the honest move set (every move that does not leave your own king attacked);
 * `selectableMoves()` additionally applies **禁止全局同形**, which forbids any move that would bring
 * back a position this game has already seen — not merely the third occurrence of one. Keeping the two
 * apart is what lets a dead position be *drawn* rather than misreported as stalemate, and it is what
 * lets the UI explain the prohibition (legal but forbidden) instead of pretending the move does not
 * exist.
 *
 * The prohibition is a property of the *position*, not of a side: `repetitions` is keyed by the exact
 * Zobrist key, which includes the side to move, so a move can only ever be forbidden for the player who
 * would actually recreate the earlier position.
 */
export class JieqiGame {
  readonly seed: number;
  readonly idlePlies: number;
  board: Board;
  /** Who has seen what. Ask it for a pool with `poolsFor()` before sampling a world. */
  knowledge: Knowledge;
  history: HistoryRecord[] = [];
  result: GameResult | null = null;
  halfMoveClock = 0;
  lastMove: Move | null = null;

  private repetitions = new Map<number, number>();

  private constructor(board: Board, knowledge: Knowledge, seed: number, idlePlies: number) {
    this.board = board;
    this.knowledge = knowledge;
    this.seed = seed;
    this.idlePlies = idlePlies;
    this.bump(board.key);
  }

  /** Deals a fresh game: king face up on its home square, everything else shuffled face down. */
  static create(options: GameOptions = {}): JieqiGame {
    const seed = options.seed ?? randomSeed();
    const rng = createRng(seed);
    const shuffled: Record<Color, Kind[]> = {
      red: rng.shuffle([...ARMY_LIST]),
      black: rng.shuffle([...ARMY_LIST]),
    };
    return new JieqiGame(Board.deal(shuffled), createKnowledge(), seed, options.idlePlies ?? 80);
  }

  /** A copy sharing no mutable state — the AI runs its searches on one of these. */
  clone(): JieqiGame {
    const copy = new JieqiGame(
      this.board.clone(),
      cloneKnowledge(this.knowledge),
      this.seed,
      this.idlePlies,
    );
    copy.history = [];
    copy.result = this.result;
    copy.halfMoveClock = this.halfMoveClock;
    copy.lastMove = this.lastMove;
    copy.repetitions = new Map(this.repetitions);
    return copy;
  }

  get sideToMove(): Color {
    return this.board.side;
  }

  /** The identities `observer` still cannot account for, on both sides. */
  poolsFor(observer: Color): Pool {
    return poolsFor(this.knowledge, observer);
  }

  get ply(): number {
    return this.history.length;
  }

  /** Every move played so far, oldest first — what the HUD's move log and trays are built from. */
  get moveEvents(): MoveEvent[] {
    return this.history.map((record) => record.event);
  }

  private bump(key: number): void {
    this.repetitions.set(key, (this.repetitions.get(key) ?? 0) + 1);
  }

  /** How many times this exact position has occurred so far, counting the current one. */
  repetitionCount(key: number): number {
    return this.repetitions.get(key) ?? 0;
  }

  inCheck(color: Color = this.board.side): boolean {
    return !isKingSafe(this.board, color);
  }

  /**
   * Every move that is legal in the ordinary sense: the piece can get there and the mover's own king
   * is not left attacked. Check legality does not depend on any hidden information — a hidden piece's
   * threats are computed from the square it stands on, which both players can see.
   */
  legalMoves(color: Color = this.board.side): Move[] {
    const pseudo = generateMoves(this.board, color, []);
    const legal: Move[] = [];
    for (const move of pseudo) {
      const undo = this.board.makeMove(move.from, move.to);
      const safe = isKingSafe(this.board, color);
      this.board.unmakeMove(undo);
      if (safe) legal.push(move);
    }
    return legal;
  }

  isLegal(move: Move, color: Color = this.board.side): boolean {
    return this.legalMoves(color).some((candidate) => sameMove(candidate, move));
  }

  /**
   * Would playing `move` bring the board back to a position that has already occurred in this game?
   *
   * 禁止全局同形, the rule the UI calls out by name when it blocks a tap. The check is on the Zobrist
   * key, which folds in the side to move, so this asks the only question that matters: does the
   * *position* come back, not merely the arrangement of the pieces with the other side to move.
   */
  wouldRepeat(move: Move): boolean {
    const undo = this.board.makeMove(move.from, move.to);
    const key = this.board.key;
    this.board.unmakeMove(undo);
    return this.repetitionCount(key) > 0;
  }

  /**
   * Legal moves a player is actually allowed to choose: the 禁止全局同形 guard forbids every move that
   * would recreate an earlier position of this game.
   *
   * Undo deliberately does *not* answer to this rule — taking a move back is not a move, and the
   * positions it walks through are exactly the ones the game already recorded.
   */
  selectableMoves(color: Color = this.board.side): Move[] {
    return this.legalMoves(color).filter((move) => !this.wouldRepeat(move));
  }

  /** Is `move` legal *and* allowed under 禁止全局同形? What a tap on the board asks. */
  isSelectable(move: Move, color: Color = this.board.side): boolean {
    return this.isLegal(move, color) && !this.wouldRepeat(move);
  }

  /**
   * Plays `move`. Throws rather than silently corrupting the position — on a move that is not legal,
   * and on one that 禁止全局同形 forbids.
   */
  apply(move: Move): MoveEvent {
    if (this.result) throw new Error('apply: the game is already over');
    const board = this.board;
    const color = board.side;
    const piece = board.at(move.from);
    if (!piece) throw new Error(`apply: no piece on square ${move.from}`);
    if (piece.color !== color) throw new Error('apply: not your piece');
    if (!this.isLegal(move, color)) throw new Error('apply: illegal move');
    // 禁止全局同形 is a rule of the game, so it is enforced where the game is, not only where the taps
    // are read: the UI refuses such a move *by name* before it gets here (and the AI never picks one,
    // because its root list is `selectableMoves`), but a repetition must not be able to enter the
    // history even if some future caller forgets to ask.
    if (this.wouldRepeat(move)) {
      throw new Error('apply: 禁止全局同形 — this move would recreate an earlier position');
    }

    const capturedPiece = board.at(move.to) ?? null;
    const notation = toChineseNotation(board, move);
    const wasHidden = piece.hidden;
    const knowledgeBefore = cloneKnowledge(this.knowledge);
    const resultBefore = this.result;
    const halfMoveClockBefore = this.halfMoveClock;
    const lastMoveBefore = this.lastMove;

    const boardUndo = board.makeMove(move.from, move.to);
    if (wasHidden) noteRevealed(this.knowledge, color, piece.kind);
    // Rule R7 read carefully: the *loser* may not look, so `color` — the capturer — does.
    if (capturedPiece?.hidden) noteLearned(this.knowledge, color, capturedPiece.kind);

    const opponent = other(color);
    const gaveCheck = this.inCheck(opponent);
    this.halfMoveClock = capturedPiece ? 0 : this.halfMoveClock + 1;
    this.lastMove = move;
    this.bump(board.key);

    const event: MoveEvent = {
      move,
      color,
      pieceId: piece.id,
      moverKind: piece.kind,
      wasHidden,
      revealedKind: wasHidden ? piece.kind : null,
      captured: capturedPiece
        ? {
            pieceId: capturedPiece.id,
            square: move.to,
            color: capturedPiece.color,
            hidden: capturedPiece.hidden,
            kind: capturedPiece.kind,
          }
        : null,
      gaveCheck,
      notation,
    };

    this.history.push({
      event,
      boardUndo,
      knowledgeBefore,
      halfMoveClockBefore,
      resultBefore,
      repetitionKey: board.key,
      lastMoveBefore,
    });

    this.result = this.computeResult();
    return event;
  }

  undo(): MoveEvent | null {
    const record = this.history.pop();
    if (!record) return null;
    // `makeMove` recorded the pre-move king squares and Zobrist halves, so this restores them exactly.
    this.board.unmakeMove(record.boardUndo);
    this.knowledge = record.knowledgeBefore;
    this.halfMoveClock = record.halfMoveClockBefore;
    this.result = record.resultBefore;
    this.lastMove = record.lastMoveBefore;
    const count = this.repetitions.get(record.repetitionKey) ?? 0;
    if (count <= 1) this.repetitions.delete(record.repetitionKey);
    else this.repetitions.set(record.repetitionKey, count - 1);
    return record.event;
  }

  resign(color: Color): GameResult {
    this.result = {
      winner: other(color),
      kind: 'resign',
      text: `${color === 'red' ? '红方' : '黑方'}认输`,
    };
    return this.result;
  }

  /**
   * The result of the position as it stands, or `null` while the game continues.
   *
   * Public because `apply()` is not the only way a position can change — the UI also calls it after a
   * load, and a test can ask about a hand-built diagram.
   */
  computeResult(): GameResult | null {
    const side = this.board.side;
    const legal = this.legalMoves(side);
    if (legal.length === 0) {
      if (this.inCheck(side)) {
        return {
          winner: other(side),
          kind: 'checkmate',
          text: `${side === 'red' ? '红方' : '黑方'}被将死`,
        };
      }
      // 困毙判负 (rule R10) — in xiangqi a stalemate is a loss, not a draw.
      return {
        winner: other(side),
        kind: 'stalemate',
        text: `${side === 'red' ? '红方' : '黑方'}困毙`,
      };
    }

    // Every legal move would recreate an earlier position. Under 禁止全局同形 there is nothing left to
    // play, and the side to move is dead the same way 困毙 kills one: no allowed move at all. Counted
    // as a loss for the side to move (user's call, 2026-09-14 — it used to be 判和). A side with no
    // *legal* move at all was already answered above as checkmate / 困毙.
    if (this.selectableMoves(side).length === 0) {
      return {
        winner: other(side),
        kind: 'stalemate',
        text: `${side === 'red' ? '红方' : '黑方'}困毙`,
      };
    }

    if (this.halfMoveClock >= this.idlePlies) {
      return { winner: null, kind: 'idle', text: '久无吃子，判和' };
    }

    return null;
  }
}
