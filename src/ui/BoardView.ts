/**
 * The board: the wooden panel, the grid, the pieces, and every animation that plays on them.
 *
 * The board is drawn with native Phaser rather than laid out by phaser-mvvm, and that split is the
 * framework's own advice — MVVM owns the HUD, ordinary Phaser owns the game. A 90-intersection board
 * with tweens, hit testing and z-ordering is game, not UI chrome.
 */

import Phaser from 'phaser';
import type { Board } from '../core/board';
import type { CapturedInfo, MoveEvent } from '../core/rules';
import { type Move, SQUARES, fileOf, rankOf } from '../core/types';
import { dust, impact } from './fx';
import {
  BOARD_HEIGHT,
  BOARD_MARGIN,
  BOARD_WIDTH,
  C,
  CELL,
  PIECE_RADIUS,
  SERIF_STACK,
  hex,
  localToSquare,
  squareToLocal,
} from './palette';
import { PieceView, REVEALED_ALPHA } from './PieceView';
import { BAKE_SCALE } from './render-scale';
import { TEX } from './textures';

/** The 炮/兵 points that carry the little corner brackets on a real board. */
const MARKED_SQUARES: readonly number[] = [
  1 + 2 * 9, 7 + 2 * 9, // cannons, black side
  1 + 7 * 9, 7 + 7 * 9, // cannons, red side
  0 + 3 * 9, 2 + 3 * 9, 4 + 3 * 9, 6 + 3 * 9, 8 + 3 * 9, // black soldiers
  0 + 6 * 9, 2 + 6 * 9, 4 + 6 * 9, 6 + 6 * 9, 8 + 6 * 9, // red soldiers
];

/**
 * The audible moments of a board animation.
 *
 * The board reports *when* something happened, not what it should sound like — the view stays free of
 * any knowledge of the soundtrack, and the scene decides which cue maps to which recording.
 */
export type BoardCue = 'deal' | 'place' | 'reveal' | 'capture';

export interface BoardViewOptions {
  /** Called with a board square whenever the player taps one. */
  onSquare: (square: number) => void;
  /** Called at the exact frame a cue-worthy thing happens, so the sound lands with the picture. */
  onCue?: (cue: BoardCue) => void;
  /**
   * Draw the board from black's side — 将 at the bottom, 帅 at the top.
   *
   * The engine has exactly one coordinate system (square 0 is black's back rank, square 89 is red's),
   * and it does not move: notation, the AI and the move log all speak it. What changes is only *where
   * that square is drawn*, which is why this flips a mapping rather than rotating the board — rotating
   * the container would put every 帅 upside down, and rotating each view with it would make the whole
   * board unreadable.
   */
  flipped?: boolean;
}

/**
 * One 吃子提示 mark: a square holding a piece that can be taken for free.
 *
 * The tone is relative to the *player*, not to red and black: `own` is a piece of theirs at the bottom of
 * the screen whoever drew which colour, which is why this is not spelled as a `Color`.
 */
export interface DangerMark {
  square: number;
  /** `own` — the player's piece, in red. `foe` — the computer's, in green. */
  tone: 'own' | 'foe';
}

export class BoardView {
  readonly root: Phaser.GameObjects.Container;

  private readonly scene: Phaser.Scene;
  private readonly options: BoardViewOptions;
  private readonly markGfx: Phaser.GameObjects.Graphics;
  private readonly dangerLayer: Phaser.GameObjects.Container;
  private readonly targetLayer: Phaser.GameObjects.Container;
  private readonly pieceLayer: Phaser.GameObjects.Container;
  private readonly fogLayer: Phaser.GameObjects.Container;
  private readonly checkGlow: Phaser.GameObjects.Image;
  private readonly pieces = new Map<number, PieceView>();
  private readonly targets: Phaser.GameObjects.Image[] = [];
  private readonly dangerMarks: Phaser.GameObjects.Image[] = [];
  /** One fog tile per square, `null` while the square is in view. */
  private readonly fogTiles: (Phaser.GameObjects.Image | null)[] = new Array(SQUARES).fill(null);
  /** The drifting mist wisps — the "particle" half of 迷雾. */
  private readonly fogParticles: Phaser.GameObjects.Image[] = [];
  /**
   * The squares currently in view, or `null` while fog is off.
   *
   * Read by {@link reconcile} to hide the piece views standing on fogged squares — a fogged square
   * must not render its piece at all, not merely cover it, so nothing can ever leak through the
   * mist. `null` (标准/混斗, and the end-of-match reveal) shows everything.
   */
  private fogVisible: ReadonlySet<number> | null = null;

  /**
   * Whether the board is drawn from black's side.
   *
   * Every square ↔ position conversion in this class goes through {@link local} or
   * {@link logicalSquare}, so this is the only place the orientation exists. The pieces themselves are
   * never told: a `PieceView` is placed at a position and draws its own glyph upright, whichever side
   * of the board that position happens to be.
   */
  private readonly flipped: boolean;

