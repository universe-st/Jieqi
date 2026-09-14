/**
 * Pure text-editing primitives shared by `TextField`, `TextArea` and the DOM input bridge.
 *
 * Everything in this module is a plain function over plain data: no Phaser, no DOM, no module-level
 * side effects, so it can be imported (and exhaustively unit-tested) in Node. The widgets own the
 * `Graphics`/`Text` objects and ask these functions *what* to draw, never *how*.
 *
 * Caret positions are UTF-16 code unit indices, exactly like `HTMLInputElement.selectionStart`, so a
 * value can be handed to (and read back from) the hidden DOM bridge without translation. Every
 * movement primitive steps over whole code points, which is what keeps an emoji from being sliced in
 * half by a Backspace or a `maxLength` cut.
 */

import type { Insets, Rect } from '@phaser-mvvm/layout';
import { clampValue } from './input-bridge';

/** Measures the rendered width of a candidate string, in design pixels. */
export type MeasureWidth = (text: string) => number;

/** Input flavours the widgets accept; only `password` and `number` change the visible text. */
export type TextInputType = 'text' | 'number' | 'password' | 'email' | 'search';

/** Horizontal alignment of the rendered text inside the content box. */
export type TextInputAlign = 'left' | 'center' | 'right';

/** The character a password field is displayed with (U+2022, `•`). */
export const PASSWORD_MASK = '\u2022';

/** Multiplier applied to the theme font size to obtain the line box height. */
export const LINE_SPACING = 1.25;

/** Blink half-period of the caret, in milliseconds. */
export const CARET_BLINK_MS = 500;

/** Minimum width of the text area of a field, in design pixels. */
export const MIN_CONTENT_WIDTH = 96;

/** An ordered `[start, end)` range of caret offsets (code units). */
export interface TextRange {
  readonly start: number;
  readonly end: number;
}

