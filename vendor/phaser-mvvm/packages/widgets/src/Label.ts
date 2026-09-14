/**
 * `Label` — a single block of theme-styled text.
 *
 * The widget owns one `Phaser.GameObjects.Text` which is *not* a layout child: the label measures it
 * itself and positions it inside its own content box. Everything visual comes from the theme, and a
 * theme switch re-applies the style and re-truncates the lines (PLAN §4.6).
 *
 * `maxLines` + `ellipsis` are implemented on top of `text-truncate.ts`: Phaser wraps text but has no
 * line limit, so the widget asks for the wrapped lines, trims them, and writes the visible text back.
 */

import Phaser from 'phaser';
import type { BoxConstraints, LayoutParams, Rect, Size } from '@phaser-mvvm/layout';
import type { PointerChainOptionHooks, ThemeColorName, ThemeSizeName } from '@phaser-mvvm/phaser';
import { Widget } from '@phaser-mvvm/phaser';
import { toCssColor } from './color';
import { contentBox } from './geometry';
import { optionBag, splitWidgetOptions, baseWidgetOptions } from './options';
import { fontSizeOf, glyphPadding, resolveLabelFontSize } from './text-padding';
import { textMetricsOf, type SceneTextMetrics } from './text-metrics';
import { applyLineLimit, rewrapOverflowingLines } from './text-truncate';

export type LabelAlign = 'left' | 'center' | 'right';

/** Semantic text colours; every tone maps to a theme token, never to a literal. */
export type LabelTone = 'default' | 'muted' | 'danger' | 'success' | 'warning' | 'primary';

export interface LabelOptions extends LayoutParams, PointerChainOptionHooks {
  /** Initial text. `\n` starts a new line even when wrapping is off. */
  text?: string;
  /**
   * Font size: a theme size token (`'xs'`…`'xl'`, so a theme switch keeps working) or explicit pixels.
   * Defaults to `'md'`. A `style.fontSize` still wins over it.
   *
   * The compose DSL has advertised `Text('标题', { size: 'xl' })` since it landed, but the key was
   * never read — `size` existed on `Button` only — so the option was silently ignored at runtime
   * (the same shape of defect as V13).
   */
  size?: ThemeSizeName | number;
  /** Overrides merged on top of the theme style (font, colour, stroke, shadow, …). */
  style?: Phaser.Types.GameObjects.Text.TextStyle;
  /** Wrap at the available width. Defaults to `true`. */
  wrap?: boolean;
  /** Alignment inside the content box, applied to the text style and to the object's position. */
  align?: LabelAlign;
  /** Lines shown before the rest is dropped. Defaults to no limit. */
  maxLines?: number;
  /** Append `…` to the last visible line when lines are dropped. Defaults to `false`. */
  ellipsis?: boolean;
  /**
   * Canvas text cannot be selected, so only `false` is accepted. The option exists so that form
   * templates can pass `selectable: false` to every control without special-casing labels.
   */
  selectable?: false;
  /** Semantic colour of the text. Defaults to `'default'` (`theme.colors.text`). */
  tone?: LabelTone;
  name?: string;
  /** Tab order hint for the focus manager (lower first). */
  focusOrder?: number;
  /** Accessible name for the DOM mirror (see `Widget.a11yLabel`); defaults to the visible text. */
  label?: string;
}

type LabelWidgetOptions = Omit<LabelOptions, keyof LayoutParams | 'name'>;

const LABEL_KEYS = [
  'text',
  'size',
  'style',
  'wrap',
  'align',
  'maxLines',
  'ellipsis',
  'selectable',
  'tone',
] as const;

const TONE_COLORS: Record<LabelTone, ThemeColorName> = {
  default: 'text',
  muted: 'textMuted',
  danger: 'danger',
  success: 'success',
  warning: 'warning',
  primary: 'primary',
};

export class Label extends Widget {
  /** The underlying Phaser text object; exposed for advanced styling, not for layout. */
  readonly textObject: Phaser.GameObjects.Text;

  private rawText: string;
  private displayedText = '';
  private clipped = false;
  private wrap: boolean;
  private align: LabelAlign;
  private maxLines: number;
  private ellipsis: boolean;
  private tone: LabelTone;
  /** Raw `size` option: a token is resolved against the *current* theme on every repaint. */
  private readonly size: ThemeSizeName | number | undefined;
  private readonly userStyle: Phaser.Types.GameObjects.Text.TextStyle;
  /** Serialised once: it is part of both the style key and the text-metrics key. */
  private readonly userStyleKey: string;
  private wrapWidth: number | null = null;
  /**
   * Width the parent offered (measure) or assigned (arrange), or `null` while unknown.
   *
   * Only the **non-wrapping** ellipsis uses it — a wrapping label clips to `wrapWidth`, which is also
   * what Phaser wraps at. Both values come from an ancestor's constraint, never from this label's own
   * size, so feeding one back into the other cannot oscillate.
   */
  private availableWidth: number | null = null;
  private styleKey = '';
  /** Last glyph padding applied, so the canvas is only re-sized when it changes. */
  private glyphPad = -1;