  private selection: number | null = null;
  private legalTargets: number[] = [];
  /** The subset of `legalTargets` where the piece would land hanging — drawn red instead of green. */
  private dangerTargets: ReadonlySet<number> = new Set();
  /** Squares where the selected piece's move would expose its own general — drawn as red X's. */
  private sendsCheck: ReadonlySet<number> = new Set();
  private lastMove: Move | null = null;
  private checkSquare: number | null = null;
  private locked = false;
  /**
   * True once the match is over and every remaining 暗子 has been turned up (see {@link revealHidden}).
   *
   * Held rather than inferred, because `reconcile` has to keep agreeing with it: the engine still says
   * those pieces are `hidden`, so the safety net that makes the views match the engine would happily
   * turn them all face down again a frame after the reveal.
   */
  private over = false;
  /**
   * How many board animations are in flight.
   *
   * Tracked here rather than inferred from Phaser's tween list, because plenty of tweens on this board
   * are *decorative and endless* — the pulsing legal-move rings, the check glow — and a few more are
   * fire-and-forget particles that outlive the move that threw them. "Is the board at rest?" has to
   * mean "have the pieces stopped moving", not "are there zero tweens anywhere".
   */
  private pending = 0;

  constructor(scene: Phaser.Scene, x: number, y: number, options: BoardViewOptions) {
    this.scene = scene;
    this.options = options;
    this.flipped = options.flipped === true;
    // Created up front so the hit handler below can safely read `this.root` at click time.
    this.root = scene.add.container(x, y, []);

    const boardGfx = scene.make.graphics({ x: 0, y: 0 }, false);
    drawBoardPanel(boardGfx);
    drawGrid(boardGfx);
    drawMarks(boardGfx);

    this.markGfx = scene.make.graphics({ x: 0, y: 0 }, false);
    this.checkGlow = scene.add
      .image(0, 0, TEX.glowRed)
      .setOrigin(0.5)
      .setDisplaySize(CELL * 1.7, CELL * 1.7)
      .setAlpha(0);

    // Legal-move dots sit under the pieces, so a piece never hides one. The 吃子提示 halos go under them
    // both: a glow is a property of the square, not something to cover the piece standing on it.
    this.dangerLayer = scene.add.container(0, 0, []);
    this.targetLayer = scene.add.container(0, 0, []);
    this.pieceLayer = scene.add.container(0, 0, []);
    // 迷雾 sits *above* every board element — pieces, marks, rings, glows — because its job is to hide
    // them. Only the hit rectangle stays on top, so a fogged square is still tappable: the player may
    // move blind into the mist, and the engine resolves the tap against the truth.
    this.fogLayer = scene.add.container(0, 0, []);

    const hit = scene.add
      .rectangle(BOARD_WIDTH / 2, BOARD_HEIGHT / 2, BOARD_WIDTH, BOARD_HEIGHT, 0x000000, 0)
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });
    hit.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      if (this.locked) return;
      const at = localToSquare(pointer.worldX - this.root.x, pointer.worldY - this.root.y);
      const square = this.logicalSquare(at);
      if (square !== null) options.onSquare(square);
    });

    this.root.add([
      boardGfx,
      ...riverLabels(scene, this.flipped),
      this.checkGlow,
      this.markGfx,
      this.dangerLayer,
      this.targetLayer,
      this.pieceLayer,
      this.fogLayer,
      hit,
    ]);
  }

  /**
   * Where a logical square is drawn, in board-local pixels.
   *
   * The mirror is `89 - square`, which is the same as rotating the board 180°: a 9×10 grid indexed
   * `y * 9 + x` maps `(x, y)` to `(8 - x, 9 - y)`, and `(9 - y) * 9 + (8 - x) = 89 - (9y + x)`. It is its
   * own inverse, which is what lets {@link logicalSquare} share it.
   */
  private local(square: number): { x: number; y: number } {
    return squareToLocal(this.flipped ? SQUARES - 1 - square : square);
  }

  /** The logical square drawn at a board-local square index, or `null`. */
  private logicalSquare(shown: number | null): number | null {
    if (shown === null) return null;
    return this.flipped ? SQUARES - 1 - shown : shown;
  }

  /** Board-local to scene coordinates — what the acceptance backdoor reports for a square. */
  squareToScene(square: number): { x: number; y: number } {
    const local = this.local(square);
    return { x: this.root.x + local.x, y: this.root.y + local.y };
  }

  get pieceCount(): number {
    return this.pieces.size;
  }

  /** True while a piece is in flight, being flipped, or being dealt. */
  get animating(): boolean {
    return this.pending > 0;
  }

  private async track<T>(work: Promise<T>): Promise<T> {
    this.pending += 1;
    try {
      return await work;
    } finally {
      this.pending -= 1;
    }
  }

  /** Blocks taps while an animation or the AI is in flight. */
  setLocked(locked: boolean): void {
    this.locked = locked;
  }

  get isLocked(): boolean {
    return this.locked;
  }

  // ---------------------------------------------------------------------------------------------
  // Pieces
  // ---------------------------------------------------------------------------------------------

  /** Creates a view for every piece on the board, at its square, with no animation. */
  rebuild(board: Board): void {
    this.over = false;
    for (const view of this.pieces.values()) view.destroy();
    this.pieces.clear();
    for (let sq = 0; sq < SQUARES; sq++) {
      const piece = board.at(sq);
      if (!piece) continue;
      const view = this.spawn(board, piece.id, sq);
      if (!piece.hidden) view.showFace(piece.kind);
    }
    this.checkGlow.setPosition(0, 0).setAlpha(0);
    this.setDangerMarks([]);
  }

  /**
   * The opening: every piece drops onto its square from its own edge of the board.
   *
   * "Its own edge" is read off the drawn position rather than off the colour, so a flipped board has
   * the red army falling in from the top without this needing to know that it is flipped.
   */
  async deal(board: Board): Promise<void> {
    // A new match is dealt onto the *same* view object, so the previous match's endgame reveal has to be
    // forgotten here or the fresh board would come up face up and dimmed.
    this.over = false;
    for (const view of this.pieces.values()) view.destroy();
    this.pieces.clear();
    this.options.onCue?.('deal');

    const jobs: Promise<void>[] = [];
    let index = 0;
    for (let sq = 0; sq < SQUARES; sq++) {
      const piece = board.at(sq);
      if (!piece) continue;
      const view = this.spawn(board, piece.id, sq);
      if (!piece.hidden) view.showFace(piece.kind);
      const local = this.local(sq);
      const fromY = local.y > BOARD_HEIGHT / 2 ? BOARD_HEIGHT + 90 : -90;
      jobs.push(view.dropIn(local.x, local.y, index * 26, fromY));
      index += 1;
    }
    await this.track(Promise.all(jobs));
  }

  /**
   * 对局结束：把还扣着的暗子全部翻开，并压到半透明。
   *
   * The board is the one thing in jieqi that withholds, and it withholds on purpose: a hidden piece is
   * hidden from its *owner* too. That is worth nothing once the result is decided, and it is actively
   * unsatisfying — a game that ends with half the board face down never says what was actually on it. So
   * the ending turns every remaining 暗子 over, in a wave from one end of the board to the other, and
   * leaves them dimmed so they are never confused with the pieces that were played face up.
   *
   * Fire-and-forget for the caller but tracked like any other board animation, so `settled` — which is
   * what an acceptance run waits on — accounts for the reveal.
   */
  revealHidden(board: Board): void {
    this.over = true;
    let index = 0;
    for (let sq = 0; sq < SQUARES; sq++) {
      const piece = board.at(sq);
      if (!piece || !piece.hidden) continue;
      const view = this.pieces.get(piece.id) ?? this.spawn(board, piece.id, sq);
      // 30 ms apart, capped: a wave that reads as one gesture rather than twenty separate events. A
      // worst case board (30 暗子, nothing turned over all game) sweeps in 0.9 s and is done turning in
      // about 1.3 s, which is the right price for the last thing the player sees.
      void this.track(view.revealHidden(piece.kind, Math.min(index * 30, 900)));
      index += 1;
    }
  }

  /** True once the endgame reveal has been asked for. */
  get isOver(): boolean {
    return this.over;
  }

  private spawn(board: Board, pieceId: number, square: number): PieceView {
    const piece = board.at(square);
    const local = this.local(square);
    const view = new PieceView(this.scene, local.x, local.y, pieceId, piece?.color ?? 'red', {
      hidden: piece?.hidden ?? true,
    });
    this.pieces.set(pieceId, view);
    this.pieceLayer.add(view);
    return view;
  }

  private viewOf(pieceId: number): PieceView | undefined {
    return this.pieces.get(pieceId);
  }

  // ---------------------------------------------------------------------------------------------
  // Animations
  // ---------------------------------------------------------------------------------------------

  /**
   * Plays a move: the captured piece dies, the mover glides across, and a face-down piece turns over
   * on the way. Resolves once everything has settled, so the caller can hand the turn over afterwards.
   */
  async playMove(board: Board, event: MoveEvent): Promise<void> {
    const target = this.local(event.move.to);
    const jobs: Promise<void>[] = [];

    if (event.captured) jobs.push(this.playCapture(event.captured, target));

    const mover = this.viewOf(event.pieceId);
    const kind = event.revealedKind;
    if (mover) {
      const glide = mover.glideTo(target.x, target.y);
      // Turn the piece over just before it lands: early enough to be part of the move, late enough
      // that the eye has already followed it across the board.
      const flip =
        event.wasHidden && kind
          ? new Promise<void>((resolve) => {
              this.scene.time.delayedCall(130, () => {
                this.options.onCue?.('reveal');
                void mover.flipTo(kind).then(resolve);
              });
            })
          : Promise.resolve();
      jobs.push(
        (async () => {
          await glide;
          // The knock lands with the dust, not when the tween was queued.
          this.options.onCue?.('place');
          dust(this.scene, target.x, target.y, this.pieceLayer.depth + 5);
          await flip;
        })(),
      );
    }

    await this.track(Promise.all(jobs));
    this.reconcile(board);
  }

  /** Rewinds a move, for 悔棋. */
  async playUndo(board: Board, event: MoveEvent): Promise<void> {
    return this.track(this.runUndo(board, event));
  }

  private async runUndo(board: Board, event: MoveEvent): Promise<void> {
    const from = this.local(event.move.from);
    const to = this.local(event.move.to);
    const mover = this.viewOf(event.pieceId);

    if (event.captured) {
      // A captured piece comes back as a fresh view. A piece taken face down comes back face down,
      // because that is the only thing anybody ever knew about it.
      const captured = event.captured;
      const view = new PieceView(this.scene, to.x, to.y, captured.pieceId, captured.color, {
        hidden: captured.hidden,
      });
      if (captured.kind) view.showFace(captured.kind);
      view.setScale(0.2).setAlpha(0);
      this.pieces.set(captured.pieceId, view);
      this.pieceLayer.add(view);
      this.scene.tweens.add({
        targets: view,
        scale: 1,
        alpha: 1,
        duration: 260,
        ease: 'Back.easeOut',
      });
    }

    if (mover) {
      await mover.glideTo(from.x, from.y);
      if (event.wasHidden) mover.showHidden();
    }

    this.reconcile(board);
  }

  private playCapture(captured: CapturedInfo, at: { x: number; y: number }): Promise<void> {
    const view = this.viewOf(captured.pieceId);
    this.pieces.delete(captured.pieceId);
    if (!view) return Promise.resolve();
    this.options.onCue?.('capture');
    impact(this.scene, at.x, at.y, captured.hidden ? C.goldDim : C.cinnabar, {
      depth: this.pieceLayer.depth + 6,
    });
    return view.spinAway().then(() => view.destroy());
  }

  /**
   * Makes the views agree with the engine exactly.
   *
   * Called after every animation. It is the safety net that keeps a dropped tween, an interrupted flip
   * or an undo from leaving a piece drawn on the wrong square — and it is cheap, because it only ever
   * touches what is already on the board.
   */
  reconcile(board: Board): void {
    const seen = new Set<number>();
    for (let sq = 0; sq < SQUARES; sq++) {
      const piece = board.at(sq);
      if (!piece) continue;
      seen.add(piece.id);
      const local = this.local(sq);
      let view = this.pieces.get(piece.id);
      if (!view) {
        view = this.spawn(board, piece.id, sq);
      }
      this.scene.tweens.killTweensOf(view);
      view.setPosition(local.x, local.y);
      // The engine still calls an unplayed piece `hidden` after the match is over; the board does not.
      const dimmed = this.over && piece.hidden;
      // 迷雾: a piece standing on a fogged square is not rendered at all — hiding it by covering is
      // not enough, the view itself must not draw it (belt-and-suspenders on top of the opaque tile).
      const fogged = this.fogVisible !== null && !this.fogVisible.has(sq);
      view
        .setScale(1)
        .setAlpha(dimmed ? REVEALED_ALPHA : 1)
        .setAngle(0)
        .setVisible(!fogged);
      if (piece.hidden) {
        if (dimmed) view.showRevealed(piece.kind);
        else view.showHidden();
      } else {
        view.showFace(piece.kind);
      }
    }
    for (const [id, view] of [...this.pieces]) {
      if (seen.has(id)) continue;
      view.destroy();
      this.pieces.delete(id);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Highlights
  // ---------------------------------------------------------------------------------------------

  /** Marks the piece the player has picked up. */
  setSelection(square: number | null): void {
    if (this.selection !== null) this.viewOfSquare(this.selection)?.setLifted(false);
    this.selection = square;
    if (square !== null) this.viewOfSquare(square)?.setLifted(true);
    this.redrawMarks();
  }

  /**
   * The squares the selected piece can move to, each drawn as a breathing ring — green for a safe
   * landing, red for one where the piece would stand hanging (capturable for free, no friendly
   * protection). The danger split is computed by the scene from the same `isHanging` rule the 吃子提示
   * overlay draws from; here it is only a tint.
   */
  setLegalTargets(targets: readonly { square: number; danger?: boolean }[]): void {
    this.legalTargets = targets.map((target) => target.square);
    this.dangerTargets = new Set(
      targets.filter((target) => target.danger === true).map((target) => target.square),
    );
    for (const image of this.targets) {
      this.scene.tweens.killTweensOf(image);
      image.destroy();
    }
    this.targets.length = 0;
    for (const target of targets) {
      const square = target.square;
      const local = this.local(square);
      const occupied = this.viewOfSquare(square) !== undefined;
      const danger = target.danger === true;
      const dot = this.scene.add
        .image(local.x, local.y, TEX.ring)
        .setOrigin(0.5)
        .setDisplaySize(PIECE_RADIUS * 1.2, PIECE_RADIUS * 1.2)
        .setTint(danger ? C.hintOwn : C.legal)
        .setAlpha(0.85);
      this.targetLayer.add(dot);
      this.targets.push(dot);
      // A piece standing on the target is marked with a ring around it, not a dot under it.
      if (occupied) dot.setDisplaySize(PIECE_RADIUS * 2.1, PIECE_RADIUS * 2.1);
      const full = dot.scale;
      this.scene.tweens.add({
        targets: dot,
        scale: { from: full, to: full * 1.3 },
        alpha: { from: 0.9, to: 0.35 },
        duration: 760,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
      });
    }
    this.redrawMarks();
  }

  /**
   * 送将提示: squares where the selected piece's move would leave its own general attacked, drawn as
   * red X's.
   *
   * Deliberately independent of the 吃子提示 checkbox: this is a legality warning — "this square is a
   * trap" — not a capture hint, so it shows on selection whether or not the hint is on.
   */
  setSendsCheck(squares: ReadonlySet<number>): void {
    this.sendsCheck = new Set(squares);
    this.redrawMarks();
  }

  setLastMove(move: Move | null): void {
    this.lastMove = move;
    this.redrawMarks();
  }

  /**
   * 吃子提示: rings the pieces that can be taken for free — red for ours, green for theirs.
   *
   * A halo *and* a ring, both breathing slowly rather than blinking like a legal-move dot: this is a
   * standing property of the position, not a prompt to do something on this frame, and the two overlays
   * sit on the same board often enough that they must not read as the same thing. Both are drawn under
   * the piece, so the character on the piece stays crisp and the halo reads as light coming off the
   * square.
   *
   * Called with an empty list to clear it — which is what happens on every move before the next
   * position has been read, so a mark can never outlive the piece that earned it.
   */
  setDangerMarks(marks: readonly DangerMark[]): void {
    for (const image of this.dangerMarks) {
      this.scene.tweens.killTweensOf(image);
      image.destroy();
    }
    this.dangerMarks.length = 0;

    for (const mark of marks) {
      const local = this.local(mark.square);
      const own = mark.tone === 'own';
      const glow = this.scene.add
        .image(local.x, local.y, own ? TEX.glowOwn : TEX.glowFoe)
        .setOrigin(0.5)
        .setDisplaySize(CELL * 1.85, CELL * 1.85)
        .setAlpha(0.85);
      const ring = this.scene.add
        .image(local.x, local.y, TEX.ring)
        .setOrigin(0.5)
        .setDisplaySize(PIECE_RADIUS * 2.5, PIECE_RADIUS * 2.5)
        .setTint(own ? C.hintOwn : C.hintFoe)
        .setAlpha(0.95);
      this.dangerLayer.add(glow);
      this.dangerLayer.add(ring);
      this.dangerMarks.push(glow, ring);

      const full = glow.scale;
      this.scene.tweens.add({
        targets: glow,
        alpha: { from: 0.9, to: 0.4 },
        scale: { from: full, to: full * 1.12 },
        duration: 1080,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
      });
      this.scene.tweens.add({
        targets: ring,
        alpha: { from: 0.95, to: 0.4 },
        duration: 1080,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
      });
    }
  }

  /** How many danger marks are on the board right now — the acceptance run's reading. */
  get dangerMarkCount(): number {
    return this.dangerMarks.length / 2;
  }

  // ---------------------------------------------------------------------------------------------
  // 迷雾 (fog of war)
  // ---------------------------------------------------------------------------------------------

  /**
   * 迷雾: show a fog tile on every square outside `visible`, and clear them everywhere else.
   *
   * `null` switches the fog off entirely — the mode the board uses in 标准/混斗 and at the end of a
   * match, when the reveal turns the whole board up. Called by the scene after every position change;
   * tiles fade rather than pop so a move's new vision reads as the mist rolling back.
   *
   * Piece visibility is *not* touched here (the move animation is usually mid-flight when this runs —
   * a piece gliding out of a now-fogged square must stay visible until it lands); {@link reconcile}
   * applies it at rest. `null` is the one exception: disabling fog happens at rest, so every piece
   * view is shown at once.
   */
  setFog(visible: ReadonlySet<number> | null): void {
    this.fogVisible = visible;
    if (visible === null) {
      this.clearFogLayer();
      for (const view of this.pieces.values()) view.setVisible(true);
      return;
    }
    for (let sq = 0; sq < SQUARES; sq++) {
      this.setFogTile(sq, !visible.has(sq));
    }
    this.sweepFogParticles(visible);
  }

  /** How many squares are fogged right now — the acceptance run's reading of the picture. */
  get fogTileCount(): number {
    let count = 0;
    for (const tile of this.fogTiles) if (tile) count += 1;
    return count;
  }

  private setFogTile(square: number, show: boolean): void {
    let tile = this.fogTiles[square];
    if (!show) {
      if (tile) {
        const fading = tile;
        this.scene.tweens.killTweensOf(fading);
        this.scene.tweens.add({
          targets: fading,
          alpha: 0,
          duration: 280,
          onComplete: () => {
            fading.destroy();
            if (this.fogTiles[square] === fading) this.fogTiles[square] = null;
          },
        });
        this.fogTiles[square] = null;
      }
      return;
    }
    if (tile) return;
    const local = this.local(square);
    tile = this.scene.add
      .image(local.x, local.y, TEX.fog)
      .setOrigin(0.5)
      .setDisplaySize(CELL * 1.08, CELL * 1.08)
      .setAlpha(0);
    this.fogLayer.add(tile);
    this.fogTiles[square] = tile;
    // Settle to fully opaque: a tile that never quite covers its square is a tile that leaks its
    // piece through the mist, which is exactly what the mode must not do. The mist's motion lives on
    // the wisps; the tile itself is a solid wall.
    this.scene.tweens.add({
      targets: tile,
      alpha: 1,
      duration: 260,
      ease: 'Quad.easeOut',
    });
  }

  /**
   * The mist wisps: a handful of soft blobs that wander from fogged square to fogged square. Called
   * after every position change; any wisp the new vision has caught out in the open dissolves and
   * re-mists somewhere still hidden.
   */
  private sweepFogParticles(visible: ReadonlySet<number>): void {
    while (this.fogParticles.length < 10) {
      const wisp = this.scene.add
        .image(0, 0, TEX.mist)
        .setOrigin(0.5)
        .setDisplaySize(CELL * 0.95, CELL * 0.95)
        .setAlpha(0);
      this.fogLayer.add(wisp);
      this.fogParticles.push(wisp);
      this.driftWisp(wisp, visible, 0);
    }
    for (const wisp of this.fogParticles) {
      const at = localToSquare(wisp.x, wisp.y);
      if (at === null || visible.has(at)) this.driftWisp(wisp, visible, 0);
    }
  }

  /** Starts (or restarts) one wisp: fade in over a random fogged square, then wander. */
  private driftWisp(wisp: Phaser.GameObjects.Image, visible: ReadonlySet<number>, delay: number): void {
    const fogged: number[] = [];
    for (let sq = 0; sq < SQUARES; sq++) if (!visible.has(sq)) fogged.push(sq);
    if (fogged.length === 0) {
      wisp.setAlpha(0);
      return;
    }
    this.scene.tweens.killTweensOf(wisp);
    const pick = fogged[Math.floor(Math.random() * fogged.length)] as number;
    const local = this.local(pick);
    wisp.setPosition(local.x, local.y);
    this.scene.tweens.add({
      targets: wisp,
      alpha: 0.3 + Math.random() * 0.35,
      duration: 380,
      delay,
    });
    const wander = (): void => {
      // A wisp that was destroyed (fog cleared, scene left) must not start a new drift on nothing.
      if (!wisp.active) return;
      const target = fogged[Math.floor(Math.random() * fogged.length)] as number;
      const at = this.local(target);
      this.scene.tweens.add({
        targets: wisp,
        x: at.x,
        y: at.y,
        alpha: 0.12 + Math.random() * 0.4,
        duration: 2400 + Math.random() * 2400,
        ease: 'Sine.easeInOut',
        onComplete: wander,
      });
    };
    this.scene.time.delayedCall(delay + 380, wander);
  }

  /** Removes every fog tile and wisp — the end of a match, or a board in a non-fog mode. */
  private clearFogLayer(): void {
    for (let sq = 0; sq < SQUARES; sq++) {
      const tile = this.fogTiles[sq];
      if (tile) {
        this.scene.tweens.killTweensOf(tile);
        tile.destroy();
      }
      this.fogTiles[sq] = null;
    }
    for (const wisp of this.fogParticles) {
      this.scene.tweens.killTweensOf(wisp);
      wisp.destroy();
    }
    this.fogParticles.length = 0;
  }

  /** Highlights the general that is currently in check, or clears it. */
  setCheckSquare(square: number | null): void {
    this.checkSquare = square;
    this.scene.tweens.killTweensOf(this.checkGlow);
    if (square === null) {
      this.checkGlow.setAlpha(0);
      this.redrawMarks();
      return;
    }
    const local = this.local(square);
    this.checkGlow.setPosition(local.x, local.y).setAlpha(0.9);
    this.scene.tweens.add({
      targets: this.checkGlow,
      alpha: { from: 0.95, to: 0.3 },
      scale: { from: 1, to: 1.25 },
      duration: 640,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    });
    this.redrawMarks();
  }

  clearHighlights(): void {
    this.setSelection(null);
    this.setLegalTargets([]);
    this.setSendsCheck(new Set());
    this.setLastMove(null);
    this.setCheckSquare(null);
    this.setDangerMarks([]);
  }

  private viewOfSquare(square: number): PieceView | undefined {
    const local = this.local(square);
    for (const view of this.pieces.values()) {
      if (Math.abs(view.x - local.x) < 1 && Math.abs(view.y - local.y) < 1) return view;
    }
    return undefined;
  }

  private redrawMarks(): void {
    const g = this.markGfx;
    g.clear();

    if (this.lastMove) {
      for (const square of [this.lastMove.from, this.lastMove.to]) {
        const local = this.local(square);
        g.lineStyle(2, C.lastMove, 0.9);
        g.strokeRect(local.x - CELL * 0.42, local.y - CELL * 0.42, CELL * 0.84, CELL * 0.84);
      }
    }

    if (this.selection !== null) {
      const local = this.local(this.selection);
      g.lineStyle(2.5, C.select, 1);
      g.strokeCircle(local.x, local.y, PIECE_RADIUS + 3.5);
      g.lineStyle(1, C.select, 0.45);
      g.strokeCircle(local.x, local.y, PIECE_RADIUS + 6.5);
    }

    for (const square of this.legalTargets) {
      if (!this.viewOfSquare(square)) continue;
      const local = this.local(square);
      g.lineStyle(2, this.dangerTargets.has(square) ? C.hintOwn : C.legal, 0.9);
      g.strokeCircle(local.x, local.y, PIECE_RADIUS + 2.5);
    }

    // 送将提示: a red X on every square where the selected piece would expose its own general. Drawn
    // on the marks layer so it sits under the piece layer — a square holding an enemy piece still shows
    // the X around it, and an empty one shows it across the square.
    for (const square of this.sendsCheck) {
      const local = this.local(square);
      const arm = PIECE_RADIUS * 0.8;
      g.lineStyle(2.5, C.check, 0.95);
      g.beginPath();
      g.moveTo(local.x - arm, local.y - arm);
      g.lineTo(local.x + arm, local.y + arm);
      g.moveTo(local.x + arm, local.y - arm);
      g.lineTo(local.x - arm, local.y + arm);
      g.strokePath();
    }

    if (this.checkSquare !== null) {
      const local = this.local(this.checkSquare);
      g.lineStyle(2, C.check, 0.9);
      g.strokeCircle(local.x, local.y, PIECE_RADIUS + 4);
    }
  }
}

// -------------------------------------------------------------------------------------------------
// Static board art
// -------------------------------------------------------------------------------------------------

/** The sandalwood panel: base fill, grain, and the double frame line of a real board. */
function drawBoardPanel(g: Phaser.GameObjects.Graphics): void {
  g.fillStyle(0x140c08, 1);
  g.fillRoundedRect(0, 0, BOARD_WIDTH, BOARD_HEIGHT, 12);
  g.fillStyle(C.wood, 1);
  g.fillRoundedRect(4, 4, BOARD_WIDTH - 8, BOARD_HEIGHT - 8, 10);
  g.fillStyle(C.woodLight, 0.26);
  g.fillRoundedRect(8, 8, BOARD_WIDTH - 16, BOARD_HEIGHT - 16, 8);

  // Grain: sine-wobbled horizontal strokes at varying opacity. Cheap, and it is the difference between
  // a board and a brown rectangle.
  for (let i = 0; i < 26; i++) {
    const baseY = 10 + (i / 25) * (BOARD_HEIGHT - 20) + Math.sin(i * 2.7) * 5;
    g.lineStyle(1, C.woodGrain, 0.05 + ((i * 37) % 9) / 70);
    g.beginPath();
    let started = false;
    for (let x = 8; x <= BOARD_WIDTH - 8; x += 14) {
      const y = baseY + Math.sin((x / BOARD_WIDTH) * Math.PI * 2.4 + i) * 2.6;
      if (!started) {
        g.moveTo(x, y);
        started = true;
      } else {
        g.lineTo(x, y);
      }
    }
    g.strokePath();
  }

  const inset = BOARD_MARGIN - 14;
  g.lineStyle(2.4, C.goldDim, 0.72);
  g.strokeRoundedRect(inset, inset, BOARD_WIDTH - inset * 2, BOARD_HEIGHT - inset * 2, 4);
  g.lineStyle(1, C.goldDim, 0.38);
  g.strokeRoundedRect(
    inset + 4,
    inset + 4,
    BOARD_WIDTH - (inset + 4) * 2,
    BOARD_HEIGHT - (inset + 4) * 2,
    3,
  );
}

/** The 9×10 grid, with the river gap and both palace diagonals. */
function drawGrid(g: Phaser.GameObjects.Graphics): void {
  const x0 = BOARD_MARGIN;
  const y0 = BOARD_MARGIN;
  const x1 = BOARD_MARGIN + 8 * CELL;
  const y1 = BOARD_MARGIN + 9 * CELL;

  g.lineStyle(1.4, C.boardLine, 0.88);
  for (let rank = 0; rank < 10; rank++) {
    g.lineBetween(x0, y0 + rank * CELL, x1, y0 + rank * CELL);
  }
  for (let file = 0; file < 9; file++) {
    const x = x0 + file * CELL;
    if (file === 0 || file === 8) {
      g.lineBetween(x, y0, x, y1);
    } else {
      // The river is left open on the inner files, exactly as on a printed board.
      g.lineBetween(x, y0, x, y0 + 4 * CELL);
      g.lineBetween(x, y0 + 5 * CELL, x, y1);
    }
  }

  g.lineStyle(1.2, C.boardLine, 0.7);
  g.lineBetween(x0 + 3 * CELL, y0, x0 + 5 * CELL, y0 + 2 * CELL);
  g.lineBetween(x0 + 5 * CELL, y0, x0 + 3 * CELL, y0 + 2 * CELL);
  g.lineBetween(x0 + 3 * CELL, y0 + 7 * CELL, x0 + 5 * CELL, y0 + 9 * CELL);
  g.lineBetween(x0 + 5 * CELL, y0 + 7 * CELL, x0 + 3 * CELL, y0 + 9 * CELL);

  // The outer border is drawn twice, the way a wooden board is routed.
  g.lineStyle(2.6, C.boardLine, 0.95);
  g.strokeRect(x0 - 7, y0 - 7, 8 * CELL + 14, 9 * CELL + 14);
  g.lineStyle(1, C.boardLine, 0.55);
  g.strokeRect(x0 - 11, y0 - 11, 8 * CELL + 22, 9 * CELL + 22);
}

/** The corner brackets that mark the cannon and soldier points. */
function drawMarks(g: Phaser.GameObjects.Graphics): void {
  for (const square of MARKED_SQUARES) {
    const file = fileOf(square);
    const rank = rankOf(square);
    const cx = BOARD_MARGIN + file * CELL;
    const cy = BOARD_MARGIN + rank * CELL;
    const gap = 5;
    const arm = 7;
    g.lineStyle(1.3, C.boardLine, 0.8);
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        // Skip brackets that would fall outside the board, on the leftmost and rightmost files.
        if (file === 0 && sx < 0) continue;
        if (file === 8 && sx > 0) continue;
        const x = cx + sx * gap;
        const y = cy + sy * gap;
        g.beginPath();
        g.moveTo(x, y + sy * arm);
        g.lineTo(x, y);
        g.lineTo(x + sx * arm, y);
        g.strokePath();
      }
    }
  }
}