/** One logical line of the value, with its offsets in the whole string. */
export interface TextLine {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

/** A `TextLine` placed in the content box (local widget coordinates). */
export interface LayoutLine extends TextLine {
  readonly x: number;
  readonly y: number;
}

/** Caret after a vertical move, plus the column the move should keep coming back to. */
export interface CaretPosition {
  readonly caret: number;
  /** Column hint: `-1` means "derive it from the current line". */
  readonly columnHint: number;
}

/** A slice of the displayed string that is visible inside the content box. */
export interface TextWindow {
  /** Index of the first visible code unit, in the displayed string. */
  readonly start: number;
  /** Index just past the last visible code unit. */
  readonly end: number;
  /** The visible substring (`display.slice(start, end)`). */
  readonly text: string;
  /**
   * Offset of `text` relative to the line's own origin: `-(scrolled away width)`. Always `<= 0`
   * when `scrollX > 0`, so the slice never overflows to the left of the view.
   */
  readonly offset: number;
}

/** The result of an editing operation: the new value plus the caret/selection it leaves behind. */
export interface EditResult {
  readonly value: string;
  readonly caret: number;
  readonly anchor: number;
}

// ---------------------------------------------------------------------------- carets

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Length of the code point starting at `index` (1, or 2 for a surrogate pair).
 *
 * Exported because "walk a string one character at a time" needs it as often as the caret helpers do -
 * the last-resort line wrapper in `text-truncate.ts` uses it to step forward, where the caret's
 * `snapToCodePoint` (which snaps *backwards*) would not advance at all.
 */
export function codePointLengthAt(value: string, index: number): number {
  const code = value.charCodeAt(index);
  return isHighSurrogate(code) && isLowSurrogate(value.charCodeAt(index + 1)) ? 2 : 1;
}

/** Number of code points (a surrogate pair counts as one character). */
export function codePointCount(value: string): number {
  let count = 0;
  for (let index = 0; index < value.length; index += codePointLengthAt(value, index)) {
    count++;
  }
  return count;
}

/**
 * Clamps a caret offset into `[0, value.length]` and snaps it onto a code point boundary.
 *
 * `NaN`/`Infinity` become `0`; an offset that would land *inside* a surrogate pair is moved one code
 * unit back, so a caller can never address half of an emoji.
 */
export function clampCaret(value: string, caret: number): number {
  if (!Number.isFinite(caret)) {
    return 0;
  }
  return snapToCodePoint(value, caret);
}

/**
 * Moves an offset back onto a code point boundary.
 *
 * An offset naming the low half of a surrogate pair is moved one code unit back, so callers that slice
 * a string (the ellipsis search, the caret) can never cut an emoji in half.
 */
export function snapToCodePoint(value: string, index: number): number {
  const clamped = Math.max(0, Math.min(value.length, Math.floor(index)));
  return isLowSurrogate(value.charCodeAt(clamped)) ? clamped - 1 : clamped;
}

/** Orders a caret/anchor pair into an ascending range. */
export function selectionRange(caret: number, anchor: number): TextRange {
  return caret <= anchor ? { start: caret, end: anchor } : { start: anchor, end: caret };
}

/** True when the caret and the anchor describe a non-empty selection. */
export function hasSelection(caret: number, anchor: number): boolean {
  return caret !== anchor;
}

/**
 * Moves a caret by `delta` code points (negative = left).
 *
 * A surrogate pair counts as one step, so `moveCaret(value, 1, -1)` removes a whole emoji. The
 * result is clamped to the value.
 */
export function moveCaret(value: string, caret: number, delta: number): number {
  const step = delta < 0 ? -1 : 1;
  let remaining = Math.abs(Math.trunc(delta));
  let index = clampCaret(value, caret);

  while (remaining > 0) {
    if (step < 0) {
      if (index <= 0) {
        return 0;
      }
      // Step over a whole surrogate pair when the caret sits just behind one.
      const previous = codePointLengthAt(value, Math.max(0, index - 2));
      index -= isLowSurrogate(value.charCodeAt(index - 1)) && previous === 2 ? 2 : 1;
      remaining--;
    } else {
      if (index >= value.length) {
        return value.length;
      }
      index += codePointLengthAt(value, index);
      remaining--;
    }
  }
  return index;
}

/** Start offset of the line that contains `caret`. */
export function lineStartAt(value: string, caret: number): number {
  const index = clampCaret(value, caret);
  const found = value.lastIndexOf('\n', Math.max(0, index - 1));
  return found === -1 ? 0 : found + 1;
}

/** The whole logical line around `caret`, as a `[start, end)` range — what a **triple click** selects. */
export function lineRangeAt(value: string, caret: number): TextRange {
  return { start: lineStartAt(value, caret), end: lineEndAt(value, caret) };
}

/** End offset (exclusive, before the newline) of the line that contains `caret`. */
export function lineEndAt(value: string, caret: number): number {
  const index = clampCaret(value, caret);
  const found = value.indexOf('\n', index);
  return found === -1 ? value.length : found;
}

/** What a double click treats as one unit: a word, a run of spaces, or a run of punctuation. */
function runKind(char: string | undefined): 'word' | 'space' | 'other' {
  if (char === undefined) {
    return 'other';
  }
  if (/\s/u.test(char)) {
    return 'space';
  }
  return /[\p{L}\p{N}_]/u.test(char) ? 'word' : 'other';
}

/**
 * The run of text a **double click** selects, as a `[start, end)` range.
 *
 * `characterIndex` is the code point the pointer is **over** (see {@link charIndexAtX}) rather than a
 * caret offset: a caret index sits *between* two characters, so "which word did the user click" is not
 * answerable from it alone — a double click at the right edge of `Drag` must select `Drag`, not the
 * space after it.
 *
 * Three kinds of run, each selected as a unit: a **word** (`\p{L}`, `\p{N}`, `_`; `中文` is one word),
 * a run of **whitespace**, and a run of **punctuation/symbols** (so `foo, bar` double-clicks `,` on its
 * own). The index is clamped, so a click past the end of the text selects the last character's run.
 */
export function wordRangeAt(value: string, characterIndex: number): TextRange {
  const chars = [...value];
  if (chars.length === 0) {
    return { start: 0, end: 0 };
  }
  const clamped = Math.min(Math.max(0, Math.floor(characterIndex)), chars.length - 1);
  const kind = runKind(chars[clamped]);
  let start = clamped;
  let end = clamped;
  while (start > 0 && runKind(chars[start - 1]) === kind) {
    start -= 1;
  }
  while (end + 1 < chars.length && runKind(chars[end + 1]) === kind) {
    end += 1;
  }
  const toOffset = (codePointIndex: number): number =>
    chars.slice(0, codePointIndex).reduce((sum, char) => sum + char.length, 0);
  return { start: toOffset(start), end: toOffset(end + 1) };
}

/**
 * Index of the code point whose horizontal span contains `x` — the character under a pointer.
 *
 * The companion of {@link caretAtX}, which answers the different question "where does the caret go".
 * Measured with the same `measureWidth` the widget paints with, so a click and a double click agree
 * about which character is under the mouse. Input past either end clamps to the first/last character.
 */
export function charIndexAtX(text: string, x: number, measureWidth: MeasureWidth): number {
  const chars = [...text];
  if (chars.length === 0) {
    return 0;
  }
  if (!Number.isFinite(x) || x <= 0) {
    return 0;
  }
  let width = 0;
  for (let i = 0; i < chars.length; i += 1) {
    width += measureWidth(chars[i] ?? '');
    if (x < width) {
      return i;
    }
  }
  return chars.length - 1;
}

// ---------------------------------------------------------------------------- editing

/** Inserts `text`, replacing the selection; the caret lands just after the inserted text. */
export function insertText(value: string, caret: number, anchor: number, text: string): EditResult {
  const range = selectionRange(clampCaret(value, caret), clampCaret(value, anchor));
  const next = value.slice(0, range.start) + text + value.slice(range.end);
  const position = range.start + text.length;
  return { value: next, caret: position, anchor: position };
}

/**
 * Deletes either the selection or one code point next to the caret.
 *
 * `'backward'` is Backspace (the code point *before* the caret), `'forward'` is Delete. With a
 * non-empty selection the direction is irrelevant: the selected range goes away.
 */
export function deleteRange(
  value: string,
  caret: number,
  anchor: number,
  direction: 'backward' | 'forward',
): EditResult {
  const range = selectionRange(clampCaret(value, caret), clampCaret(value, anchor));
  if (range.end > range.start) {
    return {
      value: value.slice(0, range.start) + value.slice(range.end),
      caret: range.start,
      anchor: range.start,
    };
  }

  if (direction === 'backward') {
    const from = moveCaret(value, range.start, -1);
    if (from === range.start) {
      return { value, caret: range.start, anchor: range.start };
    }
    return {
      value: value.slice(0, from) + value.slice(range.start),
      caret: from,
      anchor: from,
    };
  }

  const to = moveCaret(value, range.end, 1);
  if (to === range.end) {
    return { value, caret: range.end, anchor: range.end };
  }
  return {
    value: value.slice(0, range.end) + value.slice(to),
    caret: range.end,
    anchor: range.end,
  };
}

/** The selected substring (empty when nothing is selected). */
export function selectedText(value: string, caret: number, anchor: number): string {
  const range = selectionRange(clampCaret(value, caret), clampCaret(value, anchor));
  return value.slice(range.start, range.end);
}

// ---------------------------------------------------------------------------- display

/** Replaces every character with the mask character; a surrogate pair masks as one character. */
export function maskValue(value: string, mask: string = PASSWORD_MASK): string {
  return mask.repeat(codePointCount(value));
}

/** What a password field shows instead of its value. */
export function displayValue(value: string, inputType: TextInputType): string {
  return inputType === 'password' ? maskValue(value) : value;
}

/**
 * Length of the displayed prefix that corresponds to `caret`.
 *
 * For a password the count is in mask characters (code points), which is why it differs from the
 * code unit offset kept in the model.
 */
export function displayOffset(value: string, caret: number, inputType: TextInputType): number {
  const index = clampCaret(value, caret);
  return inputType === 'password' ? codePointCount(value.slice(0, index)) : index;
}

/** The visible prefix of the displayed text, up to (but excluding) the caret. */
export function displaySlice(value: string, caret: number, inputType: TextInputType): string {
  const offset = displayOffset(value, caret, inputType);
  return inputType === 'password' ? PASSWORD_MASK.repeat(offset) : value.slice(0, offset);
}

/**
 * Inverse of `displayOffset`: turns a position in the displayed string back into a value offset.
 *
 * A pointer click lands in *display* coordinates (where a password shows one mask character per code
 * point), while the model counts code units, so the two have to be converted explicitly.
 */
export function valueOffsetFromDisplay(
  value: string,
  offset: number,
  inputType: TextInputType,
): number {
  if (inputType !== 'password') {
    return clampCaret(value, offset);
  }
  const wanted = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
  let index = 0;
  let count = 0;
  while (index < value.length && count < wanted) {
    index += codePointLengthAt(value, index);
    count++;
  }
  return index;
}

/**
 * Drops everything a number field must not accept.
 *
 * Digits are always kept; a single leading `-` and a single `.` survive so that `-1.5` and `0.5`
 * can be typed, and everything else (letters, spaces, thousands separators, a second dot) is
 * removed. Filtering per keystroke therefore never produces a string that cannot be parsed later.
 */
export function filterNumeric(value: string): string {
  let digits = '';
  let dot = false;
  let negative = false;
  for (const character of value) {
    if (character >= '0' && character <= '9') {
      digits += character;
      continue;
    }
    if (character === '-' && digits.length === 0 && !negative) {
      negative = true;
      continue;
    }
    if (character === '.' && !dot) {
      dot = true;
      digits += character;
    }
  }
  // A lone sign or point (`-`, `.`, `-.`) has no digits and parses to `NaN`; the field must never hold
  // such a value, because a two-way binding would write that `NaN` straight into the view model.
  return /\d/.test(digits) ? `${negative ? '-' : ''}${digits}` : '';
}

/** Replaces line breaks with spaces; a single-line field never holds a newline. */
export function stripNewlines(value: string): string {
  return value.replace(/[\r\n]+/g, ' ');
}

export interface SanitizeOptions {
  inputType?: TextInputType;
  /** `undefined`/`null`/negative means "no limit"; `0` allows nothing. */
  maxLength?: number | null;
  /** `false` strips line breaks. */
  multiline?: boolean;
}

/** The one entry point every write goes through: filter, then clamp. */
export function sanitizeValue(value: string, options: SanitizeOptions = {}): string {
  let next = value;
  if (options.inputType === 'number') {
    next = filterNumeric(next);
  }
  if (options.multiline === false) {
    next = stripNewlines(next);
  }
  return clampValue(next, options.maxLength ?? undefined);
}

// ---------------------------------------------------------------------------- lines & layout

/** Splits the value at every `\n`; the line break itself belongs to no line. */
export function splitLines(value: string): TextLine[] {
  const lines: TextLine[] = [];
  let start = 0;
  for (let index = 0; index <= value.length; index++) {
    if (index === value.length || value[index] === '\n') {
      lines.push({ text: value.slice(start, index), start, end: index });
      start = index + 1;
    }
  }
  return lines;
}

/**
 * Greedy word wrap of one logical line.
 *
 * The algorithm breaks after the last space that still fits (`text[lastSpace]` ends the chunk and is
 * swallowed), and falls back to a hard break inside a word that is wider than the whole line, so a
 * URL cannot overflow. Offsets stay absolute in the original string, which is what makes a caret and
 * a selection survive wrapping.
 */
export function wrapLine(
  text: string,
  start: number,
  maxWidth: number,
  measureWidth: MeasureWidth,
): TextLine[] {
  if (text.length === 0 || !Number.isFinite(maxWidth) || maxWidth <= 0) {
    return [{ text, start, end: start + text.length }];
  }

  const lines: TextLine[] = [];
  let lineStart = 0;
  let lastSpace = -1;
  let position = 0;

  while (position < text.length) {
    const step = codePointLengthAt(text, position);
    const candidateEnd = position + step;
    const width = measureWidth(text.slice(lineStart, candidateEnd));

    if (width > maxWidth && candidateEnd > lineStart) {
      let breakEnd = lastSpace > lineStart ? lastSpace : position;
      if (breakEnd <= lineStart) {
        // A single character wider than the line: it gets the line to itself.
        breakEnd = candidateEnd;
      }
      lines.push({
        text: text.slice(lineStart, breakEnd),
        start: start + lineStart,
        end: start + breakEnd,
      });
      lineStart = breakEnd === lastSpace ? breakEnd + 1 : breakEnd;
      lastSpace = -1;
      position = lineStart;
      continue;
    }

    if (text[position] === ' ') {
      lastSpace = position;
    }
    position = candidateEnd;
  }

  lines.push({ text: text.slice(lineStart), start: start + lineStart, end: start + text.length });
  return lines;
}

export interface TextLayoutOptions {
  /** Wrap at `maxWidth`. Defaults to `false`. */
  wrap?: boolean;
  maxWidth: number;
  measureWidth: MeasureWidth;
}

/** Splits the value into logical lines and optionally wraps each of them. */
export function layoutTextLines(value: string, options: TextLayoutOptions): TextLine[] {
  const lines: TextLine[] = [];
  for (const line of splitLines(value)) {
    if (options.wrap !== true) {
      lines.push(line);
    } else {
      lines.push(...wrapLine(line.text, line.start, options.maxWidth, options.measureWidth));
    }
  }
  return lines;
}

/** Width of the widest line (used by `measureContent`). */
export function widestLine(lines: readonly TextLine[], measureWidth: MeasureWidth): number {
  let widest = 0;
  for (const line of lines) {
    widest = Math.max(widest, measureWidth(line.text));
  }
  return widest;
}

export interface LinePlacementOptions {
  align: TextInputAlign;
  /** Content box width. */
  width: number;
  lineHeight: number;
  measureWidth: MeasureWidth;
}

/**
 * Assigns each line its `x` (alignment) and `y` (stacked by `lineHeight`) in content coordinates.
 *
 * A line wider than the content box is left-aligned instead of centred: an overflowing centred line
 * would hide both of its ends at once.
 */
export function positionLines(
  lines: readonly TextLine[],
  options: LinePlacementOptions,
): LayoutLine[] {
  const placed: LayoutLine[] = [];
  let y = 0;

  for (const line of lines) {
    const lineWidth = options.measureWidth(line.text);
    let x = 0;
    if (lineWidth <= options.width) {
      if (options.align === 'center') {
        x = (options.width - lineWidth) / 2;
      } else if (options.align === 'right') {
        x = options.width - lineWidth;
      }
    }
    placed.push({ text: line.text, start: line.start, end: line.end, x: Math.max(0, x), y });
    y += options.lineHeight;
  }

  return placed;
}

/** Index of the line that owns `caret`; ties (a wrapped boundary) go to the following line. */
export function lineIndexAt(lines: readonly TextLine[], caret: number): number {
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index];
    if (line && caret >= line.start) {
      return index;
    }
  }
  return 0;
}

