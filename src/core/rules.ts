/**
 * The game: legality, check, terminal results, and the *public* record of what happened.
 *
 * A deliberate distinction runs through this file — the engine knows every hidden piece's identity, the
 * players do not, and {@link MoveEvent} is the boundary. It carries only what a player at the board
 * would have seen: the identity a piece turned into when it was revealed, and nothing at all about a
 * face-down piece that was captured (rule R7: it is removed face down and its owner may not look).
 *
 * 混斗 adds one wrinkle to that boundary: a revealed piece may turn out to be the *opponent's*
 * (rule M4), in which case the event says so as well — `revealedColor` carries what the piece is, and
 * a mismatch with `color` is the hand-over everybody just watched.
 */

import { Board, type Undo } from './board';
import {
  cloneKnowledge,
  createKnowledge,
  mixedPoolFor,
  noteLearned,
  noteRevealed,
  poolsFor,
  type Knowledge,
  type Pool,
} from './info';
import { generateMoves, isKingSafe, isKingSafeAfter } from './moves';
import { toChineseNotation } from './notation';
import { createRng, randomSeed } from './rng';
import { isSquareSeen } from './vision';
import {
  ARMY_LIST,
  KING_SQUARE,
  type Color,
  type GameMode,
  type Identity,
  type Kind,
  type Move,
  mixedArmy,
  other,
  sameMove,
} from './types';

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
  /**
   * The colour that face belongs to — what the piece *is*.
   *
   * Equal to `color` in 标准 and in the ordinary 混斗 case (a 暗子 on your half that turns out to be
   * yours). When it differs, rule M4 fired: the piece the mover just played now belongs to the
   * opponent, and the view has to say so.
   */
  readonly revealedColor: Color | null;
  /**
   * Did this move leave the **mover's own** general attacked?
   *
   * Impossible in 标准 (such a move is not legal) and possible in 混斗, where turning a 暗子 over can
   * hand the opponent a piece that checks the side that moved it (rule M4/M5). The general is then
   * simply taken by the opponent unless it can be answered.
   */
  readonly selfCheck: boolean;
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
  /** 迷雾: the king-seen tracker before the move, so undo puts the AI's belief back too. */
  kingSeenBefore: Record<Color, number>;
}

export interface GameOptions {
  /** Plies without a capture before the game is drawn. QQ's 空步判和 is 40 回合 = 80 plies. */
  idlePlies?: number;
  /** Seed for the deal. Omit for a `Math.random`-derived one. */
  seed?: number;
  /** 标准 or 混斗. Defaults to 标准 — the game this engine was written for. */
  mode?: GameMode;
}

/**
 * A full game of jieqi, with undo history.
 *
 * `legalMoves()` is the honest move set (every move that does not leave your own king attacked);
 * `selectableMoves()` additionally applies **禁止循环追棋**, which forbids any move that would bring
 * back a position this game has already seen **twice** — the third occurrence of one. A position may
 * appear twice; only the third time it comes back is refused, and the side that is **in check** is
 * exempt from the rule entirely (it may play any legal escape, even one that re-treads an earlier
 * position). Keeping the two lists apart is what lets a dead position be *drawn* rather than
 * misreported as stalemate, and it is what lets the UI explain the prohibition (legal but forbidden)
 * instead of pretending the move does not exist.
 *
 * The prohibition is a property of the *position*, not of a side: `repetitions` is keyed by the exact
 * Zobrist key, which includes the side to move, so a move can only ever be forbidden for the player who
 * would actually recreate the earlier position.
 */
export class JieqiGame {
  readonly seed: number;
  readonly idlePlies: number;
  /** 标准 or 混斗. Fixed for the life of the match, and carried into every clone. */
  readonly mode: GameMode;
  board: Board;
  /** Who has seen what. Ask it for a pool with `poolsFor()` before sampling a world. */
  knowledge: Knowledge;
  history: HistoryRecord[] = [];
  result: GameResult | null = null;
  halfMoveClock = 0;
  lastMove: Move | null = null;
  /**
   * 迷雾: each side's belief about where the **enemy** king is — the last square that side actually
   * saw it on, falling back to its home square (everyone knows the deal). Kept on the game because it
   * has to survive undo and clone, and updated after every fog move from the post-move vision
   * ({@link updateKingSeen}). The AI's fogged board places the enemy king here instead of at its true
   * square, which is what makes a king hiding in the mist actually hidable — until it is seen again,
   * the AI only knows where it last was.
   */
  kingSeen: Record<Color, number> = { red: KING_SQUARE.black, black: KING_SQUARE.red };

