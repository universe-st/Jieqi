/**
 * Line limiting and single-line ellipsis for `Label`.
 *
 * Phaser's `Text` wraps but has no notion of `maxLines` or of an ellipsis the layout can measure, so
 * the widget trims the wrapped lines itself. The widget hands in a width-measuring callback (its own
 * canvas `measureText`), which keeps every decision in this module free of Phaser imports and
 * therefore unit-testable in Node.
 */

import { codePointLengthAt, snapToCodePoint } from './text-edit';

/** The single character appended to a clipped line (`…`, U+2026). */
export const ELLIPSIS = '\u2026';

/** Measures the rendered width of a candidate string, in design pixels. */
export type MeasureWidth = (text: string) => number;

export interface TruncateResult {
  /** The lines to display, in order. */
  lines: string[];
  /** True when content was dropped (i.e. the result differs from the input). */
  truncated: boolean;
}

export interface LineLimitOptions {
  /** Lines kept before the rest is dropped. `Infinity`/`undefined` keeps everything. */
  maxLines?: number;
  /** Append an ellipsis to the last kept line when content is dropped. Defaults to `false`. */
  ellipsis?: boolean;
  /** Width available to one line; `Infinity` disables width-driven ellipsis. */
  maxWidth?: number;
  measureWidth: MeasureWidth;
}

function isFiniteWidth(maxWidth: number): boolean {
  return Number.isFinite(maxWidth) && maxWidth > 0;
}

/**
 * Shortens `text` so that `text + ellipsis` fits into `maxWidth`.
 *
 * Returns `text` unchanged when it already fits, `''` when the width cannot hold anything (including
 * the degenerate `maxWidth <= 0`), and otherwise the longest prefix that leaves room for the ellipsis
 * (found with a binary search, so a wide string costs `O(log n)` measurements).
 */
export function ellipsizeLine(
  text: string,
  measureWidth: MeasureWidth,
  maxWidth: number,
  ellipsis: string = ELLIPSIS,
): string {
  if (!Number.isFinite(maxWidth)) {
    return text;
  }
  if (maxWidth <= 0) {
    return '';
  }
  if (text.length === 0) {
    return text;
  }
  if (measureWidth(text) <= maxWidth) {
    return text;
  }
  const ellipsisWidth = measureWidth(ellipsis);
  if (ellipsisWidth > maxWidth) {
    return '';
  }

  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (measureWidth(text.slice(0, mid)) + ellipsisWidth <= maxWidth) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  // The binary search counts UTF-16 code units, so `low` can land between the halves of a surrogate
  // pair; slicing there would render a lone surrogate (a tofu box) instead of the last whole glyph.
  return text.slice(0, snapToCodePoint(text, low)) + ellipsis;
}

/**
 * Ends `text` in an ellipsis **whether or not it already fits** — the line-limit case.
 *
 * {@link ellipsizeLine} answers "make this line fit", so it returns a short line untouched; but when
 * `maxLines` dropped something, that short line is precisely the one that has to *say so*. Every
 * wrapped line fits its own width by construction, so a cut across prose was invisible: `ellipsis: true`
 * painted no `…` at all on real paragraphs (V64, found by the round-98 `#/compose` card, whose probe
 * read `truncated: true` with no ellipsis in the painted text).
 *
 * Shortening is still only what is needed: when `text + …` fits, the line keeps every character.
 */
export function ellipsizeAlways(
  text: string,
  measureWidth: MeasureWidth,
  maxWidth: number,
  ellipsis: string = ELLIPSIS,
): string {
  if (ellipsis.length === 0) {
    return text;
  }
  if (!isFiniteWidth(maxWidth)) {
    return `${text}${ellipsis}`;
  }
  const ellipsisWidth = measureWidth(ellipsis);
  if (ellipsisWidth > maxWidth) {
    // No room for the marker itself: the honest answer is the marker alone rather than a line that
    // silently lies about being complete.
    return ellipsis;
  }
  if (measureWidth(text) + ellipsisWidth <= maxWidth) {
    return `${text}${ellipsis}`;
  }

  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (measureWidth(text.slice(0, mid)) + ellipsisWidth <= maxWidth) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return text.slice(0, snapToCodePoint(text, low)) + ellipsis;
}

