/**
 * The little bit of padding a themed text object needs so glyphs are not shaved off.
 *
 * Phaser sizes a `Text` canvas to the font's measured `ascent + descent` and draws the baseline at
 * `ascent`. Two things then clip the tail of letters like `g`:
 *
 * 1. the height is fractional (measured `14.6 + 3.0 = 17.6` at 16px) and assigning it to
 *    `canvas.height` truncates it to 17;
 * 2. glyph rasterisation overshoots the font's measured box by a fraction of a pixel.
 *
 * `Label` used to report that clipped height to the layout as well, so the label was *both* drawn one
 * pixel short and measured one pixel short. A symmetric pad fixes both at once and - because it grows
 * the top and bottom equally - keeps the optical centre of the text inside its box exactly where it was.
 *
 * The value scales with the font size (overshoot is a fraction of the em), with a floor of one pixel so
 * the canvas truncation is always covered.
 */

/** Font sizes a theme publishes; kept structural so this module stays free of Phaser imports. */
type SizeScale = { readonly [token: string]: number };

/** Fallback when neither the `size` option nor the theme's `md` token is usable. */
const DEFAULT_FONT_SIZE = 16;

/** Padding (top and bottom, in design pixels) that keeps descenders inside the canvas. */
export function glyphPadding(fontSize: number): number {
  if (!Number.isFinite(fontSize) || fontSize <= 0) {
    return 1;
  }
  return Math.max(1, Math.round(fontSize * 0.08));
}

/** Reads the pixel size out of a Phaser text style's `fontSize` (`16`, `'16px'`, `'1.2em'` → fallback). */
export function fontSizeOf(
  style: { fontSize?: string | number } | undefined,
  fallback: number,
): number {
  const raw = style?.fontSize;
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw > 0 ? raw : fallback;
  }
  const parsed = typeof raw === 'string' ? Number.parseFloat(raw) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Resolves the `size` option to pixels.
 *
 * A token is looked up in the *current* theme's scale, so a theme switch re-sizes the text along with
 * everything else; a number is used as-is. An unknown token or a non-finite number falls back to the
 * theme's `md` (16px when the scale itself is unusable), which is what a caller who omits the option
 * gets.
 */
export function resolveLabelFontSize(size: string | number | undefined, scale: SizeScale): number {
  const md = typeof scale.md === 'number' && scale.md > 0 ? scale.md : DEFAULT_FONT_SIZE;
  if (typeof size === 'number') {
    return Number.isFinite(size) && size > 0 ? size : md;
  }
  if (typeof size === 'string') {
    const token = scale[size];
    if (typeof token === 'number' && token > 0) {
      return token;
    }
  }
  return md;
}