/** 楚河 · 汉界, sitting in the river band. */
/**
 * 楚河 · 汉界, sitting in the river band.
 *
 * The only part of the board art that is not symmetric under a 180° turn: the whole panel is a
 * rotation-invariant drawing (grid, palace diagonals, the cannon and soldier brackets all map onto
 * themselves) except for these two words, which are printed 楚河-left / 汉界-right on a real board and
 * so have to swap sides when the board is read from the other end. They stay the right way up, because
 * nobody wants to read 楚河 upside down.
 */
function riverLabels(scene: Phaser.Scene, flipped = false): Phaser.GameObjects.GameObject[] {
  const y = BOARD_MARGIN + 4.5 * CELL;
  const style = {
    fontFamily: SERIF_STACK,
    fontSize: '19px',
    color: hex(C.boardLine),
    // The board is drawn by a camera zoomed to device resolution, so a glyph baked at 1× would be
    // magnified again on the way to the screen.
    resolution: BAKE_SCALE,
  };
  const left = flipped ? '汉 界' : '楚 河';
  const right = flipped ? '楚 河' : '汉 界';
  return [
    scene.add.text(BOARD_MARGIN + 2 * CELL, y, left, style).setOrigin(0.5).setAlpha(0.7),
    scene.add.text(BOARD_MARGIN + 6 * CELL, y, right, style).setOrigin(0.5).setAlpha(0.7),
  ];
}
