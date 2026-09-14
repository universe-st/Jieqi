/**
 * `VirtualKeyboard` — an on-screen keyboard for players who have no keyboard (PLAN M9's 手柄文本输入).
 *
 * A gamepad can move focus, activate buttons and press `back`, but it cannot type. Every console UI
 * answers that with a keyboard drawn on the screen, and this is that: a panel of ordinary `Button`s
 * arranged in rows, writing into a `TextInputBase` through the **same** path a keystroke takes
 * (`insertText`/`deleteText`), so `maxLength`, numeric filtering, sanitising and the change event all
 * behave exactly as they do when the player types on a real keyboard.
 *
 * ```ts
 * const field = TextField({ label: '玩家名', width: 260 });
 * VirtualKeyboard({ target: () => field, onSubmit: () => this.submit() });
 * ```
 *
 * Why buttons and not a custom widget: everything a text entry needs is already in the framework once
 * the keys are focusable controls — `Tab`/D-Pad/arrow navigation walks them, the gamepad's `A`
 * activates them, the pointer hovers and clicks them, the accessibility mirror announces them (each
 * key carries a `label`, so the reader says "delete" rather than "key.backspace"), and the focus ring
 * and pressed states come from the theme. The keyboard itself therefore has almost no behaviour: it
 * maps a key name to an action.
 *
 * Deliberately **not** an IME: a player who needs Chinese/Japanese input uses the real keyboard path
 * (the DOM bridge, ADR-0004). This widget exists for the case where there is no real keyboard at all.
 */

import Phaser from 'phaser';
import { BoxWidget, type FocusTarget, type Widget } from '@phaser-mvvm/phaser';
import { Button } from './Button';
import { Panel, type PanelOptions } from './Panel';
import type { TextInputBase } from './TextInputBase';
import {
  afterTyping,
  CASE_OFF,
  describeSlot,
  type CaseState,
  KEY_GAP,
  type KeySlot,
  type KeyboardPage,
  keyboardRows,
  keyWidth,
  labelFor,
  pageOf,
  pressShift,
  type VirtualKeyboardKind,
} from './keyboard-plan';

export type { KeySlot, KeyboardPage, VirtualKeyboardKind };

export interface VirtualKeyboardOptions extends PanelOptions {
  /**
   * The field the keys write into.
   *
   * A getter rather than the field itself, because a keyboard is usually written before the field it
   * serves (and because a page may swap fields under one keyboard). `null` means "nothing focused
   * yet": keys then do nothing, which is also what happens when the field is disabled or read-only.
   */
  target: () => TextInputBase | null;
  /**
   * Which key set to show.
   *
   * The widget **rebuilds its own keys** when this changes — the DSL accepts a literal or a reactive
   * source (`kind: () => this.kind.value`), and there is no second construction path to keep in step:
   * `onSubmit`/`onChange`/`target` belong to the keyboard, not to a particular key set. This is the
   * `#/keyboard` page's "切到数字键盘" button, and it is why switching cannot silently drop an option
   * (round 81 V48 was exactly that, and this shape makes it unrepresentable).
   */
  kind?: VirtualKeyboardKind;
  /** Called when the Enter key is pressed. */
  onSubmit?: () => void;
  /** Called after every edit the keys produced (so a page can refresh its own readouts). */
  onChange?: () => void;
  /** Debug name prefix for the keys. Defaults to `keyboard`. */
  name?: string;
}

export class VirtualKeyboardWidget extends Panel {
  private readonly targetOf: () => TextInputBase | null;
  private kind: VirtualKeyboardKind;
  private readonly onSubmitCallback: (() => void) | undefined;
  private readonly onChangeCallback: (() => void) | undefined;
  private readonly keyWidgets = new Map<string, { widget: Widget; slot: KeySlot }>();

  /** Shift state: one press is a one-shot, two presses lock the case (`keyboard-plan.ts`). */
  private caseState: CaseState = CASE_OFF;
  /** Which character page the text keyboard shows. */
  private symbols = false;
  /** Bumped on every rebuild; see `revision`. */
  private revisionCount = 0;

  constructor(scene: Phaser.Scene, options: VirtualKeyboardOptions) {
    const { target, kind, onSubmit, onChange, name, ...panel } = options;
    super(scene, {
      direction: 'vertical',
      gap: 6,
      padding: 10,
      variant: 'surfaceAlt',
      radius: 12,
      ...panel,
      name: name ?? 'keyboard',
    });
    this.targetOf = target;
    this.kind = kind ?? 'text';
    this.onSubmitCallback = onSubmit;
    this.onChangeCallback = onChange;

    // The keys are real widgets owned by this one, built here rather than by a caller-provided lambda:
    // a keyboard that can change its own key set (`kind`) must be able to rebuild them *itself*, at any
    // time, with or without a build pass around it. Drawing them through the DSL would hand that job to
    // whoever called `VirtualKeyboard()`, and a rebuild from a click handler (the common case) has no
    // build scope at all — round 81's V48 was exactly that trap.
    this.drawKeys();
  }

