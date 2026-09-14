/**
 * `TextArea` — a multi-line text input built on the same editing core as `TextField`.
 *
 * The differences are all line policy:
 *
 * - the bridge element is a hidden `<textarea>`, so a soft keyboard offers a return key;
 * - the value is wrapped at the content width (`wrap`, default `true`) by the widget's own wrapper,
 *   which keeps caret offsets exact — the lines drawn are the lines the caret maths uses;
 * - `rows` (default `3`) derives the default and the maximum height from the line height;
 * - vertical scrolling keeps the caret line visible inside the content box;
 * - Enter inserts a line break and Ctrl/Cmd+Enter submits, unless `submitOnEnter` swaps the two
 *   (Shift+Enter then inserts the break).
 *
 * Up/Down move the caret between lines and keep the column they started in, and a selection is
 * highlighted across every line it spans.
 *
 * The three extra options are read lazily from the option bag rather than copied into fields: the
 * base class paints once from its own constructor, and a getter is the only form that is already
 * correct at that moment.
 */

import type Phaser from 'phaser';
import { TextField, type TextFieldOptions } from './TextField';
import { heightForRows } from './text-edit';

export interface TextAreaOptions extends TextFieldOptions {
  /** Visible line count used for the default/maximum height. Defaults to `3`. */
  rows?: number;
  /** Wraps long lines at the content width. Defaults to `true`. */
  wrap?: boolean;
  /**
   * Swaps the Enter bindings: `true` makes Enter submit and Shift+Enter insert a line break, `false`
   * (the default) makes Enter insert the break and Ctrl/Cmd+Enter submit.
   */
  submitOnEnter?: boolean;
}

/** Keys `TextArea` adds on top of the ones every text input already moves out of the layout params. */
const TEXT_AREA_KEYS = ['rows', 'wrap', 'submitOnEnter'] as const;

export class TextArea extends TextField {
  constructor(scene: Phaser.Scene, options: TextAreaOptions = {}) {
    super(scene, options, TEXT_AREA_KEYS);
  }

  /** Visible line count (`rows` option). */
  get rows(): number {
    return normalizeRows(this.widgetOptions.rows);
  }

  /** Whether long lines wrap at the content width. */
  get wrapLines(): boolean {
    return this.widgetOptions.wrap !== false;
  }

  /** Whether Enter submits instead of inserting a line break. */
  get submitOnEnter(): boolean {
    return this.widgetOptions.submitOnEnter === true;
  }

  /** A text area is always multi-line. */
  protected override get multiline(): boolean {
    return true;
  }

  /** Wrapping is on unless the caller turned it off. */
  protected override get wrapsText(): boolean {
    return this.wrapLines;
  }

  /**
   * `rows × lineHeight` (plus padding) is both the default height and the maximum one: a text area
   * sized by `rows` should not silently grow past them, and a caller that wants a different box sets
   * `height`/`maxHeight` explicitly.
   */
  protected override applyDefaultHeight(): void {
    const derived = heightForRows(this.rows, this.lineHeight, this.layoutParams.padding);
    if (!this.explicitHeight) {
      this.layoutParams.height = derived;
    }
    if (this.layoutParams.maxHeight === Number.POSITIVE_INFINITY) {
      this.layoutParams.maxHeight = derived;
    }
  }

  protected override intrinsicHeight(): number {
    return heightForRows(this.rows, this.lineHeight, this.layoutParams.padding);
  }

  /** Enter submits only when asked (or with Ctrl/Cmd); Shift+Enter always inserts a break. */
  protected override submitsOnEnter(event: KeyboardEvent): boolean {
    if (event.ctrlKey || event.metaKey) {
      return true;
    }
    return this.submitOnEnter && !event.shiftKey;
  }
}

function normalizeRows(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return 3;
  }
  return Math.max(1, Math.floor(value));
}