/**
 * Moves the caret one line up or down, keeping the column it was in.
 *
 * `columnHint` is the column to restore; `-1` means "take it from the current line". The returned
 * hint is the column the caret started from, so a sequence of moves over short lines comes back to
 * the original column (the behaviour every text editor has).
 */
export function moveCaretVertically(
  lines: readonly TextLine[],
  caret: number,
  direction: 'up' | 'down',
  columnHint: number,
): CaretPosition {
  if (lines.length === 0) {
    return { caret: 0, columnHint: -1 };
  }

  const index = lineIndexAt(lines, caret);
  const line = lines[index] ?? { text: '', start: 0, end: 0 };
  const column = columnHint >= 0 ? columnHint : Math.max(0, caret - line.start);
  const target = Math.max(
    0,
    Math.min(lines.length - 1, direction === 'up' ? index - 1 : index + 1),
  );
  const targetLine = lines[target] ?? line;
  // `clampCaret` (not a raw `Math.min`) so the restored column cannot land inside a surrogate pair.
  const offset = clampCaret(targetLine.text, column);

  return { caret: targetLine.start + offset, columnHint: column };
}

/** Caret offset (in the displayed string) that is closest to the local x position `x`. */
export function caretAtX(text: string, x: number, measureWidth: MeasureWidth): number {
  if (x <= 0) {
    return 0;
  }
  let position = 0;
  let previousRight = 0;

  while (position < text.length) {
    const next = position + codePointLengthAt(text, position);
    const right = measureWidth(text.slice(0, next));
    if (x < (previousRight + right) / 2) {
      return position;
    }
    previousRight = right;
    position = next;
  }

  return text.length;
}

