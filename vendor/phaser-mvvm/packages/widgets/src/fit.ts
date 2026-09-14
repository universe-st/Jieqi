/**
 * `object-fit` maths for the `Image` widget.
 *
 * Pure functions: the widget passes the frame's natural size and the rect the layout engine handed
 * it, and receives a scale plus a centring offset. Keeping this out of the widget is what makes the
 * four fit modes testable in Node, where Phaser cannot render.
 */

import { centeredOffsetOverflow } from './geometry';

export type ImageFit = 'none' | 'contain' | 'cover' | 'fill';

export interface FitResult {
  /** Horizontal scale factor to apply to the Game Object. */
  scaleX: number;
  /** Vertical scale factor to apply to the Game Object. */
  scaleY: number;
  /** Rendered width of the image, in design pixels. */
  width: number;
  /** Rendered height of the image, in design pixels. */
  height: number;
  /** Left offset inside the box (the image is centred in both axes). */
  offsetX: number;
  /** Top offset inside the box (the image is centred in both axes). */
  offsetY: number;
}

function positive(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Computes how a `srcWidth × srcHeight` image is drawn inside a `boxWidth × boxHeight` box.
 *
 * - `none`    — natural size, centred (no scaling at all).
 * - `contain` — scaled by the smaller ratio so the whole image fits (letterboxed).
 * - `cover`   — scaled by the larger ratio so the box is filled (the overflow is centred, the caller
 *               decides whether to clip it).
 * - `fill`    — stretched independently on both axes (`scaleX`/`scaleY` differ).
 *
 * A degenerate source (zero or non-finite natural size) yields a zero-sized, centred result, so a
 * missing texture can never produce `Infinity` scales.
 */
export function computeFit(
  srcWidth: number,
  srcHeight: number,
  boxWidth: number,
  boxHeight: number,
  fit: ImageFit = 'contain',
): FitResult {
  const srcW = positive(srcWidth);
  const srcH = positive(srcHeight);
  const boxW = positive(boxWidth);
  const boxH = positive(boxHeight);

  if (srcW === 0 || srcH === 0) {
    return {
      scaleX: 1,
      scaleY: 1,
      width: 0,
      height: 0,
      offsetX: centeredOffsetOverflow(0, boxW),
      offsetY: centeredOffsetOverflow(0, boxH),
    };
  }

  let scaleX = 1;
  let scaleY = 1;

  switch (fit) {
    case 'none':
      break;
    case 'contain': {
      const scale = Math.min(boxW / srcW, boxH / srcH);
      scaleX = scale;
      scaleY = scale;
      break;
    }
    case 'cover': {
      const scale = Math.max(boxW / srcW, boxH / srcH);
      scaleX = scale;
      scaleY = scale;
      break;
    }
    case 'fill':
      scaleX = boxW / srcW;
      scaleY = boxH / srcH;
      break;
  }

  if (!Number.isFinite(scaleX) || scaleX <= 0) {
    scaleX = 0;
  }
  if (!Number.isFinite(scaleY) || scaleY <= 0) {
    scaleY = 0;
  }

  const width = srcW * scaleX;
  const height = srcH * scaleY;

  return {
    scaleX,
    scaleY,
    width,
    height,
    offsetX: centeredOffsetOverflow(width, boxW),
    offsetY: centeredOffsetOverflow(height, boxH),
  };
}
