/**
 * `window.__JIEQI__` — the agent backdoor the acceptance run drives.
 *
 * The requirement for this project explicitly allows one, and the reason it is needed is concrete:
 * playing jieqi end to end through the UI means making ~100 taps on pieces whose value neither the
 * player nor the harness can see, so a scripted "click a legal move" loop is both slow and brittle.
 *
 * The design keeps the honest path first, though. {@link Backdoor.point} returns the **screen
 * coordinates** of a square, so a Playwright run can drive real `mouse.move/down/up` through Phaser's
 * own input pipeline and prove the UI works. Everything else (`move`, `aiPly`, `autoPlay`) is for
 * getting to a terminal state quickly, and every one of them goes through the same `GameScene` methods
 * the buttons call — there is no second implementation of the game rules hiding in here.
 *
 * ## Screens
 *
 * The game now has three of them (开始界面 → 定先后 → 棋盘), and which one is on screen is the first thing
 * a run has to know: a board query is meaningless while the menu is up, and the draw's outcome is only
 * observable while the draw is. {@link Backdoor.screen} answers that, `startGame()` walks from the menu
 * to the board *through the real animation*, and every board-only call throws a named error instead of
 * reporting a plausible-looking zero.
 */

import type Phaser from 'phaser';
import { stageRectOf, type Widget } from '@phaser-mvvm/phaser';
import type { Difficulty } from '../ai';
import { toChineseNotation } from '../core/notation';
import type { JieqiGame, MoveEvent } from '../core/rules';
import {
  type Color,
  type GameMode,
  type Kind,
  KIND_NAME,
  SQUARES,
  fileOf,
  rankOf,
} from '../core/types';
import { DESIGN_HEIGHT, DESIGN_WIDTH } from '../ui/palette';
import type { DrawScene } from '../scenes/DrawScene';
import type { GameScene } from '../scenes/GameScene';
import type { StartScene } from '../scenes/StartScene';
import { currentScreen, type ScreenName as Screen } from '../scenes/screen';

export type SquareArg = number | string | [number, number];

/**
 * Which scene is on screen. `boot` is the loading page: the font and the soundtrack are still arriving,
 * so the menu has not mounted yet.
 *
 * The three real names are the registry's (`scenes/screen.ts`), which is what a scene announces itself
 * with; `boot` only exists here, for the window before anything has.
 */
export type ScreenName = 'boot' | Screen;

/** What the draw screen looks like from outside — enough to check the animation against the outcome. */
export interface DrawState {
  /** The colour the draw is going to hand over. Decided on entry. */
  outcome: Color;
  /** The face the piece is presenting *right now*. Should equal `outcome` once `settled`. */
  shownFace: Color;
  /** How far the piece has turned, in radians. */
  radians: number;
  /** True once the piece has stopped and the verdict is on screen. */
  settled: boolean;
  /** The verdict line as rendered, e.g. `红 帅 你执红方 · 先行`. */
  verdict: string;
  halfTurns: number;
}

/** Accepts a flat index, an `"x,y"` string, or an `[x, y]` pair. */
export function toSquare(value: SquareArg): number {
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0 || value >= SQUARES) {
      throw new Error(`square index out of range: ${value}`);
    }
    return value;
  }
  if (typeof value === 'string') {
    const parts = value.split(',').map((part) => Number(part.trim()));
    if (parts.length !== 2) throw new Error(`square string must be "x,y", got "${value}"`);
    return toSquare([parts[0] as number, parts[1] as number]);
  }
  const [x, y] = value;
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x > 8 || y < 0 || y > 9) {
    throw new Error(`square out of range: ${x},${y}`);
  }
  return y * 9 + x;
}