/** Caret position in content coordinates. */
export function caretRectOf(
  lines: readonly LayoutLine[],
  caret: number,
  measureWidth: MeasureWidth,
): { x: number; y: number } {
  const line = lines[lineIndexAt(lines, caret)] ?? { text: '', start: 0, end: 0, x: 0, y: 0 };
  const offset = Math.max(0, Math.min(line.text.length, caret - line.start));
  return { x: line.x + measureWidth(line.text.slice(0, offset)), y: line.y };
}

/**
 * Rectangles that cover a selection, one per line it spans.
 *
 * Zero-width fragments (an empty line inside the selection) are dropped: nothing would be visible
 * anyway, and a 0-pixel fill would only add draw calls.
 */
export function selectionRects(
  lines: readonly LayoutLine[],
  range: TextRange,
  lineHeight: number,
  measureWidth: MeasureWidth,
): Rect[] {
  const rects: Rect[] = [];

  for (const line of lines) {
    if (line.end < range.start || line.start > range.end) {
      continue;
    }
    const from = Math.max(range.start, line.start) - line.start;
    const to = Math.min(range.end, line.end) - line.start;
    const left = line.x + measureWidth(line.text.slice(0, from));
    const right = line.x + measureWidth(line.text.slice(0, to));
    const width = right - left;
    if (width <= 0) {
      continue;
    }
    rects.push({ x: left, y: line.y, width, height: lineHeight });
  }

  return rects;
}