  constructor(scene: Phaser.Scene, options: LabelOptions = {}) {
    const { layout, widget } = splitWidgetOptions<LabelWidgetOptions>(
      optionBag(options),
      LABEL_KEYS,
    );
    super(scene, { layout, ...baseWidgetOptions(options) });

    this.rawText = widget.text ?? '';
    this.wrap = widget.wrap !== false;
    this.align = widget.align ?? 'left';
    this.maxLines = widget.maxLines ?? Number.POSITIVE_INFINITY;
    this.ellipsis = widget.ellipsis === true;
    this.tone = widget.tone ?? 'default';
    this.size = widget.size;
    this.userStyle = widget.style ?? {};
    this.userStyleKey = JSON.stringify(this.userStyle);

    this.textObject = new Phaser.GameObjects.Text(scene, 0, 0, this.rawText, {});
    this.textObject.setOrigin(0, 0);
    this.add(this.textObject);

    this.applyThemeStyle();
    this.updateDisplayedText();
  }

  // ------------------------------------------------------------------ content

  /** The logical text (never the truncated display text). */
  getText(): string {
    return this.rawText;
  }

  /**
   * The text actually on the canvas — the logical text after wrapping and `maxLines`/`ellipsis`.
   *
   * Exists because "what the label shows" is the observable half of truncation: a check that only reads
   * `getText()` cannot tell a label that dropped three lines from one that dropped none, and the display
   * text is a layout decision (wrapping depends on the width the parent assigned).
   */
  getDisplayText(): string {
    return this.displayedText;
  }

  setText(value: string): this {
    if (this.rawText === value) {
      return this;
    }
    this.rawText = value;
    this.updateDisplayedText();
    this.markDirty();
    return this;
  }

  /** Switches the semantic colour of the text. */
  setTone(tone: LabelTone): this {
    if (this.tone === tone) {
      return this;
    }
    this.tone = tone;
    this.applyThemeStyle();
    return this;
  }

  /** True when the display text had to be clipped to satisfy `maxLines`/`ellipsis`. */
  get truncated(): boolean {
    return this.clipped;
  }

  /**
   * Changes the line limit.
   *
   * Truncation is state, not configuration: "show 2 lines" collapses a long description and "show all"
   * expands it, which is why the compose `Text()` slot accepts a `Ref` here. Re-measures, because the
   * visible height is part of the label's own size (see `measureContent`).
   */
  setMaxLines(maxLines: number): this {
    const next = Number.isFinite(maxLines)
      ? Math.max(0, Math.floor(maxLines))
      : Number.POSITIVE_INFINITY;
    if (next === this.maxLines) {
      return this;
    }
    this.maxLines = next;
    this.updateDisplayedText();
    this.markDirty();
    return this;
  }

  /** Appends (or stops appending) `…` to the last visible line when lines were dropped. */
  setEllipsis(ellipsis: boolean): this {
    const next = ellipsis === true;
    if (next === this.ellipsis) {
      return this;
    }
    this.ellipsis = next;
    this.updateDisplayedText();
    this.markDirty();
    return this;
  }

  override measureContent(constraint: BoxConstraints): Size {
    this.setWrapWidth(this.wrap ? constraint.maxWidth : null);
    this.availableWidth = Number.isFinite(constraint.maxWidth) ? constraint.maxWidth : null;
    this.updateDisplayedText();
    return { width: this.textObject.width, height: this.textObject.height };
  }

  protected override onRectChanged(rect: Rect): void {
    const box = contentBox(rect.width, rect.height, this.layoutParams.padding);
    // The engine re-measures against the final, tight constraint before `applyRect`, so this is a
    // no-op in the normal flow; it keeps the display correct for direct `applyRect` calls in tests.
    this.setWrapWidth(this.wrap && box.width > 0 ? box.width : null);
    this.availableWidth = box.width > 0 ? box.width : null;
    this.updateDisplayedText();
    this.positionText(box);
  }

  protected override refreshAppearance(): void {
    this.applyThemeStyle();
    this.updateDisplayedText();
    this.positionText(contentBox(this.rect.width, this.rect.height, this.layoutParams.padding));
  }

  // ------------------------------------------------------------------ internals

