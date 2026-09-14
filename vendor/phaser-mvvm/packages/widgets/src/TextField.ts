/**
 * `TextField` — a single-line, themed text input.
 *
 * The control is a panel-styled box (fill, border, focus ring, `danger` border in the error state)
 * whose text, caret and selection are drawn by the widget itself (PLAN §4.5): one
 * `Phaser.GameObjects.Text` for the visible slice of the value, two `Graphics` for the selection
 * highlight and the blinking caret.
 *
 * Input arrives through `TextInputBase`, which means the same editing state machine serves both
 * sources: the hidden DOM `<input>` bridge (ADR-0004 — IME candidates and the mobile soft keyboard)
 * and the pure-Canvas keyboard fallback used when the game has no DOM container. Everything a user
 * can do (arrows, Home/End, shift-selection, Backspace/Delete, Ctrl/Cmd+A/C/V/X, Enter, Escape) is
 * routed through that state machine, so both paths behave identically.
 *
 * Observable state for demos and end-to-end tests: `getValue()`, `getError()`, `isFocused()`,
 * `caretIndex`, `getSelection()` and the `change` event emitted for every user edit.
 */

import type Phaser from 'phaser';
import type { LayoutParams } from '@phaser-mvvm/layout';
import type { PointerChainOptionHooks } from '@phaser-mvvm/phaser';
import { TextInputBase } from './TextInputBase';

export interface TextFieldOptions extends LayoutParams, PointerChainOptionHooks {
  /** Field label; shown as the bridge's accessible name (no label widget is laid out yet). */
  label?: string;
  /** Initial value. */
  value?: string;
  /** Muted text shown while the value is empty. */
  placeholder?: string;
  /** Maximum number of characters (code points). */
  maxLength?: number;
  /**
   * Input flavour. `password` displays `•`, `number` filters everything that is not part of a number,
   * and `email`/`search` only pick the matching mobile keyboard.
   */
  inputType?: 'text' | 'number' | 'password' | 'email' | 'search';
  /** Horizontal alignment of the text. Defaults to `'left'`. */
  align?: 'left' | 'center' | 'right';
  /** Keeps the value but rejects every edit. */
  readOnly?: boolean;
  /** Starts disabled (no focus, `disabled` visual state). */
  disabled?: boolean;
  /** Paints a clickable `×` that empties the field. */
  clearable?: boolean;
  /**
   * Uses the hidden DOM input bridge when the game was created with
   * `dom: { createContainer: true }`. Defaults to `true`; `false` forces the Canvas path.
   */
  dom?: boolean;
  /** Validation run on blur; returning a string marks the field as `error` with that message. */
  validate?: (value: string) => string | null;
  /** Called after every *user* edit (not for `setValue`). */
  onChange?: (value: string, field: TextField) => void;
  /** Called on Enter. */
  onSubmit?: (value: string, field: TextField) => void;
  /** Called when the field takes the framework focus. */
  onFocus?: (field: TextField) => void;
  /** Called when the field loses focus (after validation ran). */
  onBlur?: (field: TextField) => void;
  name?: string;
  /** Tab order hint for the focus manager (lower first). */
  focusOrder?: number;
}

export class TextField extends TextInputBase {
  /** Called after every user edit. */
  onChange: ((value: string, field: TextField) => void) | null;
  /** Called on Enter (and on Ctrl/Cmd+Enter once `TextArea` reuses this class). */
  onSubmit: ((value: string, field: TextField) => void) | null;
  /** Called when the field gains focus. */
  onFocusField: ((field: TextField) => void) | null;
  /** Called when the field loses focus. */
  onBlurField: ((field: TextField) => void) | null;

  constructor(
    scene: Phaser.Scene,
    options: TextFieldOptions = {},
    /** Internal extension point: option keys a subclass must move out of the layout params. */
    extraKeys: readonly string[] = [],
  ) {
    super(scene, options, extraKeys);

    this.onChange = options.onChange ?? null;
    this.onSubmit = options.onSubmit ?? null;
    this.onFocusField = options.onFocus ?? null;
    this.onBlurField = options.onBlur ?? null;

    this.applyDefaultHeight();
    this.refreshAppearance();
  }

  /** A single line never wraps. */
  protected override get wrapsText(): boolean {
    return false;
  }

  /** Default height is the theme's medium control height; a taller box centres the line. */
  protected override applyDefaultHeight(): void {
    if (!this.explicitHeight) {
      this.layoutParams.height = this.theme.controlHeight.md;
    }
  }

  protected override intrinsicHeight(): number {
    return this.theme.controlHeight.md;
  }

  // ------------------------------------------------------------------ callbacks

  protected override notifyChange(value: string): void {
    this.onChange?.(value, this);
  }

  protected override notifySubmit(value: string): void {
    this.onSubmit?.(value, this);
  }

  protected override notifyFocus(): void {
    this.onFocusField?.(this);
  }

  protected override notifyBlur(): void {
    this.onBlurField?.(this);
  }
}