  /**
   * Switches the key set, rebuilding the keys — the reactive half of `kind`.
   *
   * Idempotent for the same kind, so a reactive `kind: () => ref.value` slot can call it on every
   * change without knowing whether anything moved. Focus is restored onto the same key when that key
   * exists on the new page (`enter` and `backspace` are on both), and onto the first key when it does
   * not — a player must never be left with a keyboard that has no focus in it.
   */
  setKind(kind: VirtualKeyboardKind): boolean {
    if (kind === this.kind) {
      return false;
    }
    const held = this.focusedKeyId();
    const manager = this.focusManagerOfKeys();
    this.kind = kind;
    this.symbols = false;
    this.drawKeys();
    this.restoreFocus(held, manager);
    return true;
  }

  /**
   * How many times the key widgets have been (re)built.
   *
   * A page or kind switch destroys the old keys and builds new ones, so anything holding a key
   * reference — a probe table, a check walking `keyOf(id)` — has to know when its references went
   * stale. A counter says that without diffing the keys. (`keyRevision`, not `revision`: the base
   * widget already uses `revision` for the layout engine's dirty tracking.)
   */
  get keyRevision(): number {
    return this.revisionCount;
  }

  /** The first key of the current page — where focus lands when the key it was on is gone. */
  private firstKeyId(): string {
    return this.keyWidgets.keys().next().value ?? '';
  }

  /** The id of the key that currently holds framework focus, or `null`. */
  private focusedKeyId(): string | null {
    for (const [id, entry] of this.keyWidgets) {
      if (entry.widget.focused) {
        return id;
      }
    }
    return null;
  }

  /**
   * The focus manager, taken from a key rather than from `this`.
   *
   * A keyboard is a container, not a control: `Widget#focusManager` is only set on widgets the focus
   * manager collects, and this panel is not focusable, so `this.focusManager` is always `null` here.
   * Its keys are focusable, so one of them knows the manager.
   */
  private focusManagerOfKeys(): FocusTarget | null {
    for (const entry of this.keyWidgets.values()) {
      if (entry.widget.focusManager) {
        return entry.widget.focusManager;
      }
    }
    return null;
  }

  /**
   * Puts focus back on the same key id after a rebuild, or on the first key when it is gone.
   *
   * The `refresh()` is not optional: `FocusManager.focus()` only accepts a widget of the scope's
   * *collection*, and that collection still describes the keys this rebuild just destroyed — so without
   * it the call is silently ignored and a gamepad player is left with nothing focused at all. The
   * re-collection is what the plugin does for any structural change anyway; doing it here only means the
   * new keys are known (and have their manager back-reference) before focus lands on one of them.
   */
  private restoreFocus(held: string | null, manager: FocusTarget | null): void {
    if (held === null || !manager) {
      return;
    }
    const target = this.keyOf(this.keyWidgets.has(held) ? held : this.firstKeyId());
    if (!target) {
      return;
    }
    manager.refresh?.();
    target.focus();
  }

  /**
   * Builds the rows and the keys for the current page.
   *
   * Destroying and rebuilding is the honest implementation of "the key set changed": the symbols page
   * has no shift key and the numpad has no letters, so a page that only re-labelled its keys would show
   * a `⇧` that does nothing and keep a `q` on the numpad. The rows are `BoxWidget`s and the keys are
   * `ButtonWidget`s created here (not through the DSL) so this can run at *any* time — inside the page's
   * build pass, from a click handler, or from a reactive `kind` slot — with no build scope involved.
   */
  private drawKeys(): void {
    this.removeAllWidgets(true);
    this.keyWidgets.clear();
    this.revisionCount += 1;

    for (const row of keyboardRows(this.kind, this.page)) {
      const line = new BoxWidget(this.scene, {
        direction: 'horizontal',
        gap: KEY_GAP,
        justifyContent: 'center',
      });
      this.scene.add.existing(line);
      this.addWidget(line);

      for (const slot of row) {
        const key = describeSlot(slot, this.page, this.caseState.upper);
        const button = new Button(this.scene, {
          text: key.label,
          name: `${this.name}.${slot.id}`,
          size: 'sm',
          variant: key.primary ? 'primary' : 'secondary',
          width: keyWidth(key.weight),
          ...(key.a11yLabel ? { label: key.a11yLabel } : {}),
          onClick: () => this.activateSlot(slot),
        });
        this.scene.add.existing(button);
        line.addWidget(button);
        this.keyWidgets.set(slot.id, { widget: button, slot });
      }
    }
  }