  private repetitions = new Map<number, number>();

  private constructor(
    board: Board,
    knowledge: Knowledge,
    seed: number,
    idlePlies: number,
    mode: GameMode,
  ) {
    this.board = board;
    this.knowledge = knowledge;
    this.seed = seed;
    this.idlePlies = idlePlies;
    this.mode = mode;
    this.bump(board.key);
  }

  /** Deals a fresh game: king face up on its home square, everything else shuffled face down. */
  static create(options: GameOptions = {}): JieqiGame {
    const seed = options.seed ?? randomSeed();
    const mode = options.mode ?? 'standard';
    const rng = createRng(seed);
    // 混斗 deals both armies out of one pool (rule M1); 标准 keeps each army on its own half (rule R3).
    // 迷雾 deals exactly like 标准 — the fog is an information overlay, not a different deal.
    const board =
      mode === 'mixed'
        ? Board.dealMixed(rng.shuffle(mixedArmy()))
        : Board.deal({
            red: rng.shuffle([...ARMY_LIST]),
            black: rng.shuffle([...ARMY_LIST]),
          });
    board.fog = mode === 'fog';
    return new JieqiGame(board, createKnowledge(), seed, options.idlePlies ?? 80, mode);
  }

  /** A copy sharing no mutable state — the AI runs its searches on one of these. */
  clone(): JieqiGame {
    const copy = new JieqiGame(
      this.board.clone(),
      cloneKnowledge(this.knowledge),
      this.seed,
      this.idlePlies,
      this.mode,
    );
    copy.history = [];
    copy.result = this.result;
    copy.halfMoveClock = this.halfMoveClock;
    copy.lastMove = this.lastMove;
    copy.kingSeen = { red: this.kingSeen.red, black: this.kingSeen.black };
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

  /** 混斗's pool: the thirty identities, minus everything `observer` has seen or learned. */
  mixedPoolFor(observer: Color): Identity[] {
    return mixedPoolFor(this.knowledge, observer);
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
   *
   * 混斗 keeps that promise by judging the general with {@link isKingSafeAfter}: turning a 暗子 over
   * may hand it to the opponent, and a move list that knew which squares would do that would be
   * reading the hidden identity out loud. So the test is the ordinary 送将 one — *with this piece
   * still mine, is my general exposed?* — and the hand-over's own consequences land afterwards, as
   * `apply()` reports them in `selfCheck`.
   */
  legalMoves(color: Color = this.board.side): Move[] {
    const pseudo = generateMoves(this.board, color, []);
    // 迷雾 = 吃王棋 (rule F4, user 2026-09-15): 送将不再是非法着法 — any move a piece can
    // geometrically make is legal, including one that leaves the general exposed; the game ends only
    // when a general is actually captured. No king-safety filter here at all.
    if (this.board.fog) return pseudo;
    const legal: Move[] = [];
    for (const move of pseudo) {
      if (isKingSafeAfter(this.board, color, move)) legal.push(move);
    }
    return legal;
  }

  isLegal(move: Move, color: Color = this.board.side): boolean {
    return this.legalMoves(color).some((candidate) => sameMove(candidate, move));
  }

  /**
   * Would playing `move` bring the board back to a position that has already occurred **twice** in this
   * game — the third occurrence of it?
   *
   * 禁止循环追棋, the rule the UI calls out by name when it blocks a tap. The check is on the Zobrist
   * key, which folds in the side to move, so this asks the only question that matters: does the
   * *position* come back, not merely the arrangement of the pieces with the other side to move.
   *
   * A position may appear twice; only the third time it comes back is forbidden. And the side that is
   * currently **in check** is exempt entirely — 循环追棋 is what the checker would do to keep a chase
   * going, so the rule must not also trap the chased king in the very squares that are its only way out.
   */
  wouldRepeat(move: Move): boolean {
    if (this.inCheck()) return false;
    const undo = this.board.makeMove(move.from, move.to);
    const key = this.board.key;
    this.board.unmakeMove(undo);
    return this.repetitionCount(key) >= 2;
  }

  /**
   * Would playing `move` immediately take a general that a **handed-over** piece is checking?
   *
   * 混斗's sting (rule M5): the piece a move just flipped may turn out to be the opponent's, and it may
   * be checking the side that moved it. Left alone, that general is simply taken on the reply — the
   * flipping side never gets a turn. **禁止立即吃将** gives it one: on the immediate reply, the handed-over
   * piece may not take the general outright; the flipped side gets to move the general away, block, or
   * capture the checker. Once the reply has been played the rule is spent — this method is false for
   * every later move.
   *
   * Only the handed-over piece can be the culprit (nothing else attacks the general in a selfCheck —
   * the position was safe a ply ago, so the flip is the only change), which is why the test is "is this
   * the piece that was just handed over, and is it taking the mover's general?".
   */
  wouldEatGeneral(move: Move): boolean {
    if (this.mode !== 'mixed') return false;
    const last = this.history[this.history.length - 1];
    if (!last) return false;
    const e = last.event;
    if (!e.selfCheck) return false;
    // The handed-over piece stands on the square the flip moved to; only that piece, only the general
    // of the side that moved it, only on this immediate reply.
    if (move.from !== e.move.to) return false;
    const target = this.board.at(move.to);
    if (!target || target.kind !== 'K') return false;
    return target.color === e.color;
  }

  /**
   * Legal moves a player is actually allowed to choose: the 禁止循环追棋 and 禁止立即吃将 guards forbid
   * every move that would recreate an earlier position of this game, or take the general with a
   * just-handed-over piece.
   *
   * Undo deliberately does *not* answer to these rules — taking a move back is not a move, and the
   * positions it walks through are exactly the ones the game already recorded.
   */
  selectableMoves(color: Color = this.board.side): Move[] {
    return this.legalMoves(color).filter(
      (move) => !this.wouldRepeat(move) && !this.wouldEatGeneral(move),
    );
  }

  /** Is `move` legal *and* allowed under the two guards above? What a tap on the board asks. */
  isSelectable(move: Move, color: Color = this.board.side): boolean {
    return this.isLegal(move, color) && !this.wouldRepeat(move) && !this.wouldEatGeneral(move);
  }

  /**
   * Plays `move`. Throws rather than silently corrupting the position — on a move that is not legal,
   * and on one that 禁止循环追棋 or 禁止立即吃将 forbids.
   */
  apply(move: Move): MoveEvent {
    if (this.result) throw new Error('apply: the game is already over');
    const board = this.board;
    const color = board.side;
    const piece = board.at(move.from);
    if (!piece) throw new Error(`apply: no piece on square ${move.from}`);
    // Ownership, not `piece.color`: in 混斗 a 暗子 on my half is mine to move whoever it turns out to
    // be (rule M2).
    if (board.ownerAt(move.from) !== color) throw new Error('apply: not your piece');
    if (!this.isLegal(move, color)) throw new Error('apply: illegal move');
    // 禁止循环追棋 and 禁止立即吃将 are rules of the game, so they are enforced where the game is, not
    // only where the taps are read: the UI refuses such a move *by name* before it gets here (and the
    // AI never picks one, because its root list is `selectableMoves`), but a forbidden move must not be
    // able to enter the history even if some future caller forgets to ask.
    if (this.wouldRepeat(move)) {
      throw new Error('apply: 禁止循环追棋 — this move would recreate an earlier position for the third time');
    }
    if (this.wouldEatGeneral(move)) {
      throw new Error('apply: 禁止立即吃将 — a handed-over piece may not take the general on the immediate reply');
    }

    const capturedPiece = board.at(move.to) ?? null;
    const notation = toChineseNotation(board, move);
    const wasHidden = piece.hidden;
    const knowledgeBefore = cloneKnowledge(this.knowledge);
    const resultBefore = this.result;
    const halfMoveClockBefore = this.halfMoveClock;
    const lastMoveBefore = this.lastMove;

    const boardUndo = board.makeMove(move.from, move.to);
    // A reveal is public, and what it reveals is the piece's *true* colour — which in 混斗 is not
    // necessarily the colour of the side that moved it (rule M4).
    if (wasHidden) noteRevealed(this.knowledge, piece.color, piece.kind);
    // Rule R7 read carefully: the *loser* may not look, so `color` — the capturer — does.
    if (capturedPiece?.hidden) {
      noteLearned(this.knowledge, color, capturedPiece.kind, capturedPiece.color);
    }

    const opponent = other(color);
    const gaveCheck = this.inCheck(opponent);
    // 混斗 only: the piece just turned over may have gone to the opponent, and it may be checking the
    // side that moved it. Legal, and reported — the general is then the opponent's for the taking.
    const selfCheck = !isKingSafe(board, color);
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
      revealedColor: wasHidden ? piece.color : null,
      selfCheck,
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
      kingSeenBefore: { red: this.kingSeen.red, black: this.kingSeen.black },
    });

    // 迷雾 only: after every move, each side's belief about the enemy king follows its vision — a
    // king that is currently in sight gets its square recorded; a king out of sight keeps the square
    // where it was last seen. This is what the AI's fogged board reads instead of the true square.
    if (this.board.fog) this.updateKingSeen();

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
    this.kingSeen = { red: record.kingSeenBefore.red, black: record.kingSeenBefore.black };
    const count = this.repetitions.get(record.repetitionKey) ?? 0;
    if (count <= 1) this.repetitions.delete(record.repetitionKey);
    else this.repetitions.set(record.repetitionKey, count - 1);
    return record.event;
  }

