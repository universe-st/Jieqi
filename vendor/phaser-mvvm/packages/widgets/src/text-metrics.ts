/**
 * Per-scene cache for the canvas text work the widgets would otherwise redo on every measure pass.
 *
 * `Widget.measureContent()` runs inside the layout measure pass. The engine caches whole measurements by
 * (constraint, percent base, revision), but **every revision re-measures every text in the subtree**,
 * and each of those re-measurements used to call straight into the canvas:
 *
 * - `Label` re-wrapped its text (`Text#getWrappedText`) and then binary-searched candidate prefixes
 *   through `context.measureText` for `maxLines`/`ellipsis`;
 * - `TextInputBase` measured candidate strings the same way for caret placement and truncation.
 *
 * Both are pure functions of (text, style, wrap width), so this module memoises their *results*. It
 * deliberately caches the answers of the widget's **own** canvas instead of measuring through a probe
 * `Text`: the numbers then cannot diverge from what the widget renders, whatever extras a caller put in
 * `style` (stroke, shadow, padding, resolution).
 *
 * The cache holds only strings and numbers and is keyed by the scene in a `WeakMap`, so it needs no
 * teardown: destroying the scene releases it.
 *
 * PLAN §8 budgets a hit rate above 95 % for form-heavy UIs; `textMetricsStats` reports the counters so a
 * scene can publish them and a check can assert the rate (see `docs/ACCEPTANCE-performance.md`).
 */

import { LruCache } from '@phaser-mvvm/core';

/** Counters of one scene's cache, in the shape the PLAN §8 budget talks about. */
export interface TextMetricsStats {
  hits: number;
  misses: number;
  /** Cached values currently held (lines + widths). */
  size: number;
  hitRate: number;
}

export interface SceneTextMetrics {
  /**
   * Wrapped lines of `text` at `wrapWidth`, computed by `compute` on a miss.
   *
   * The returned array belongs to the cache: callers must treat it as read-only.
   */
  wrappedLines(key: string, compute: () => string[]): readonly string[];
  /** Width in design pixels, computed by `compute` on a miss. */
  width(key: string, compute: () => number): number;
  readonly stats: TextMetricsStats;
  clear(): void;
}

/** Entries per scene; a form or a long list stays far below this. */
const MAX_ENTRIES = 1024;

class SceneTextMetricsImpl implements SceneTextMetrics {
  private readonly lines = new LruCache<string, readonly string[]>(MAX_ENTRIES);
  private readonly widths = new LruCache<string, number>(MAX_ENTRIES);
  private readonly counters = { hits: 0, misses: 0 };

  wrappedLines(key: string, compute: () => string[]): readonly string[] {
    const cached = this.lines.get(key);
    if (cached !== undefined) {
      this.counters.hits++;
      return cached;
    }
    this.counters.misses++;
    const lines = compute();
    this.lines.set(key, lines);
    return lines;
  }

  width(key: string, compute: () => number): number {
    const cached = this.widths.get(key);
    if (cached !== undefined) {
      this.counters.hits++;
      return cached;
    }
    this.counters.misses++;
    const width = compute();
    this.widths.set(key, width);
    return width;
  }

  get stats(): TextMetricsStats {
    const { hits, misses } = this.counters;
    const total = hits + misses;
    return {
      hits,
      misses,
      size: this.lines.size + this.widths.size,
      hitRate: total === 0 ? 1 : hits / total,
    };
  }

  clear(): void {
    this.lines.clear();
    this.widths.clear();
  }
}

const caches = new WeakMap<object, SceneTextMetricsImpl>();

/** The cache of one scene (widgets pass `this.scene`). Created on first use. */
export function textMetricsOf(scene: object): SceneTextMetrics {
  let cache = caches.get(scene);
  if (cache === undefined) {
    cache = new SceneTextMetricsImpl();
    caches.set(scene, cache);
  }
  return cache;
}

/** Counters of one scene, or `null` when the scene never measured anything (gates and tests). */
export function textMetricsStats(scene: object): TextMetricsStats | null {
  return caches.get(scene)?.stats ?? null;
}

/** Drops the cached measurements of a scene (theme/font changes that keep the same style key). */
export function clearTextMetrics(scene: object): void {
  caches.get(scene)?.clear();
}