export interface BackdoorState {
  /** Which screen is up. */
  screen: ScreenName;
  seed: number;
  ply: number;
  turn: Color;
  player: Color;
  /**
   * True when the board is drawn from black's side (将 at the bottom), which is what a player who drew
   * 黑 sees. The `view`/`truth` rows below stay in *engine* coordinates — square 0 is always black's
   * back rank — so this is what says whether "the top row" is near or far from the player.
   */
  flipped: boolean;
  busy: boolean;
  thinking: boolean;
  result: { winner: Color | null; kind: string; text: string } | null;
  /** What a player can legally do right now: `[from, to]` pairs as `"x,y"` strings. */
  legal: string[];
  /** The board as the *player* sees it — a face-down piece is a `?`, never its identity. */
  view: string[];
  /** The engine's own view, with every identity filled in. Debugging only. */
  truth: string[];
  selection: string | null;
  history: string[];
  /**
   * What neither side can account for yet: in 标准 the two armies' unknown identities, in 混斗 the
   * thirty-identity pool split by the colour each unknown piece would turn out to have.
   */
  pool: { red: number; black: number };
  /** 标准 or 混斗 — the two deals produce very different boards, so a run has to be able to tell. */
  mode: GameMode;
  /** The line under the board — how a refusal reads to the player. */
  status: string;
  /** 吃子提示 as the board has it. */
  captureHint: boolean;
  errors: number;
}

export interface Backdoor {
  version: string;
  /** Which scene is on screen right now. */
  screen(): ScreenName;
  /** Everything the harness needs for an assertion, in one call. */
  state(): BackdoorState;
  /** Waits for a screen to come up, or gives up after `ms`. */
  waitForScreen(name: ScreenName, ms?: number): Promise<boolean>;
  /**
   * Presses 开始游戏 and resolves once the board is dealt and idle.
   *
   * `mode` answers the 玩法 dialog the button opens. Omit it and the dialog is pressed through with
   * whatever the menu last used, which is what a run that just wants a board should do; pass `'mixed'`
   * for a 混斗 board. The dialog's own buttons are named (`mode_standard` / `mode_mixed`), so a run that
   * wants to prove the *question* is asked can click them for real instead.
   */
  startGame(mode?: GameMode): Promise<void>;
  /** Presses 新局: back through 定先后, which decides the colour again. */
  redraw(): Promise<void>;
  /** The draw as it stands, or `null` when that screen is not up. */
  draw(): DrawState | null;
  /** The level the menu / the board is set to. */
  difficulty(): Difficulty;
  setDifficulty(value: Difficulty): void;
  legal(): { from: string; to: string; notation: string }[];
  /**
   * Screen coordinates of a square's centre, in **page** pixels — feed these straight to
   * `page.mouse.click`.
   *
   * "Page" and not "design": the scene places the board in design pixels and `Scale.FIT` then scales the
   * 450×900 canvas to whatever the viewport allows and centres it. A harness that clicked the raw
   * design coordinate would be off by the scale factor *and* the letterbox offset on every real
   * viewport.
   */
  point(square: SquareArg): { x: number; y: number };
  /**
   * Screen coordinates of the centre of the named widget on screen, or `null` if it is not up.
   *
   * The counterpart of {@link point} for the UI: the menu's buttons and the dialogs' sliders have no
   * canvas square to be addressed by, so this is what lets an acceptance run press 开始游戏 or drag the
   * volume slider with a genuine `mouse.click` instead of calling the handler behind the control.
   */
  widgetPoint(name: string): { x: number; y: number } | null;
  /** Every named widget on screen with its rect, in page coordinates. */
  widgets(): { name: string; x: number; y: number; width: number; height: number }[];
  /** Screen coordinates of the canvas itself, so a harness can offset into page space. */
  canvasRect(): { x: number; y: number; width: number; height: number };
  /**
   * Plays a move through the same path the UI uses, and waits for the animations.
   *
   * `true` means the move was **legal**, which is not the same as "it happened": a move that 禁止循环追棋
   * forbids is played all the way into `play()` so the refusal is exercised rather than bypassed, and it
   * comes back with `ply` unchanged and a `status` that names the rule (see `state()`).
   */
  move(from: SquareArg, to: SquareArg): Promise<boolean>;
  /** Taps a square the way a player would: select, then confirm. */
  tap(square: SquareArg): Promise<void>;
  hint(): Promise<{ from: string; to: string; notation: string; score: number }[]>;
  undo(): Promise<boolean>;
  resign(): void;
  newGame(seed?: number): Promise<void>;
  /** Back to the title screen, for a second draw. */
  backToMenu(): Promise<void>;
  /** One ply played by the AI, for whichever side is to move. */
  aiPly(difficulty?: Difficulty): Promise<boolean>;
  /** 吃子提示 as it stands, and the switch the dialog's checkbox drives. */
  captureHint(): boolean;
  setCaptureHint(on: boolean): void;
  /**
   * The pieces 吃子提示 says are hanging: `mine` can be taken by the computer, `theirs` by the player.
   *
   * Read from the rules predicate, not from the picture — `marks` is what the board is drawing, so the
   * two can be compared and the difference between "the rules say so" and "the overlay shows it" stays
   * visible to a run.
   */
  danger(): { mine: string[]; theirs: string[]; marks: number; on: boolean };
  /**
   * The legal moves of the side to move, split by whether 禁止循环追棋 allows them.
   *
   * `forbidden` is the evidence for the rule: those moves are in `legal()` and are refused when played.
   */
  repetition(): { allowed: string[]; forbidden: string[] };
  /** The move log as rendered — the rows the player sees, so in 迷雾 invisible AI moves are absent. */
  log(): { index: number; notation: string }[];
  /** Plays the game out to a terminal state and returns what happened. */
  autoPlay(maxPlies?: number, difficulty?: Difficulty): Promise<{ plies: number; result: BackdoorState['result'] }>;
  /**
   * 迷雾: the picture's own answer — how many squares the board is fogging, which ones the player
   * can see, and whether this match is fog at all. `visible` is what the mist is *not* covering, so a
   * run can assert that a piece it knows is hidden stays out of the player's view.
   */
  fog(): { tiles: number; visible: string[]; mode: boolean };
  settle(ms?: number): Promise<boolean>;
  settled(): boolean;
  /** Runtime errors seen since load. The acceptance criterion is that this stays empty. */
  errors(): string[];
  clearErrors(): void;
  /** The player-visible board as one string, for eyeballing. */
  ascii(): string;
  quiesce(ms?: number): Promise<void>;
}