  /**
   * 迷雾: refreshes each side's belief about the enemy king from the current position's vision.
   *
   * The rule is deliberately simple — "where did I last see it": a king standing on a square the
   * observer can see right now is recorded there; a king out of sight keeps the old square. No
   * inference about where a vanished king went; the AI reasons against a possibly-stale position,
   * which is exactly the honest cost of letting the enemy king hide in the mist.
   */
  private updateKingSeen(): void {
    for (const observer of ['red', 'black'] as const) {
      const kingSq = this.board.kingSq[other(observer)];
      if (kingSq < 0) continue; // captured — the game is over, the belief no longer matters
      if (isSquareSeen(this.board, observer, kingSq)) this.kingSeen[observer] = kingSq;
    }
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
    // 迷雾 = 吃王棋 (rule F4): the only way to win is to actually capture the enemy general, and the
    // only way to lose is to have yours captured. 将死/困毙 — abstract rulings a fog player may not
    // even be able to see — do not end the game; the first general taken does. Idle 判和 and resign
    // are unchanged, and a general missing from the board is the one terminal state.
    if (this.board.fog) {
      if (this.board.kingSq.red < 0) {
        return { winner: 'black', kind: 'checkmate', text: '红方将帅被吃，黑方胜' };
      }
      if (this.board.kingSq.black < 0) {
        return { winner: 'red', kind: 'checkmate', text: '黑方将帅被吃，红方胜' };
      }
      if (this.halfMoveClock >= this.idlePlies) {
        return { winner: null, kind: 'idle', text: '久无吃子，判和' };
      }
      return null;
    }

    const side = this.board.side;
    const legal = this.legalMoves(side);
    if (legal.length === 0) {
      if (this.inCheck(side)) {
        // Includes 混斗's one way to lose a general outright: a 暗子 that turned out to be the
        // opponent's left this side checked (rule M4), the opponent simply took the general, and a
        // general that is no longer on the board counts as attacked (`isKingSafe`) — so the side with
        // nothing left to play reads as 将死, which is what happened.
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

    // Every legal move would recreate a position this game has already seen twice, or is a 禁止立即吃将
    // capture. Under 禁止循环追棋 there is nothing left to play, and the side to move is dead the same
    // way 困毙 kills one: no allowed move at all. Counted as a loss for the side to move (user's call,
    // 2026-09-14 — it used to be 判和). A side with no *legal* move at all was already answered above as
    // checkmate / 困毙.
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