// ---------------------------------------------------------------------------- scrolling

/**
 * Visible slice of a line for the given horizontal scroll offset.
 *
 * The window starts at the first code point that is not entirely scrolled away and ends at the first
 * one that begins past the right edge, so a partially visible character is kept at both ends and the
 * drawn string never overflows the content box.
 */
export function visibleTextWindow(
  text: string,
  scrollX: number,
  viewWidth: number,
  measureWidth: MeasureWidth,
): TextWindow {
  const windowLeft = Number.isFinite(scrollX) ? Math.max(0, scrollX) : 0;

  if (viewWidth <= 0) {
    return { start: text.length, end: text.length, text: '', offset: 0 };
  }
  if (text.length === 0) {
    return { start: 0, end: 0, text: '', offset: -windowLeft };
  }

  const windowRight = windowLeft + viewWidth;
  let start = 0;
  let left = 0;

  while (start < text.length) {
    const next = start + codePointLengthAt(text, start);
    const right = measureWidth(text.slice(0, next));
    if (right > windowLeft) {
      break;
    }
    left = right;
    start = next;
  }

  let end = start;
  let position = start;
  while (position < text.length) {
    if (measureWidth(text.slice(0, position)) >= windowRight) {
      break;
    }
    position += codePointLengthAt(text, position);
    end = position;
  }

  return { start, end, text: text.slice(start, end), offset: left - windowLeft };
}