  /**
   * Theme defaults first, caller overrides last; nothing here is a literal colour.
   *
   * The style is re-applied only when it actually changes, so a state change that does not affect the
   * text (an error flag, for example) does not force a canvas text re-render.
   */
  private applyThemeStyle(): void {
    const theme = this.theme;
    const color = toCssColor(theme.colors[TONE_COLORS[this.tone]]);
    const fontSize = resolveLabelFontSize(this.size, theme.fontSize);
    // The baking ratio belongs in the key: a display whose ratio changed (a resize under `Scale.FIT`)
    // has to re-bake the glyph texture, and nothing else in this key would notice.
    const resolution = this.textResolution;
    // The caller's style overrides participate in the key: two labels with the same theme style but a
    // different `userStyle` must not share cached measurements.
    const styleKey = `${theme.name}|${theme.fontFamily}|${fontSize}|${color}|${this.align}|${resolution}|${this.userStyleKey}`;
    if (styleKey === this.styleKey) {
      return;
    }
    this.styleKey = styleKey;
    this.textObject.setStyle({
      fontFamily: theme.fontFamily,
      fontSize,
      color,
      align: this.align,
      resolution,
      ...this.userStyle,
    });
    this.applyGlyphPadding();
  }

  /**
   * Reserves the fraction of a pixel Phaser's text canvas loses to truncation and glyph overshoot.
   *
   * Without it the descender of a `g` is shaved off, and - worse - the label *measured* one pixel short
   * as well, so the layout under-reserved the space. Symmetric so the optical centre does not move.
   */
  private applyGlyphPadding(): void {
    const size = fontSizeOf(
      this.textObject.style,
      resolveLabelFontSize(this.size, this.theme.fontSize),
    );
    const pad = glyphPadding(size);
    if (pad === this.glyphPad) {
      return;
    }
    this.glyphPad = pad;
    this.textObject.setPadding(pad, pad, pad, pad);
  }

  private setWrapWidth(width: number | null): void {
    const next = width !== null && Number.isFinite(width) && width > 0 ? width : null;
    if (next === this.wrapWidth) {
      return;
    }
    this.wrapWidth = next;
    this.textObject.setWordWrapWidth(next);
  }

  /** This scene's text-metrics cache, or `null` once the widget lost its scene (destroyed). */
  private get metrics(): SceneTextMetrics | null {
    return this.scene ? textMetricsOf(this.scene) : null;
  }

  private updateDisplayedText(): void {
    const metrics = this.metrics;
    // Wrapping and the ellipsis search are the two canvas-bound steps of a label, and both are pure
    // functions of (text, style, wrap width) - so they are memoised per scene instead of re-run on every
    // measure pass (see `text-metrics.ts`).
    const lines = metrics
      ? metrics.wrappedLines(this.metricsKey(this.rawText), () =>
          this.textObject.getWrappedText(this.rawText),
        )
      : this.textObject.getWrappedText(this.rawText);
    const wrapWidth = this.wrapWidth ?? Number.POSITIVE_INFINITY;
    // Phaser breaks at spaces only, so a line that still overflows is split here (CJK has no spaces at
    // all); this runs before the line limit so `maxLines`/`ellipsis` see the real lines.
    const wrapped =
      this.wrap && Number.isFinite(wrapWidth)
        ? rewrapOverflowingLines(lines, wrapWidth, (value) => this.measureTextWidth(value))
        : lines;
    // A **non-wrapping** label still needs a width to clip *to*: `wrap: false` means "one line, no
    // reflow", not "overflow the box". `wrapWidth` is `null` there (Phaser would wrap), so the limit
    // comes from the width the parent offered/assigned instead — without it `ellipsis: true` had
    // nothing to measure against and a long single line simply overflowed its box (round 98).
    const limitWidth = this.wrap ? wrapWidth : (this.availableWidth ?? Number.POSITIVE_INFINITY);
    const result = applyLineLimit(wrapped, {
      maxLines: this.maxLines,
      ellipsis: this.ellipsis,
      maxWidth: limitWidth,
      measureWidth: (value) => this.measureTextWidth(value),
    });
    const joined = result.lines.join('\n');
    this.clipped = result.truncated;
    if (joined !== this.displayedText) {
      this.displayedText = joined;
      this.textObject.setText(joined);
    }
  }

  /**
   * Width of a candidate string with the current font, straight from the text's own canvas.
   *
   * Cached per (style, wrap width, candidate): the ellipsis search calls this `log2(length)` times per
   * line on *every* measure of a dirty label, always with the same handful of candidates.
   */
  private measureTextWidth(value: string): number {
    const metrics = this.metrics;
    const compute = (): number => {
      const context = this.textObject.context;
      this.textObject.style.syncFont(this.textObject.canvas, context);
      return context.measureText(value).width;
    };
    return metrics ? metrics.width(this.metricsKey(value), compute) : compute();
  }

  /** Identity of a measurement: the effective style, the wrap width, and the string itself. */
  private metricsKey(text: string): string {
    return `${this.styleKey}\u0001${this.wrapWidth ?? 0}\u0001${text}`;
  }

  private positionText(box: Rect): void {
    let x = box.x;
    if (this.align === 'center') {
      x = box.x + Math.max(0, (box.width - this.textObject.width) / 2);
    } else if (this.align === 'right') {
      x = box.x + Math.max(0, box.width - this.textObject.width);
    }
    this.textObject.setPosition(x, box.y);
  }
}
