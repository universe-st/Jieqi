/**
 * Chinese move notation (炮二平五), which is what a jieqi player expects to read in a move list.
 *
 * Two twists are specific to this variant:
 *
 * - a face-down piece is written with the 暗 prefix and named after **the square it stands on**, because
 *   that is what governs its move (`暗兵五进一`, exactly as the strategy texts write it);
 * - 前/后 disambiguation is done within the same *displayed* name, so two 暗兵 on one file are told
 *   apart the same way two 明兵 would be.
 *
 * Everything is written from **the side that is moving**, which in 混斗 is `ownerAt` rather than
 * `piece.color`: a 暗子 on red's half reads as red's move (暗兵 · 五进一) whoever it turns out to be,
 * and a revealed enemy piece reads by its true colour from then on. That is the reading a player of
 * either mode can follow.
 */

import type { Board } from './board';
import { KIND_NAME, type Color, type Kind, type Move, fileOf, movementOf, rankOf } from './types';

/** Red files count 1–9 from red's right; black files count 1–9 from black's right. */
export function fileNumber(color: Color, x: number): string {
  const n = color === 'red' ? 9 - x : x + 1;
  return '一二三四五六七八九'[n - 1] ?? String(n);
}

/** The side a move is *read* from: who owns the square now, not what the piece secretly is. */
function readingColor(board: Board, square: number): Color | null {
  const piece = board.at(square);
  if (!piece) return null;
  return board.ownerAt(square) ?? piece.color;
}

/** The piece name a player would read off the board: 暗 prefixed while the piece is face down. */
export function displayName(board: Board, square: number): string {
  const piece = board.at(square);
  if (!piece) return '';
  const kind = piece.hidden ? piece.homeKind : piece.kind;
  const color = readingColor(board, square) ?? piece.color;
  return `${piece.hidden ? '暗' : ''}${KIND_NAME[color][kind]}`;
}

/** Same label, but for a piece that is about to be revealed — used by the move log. */
export function nameOfKind(color: Color, kind: Kind, hidden: boolean): string {
  return `${hidden ? '暗' : ''}${KIND_NAME[color][kind]}`;
}

/** Pieces that step diagonally or crookedly name their *destination file* on 进/退; the rest name a count. */
function namesDestinationFile(kind: Kind): boolean {
  return kind === 'H' || kind === 'A' || kind === 'E';
}

/**
 * Two brothers on one file are told apart by 前/后 instead of by a file number — where 前 is the one
 * nearer the opponent. Returns `null` when the plain file number is unambiguous.
 */
function prefixFor(board: Board, square: number, name: string): '前' | '后' | null {
  const piece = board.at(square);
  if (!piece) return null;
  const color = readingColor(board, square) ?? piece.color;
  const x = fileOf(square);
  const brothers: number[] = [];
  for (let sq = 0; sq < board.squares.length; sq++) {
    if (fileOf(sq) !== x) continue;
    const other = board.at(sq);
    if (!other || board.ownerAt(sq) !== color) continue;
    const otherName = `${other.hidden ? '暗' : ''}${KIND_NAME[color][other.hidden ? other.homeKind : other.kind]}`;
    if (otherName === name) brothers.push(sq);
  }
  if (brothers.length < 2) return null;
  // Red moves up the board, so for red the *smallest* rank is the leading piece; for black the largest.
  const sorted = brothers.sort((a, b) => (color === 'red' ? rankOf(a) - rankOf(b) : rankOf(b) - rankOf(a)));
  return sorted[0] === square ? '前' : '后';
}

/** Renders `move` (played in the position `board` currently holds) in Chinese notation. */
export function toChineseNotation(board: Board, move: Move): string {
  const piece = board.at(move.from);
  if (!piece) return '??';
  const color = readingColor(board, move.from) ?? piece.color;
  const { kind } = movementOf(piece);
  const name = displayName(board, move.from);
  const prefix = prefixFor(board, move.from, name);
  const head = prefix ? `${prefix}${name}` : `${name}${fileNumber(color, fileOf(move.from))}`;

  const dy = rankOf(move.to) - rankOf(move.from);

  if (dy === 0) {
    return `${head}平${fileNumber(color, fileOf(move.to))}`;
  }

  const forward = color === 'red' ? dy < 0 : dy > 0;
  const verb = forward ? '进' : '退';
  if (namesDestinationFile(kind)) {
    return `${head}${verb}${fileNumber(color, fileOf(move.to))}`;
  }
  // Rooks, cannons, soldiers and the king count the squares they travel; that count is all a player
  // needs, because those pieces only ever move in a straight line.
  return `${head}${verb}${numberWord(Math.abs(dy))}`;
}

/** 一…九 for step counts, matching the file digits. */
function numberWord(n: number): string {
  return '一二三四五六七八九'[n - 1] ?? String(n);
}

/** `a1`-style coordinate, handy in logs and in the acceptance backdoor. */
export function toCoord(move: Move): string {
  return `${fileOf(move.from)}${rankOf(move.from)}-${fileOf(move.to)}${rankOf(move.to)}`;
}

export { fileNumber as notationFile };