/**
 * Horizontal scroll that keeps the caret inside the view.
 *
 * `caretX` is measured from the start of the line (not from the view), which is why the caller can
 * keep `scrollX` between calls: the caret only pushes the view when it would leave it, and pulling
 * it back never happens by more than necessary.
 */
export function computeScrollX(
  caretX: number,
  viewWidth: number,
  currentScrollX: number,
  caretWidth = 1,
): number {
  if (!Number.isFinite(viewWidth) || viewWidth <= 0) {
    return 0;
  }
  let scroll = Number.isFinite(currentScrollX) ? Math.max(0, currentScrollX) : 0;
  const x = Number.isFinite(caretX) ? Math.max(0, caretX) : 0;

  if (x < scroll) {
    scroll = x;
  } else if (x + caretWidth > scroll + viewWidth) {
    scroll = x + caretWidth - viewWidth;
  }
  return Math.max(0, scroll);
}

/** Vertical scroll that keeps the caret line inside the view (mirror of `computeScrollX`). */
export function computeScrollY(
  caretTop: number,
  caretBottom: number,
  viewHeight: number,
  currentScrollY: number,
): number {
  if (!Number.isFinite(viewHeight) || viewHeight <= 0) {
    return 0;
  }
  let scroll = Number.isFinite(currentScrollY) ? Math.max(0, currentScrollY) : 0;

  if (caretTop < scroll) {
    scroll = caretTop;
  } else if (caretBottom > scroll + viewHeight) {
    scroll = caretBottom - viewHeight;
  }
  return Math.max(0, scroll);
}

// ---------------------------------------------------------------------------- drag auto-scroll

/** Full speed of a held drag's auto-scroll, in design pixels per second. */
export const DRAG_AUTOSCROLL_MAX_SPEED = 900;

/** Distance past the edge at which a held drag reaches {@link DRAG_AUTOSCROLL_MAX_SPEED}. */
export const DRAG_AUTOSCROLL_RAMP = 48;

/** Slowest a held drag scrolls, as a fraction of the full speed: leaving the box already moves it. */
const DRAG_AUTOSCROLL_MIN_RATIO = 1 / 6;

