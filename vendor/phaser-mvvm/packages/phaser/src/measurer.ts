/**
 * Text measurement with an LRU cache.
 *
 * `Widget.measureContent()` is called during the layout measure pass, which is cached per
 * (constraint, revision) — but every *revision* still re-measures every text. `PhaserTextMeasurer`
 * keeps one hidden `Text` probe and memoises results, so re-measuring an unchanged string (the
 * common case in a form or a list that only re-orders) costs a map lookup instead of a canvas
 * layout pass. PLAN §8 budgets a > 95 % hit rate for form-heavy UIs.
 *
 * The probe is a real `Phaser.GameObjects.Text`, so wrapped width, `letterSpacing`, `lineSpacing`
 * and `padding` all behave exactly as they will at render time.
 */

import Phaser from 'phaser';
import { LruCache } from '@phaser-mvvm/core';
import type { Size } from '@phaser-mvvm/layout';

// Re-exported so existing consumers keep their import; the implementation lives in `core` so the
// widget packages can cache without pulling Phaser (and therefore without a renderer) in.
export { LruCache };

export interface TextMeasureRequest {
  text: string;
  fontFamily?: string;
  fontSize?: number;
  fontStyle?: string;
  color?: string;
  letterSpacing?: number;
  lineSpacing?: number;
  /** Enables word wrapping at this width (in design pixels). */
  wordWrapWidth?: number;
  align?: 'left' | 'center' | 'right' | 'justify';
  padding?: number;
  useAdvancedWrap?: boolean;
}

export interface MeasuredText extends Size {
  /** Number of wrapped lines; `1` when no wrapping is configured. */
  lines: number;
}

/** Builds the cache key of a request; style and text are both part of the identity. */
export function textMeasureKey(request: TextMeasureRequest): string {
  return [
    request.text,
    request.fontFamily ?? '',
    request.fontSize ?? '',
    request.fontStyle ?? '',
    request.color ?? '',
    request.letterSpacing ?? '',
    request.lineSpacing ?? '',
    request.wordWrapWidth ?? '',
    request.align ?? '',
    request.padding ?? '',
    request.useAdvancedWrap === true ? 'a' : '',
  ].join('\u0001');
}

export interface TextMeasurer {
  measure(request: TextMeasureRequest): MeasuredText;
  clear(): void;
  readonly stats: { hits: number; misses: number; size: number };
}

export interface PhaserTextMeasurerOptions {
  /** Probe resolution; `1` is enough because measurement is in design pixels. */
  resolution?: number;
  maxEntries?: number;
}

export class PhaserTextMeasurer implements TextMeasurer {
  private readonly probe: Phaser.GameObjects.Text;
  private readonly cache: LruCache<string, MeasuredText>;
  private readonly counters = { hits: 0, misses: 0 };
  private styleKey = '';

  constructor(scene: Phaser.Scene, options: PhaserTextMeasurerOptions = {}) {
    this.probe = new Phaser.GameObjects.Text(scene, 0, 0, '', {});
    this.probe.setVisible(false);
    this.probe.setResolution(options.resolution ?? 1);
    this.cache = new LruCache<string, MeasuredText>(options.maxEntries ?? 512);
  }

  measure(request: TextMeasureRequest): MeasuredText {
    const key = textMeasureKey(request);
    const cached = this.cache.get(key);
    if (cached) {
      this.counters.hits++;
      return cached;
    }

    this.counters.misses++;
    this.applyStyle(request);
    this.probe.setText(request.text);
    this.probe.setWordWrapWidth(
      request.wordWrapWidth !== undefined && request.wordWrapWidth > 0 ? request.wordWrapWidth : 0,
      request.useAdvancedWrap === true,
    );

    const lines =
      request.wordWrapWidth !== undefined && request.wordWrapWidth > 0
        ? Math.max(1, this.probe.getWrappedText(request.text).length)
        : Math.max(1, request.text.split('\n').length);

    const measured: MeasuredText = {
      width: this.probe.width,
      height: this.probe.height,
      lines,
    };

    this.cache.set(key, measured);
    return measured;
  }

  clear(): void {
    this.cache.clear();
  }

  get stats(): { hits: number; misses: number; size: number } {
    return { ...this.counters, size: this.cache.size };
  }

  /** Drops the probe (call on scene shutdown; the probe is not on the display list). */
  destroy(): void {
    this.cache.clear();
    this.probe.destroy();
  }

  private applyStyle(request: TextMeasureRequest): void {
    const nextKey = textMeasureKey({ ...request, text: '' });
    if (nextKey === this.styleKey) {
      return;
    }
    this.styleKey = nextKey;
    this.probe.setStyle({
      fontFamily: request.fontFamily,
      fontSize: request.fontSize !== undefined ? `${request.fontSize}px` : undefined,
      fontStyle: request.fontStyle,
      color: request.color,
      letterSpacing: request.letterSpacing,
      lineSpacing: request.lineSpacing,
      align: request.align,
      padding:
        request.padding !== undefined ? { x: request.padding, y: request.padding } : undefined,
    });
  }
}