function pieceGlyph(color: Color, kind: Kind): string {
  return KIND_NAME[color][kind];
}

export function installBackdoor(game: Phaser.Game): Backdoor {
  const errors: string[] = [];
  if (typeof window !== 'undefined') {
    window.addEventListener('error', (event) => {
      errors.push(`error: ${event.message} @ ${event.filename}:${event.lineno}`);
    });
    window.addEventListener('unhandledrejection', (event) => {
      errors.push(`rejection: ${String(event.reason)}`);
    });
  }

  /**
   * Which screen is up.
   *
   * Read from the registry the scenes write to as they mount (`scenes/screen.ts`) rather than inferred
   * from `scene.isActive()`: during a cross fade both scenes are running, and inferring used to report
   * `game` for a whole frame after 新局 had already handed the screen to the draw — long enough for a
   * harness's very next call to land on a board that was on its way out.
   */
  const screen = (): ScreenName => currentScreen() ?? 'boot';

  const sceneByKey = <T>(key: string): T => game.scene.getScene(key) as T;

  /**
   * The board, or `null` while it is not on screen.
   *
   * `state()` gets polled in a loop by a harness, and the window between "the scene exists" and "the
   * deal has happened" is real — reading through it used to throw `Cannot read properties of
   * undefined`, which turned "wait for the game to be ready" into a crash instead of a wait. Now that
   * the board is not the first scene, "not on screen yet" is the *normal* state for the first few
   * seconds of a session, so this is a null rather than an error.
   */
  const gameScene = (): GameScene | null => {
    if (screen() !== 'game') return null;
    return sceneByKey<GameScene>('game') ?? null;
  };

  /** The board scene, or a named error. For the calls that are meaningless without one. */
  const scene = (): GameScene => {
    const current = gameScene();
    if (!current) {
      throw new Error(
        `__JIEQI__: the board is not on screen (screen = "${screen()}") — call startGame(), or press 开始游戏`,
      );
    }
    return current;
  };

  const drawScene = (): DrawScene | null =>
    screen() === 'draw' ? sceneByKey<DrawScene>('draw') : null;

  const startScene = (): StartScene | null =>
    screen() === 'start' ? sceneByKey<StartScene>('start') : null;

  /** The match, or `null` while it is still booting. */
  const match = (): JieqiGame | null => gameScene()?.engine ?? null;

  const view = (): string[] => {
    const board = match()?.board;
    if (!board) return [];
    // 迷雾: the player-visible picture hides everything outside the player's vision — a piece the
    // player cannot see reads as fog, not as a face-down piece (which would itself be information).
    const s = gameScene();
    const visible = s && s.isFogMode ? new Set(s.visibleSquaresNow()) : null;
    const rows: string[] = [];
    for (let y = 0; y < 10; y++) {
      let row = '';
      for (let x = 0; x < 9; x++) {
        const sq = y * 9 + x;
        const piece = board.at(sq);
        if (!piece) {
          row += ' . ';
          continue;
        }
        if (visible && !visible.has(sq)) {
          row += ' ≈ ';
          continue;
        }
        // A face-down piece is rendered as a question mark even though the engine knows what it is:
        // this string is what the harness asserts on, and it must not be able to see more than a
        // player can.
        row += piece.hidden ? ' ? ' : ` ${pieceGlyph(piece.color, piece.kind)} `;
      }
      rows.push(row);
    }
    return rows;
  };

  /**
   * The engine's view, every identity filled in. Debugging only.
   *
   * Case carries the side (upper case is red, lower case is black) and a trailing `?` marks a piece
   * that is still face down — without that, a red and a black 车 read identically and the output is
   * worse than useless.
   */
  const truth = (): string[] => {
    const board = match()?.board;
    if (!board) return [];
    const rows: string[] = [];
    for (let y = 0; y < 10; y++) {
      let row = '';
      for (let x = 0; x < 9; x++) {
        const piece = board.at(y * 9 + x);
        if (!piece) {
          row += '. ';
          continue;
        }
        const letter = piece.kind.toLowerCase();
        row += (piece.color === 'red' ? letter.toUpperCase() : letter) + (piece.hidden ? '?' : ' ');
      }
      rows.push(row);
    }
    return rows;
  };

  const label = (square: number): string => `${fileOf(square)},${rankOf(square)}`;

  /**
   * Every widget on the scene currently on screen, by debug name.
   *
   * The walk starts at the scene's **display list** rather than at the page root, because a dialog is
   * not part of the page's widget tree — `ModalHost` builds its own layer. Starting at the display list
   * is what makes `volumeCloseButton` findable while a modal is up.
   */
  const namedWidgets = (): Map<string, Widget> => {
    const out = new Map<string, Widget>();
    const key = screen();
    if (key === 'boot') return out;
    const scene = sceneByKey<Phaser.Scene>(key);
    const roots = (scene.children?.list ?? []) as unknown[];
    const walk = (node: unknown): void => {
      const widget = node as Widget;
      if (!widget || typeof widget.getWidgetChildren !== 'function') return;
      if (widget.name) out.set(widget.name, widget);
      for (const child of widget.getWidgetChildren()) walk(child);
    };
    for (const node of roots) walk(node);
    return out;
  };

  /** Design pixels → page pixels, through the canvas rect that `Scale.FIT` settled on. */
  const toPage = (x: number, y: number): { x: number; y: number } => {
    const rect = game.canvas.getBoundingClientRect();
    return {
      x: rect.x + (x / DESIGN_WIDTH) * rect.width,
      y: rect.y + (y / DESIGN_HEIGHT) * rect.height,
    };
  };

  const api: Backdoor = {
    version: '1.5.4',

    screen,

    state(): BackdoorState {
      const s = gameScene();
      const engine = match();
      if (!s || !engine) {
        // Not on the board yet (boot, the menu, the draw): answer with the shape a caller expects so a
        // poll loop can simply keep waiting.
        return {
          screen: screen(),
          seed: 0,
          ply: 0,
          turn: 'red',
          // Off the board the colour is either already drawn (during the 定先后 screen) or unknown.
          player: drawScene()?.outcome ?? 'red',
          flipped: drawScene()?.outcome === 'black',
          busy: true,
          thinking: false,
          result: null,
          legal: [],
          view: [],
          truth: [],
          selection: null,
          history: [],
          pool: { red: 15, black: 15 },
          // Off the board, the mode is whatever the menu is about to deal, or 标准 when nothing is up.
          mode: startScene()?.selectedMode ?? drawScene()?.gameMode ?? 'standard',
          status: '',
          captureHint: api.captureHint(),
          errors: errors.length,
        };
      }
      const board = engine.board;
      return {
        screen: 'game',
        seed: engine.seed,
        ply: engine.ply,
        turn: board.side,
        player: s.playerColor,
        flipped: s.playerColor === 'black',
        busy: s.isBusy,
        thinking: s.vm.thinking.value,
        result: engine.result
          ? { winner: engine.result.winner, kind: engine.result.kind, text: engine.result.text }
          : null,
        legal: engine.legalMoves().map((move) => `${label(move.from)}>${label(move.to)}`),
        view: view(),
        truth: truth(),
        selection: s.selection === null ? null : label(s.selection),
        history: engine.moveEvents.map((event: MoveEvent) => event.notation),
        pool: (() => {
          if (engine.mode === 'mixed') {
            const pool = engine.mixedPoolFor('red');
            return {
              red: pool.filter((entry) => entry.color === 'red').length,
              black: pool.filter((entry) => entry.color === 'black').length,
            };
          }
          const pools = engine.poolsFor('red');
          return { red: pools.red.length, black: pools.black.length };
        })(),
        mode: engine.mode,
        status: s.vm.status.value,
        captureHint: s.captureHint,
        errors: errors.length,
      };
    },

    async waitForScreen(name: ScreenName, ms = 15000) {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        if (screen() === name) return true;
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
      }
      return screen() === name;
    },

    /**
     * Presses 开始游戏 and waits for the board.
     *
     * Deliberately the menu's own button handler, so the run goes through the real cross fade and the
     * real 定先后 spin — skipping the animation would skip the thing under test.
     *
     * Called while already on the board it deals a fresh position **without** a draw, which is what a
     * harness that wants a board right now needs; the button's own 新局 → 重新定先后 path is
     * {@link redraw}, and the two are deliberately different calls so neither is a surprise.
     */
    async startGame(mode?: GameMode) {
      if (screen() === 'game') {
        const board = scene();
        // Already on a board: a fresh deal keeps the mode the board is being played in — and if the
        // caller asked for the *other* one, say so instead of quietly dealing the same game again.
        if (mode && mode !== board.gameMode) {
          throw new Error(
            `__JIEQI__: this board is ${board.gameMode}; call backToMenu() before startGame('${mode}')`,
          );
        }
        await api.newGame();
        return;
      }
      const menu = startScene();
      // `beginGame(mode)` answers the 玩法 dialog on the caller's behalf; without a mode it opens it,
      // and the call would then have to press a button — which is the run's business, not this one's.
      if (menu) menu.beginGame(mode ?? menu.selectedMode);
      const reached = await api.waitForScreen('game', 20000);
      if (!reached) throw new Error(`__JIEQI__: startGame() never reached the board (screen = "${screen()}")`);
      await api.settle();
    },

    /** Presses 新局: back through the 定先后 draw, and the board comes back on whatever colour it lands. */
    async redraw() {
      const board = scene();
      board.redraw();
      const drawing = await api.waitForScreen('draw', 8000);
      if (!drawing) throw new Error('__JIEQI__: redraw() never reached the 定先后 screen');
    },

    draw(): DrawState | null {
      const s = drawScene();
      if (!s) return null;
      return {
        outcome: s.outcome,
        shownFace: s.shownFace,
        radians: s.pieceRotation,
        settled: s.isSettled,
        verdict: s.verdictText,
        halfTurns: s.spinPlan.halfTurns,
      };
    },

    difficulty(): Difficulty {
      const board = gameScene();
      if (board) return board.vm.difficulty.value;
      return startScene()?.selectedDifficulty ?? 'normal';
    },

    setDifficulty(value: Difficulty): void {
      startScene()?.setDifficulty(value);
      const board = gameScene();
      if (board) board.vm.difficulty.value = value;
    },

    legal() {
      const s = scene();
      // The notation is derived from the position *before* the move, which is the one on the board.
      return s.engine.legalMoves().map((move) => ({
        from: label(move.from),
        to: label(move.to),
        notation: toChineseNotation(s.engine.board, move),
      }));
    },

    point(square: SquareArg) {
      const at = scene().squarePoint(toSquare(square));
      return toPage(at.x, at.y);
    },

    widgetPoint(name: string) {
      const widget = namedWidgets().get(name);
      if (!widget) return null;
      const rect = stageRectOf(widget);
      return toPage(rect.x + rect.width / 2, rect.y + rect.height / 2);
    },

    widgets() {
      const out: { name: string; x: number; y: number; width: number; height: number }[] = [];
      for (const [name, widget] of namedWidgets()) {
        const rect = stageRectOf(widget);
        const scaleX = game.canvas.getBoundingClientRect().width / DESIGN_WIDTH;
        const scaleY = game.canvas.getBoundingClientRect().height / DESIGN_HEIGHT;
        const topLeft = toPage(rect.x, rect.y);
        out.push({
          name,
          x: topLeft.x,
          y: topLeft.y,
          width: rect.width * scaleX,
          height: rect.height * scaleY,
        });
      }
      return out;
    },

    canvasRect() {
      const canvas = game.canvas;
      const rect = canvas.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    },

    async move(from: SquareArg, to: SquareArg) {
      const s = scene();
      const legal = s.engine.legalMoves();
      const a = toSquare(from);
      const b = toSquare(to);
      const found = legal.some((move) => move.from === a && move.to === b);
      if (!found) return false;
      await s.play({ from: a, to: b }, true);
      await s.settle();
      return true;
    },

    async tap(square: SquareArg) {
      const s = scene();
      const target = toSquare(square);
      // Reuse the scene's own selection logic, which is what a real click ends up calling.
      const current = s.selection;
      if (current !== null) {
        const legal = s.engine.legalMoves().some((m) => m.from === current && m.to === target);
        if (legal) {
          await s.play({ from: current, to: target }, true);
          await s.settle();
          return;
        }
      }
      s.tapSquare(target);
      await s.settle(1500);
    },

    async hint() {
      const candidates = await scene().showHint();
      await scene().settle();
      return candidates.slice(0, 5).map((entry) => ({
        from: label(entry.move.from),
        to: label(entry.move.to),
        notation: entry.notation,
        score: Math.round(entry.score),
      }));
    },

    async undo() {
      const s = scene();
      if (s.engine.ply === 0) return false;
      await s.undo();
      await s.settle();
      return true;
    },

    resign() {
      scene().resign();
    },

    async newGame(seed?: number) {
      await scene().startNewGame(seed ?? Math.floor(Math.random() * 0xffffffff));
      await scene().settle();
    },

    async backToMenu() {
      scene().backToMenu();
      const reached = await api.waitForScreen('start', 8000);
      if (!reached) throw new Error('__JIEQI__: backToMenu() never reached the title screen');
    },

    async aiPly(difficulty: Difficulty = 'easy') {
      const ok = await scene().playAiPly(difficulty);
      await scene().settle();
      return ok;
    },

    captureHint(): boolean {
      return gameScene()?.captureHint ?? startScene()?.captureHintSetting ?? false;
    },

    setCaptureHint(on: boolean): void {
      startScene()?.setCaptureHintSetting(on);
      gameScene()?.setCaptureHint(on);
    },

    danger() {
      const s = scene();
      const marks = s.dangerSquares();
      return {
        mine: marks.own.map(label),
        theirs: marks.foe.map(label),
        marks: s.dangerMarkCount,
        on: s.captureHint,
      };
    },

    repetition() {
      return scene().repetitionProbe();
    },

    log() {
      return scene().vm.moves.value.map((row) => ({ index: row.index, notation: row.notation }));
    },

    async autoPlay(maxPlies = 300, difficulty: Difficulty = 'easy') {
      // Resolved once, up front: self-play never crosses a scene boundary, and re-resolving it every
      // ply only adds a way for a mid-game screen change to throw in the middle of a loop.
      const s = scene();
      let plies = 0;
      while (!s.engine.result && plies < maxPlies) {
        const ok = await s.playAiPly(difficulty);
        if (!ok) break;
        const done = await s.settle();
        if (!done) errors.push(`settle timed out at ply ${plies}`);
        plies += 1;
      }
      return { plies, result: api.state().result };
    },

    fog() {
      const s = scene();
      return {
        tiles: s.fogTileCount,
        visible: s.visibleSquaresNow().map(label),
        mode: s.isFogMode,
        kingSeen: {
          // The AI's belief about where the player's king is (last-seen tracking), labelled like the
          // rest of the probe so a run can assert a hidden king stays out of the AI's belief.
          ai: label(s.engine.kingSeen[s.aiColor]),
          player: label(s.engine.kingSeen[s.playerColor]),
        },
      };
    },

    async settle(ms = 10000) {
      return scene().settle(ms);
    },

    settled() {
      return scene().settled;
    },

    errors() {
      return [...errors];
    },

    clearErrors() {
      errors.length = 0;
    },

    ascii() {
      return view().join('\n');
    },

    async quiesce(ms = 600) {
      await new Promise<void>((resolve) => setTimeout(resolve, ms));
    },
  };

  (window as unknown as { __JIEQI__: Backdoor }).__JIEQI__ = api;
  return api;
}