/** Longest frame the auto-scroll integrates, so a stalled tab does not jump a whole page. */
const DRAG_AUTOSCROLL_MAX_FRAME_MS = 50;

/**
 * How far a coordinate sticks out of `[min, max]`: negative below, positive above, `0` inside.
 *
 * The auto-scroll needs a **signed** distance and not a boolean, because the direction of the scroll
 * and its speed both come from it.
 */
export function edgeOverflow(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value < min) {
    return value - min;
  }
  if (value > max) {
    return value - max;
  }
  return 0;
}

/**
 * How far a held drag scrolls the content during one frame, in design pixels.
 *
 * This is the browser's own drag-to-edge behaviour: the further the pointer is past the edge the
 * faster the content moves, and a pointer that has only just left the box already moves it — a step
 * that started at zero would feel stuck exactly where the user needs it most. A zero overflow is a
 * zero step, so a pointer inside the box never scrolls anything.
 */
export function dragAutoScrollStep(overflow: number, deltaMs: number): number {
  if (overflow === 0 || !Number.isFinite(overflow)) {
    return 0;
  }
  if (!Number.isFinite(deltaMs) || deltaMs <= 0) {
    return 0;
  }
  const ratio = Math.min(
    1,
    Math.max(DRAG_AUTOSCROLL_MIN_RATIO, Math.abs(overflow) / DRAG_AUTOSCROLL_RAMP),
  );
  const frame = Math.min(deltaMs, DRAG_AUTOSCROLL_MAX_FRAME_MS);
  return (Math.sign(overflow) * DRAG_AUTOSCROLL_MAX_SPEED * ratio * frame) / 1000;
}

/** Clamps a vertical offset so the last line stays reachable and the first one stays visible. */
export function clampScrollY(scrollY: number, contentHeight: number, viewHeight: number): number {
  const max = Math.max(0, contentHeight - viewHeight);
  if (!Number.isFinite(scrollY)) {
    return 0;
  }
  return Math.max(0, Math.min(max, scrollY));
}

// ---------------------------------------------------------------------------- metrics

/** Height of one line box: the theme font size scaled by `LINE_SPACING`. */
export function computeLineHeight(fontSize: number, spacing: number = LINE_SPACING): number {
  if (!Number.isFinite(fontSize) || fontSize <= 0) {
    return 1;
  }
  const scale = Number.isFinite(spacing) && spacing > 0 ? spacing : LINE_SPACING;
  return fontSize * scale;
}

/** Height of a `rows`-line text area, including its vertical padding. */
export function heightForRows(rows: number, lineHeight: number, insets: Insets): number {
  const count = Number.isFinite(rows) ? Math.max(1, Math.floor(rows)) : 1;
  return count * lineHeight + insets.top + insets.bottom;
}

/** How many whole lines fit into `height` (at least one). */
export function rowsForHeight(height: number, lineHeight: number, insets: Insets): number {
  if (!Number.isFinite(height) || lineHeight <= 0) {
    return 1;
  }
  const usable = height - insets.top - insets.bottom;
  return Math.max(1, Math.floor(usable / lineHeight));
}

// ---------------------------------------------------------------------------- permissions

/** The two pieces of control state that decide whether an *edit* may land. */
export interface EditPermission {
  /** `Widget#enabled` — a disabled control accepts nothing. */
  enabled: boolean;
  /** The `readOnly` option — the value is shown and selectable, but the user cannot change it. */
  readOnly: boolean;
}

/**
 * Whether an editing command may change the value.
 *
 * The DOM path gets this for free from the element (`readonly` / `disabled` attributes), so the Canvas
 * path has to decide it itself — and it has to decide it **once**, in the one funnel every edit goes
 * through (`TextInputBase#applyEdit`). Deciding it per caller is exactly how `Ctrl+X`/`Ctrl+V` slipped
 * past the `readOnly` check that typing, Backspace and Enter all honoured: those two are handled by
 * their own clipboard path rather than by the key switch (round 88, V59).
 *
 * Copying is deliberately **not** covered: reading the selection out of a read-only field is what a
 * browser allows too, so a cut on a read-only field still fills the clipboard and only its delete half
 * is refused.
 */
export function canEditValue(state: EditPermission): boolean {
  return state.enabled && !state.readOnly;
}
