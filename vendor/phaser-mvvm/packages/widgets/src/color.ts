/**
 * Colour helpers.
 *
 * Widgets never hard-code colours (PLAN §4.6/§10.3): they read a semantic token from the active
 * theme and, when they need a shade the theme does not name (a `danger` button's hover fill, for
 * example), derive it from that token instead of inventing a literal. Keeping the maths in a module
 * without Phaser imports makes it unit-testable in plain Node.
 */

export const WHITE = 0xffffff;
export const BLACK = 0x000000;

/** Keeps a packed colour inside the 24-bit RGB range. */
function toRgb(value: number): number {
  if (!Number.isFinite(value)) {
    return BLACK;
  }
  const rounded = Math.round(value);
  return ((rounded % 0x1000000) + 0x1000000) % 0x1000000;
}

/** Packs a colour number into a CSS colour string: `0x2f6feb` → `'#2f6feb'`. */
export function toCssColor(value: number): string {
  return `#${toRgb(value).toString(16).padStart(6, '0')}`;
}

/**
 * Lightens (`amount > 0`) or darkens (`amount < 0`) a packed colour.
 *
 * `amount` is a ratio in `[-1, 1]`: `1` is white, `-1` is black, `0` returns the colour unchanged.
 * Used to derive hover/pressed shades for tokens that only exist in one flavour (PLAN §10.3 keeps
 * the theme token set small on purpose).
 */
export function shadeColor(value: number, amount: number): number {
  const rgb = toRgb(value);
  const t = Number.isFinite(amount) ? Math.max(-1, Math.min(1, amount)) : 0;
  if (t === 0) {
    return rgb;
  }
  const mix = (channel: number): number =>
    Math.round(t > 0 ? channel + (255 - channel) * t : channel * (1 + t));
  const r = mix((rgb >> 16) & 0xff);
  const g = mix((rgb >> 8) & 0xff);
  const b = mix(rgb & 0xff);
  return (r << 16) | (g << 8) | b;
}