/**
 * Keeps at most `maxLines` lines.
 *
 * When lines are dropped and `ellipsis` is on, the last kept line **ends in `…`** — shortened only as
 * far as that needs ({@link ellipsizeAlways}); without an ellipsis the lines are simply cut. Lines are
 * never re-wrapped here — the caller has already wrapped the text at the final width.
 */
export function truncateLines(
  lines: readonly string[],
  maxLines: number,
  measureWidth: MeasureWidth,
  maxWidth: number,
  ellipsis: string = ELLIPSIS,
): TruncateResult {
  const limit = Number.isFinite(maxLines) ? Math.max(0, Math.floor(maxLines)) : lines.length;
  if (lines.length <= limit) {
    return { lines: lines.slice(), truncated: false };
  }
  if (limit === 0) {
    return { lines: [], truncated: true };
  }

  const kept = lines.slice(0, limit);
  const last = kept[limit - 1] ?? '';
  // An empty ellipsis means "cut, do not shorten the kept line": the line keeps whatever width it
  // already has (it may overflow when a single word is wider than the content box).
  kept[limit - 1] = ellipsizeAlways(last, measureWidth, maxWidth, ellipsis);
  return { lines: kept, truncated: true };
}

/**
 * Breaks any line that is wider than `maxWidth` at code-point boundaries.
 *
 * Phaser wraps at **spaces**, which is correct for Latin text and useless for Chinese and Japanese:
 * a sentence with no spaces comes back as one long line and simply overflows its box (measured: a
 * 36-character Chinese sentence stayed a single 19.5px line inside a 140px box, hair over 4x too wide).
 * This is the last-resort pass browsers call `overflow-wrap: anywhere`: a line that still does not fit
 * is split so every line does, and a single glyph wider than the box is left alone on its own line
 * (splitting it further is impossible, and dropping it would hide content).
 *
 * Code points, not code units, so an emoji or a surrogate pair is never cut in half.
 */
export function rewrapOverflowingLines(
  lines: readonly string[],
  maxWidth: number,
  measureWidth: MeasureWidth,
): string[] {
  if (!isFiniteWidth(maxWidth)) {
    return lines.slice();
  }
  const out: string[] = [];
  let changed = false;

  for (const line of lines) {
    if (line.length === 0 || measureWidth(line) <= maxWidth) {
      out.push(line);
      continue;
    }
    changed = true;
    let current = '';
    for (let index = 0; index < line.length;) {
      // Step *forward* by a whole code point: `snapToCodePoint` snaps backwards onto the high
      // surrogate, so using it here would leave the index where it is and spin forever.
      const next = index + codePointLengthAt(line, index);
      const candidate = current + line.slice(index, next);
      if (current.length > 0 && measureWidth(candidate) > maxWidth) {
        out.push(current);
        current = line.slice(index, next);
      } else {
        current = candidate;
      }
      index = next;
    }
    out.push(current);
  }

  return changed ? out : lines.slice();
}

/**
 * The `Label` policy in one call: apply `maxLines`, and ellipsize when asked to.
 *
 * A single line is also ellipsized when it overflows `maxWidth` (the un-wrapped case: a long word or
 * `wrap: false`), which `truncateLines` alone would not catch because nothing was dropped.
 */
export function applyLineLimit(
  lines: readonly string[],
  options: LineLimitOptions,
): TruncateResult {
  const { measureWidth, ellipsis = false, maxWidth = Number.POSITIVE_INFINITY } = options;
  const maxLines = options.maxLines ?? Number.POSITIVE_INFINITY;

  if (lines.length > maxLines) {
    return ellipsis
      ? truncateLines(lines, maxLines, measureWidth, maxWidth)
      : truncateLines(lines, maxLines, measureWidth, maxWidth, '');
  }

  if (ellipsis && lines.length === 1 && isFiniteWidth(maxWidth)) {
    const only = lines[0] ?? '';
    const shortened = ellipsizeLine(only, measureWidth, maxWidth);
    return { lines: [shortened], truncated: shortened !== only };
  }

  return { lines: lines.slice(), truncated: false };
}