  /**
   * The key layout for the current page: rows of slots.
   *
   * Public because the DSL builder (and a check that wants to know what is on screen) needs it; the
   * slots never change identity afterwards — a page or case switch only re-labels them, because
   * destroying and rebuilding the keys would drop focus on the key the player was about to press.
   */
  slots(): readonly (readonly KeySlot[])[] {
    return keyboardRows(this.kind, this.page);
  }

  /** The action of one slot (the DSL's `onClick`). */
  activateSlot(slot: KeySlot): boolean {
    return this.runSlot(slot);
  }

  /** The key ids this keyboard exposes, in reading order (a check walks this list). */
  get keys(): readonly string[] {
    return [...this.keyWidgets.keys()];
  }

  /** The widget behind one key id, or `null`. */
  keyOf(id: string): Widget | null {
    return this.keyWidgets.get(id)?.widget ?? null;
  }

  /** What the keyboard is showing: the page and the case (one-shot upper vs. locked upper). */
  get appearance(): {
    kind: VirtualKeyboardKind;
    page: KeyboardPage;
    upper: boolean;
    capsLock: boolean;
  } {
    return {
      kind: this.kind,
      page: this.page,
      upper: this.caseState.upper,
      capsLock: this.caseState.capsLock,
    };
  }

  /** The page the text keyboard is on; `'numeric'` for the numpad kind. */
  private get page(): KeyboardPage {
    return pageOf(this.kind, this.symbols);
  }

  /** The label a key shows right now (what the player sees, and what `keyFor` matches on). */
  labelOf(id: string): string {
    const entry = this.keyWidgets.get(id);
    return entry ? labelFor(entry.slot, this.page, this.caseState.upper) : '';
  }

  /** The key id whose current label is `char` — the way a check or a macro finds a letter to press. */
  keyFor(char: string): string | null {
    for (const [id, entry] of this.keyWidgets) {
      if (labelFor(entry.slot, this.page, this.caseState.upper) === char) {
        return id;
      }
    }
    return null;
  }

  /**
   * Runs a key's action, exactly as activating it would.
   *
   * Public because a check (and a "type this word" macro) wants to send one key without hunting for its
   * widget — but it is the same code path as the button's own `onClick`, including the sanitising the
   * field applies to every insert.
   */
  press(id: string): boolean {
    const entry = this.keyWidgets.get(id);
    return entry ? this.runSlot(entry.slot) : false;
  }

  /** Types one character by finding the key that shows it (returns `false` when it is on another page). */
  typeChar(char: string): boolean {
    const id = this.keyFor(char);
    return id === null ? false : this.press(id);
  }

  /** Runs one slot's action against the target field. */
  private runSlot(slot: KeySlot): boolean {
    const field = this.targetOf();
    switch (slot.command) {
      case 'case':
        this.caseState = pressShift(this.caseState);
        this.relabel();
        return true;
      case 'page': {
        // A different page is a different *key set* (the symbols page has no shift key), so this is a
        // rebuild rather than a relabel — the plan and the widget have to agree on what is on screen.
        const held = this.focusedKeyId() ?? slot.id;
        const manager = this.focusManagerOfKeys();
        this.symbols = !this.symbols;
        this.drawKeys();
        this.restoreFocus(held, manager);
        return true;
      }
      case 'enter':
        this.onSubmitCallback?.();
        return true;
      case 'backspace':
        if (!field) {
          return false;
        }
        field.deleteText('backward');
        this.onChangeCallback?.();
        return true;
      case 'space':
        if (!field) {
          return false;
        }
        field.insertText(' ');
        this.typed();
        return true;
      default: {
        if (!field) {
          return false;
        }
        const char = labelFor(slot, this.page, this.caseState.upper);
        if (char.length === 0) {
          return false;
        }
        field.insertText(char);
        this.typed();
        return true;
      }
    }
  }

  /**
   * A character went into the field: release a one-shot shift, keep a locked one.
   *
   * Both insert paths (a character key and space) go through here, because shift applies to the *next
   * character* however it is produced; a backspace or Enter does not consume it.
   */
  private typed(): void {
    const next = afterTyping(this.caseState);
    if (next !== this.caseState) {
      this.caseState = next;
      this.relabel();
    }
    this.onChangeCallback?.();
  }

  /** Re-labels every key in place (see the note where the keys are built). */
  private relabel(): void {
    for (const entry of this.keyWidgets.values()) {
      const button = entry.widget as { setText?: (text: string) => void };
      button.setText?.(labelFor(entry.slot, this.page, this.caseState.upper));
    }
  }
}
