/**
 * The look: a 中国古风 palette and the board's geometry.
 *
 * Everything here is a *design* constant for a 450×900 portrait canvas — the canvas is scaled to the
 * device, so these numbers are the same on every phone, which is what keeps the board and the HUD
 * aligned to the pixel. The palette is deliberately narrow: sandalwood, ivory, 朱砂 red, 墨 black and
 * antique gold, nothing else.
 */

/** Design resolution. Portrait, aspect 1:2, comfortably inside a modern phone's safe area. */
export const DESIGN_WIDTH = 450;
export const DESIGN_HEIGHT = 900;

/** Distance between two adjacent file/rank lines. */
export const CELL = 44;
/** Wooden margin between the outermost lines and the edge of the board panel. */
export const BOARD_MARGIN = 28;

/** Outer size of the board panel, including its wooden margin. */
export const BOARD_WIDTH = 8 * CELL + BOARD_MARGIN * 2; // 408
export const BOARD_HEIGHT = 9 * CELL + BOARD_MARGIN * 2; // 452

export const FILES = 9;
export const RANKS = 10;

/** Radius of a playing piece. Slightly smaller than a cell so neighbours never touch. */
export const PIECE_RADIUS = 19;

/** Where the top HUD block ends and the board slot begins, in design pixels. */
export const HUD_TOP_HEIGHT = 148;
/** Gap between the board slot and the bottom HUD block. */
export const HUD_GAP = 8;

export const BOARD_LEFT = (DESIGN_WIDTH - BOARD_WIDTH) / 2;

/** Centre of a board square in board-local coordinates (board panel top-left is the origin). */
export function squareToLocal(square: number): { x: number; y: number } {
  const file = square % FILES;
  const rank = (square / FILES) | 0;
  return { x: BOARD_MARGIN + file * CELL, y: BOARD_MARGIN + rank * CELL };
}

/** The square under a board-local point, or `null` when the point is too far from any intersection. */
export function localToSquare(x: number, y: number, tolerance = CELL * 0.52): number | null {
  const file = Math.round((x - BOARD_MARGIN) / CELL);
  const rank = Math.round((y - BOARD_MARGIN) / CELL);
  if (file < 0 || file >= FILES || rank < 0 || rank >= RANKS) return null;
  const centre = squareToLocal(rank * FILES + file);
  if (Math.hypot(centre.x - x, centre.y - y) > tolerance) return null;
  return rank * FILES + file;
}

/**
 * The palette.
 *
 * `hex()` exists because Phaser's Text takes CSS strings while Graphics takes numbers, and having two
 * copies of every colour is how a palette drifts.
 */
export const C = {
  /* Canvas and board wood */
  backdrop: 0x1b1210,
  woodDeep: 0x3a2418,
  wood: 0x6b4423,
  woodLight: 0x8a5a30,
  woodGrain: 0x54341c,
  boardLine: 0x2f1c10,
  boardLineSoft: 0x5a3a20,

  /* Pieces */
  ivory: 0xf0e2c4,
  ivoryShade: 0xd8c49c,
  sandal: 0x4a2f1c,
  sandalLight: 0x6b4527,
  cinnabar: 0xb0301f,
  ink: 0x1d1a17,

  /* Accents */
  gold: 0xc8a86a,
  goldBright: 0xe8cf95,
  goldDim: 0x8a7444,
  jade: 0x4e8a5f,

  /* Feedback */
  select: 0xffd76a,
  legal: 0x7fbf6a,
  lastMove: 0x9a7b4f,
  check: 0xd93b2b,
  danger: 0xc0392b,
  /* 迷雾 — the mist blue the fog tiles are baked in; also the 对方已落子 announcement colour. */
  fog: 0x93a8c2,

  /*
   * 吃子提示. Two colours with two meanings, and they are the opposite way round from what a chess
   * player might guess: red is *ours and in trouble*, green is *theirs and takeable*. Red has meant
   * "something is wrong on your side" everywhere else in this game (将军, 认输, the check glow) and the
   * overlay has to agree with the rest of the board rather than with a convention imported from
   * elsewhere.
   */
  hintOwn: 0xff4a33,
  hintFoe: 0x5fd07f,
} as const;

export const hex = (value: number): string => `#${value.toString(16).padStart(6, '0')}`;

/**
 * 霞鹜文楷 (LXGW WenKai) — the face the whole game is set in.
 *
 * The file behind this name is fetched at boot by `ui/font.ts` and registered with the document before
 * anything is drawn, so by the time a piece, a banner or a HUD label is baked this family exists.
 */
export const FONT_FAMILY = 'LXGW WenKai';

/**
 * The stack everything typographic asks for: the game's own face first, then a serif CJK fallback.
 *
 * The fallbacks are not decoration. They cover the two moments the real font cannot: the loading page
 * paints its first frame before the file has arrived, and a device where the fetch or the parse fails
 * still has to draw Chinese. Every candidate here ships with at least one of macOS, Windows, Android
 * and iOS, and all of them are 宋体/楷体-flavoured, so the fallback reads as the same *kind* of type
 * rather than as a different app.
 */
export const SERIF_STACK = `"${FONT_FAMILY}", "Songti SC", "STSong", "Noto Serif CJK SC", "Source Han Serif SC", "KaiTi", "STKaiti", "SimSun", serif`;

/** Decorative large glyphs (楚河汉界, banners) use the same stack, larger. */
export const TITLE_STACK = SERIF_STACK;

