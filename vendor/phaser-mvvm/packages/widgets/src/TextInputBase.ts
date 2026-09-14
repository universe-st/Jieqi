/**
 * `TextInputBase` — the shared machinery of `TextField` and `TextArea`.
 *
 * Both controls are the same thing with a different line policy, so every decision that is not
 * "how do the lines flow" lives here:
 *
 * - a panel-like background painted from the theme (`ProceduralSkin`, `danger` border for the error
 *   state, focus ring for keyboard focus) — PLAN §4.5, §10.3 and zero art assets;
 * - one `Phaser.GameObjects.Text` per visible line inside the content box, which is what lets the
 *   widget place a caret, a selection and a scroll offset *exactly* instead of guessing how Phaser
 *   laid the text out on its own canvas;
 * - the editing state machine (`value`/`caret`/`anchor`/`scroll`/validation) driven by the pure
 *   functions of `text-edit.ts`;
 * - two input sources that end in the same place: the hidden DOM bridge (ADR-0004, the path that
 *   gets IME and a soft keyboard) and a keyboard fallback for scenes without a DOM container.
 *
 * The widget never installs a *global* listener that could fight another control: the Canvas
 * fallback only listens while this field holds the framework focus, and the Phaser keyboard listener
 * is filtered on `focused` as well.
 */

import Phaser from 'phaser';
import type { BoxConstraints, LayoutParams, Rect, Size } from '@phaser-mvvm/layout';
import type { Theme } from '@phaser-mvvm/phaser';
import {
  ProceduralSkin,
  claimPointerDrag,
  pointerClaims,
  pointerDragOwner,
  releasePointerDrag,
  stageRectOf,
  Widget,
} from '@phaser-mvvm/phaser';
import type { A11yDescriptor, PointerChainOptionHooks, WidgetState } from '@phaser-mvvm/phaser';
import { paintFocusRing, textInputSkinStyles } from './appearance';
import { toCssColor } from './color';
import { contentBox } from './geometry';
import { DomInputBridge, clampSelection, type InputBridgeHandlers } from './input-bridge';
import { optionBag, splitWidgetOptions, baseWidgetOptions } from './options';
import { glyphPadding } from './text-padding';
import { textMetricsOf } from './text-metrics';
import {
  CARET_BLINK_MS,
  MIN_CONTENT_WIDTH,
  canEditValue,
  caretAtX,
  charIndexAtX,
  caretRectOf,
  clampCaret,
  clampScrollY,
  computeLineHeight,
  computeScrollX,
  computeScrollY,
  deleteRange,
  displayOffset,
  displaySlice,
  displayValue,
  dragAutoScrollStep,
  edgeOverflow,
  insertText,
  layoutTextLines,
  lineEndAt,
  lineRangeAt,
  lineStartAt,
  moveCaret,
  moveCaretVertically,
  positionLines,
  sanitizeValue,
  selectedText,
  selectionRange,
  wordRangeAt,
  selectionRects,
  valueOffsetFromDisplay,
  visibleTextWindow,
  widestLine,
  type EditResult,
  type LayoutLine,
  type TextInputAlign,
  type TextInputType,
  type TextRange,
} from './text-edit';

/** Options every text input understands, whatever its line policy. */
export interface TextInputOptions extends LayoutParams, PointerChainOptionHooks {
  /** Field label; used as the accessible name of the DOM bridge. */
  label?: string;
  /** Initial value. */
  value?: string;
  /** Shown (muted) while the value is empty. */
  placeholder?: string;
  /** Maximum number of characters; counts code points, so an emoji is never cut in half. */
  maxLength?: number;
  /** Input flavour. `password` masks the text, `number` filters it. */
  inputType?: TextInputType;
  /** Horizontal alignment of the text inside the box. Defaults to `'left'`. */
  align?: TextInputAlign;
  /** Keeps the text but rejects every edit. */
  readOnly?: boolean;
  /** Starts disabled; the field cannot be focused and paints the `disabled` state. */
  disabled?: boolean;
  /** Shows a clickable `×` that empties the field. */
  clearable?: boolean;
  /**
   * Uses the hidden DOM `<input>`/`<textarea>` bridge when the game has a DOM container (ADR-0004).
   * Defaults to `true`; `false` forces the pure-Canvas path (English/number-only forms, hosts without
   * `dom: { createContainer: true }`).
   */
  dom?: boolean;
  /** Returns an error message for a value, or `null`. Runs on blur and on demand. */
  validate?: (value: string) => string | null;
  name?: string;
  /** Tab order hint for the focus manager (lower first). */
  focusOrder?: number;
}

/**
 * The widget-level half of the option bag, after the layout params were split off.
 *
 * Declared as a type alias (not an interface) so it keeps an implicit index signature and can be used
 * as the `W` of `splitWidgetOptions`.
 */
export type TextInputWidgetOptions = {
  label?: string;
  value?: string;
  placeholder?: string;
  maxLength?: number;
  inputType?: TextInputType;
  align?: TextInputAlign;
  readOnly?: boolean;
  disabled?: boolean;
  clearable?: boolean;
  dom?: boolean;
  validate?: (value: string) => string | null;
  rows?: number;
  wrap?: boolean;
  submitOnEnter?: boolean;
};

/** Keys that must be moved out of the layout params for every text input. */
export const TEXT_INPUT_KEYS = [
  'label',
  'value',
  'placeholder',
  'maxLength',
  'inputType',
  'align',
  'readOnly',
  'disabled',
  'clearable',
  'dom',
  'validate',
  // The callbacks. `TextField`/`TextArea` read them straight off the option bag, so they have always
  // worked — but they were missing from this list, which means `splitOptions()` filed them under
  // *layout* params and the option audit reported every one of them as an unknown key (found in round 87
  // by the first page that passed `onSubmit` to a `TextArea`: `#/options`). A working option that the
  // framework's own audit calls a typo is worse than no audit.
  'onChange',
  'onSubmit',
  'onFocus',
  'onBlur',
] as const;

/** Events a text input emits on the Phaser emitter. */
export const TEXT_INPUT_EVENTS = {
  /**
   * Fired with the new value whenever the value changes.
   *
   * This is the channel a model binding listens on (`bindModel` writes the value back to the source),
   * so **any** committed change reaches it — including a programmatic `setValue`, because a two-way
   * `ref` that is not told about a programmatic write would keep a stale value and silently disagree
   * with what the player sees. What stays user-only is the `onChange` *option* (see
   * {@link TextInputBase.setValue}).
   */
  CHANGE: 'change',
  /** Fired when the user submits (Enter, or Ctrl/Cmd+Enter in a text area). */
  SUBMIT: 'submit',
} as const;

/** Opacity of the selection highlight. */
/** Two presses count as a double click when they land within this window… */
const DOUBLE_CLICK_MS = 400;
/** …and within this distance, in design pixels. */
const DOUBLE_CLICK_SLOP = 6;
const SELECTION_ALPHA = 0.35;

/** Number of line objects kept alive before the pool grows on demand. */
const MIN_LINE_POOL = 4;

export abstract class TextInputBase extends Widget {
  /** Input flavour; `password` masks the display and `number` filters the value. */
  readonly inputType: TextInputType;
  /** Horizontal alignment of the text. */
  readonly align: TextInputAlign;
  /** Character limit (`null` = unlimited). Counted in code points. */
  readonly maxLength: number | null;
  /** Whether edits are rejected. Mutable through {@link TextInputBase.setReadOnly}. */
  readOnly: boolean;
  /** Whether a clear button is painted and clickable. */
  readonly clearable: boolean;
  /** Placeholder shown while the value is empty. */
  readonly placeholder: string;
  /** Field label; doubles as the bridge's accessible name. */
  readonly label: string;
  /** Whether the DOM bridge was requested at all (`dom: false` turns it off). */
  readonly domRequested: boolean;

  /** Parse result of the mixed option bag; subclasses read their own keys from it. */
  protected readonly widgetOptions: TextInputWidgetOptions;
  /** True when `options.height` was given, which disables the derived default height. */
  protected readonly explicitHeight: boolean;

  protected readonly validateFn: ((value: string) => string | null) | null;

  private readonly backgroundGraphics: Phaser.GameObjects.Graphics;
  private readonly selectionGraphics: Phaser.GameObjects.Graphics;
  private readonly clearGraphics: Phaser.GameObjects.Graphics;
  private readonly caretGraphics: Phaser.GameObjects.Graphics;
  private readonly lineObjects: Phaser.GameObjects.Text[] = [];
  private readonly bridge: DomInputBridge | null;
  private readonly usingDomBridge: boolean;

  private value = '';
  private caret = 0;
  private anchor = 0;
  private scrollX = 0;
  private scrollY = 0;
  private columnHint = -1;
  private errorMessage: string | null = null;
  private compositionActive = false;
  private caretVisible = false;
  private blinkTimer: Phaser.Time.TimerEvent | null = null;
  private lastFocused = false;
  private valueAtFocus: string | null = null;
  private textStyleKey = '';
  private displayLines: LayoutLine[] = [];
  private contentOffsetY = 0;
  private clearHotspot = 0;
  private keyGuardInstalled = false;
  private lastConsumedEvent: KeyboardEvent | null = null;
  private skinCache: { theme: Theme; skin: ProceduralSkin } | null = null;
  /**
   * The pointer of the drag this field owns, or `null` when it owns none.
   *
   * Kept as the pointer itself rather than its id because the per-frame auto-scroll has to read the
   * position of *this* drag every frame, and a pointer id would have to be looked up again.
   */
  private dragPointer: Phaser.Input.Pointer | null = null;
  /**
   * True while the drag is held past the edge of the content box, so the drag — not the caret — owns
   * the scroll offset (see {@link TextInputBase.updateScroll}).
   */
  private autoScrolling = false;

  /**
   * Measured text width in design pixels, straight from a line object's canvas.
   *
   * Cached per (style, text) in the scene's text-metrics cache: caret placement, windowing and
   * truncation all measure the same candidate strings again on every repaint and every measure pass.
   */
  private readonly measureWidth = (text: string): number => {
    if (text.length === 0) {
      return 0;
    }
    const compute = (): number => {
      const probe = this.probeObject();
      probe.style.syncFont(probe.canvas, probe.context);
      return probe.context.measureText(text).width;
    };
    const scene = this.scene;
    return scene === undefined || scene === null
      ? compute()
      : textMetricsOf(scene).width(`${this.textStyleKey}\u0001${text}`, compute);
  };

  // The Canvas fallback reads keys from a capture-phase listener on `window` while this field holds
  // the focus: consuming a key there keeps the framework's own arrow-key navigation (the scene
  // plugin) from moving the focus away while the user is editing.
  private readonly windowKeyGuard = (event: KeyboardEvent): void => {
    if (!this.focused || !this.enabled || this.usingDomBridge) {
      return;
    }
    if (this.handleKeyEvent(event)) {
      this.lastConsumedEvent = event;
      event.stopPropagation();
    }
  };

  // The scene plugin forwards the *same* native event; the dedupe below is what keeps a key that the
  // guard already applied from being applied twice when `stopPropagation` did not reach the plugin.
  private readonly phaserKeyDown = (event: KeyboardEvent): void => {
    if (event === this.lastConsumedEvent || this.usingDomBridge) {
      return;
    }
    if (!this.focused || !this.enabled) {
      return;
    }
    this.handleKeyEvent(event);
  };

  private readonly handleResize = (): void => {
    this.placeBridge();
  };

  /**
   * How many clicks this press is, and where/when the previous one landed.
   *
   * Phaser hands the widget a pointer, not a DOM `MouseEvent`, so there is no `detail` to read: the
   * count is derived from the time and distance to the previous press. Both windows are generous
   * (400 ms, 6 px) because the two clicks of a double click are rarely identical.
   */
  private clickCount = 0;
  private lastClickAt = 0;
  private lastClickX = Number.NaN;
  private lastClickY = Number.NaN;

  private readonly handlePointerDown = (pointer: Phaser.Input.Pointer): void => {
    if (!this.enabled) {
      return;
    }
    const local = this.localPoint(pointer.worldX, pointer.worldY);
    if (this.showsClearButton() && local.x >= this.rect.width - this.clearHotspot) {
      this.setValue('');
      return;
    }
    if (this.readOnly) {
      return;
    }
    // The press belongs to this field: a drag that follows is a *selection*, not a scroll. The claim is
    // made here and read by every enclosing `ScrollView` when it is about to move (see `pointer-claim`),
    // which makes the order of the two `pointerdown` handlers irrelevant. The DOM path does not claim:
    // the hidden element sits above the canvas and the browser does the selecting itself.
    if (!this.usingDomBridge) {
      claimPointerDrag(this.scene, pointer.id, this);
      this.dragPointer = pointer;
    }
    const count = this.countClick(pointer);
    if (count >= 2 && this.selectUnitAt(local.x, local.y, count)) {
      return;
    }
    this.placeCaretAt(local.x, local.y);
  };

  /** How many clicks this press is (1, 2 or 3) — see {@link TextInputBase.clickCount}. */
  private countClick(pointer: Phaser.Input.Pointer): number {
    const now = pointer.downTime || this.scene?.time?.now || 0;
    const near =
      Math.abs(pointer.x - this.lastClickX) <= DOUBLE_CLICK_SLOP &&
      Math.abs(pointer.y - this.lastClickY) <= DOUBLE_CLICK_SLOP;
    const soon = now - this.lastClickAt <= DOUBLE_CLICK_MS;
    this.clickCount = near && soon ? Math.min(this.clickCount + 1, 3) : 1;
    this.lastClickAt = now;
    this.lastClickX = pointer.x;
    this.lastClickY = pointer.y;
    return this.clickCount;
  }

  /**
   * Double click selects the word under the pointer, triple click the whole logical line.
   *
   * The unit comes from the **character** under the pointer (`charIndexAtX`), not from the caret: the
   * caret sits between two characters, so it cannot say which word was clicked. Returns `false` for a
   * single-line field whose line is the whole value? No — a line selection is still a selection, so the
   * only `false` here is an empty value.
   */
  private selectUnitAt(localX: number, localY: number, count: number): boolean {
    if (this.value.length === 0) {
      return false;
    }
    const box = this.contentRect();
    // Two indexes of the same click, both in *value* offsets: where the caret would go, and which
    // character the pointer is over. The second one has to be resolved **inside the clicked line**:
    // measuring it against the whole value would put a pointer on line 2 into line 1 (the newline and
    // every earlier line shift the x-to-character mapping).
    let index = 0;
    let character = 0;
    if (this.multiline) {
      const relativeY = localY - box.y - this.contentOffsetY + this.scrollY;
      const lineIndex = Math.max(
        0,
        Math.min(this.displayLines.length - 1, Math.floor(relativeY / this.lineHeight)),
      );
      const line = this.displayLines[lineIndex];
      if (line) {
        const lineX = localX - box.x - line.x + this.scrollX;
        index = valueOffsetFromDisplay(
          this.value,
          line.start + caretAtX(line.text, lineX, this.measureWidth),
          this.inputType,
        );
        character = valueOffsetFromDisplay(
          this.value,
          line.start + charIndexAtX(line.text, lineX, this.measureWidth),
          this.inputType,
        );
      }
    } else {
      const display = displayValue(this.value, this.inputType);
      const x = localX - box.x + this.scrollX;
      index = valueOffsetFromDisplay(
        this.value,
        caretAtX(display, x, this.measureWidth),
        this.inputType,
      );
      character = valueOffsetFromDisplay(
        this.value,
        charIndexAtX(display, x, this.measureWidth),
        this.inputType,
      );
    }
    const range = count >= 3 ? lineRangeAt(this.value, index) : wordRangeAt(this.value, character);
    if (range.end <= range.start) {
      return false;
    }
    // The caret sits at the *end* of the unit with the anchor at its start, which is where a mouse
    // selection leaves it — `setCaret` would collapse the anchor, so it is set directly here.
    this.caret = range.end;
    this.anchor = range.start;
    this.columnHint = -1;
    this.paintContent();
    this.syncDomSelection();
    this.restartBlink();
    return true;
  }

  /**
   * Drag selection on the pure-Canvas path (`dom: false`).
   *
   * Only runs while this field owns the pointer's drag: the anchor stays where the press put the caret
   * and every move extends towards the pointer, which is what a mouse user expects of text. A multiline
   * drag across lines carries the row selection through `displayLines`, and dragging past either end
   * keeps extending to that line's edge because the caret is clamped into the text.
   *
   * A move alone cannot express "held past the edge", because a browser stops sending moves once the
   * pointer stops: that half is the per-frame `handleDragFrame`.
   */
  private readonly handleScenePointerMove = (pointer: Phaser.Input.Pointer): void => {
    if (this.usingDomBridge || !this.enabled || this.readOnly || !pointer.isDown) {
      return;
    }
    if (!this.ownsDrag(pointer.id)) {
      return;
    }
    this.extendSelectionTo(pointer);
  };

  /**
   * The per-frame half of a Canvas-path drag: **auto-scroll while the pointer is held past an edge**.
   *
   * This is the behaviour every native text field has and the Canvas path did not: hold the pointer
   * below a `rows: 3` box and the text keeps scrolling, one step per frame, while the selection grows
   * with it — so a long value can be selected gradually instead of in one jump to the end. The two
   * halves that make it work are
   *
   * - the caret is taken from the pointer **clamped into the box** (see `extendSelectionTo`), which is
   *   what the browser does too: the pointer says *which edge*, the scroll says *which character*;
   * - `updateScroll` stands aside while this runs, otherwise revealing the caret would snap the content
   *   straight to the far end of the value and the "per frame" part would be a single jump.
   *
   * Registered on `POST_UPDATE`, like `ScrollView`'s coasting, and a no-op while no drag is owned.
   */
  private readonly handleDragFrame = (): void => {
    const pointer = this.dragPointer;
    if (pointer === null) {
      return;
    }
    if (
      this.isDestroyed ||
      this.usingDomBridge ||
      !this.enabled ||
      this.readOnly ||
      !pointer.isDown ||
      !this.ownsDrag(pointer.id)
    ) {
      this.endDrag();
      return;
    }
    const box = this.contentRect();
    const local = this.localPoint(pointer.worldX, pointer.worldY);
    // A wrapped multiline field has no horizontal overflow to scroll into (`wrap` is its line policy),
    // and a single-line field has none vertically.
    const overflowX = this.multiline ? 0 : edgeOverflow(local.x, box.x, box.x + box.width);
    const overflowY = this.multiline ? edgeOverflow(local.y, box.y, box.y + box.height) : 0;
    if (overflowX === 0 && overflowY === 0) {
      this.autoScrolling = false;
      return;
    }
    const delta = this.scene?.game?.loop?.delta ?? 0;
    const stepX = dragAutoScrollStep(overflowX, delta);
    const stepY = dragAutoScrollStep(overflowY, delta);
    if (stepX === 0 && stepY === 0) {
      return;
    }
    this.autoScrolling = true;
    if (stepX !== 0) {
      this.scrollX = Math.min(this.scrollX + stepX, this.maxScrollX());
    }
    if (stepY !== 0) {
      const contentHeight = Math.max(1, this.displayLines.length) * this.lineHeight;
      // `clampScrollY` stops at the last line and at the first one: holding past the bottom when the
      // value is already at its end must not keep scrolling into empty space.
      this.scrollY = clampScrollY(this.scrollY + stepY, contentHeight, box.height);
    }
    this.extendSelectionTo(pointer);
  };

  /**
   * Extends the selection towards a drag pointer, clamped into the content box.
   *
   * A pointer **inside** the box places the caret under the cursor (minus the caret's own width, which
   * is where a click at the very edge belongs). A pointer past an edge is clamped to that edge so the
   * caret lands on the edge character instead of jumping to the end of the value — the auto-scroll then
   * decides which character that edge holds on the next frame.
   */
  private extendSelectionTo(pointer: Phaser.Input.Pointer): void {
    const box = this.contentRect();
    const local = this.localPoint(pointer.worldX, pointer.worldY);
    const x = Math.min(Math.max(local.x, box.x), box.x + box.width - this.caretWidth);
    const y = this.multiline ? Math.min(Math.max(local.y, box.y), box.y + box.height - 1) : local.y;
    this.placeCaretAt(x, y, true);
  }

  /** Furthest `scrollX` that still shows the end of a single-line value. */
  private maxScrollX(): number {
    const box = this.contentRect();
    const display =
      this.value.length === 0 ? this.placeholder : displayValue(this.value, this.inputType);
    return Math.max(0, this.measureWidth(display) + this.caretWidth - box.width);
  }

  /** Releases the drag claim, so the next press starts clean (V24's shape of defect). */
  private readonly handleScenePointerUp = (pointer: Phaser.Input.Pointer): void => {
    if (this.dragPointer !== null && this.dragPointer.id === pointer.id) {
      // The last word on where the caret goes belongs to the release: the content has scrolled since
      // the pointer left the box, so the caret is re-placed (with the reveal back on) at the edge
      // character the user is actually looking at.
      this.autoScrolling = false;
      this.extendSelectionTo(pointer);
      this.dragPointer = null;
    }
    releasePointerDrag(this.scene, pointer.id, this);
  };

  /** Forgets the drag: no more per-frame scrolling, and the caret keeps the scroll it reached. */
  private endDrag(): void {
    this.dragPointer = null;
    this.autoScrolling = false;
  }

  private ownsDrag(pointerId: number): boolean {
    return pointerDragOwner(this.scene, pointerId) === this;
  }

  /** Drops every claim of this field — on blur and on destroy, where the pointer id is not known. */
  private releaseAllDrags(): void {
    this.endDrag();
    for (const claim of pointerClaims(this.scene)) {
      if (claim.owner === (this.name || this.constructor.name)) {
        releasePointerDrag(this.scene, claim.pointerId);
      }
    }
  }

  /**
   * Releases the focus when the pointer goes down somewhere else on the canvas.
   *
   * The input router only *moves* focus between widgets, so a click on the background next to a field
   * would otherwise leave it focused: the caret would keep blinking, the soft keyboard would stay up
   * and the `validate` on blur would never run. This listener is gated on the field being focused and
   * never consumes or alters the event, so it cannot interfere with other controls.
   */
  private readonly handleScenePointerDown = (pointer: Phaser.Input.Pointer): void => {
    if (!this.focused || !this.enabled) {
      return;
    }
    const local = this.localPoint(pointer.worldX, pointer.worldY);
    const inside =
      local.x >= 0 && local.x <= this.rect.width && local.y >= 0 && local.y <= this.rect.height;
    if (!inside) {
      this.blur();
    }
  };

  protected constructor(
    scene: Phaser.Scene,
    options: TextInputOptions,
    extraKeys: readonly string[] = [],
  ) {
    const keys = [...TEXT_INPUT_KEYS, ...extraKeys];
    const { layout, widget } = splitWidgetOptions<TextInputWidgetOptions>(optionBag(options), keys);
    super(scene, { layout, ...baseWidgetOptions(options) });

    this.widgetOptions = widget;
    this.explicitHeight = options.height !== undefined;
    this.maxLength = normalizeMaxLength(widget.maxLength);
    this.inputType = widget.inputType ?? 'text';
    this.align = widget.align ?? 'left';
    this.readOnly = widget.readOnly === true;
    this.clearable = widget.clearable === true;
    this.placeholder = widget.placeholder ?? '';
    this.label = widget.label ?? '';
    this.domRequested = widget.dom !== false;
    this.validateFn = widget.validate ?? null;

    // The control's own padding: the label-free field is a padded box, so the text never touches the
    // border. An explicit `padding` always wins.
    if (options.padding === undefined) {
      const spacing = this.theme.spacing;
      this.layoutParams.padding = {
        top: spacing.sm,
        right: spacing.md,
        bottom: spacing.sm,
        left: spacing.md,
      };
    }

    this.value = this.sanitize(widget.value ?? '');
    this.caret = this.value.length;
    this.anchor = this.value.length;

    this.focusable = true;
    // …and the one control family that keeps its ring when the *mouse* focuses it, exactly as browsers
    // keep `:focus-visible` on a clicked `<input>`: the ring is where the typing goes, and clicking the
    // box is one of the two normal ways to get there (the other is `Tab`). A button has no such excuse.
    this.focusRingOnPointer = true;
    // A text box to a screen reader; the text, the placeholder-as-label and the validation state are
    // read live through `describeA11y()`.
    this.a11y = { role: 'textbox' };
    this.onActivate = () => {
      this.focus();
    };

    this.backgroundGraphics = new Phaser.GameObjects.Graphics(scene);
    this.selectionGraphics = new Phaser.GameObjects.Graphics(scene);
    this.clearGraphics = new Phaser.GameObjects.Graphics(scene);
    this.caretGraphics = new Phaser.GameObjects.Graphics(scene);
    this.add(this.backgroundGraphics);
    this.add(this.selectionGraphics);
    for (let index = 0; index < MIN_LINE_POOL; index++) {
      this.createLineObject();
    }
    this.add(this.clearGraphics);
    this.add(this.caretGraphics);

    this.bridge = this.domRequested
      ? new DomInputBridge(scene, {
          type: this.multiline ? 'textarea' : 'text',
          maxLength: this.maxLength ?? undefined,
          inputMode: inputModeOf(this.inputType),
          autocomplete: 'off',
          ariaLabel: this.label.length > 0 ? this.label : undefined,
        })
      : null;
    this.usingDomBridge = this.bridge?.available === true;

    if (this.bridge) {
      this.bridge.on(this.bridgeHandlers);
      this.bridge.attach();
      this.bridge.setEnabled(this.enabled);
      this.bridge.setReadOnly(this.readOnly);
      if (this.inputType === 'password') {
        this.bridge.setSecure(true);
      }
    }

    // The caret, the selection and a pointer click are all handled by the widget itself; the input
    // router still owns hover/press/activation. The hit area is enabled here (as `Button` does) so a
    // field used outside a mounted UI root stays clickable.
    this.enablePointerInput();
    this.on('pointerdown', this.handlePointerDown);
    scene.input?.keyboard?.on('keydown', this.phaserKeyDown);
    scene.input?.on('pointerdown', this.handleScenePointerDown);
    scene.input?.on('pointermove', this.handleScenePointerMove);
    scene.input?.on('pointerup', this.handleScenePointerUp);
    scene.input?.on('pointerupoutside', this.handleScenePointerUp);
    // The per-frame half of drag selection: a held pointer past the edge scrolls the content even
    // though no pointer events arrive while it is held still (`handleDragFrame`).
    scene.events?.on(Phaser.Scenes.Events.POST_UPDATE, this.handleDragFrame);
    scene.scale?.on('resize', this.handleResize);

    if (widget.disabled === true) {
      this.setEnabled(false);
    }
  }

  // ------------------------------------------------------------------ line policy (subclasses)

  /** True for a multi-line input; changes the bridge element and the scroll axis. */
  protected get multiline(): boolean {
    return false;
  }

  /** True when lines are wrapped at the content width instead of overflowing. */
  protected get wrapsText(): boolean {
    return false;
  }

  /** Default height of the control when the caller did not set one. */
  protected applyDefaultHeight(): void {
    if (!this.explicitHeight) {
      this.layoutParams.height = this.theme.controlHeight.md;
    }
  }

  /** Default height for `measureContent`. */
  protected intrinsicHeight(): number {
    return this.theme.controlHeight.md;
  }

  /** Whether Enter commits the field rather than inserting a line break. */
  protected submitsOnEnter(_event: KeyboardEvent): boolean {
    return true;
  }

  /** Value changed by the user (never called for `setValue`). */
  protected abstract notifyChange(value: string): void;
  /** The user submitted the field. */
  protected abstract notifySubmit(value: string): void;
  /** The field gained focus. */
  protected abstract notifyFocus(): void;
  /** The field lost focus (after validation ran). */
  protected abstract notifyBlur(): void;

  // ------------------------------------------------------------------ public API

  /** Current value. */
  /** Live description for the accessibility mirror (`a11y.ts`). */
  override describeA11y(): A11yDescriptor | null {
    // The field's own `label` option wins (it exists since M5 as the bridge's accessible name), then
    // the placeholder, then the debug name as a last resort.
    const own = this.a11yLabel ?? (this.label.length > 0 ? this.label : this.placeholder);
    const label = own.length > 0 ? own : this.name || 'text field';
    const error = this.getError();
    return {
      role: 'textbox',
      label,
      value: this.value,
      disabled: !this.enabled,
      invalid: error !== null,
      ...(error !== null ? { hint: error } : {}),
    };
  }

  getValue(): string {
    return this.value;
  }

  /**
   * Replaces the value programmatically.
   *
   * The value, the display, the DOM mirror **and the model binding** all follow, so a two-way `ref`
   * can never be left describing text the field no longer holds. What it does *not* do is tell the page
   * "the user typed": the `onChange` option stays silent, which is what keeps
   * `bindValue(field, () => vm.value, (v, w) => w.setValue(v))` a one-way write with no feedback loop
   * (the same convention `Button.setValue` uses) and lets a page clear or prefill a field without
   * re-entering its own validation.
   */
  setValue(value: string): this {
    const next = this.sanitize(value);
    if (next === this.value) {
      return this;
    }
    this.commit(next, next.length, next.length, { userEdit: false });
    return this;
  }

  /** Empties the field (keeps focus, validation state and options). */
  clear(): this {
    return this.setValue('');
  }

  /** Current selection as an ordered `[start, end)` range of code unit offsets. */
  getSelection(): TextRange {
    return selectionRange(this.caret, this.anchor);
  }

  /** Sets the selection; the pair is clamped into the value and ordered. */
  setSelection(start: number, end: number): this {
    const range = clampSelection(start, end, this.value.length);
    this.caret = range.start;
    this.anchor = range.end;
    this.columnHint = -1;
    this.syncDomSelection();
    this.paintContent();
    return this;
  }

  /** Caret offset (code units, like `HTMLInputElement.selectionStart`). */
  get caretIndex(): number {
    return this.caret;
  }

  /** Selection anchor offset (the end a shift-arrow drags). */
  get selectionAnchor(): number {
    return this.anchor;
  }

  /**
   * Horizontal scroll of the text inside the box, in design pixels — the platform's `scrollLeft`.
   *
   * Public because it is *observable behaviour* and not an implementation detail: a single-line field
   * scrolls when the caret leaves the box (typing past the right edge) and while a drag is held past
   * it, and a host that mirrors the field's geometry needs to read that number.
   */
  get scrollLeft(): number {
    return this.scrollX;
  }

  /** Vertical scroll of the text inside the box, in design pixels — the platform's `scrollTop`. */
  get scrollTop(): number {
    return this.scrollY;
  }

  /**
   * Turns "keep the text, reject every edit" on or off at runtime.
   *
   * `readOnly` is **state**, not configuration: a form locks its fields while a save is in flight and
   * unlocks them when it fails, which is why the compose `TextField()`/`TextArea()` slot accepts a `Ref`
   * here (round 98). Three things have to follow the flag, and all three are the same funnel the
   * constructor uses:
   *
   * - the DOM bridge element (`readonly` attribute) — the browser path would otherwise keep editing;
   * - the skin — a read-only field paints `surfaceAlt` instead of `surface`, so the repaint is visible;
   * - any drag in flight: a selection drag that was claimed while the field was editable must let go, or
   *   a held pointer would keep extending a selection in a field the user can no longer edit.
   */
  setReadOnly(readOnly: boolean): this {
    const next = readOnly === true;
    if (next === this.readOnly) {
      return this;
    }
    this.readOnly = next;
    if (next) {
      this.endDrag();
      this.releaseAllDrags();
    }
    this.bridge?.setReadOnly(next);
    this.skinCache = null;
    this.paintAll();
    return this;
  }

  /** True while the field holds the framework focus. */
  isFocused(): boolean {
    return this.focused;
  }

  /** Current error message, or `null`. */
  getError(): string | null {
    return this.errorMessage;
  }

  /**
   * Sets (or clears) the error state.
   *
   * Widened to `boolean | string | null` so it still satisfies `Widget.setError(boolean)`: a string
   * carries the message, `true` keeps the current message, `null`/`false` clear it.
   */
  override setError(value: boolean | string | null): this {
    const next =
      typeof value === 'boolean' ? (value ? (this.errorMessage ?? '') : null) : (value ?? null);
    const messageChanged = this.errorMessage !== next;
    this.errorMessage = next;
    super.setError(next !== null);
    // `super.setError` repaints only when the flag flipped; a message-only change still has to show.
    if (messageChanged && this.error === (next !== null)) {
      this.appearanceChanged();
    }
    return this;
  }

  /** Re-runs `validate` and applies its verdict. */
  validateNow(): this {
    this.runValidation();
    return this;
  }

  /**
   * Inserts `text` at the caret, replacing the selection — the programmatic half of typing.
   *
   * This is what a soft/virtual keyboard, a paste button or any other input method calls. It goes
   * through exactly the same path as a real keystroke (`applyEdit` → `sanitize` → `maxLength`,
   * numeric filtering, code-point snapping), so a virtual keyboard cannot write a character that the
   * DOM bridge would have rejected, and the change event fires the same way.
   *
   * The DOM bridge (if any) is updated too, so a field driven by both a gamepad and an IME never shows
   * a stale element value.
   */
  insertText(text: string): this {
    if (text.length === 0 || !canEditValue(this)) {
      return this;
    }
    this.applyEdit(insertText(this.value, this.caret, this.anchor, text));
    return this;
  }

  /**
   * Deletes the selection, or one code point in `direction` — the programmatic half of Backspace and
   * Delete.
   *
   * `'backward'` (the default) is what an on-screen ⌫ key sends: with a selection it deletes the
   * selection, otherwise it deletes the code point before the caret.
   */
  deleteText(direction: 'backward' | 'forward' = 'backward'): this {
    if (!canEditValue(this)) {
      return this;
    }
    this.applyEdit(deleteRange(this.value, this.caret, this.anchor, direction));
    return this;
  }

  /**
   * Moves the caret to an absolute index, clamping and clearing any selection.
   *
   * The public half of "the caret is somewhere else now": an on-screen keyboard that has just written
   * a word wants the caret after it, and a demo that drives the field programmatically should not have
   * to fake an arrow key.
   */
  setCaretIndex(index: number): this {
    this.setCaret(index, false);
    return this;
  }

  /** True while an IME composition is open; the value is frozen until it ends. */
  get composing(): boolean {
    return this.compositionActive;
  }

  /** The hidden mirrored element, or `null` in the pure-Canvas path. */
  get bridgeElement(): HTMLInputElement | HTMLTextAreaElement | null {
    return this.bridge?.element ?? null;
  }

  /**
   * Tells the accessibility mirror to step aside: this field is *already* an element in the DOM.
   *
   * `null` when there is no bridge (a game without a DOM container), which keeps the mirror node as the
   * field's only surface in that case — see `Widget#getA11yDomElement`.
   */
  override getA11yDomElement(): HTMLElement | null {
    return this.bridgeElement;
  }

  /** True when the field is driven by the hidden DOM element. */
  get bridged(): boolean {
    return this.usingDomBridge;
  }

  override focus(): void {
    if (!this.enabled) {
      return;
    }
    if (this.focusManager) {
      super.focus();
      return;
    }
    // A standalone field (no scene plugin) still has to be usable.
    this.setFocusedInternal(true);
  }

  override blur(): void {
    if (this.focusManager) {
      super.blur();
      return;
    }
    this.setFocusedInternal(false);
  }

  override setEnabled(value: boolean): this {
    super.setEnabled(value);
    this.bridge?.setEnabled(value);
    return this;
  }

  // ------------------------------------------------------------------ layout

  override measureContent(constraint: BoxConstraints): Size {
    const padding = this.layoutParams.padding;
    const display = this.displayString();
    const intrinsic = this.multiline
      ? widestLine(
          layoutTextLines(display, { maxWidth: 0, measureWidth: this.measureWidth }),
          this.measureWidth,
        )
      : this.measureWidth(display);
    const available = Number.isFinite(constraint.maxWidth)
      ? Math.max(0, constraint.maxWidth - padding.left - padding.right)
      : Number.POSITIVE_INFINITY;
    const content = Math.max(MIN_CONTENT_WIDTH, Math.min(intrinsic, available));

    return {
      width: content + padding.left + padding.right + (this.clearable ? this.clearButtonSize() : 0),
      height: this.intrinsicHeight(),
    };
  }

  protected override onRectChanged(_rect: Rect): void {
    this.paintAll();
    this.placeBridge();
  }

  protected override refreshAppearance(): void {
    // The input router may still poke hover/press state while the scene is shutting down (and a
    // theme change may arrive after the display list is gone); painting then would touch destroyed
    // `Text` objects, whose canvas has already been released.
    if (this.isDestroyed) {
      return;
    }
    this.applyDefaultHeight();
    this.applyTextStyle();
    this.syncFocusSideEffects();
    this.paintAll();
  }

  override destroy(fromScene?: boolean): void {
    this.stopBlink();
    this.removeKeyGuard();
    this.scene?.input?.keyboard?.off('keydown', this.phaserKeyDown);
    this.scene?.input?.off('pointerdown', this.handleScenePointerDown);
    this.scene?.input?.off('pointermove', this.handleScenePointerMove);
    this.scene?.input?.off('pointerup', this.handleScenePointerUp);
    this.scene?.input?.off('pointerupoutside', this.handleScenePointerUp);
    this.scene?.events?.off(Phaser.Scenes.Events.POST_UPDATE, this.handleDragFrame);
    this.releaseAllDrags();
    this.scene?.scale?.off('resize', this.handleResize);
    this.off('pointerdown', this.handlePointerDown);
    this.bridge?.dispose();
    super.destroy(fromScene);
  }

  // ------------------------------------------------------------------ painting

  private paintAll(): void {
    if (this.isDestroyed) {
      return;
    }
    this.paintBackground();
    this.paintContent();
  }

  private paintBackground(): void {
    const theme = this.theme;
    const width = Math.max(0, this.rect.width);
    const height = Math.max(0, this.rect.height);
    const radius = Math.max(0, Math.min(theme.radius.sm, Math.min(width, height) / 2));

    this.backgroundGraphics.clear();
    if (width <= 0 || height <= 0) {
      return;
    }
    this.skinFor(theme).paint(this.backgroundGraphics, width, height, this.skinState());
    // `focusVisible` (not `focused`): the ring follows the host's `focus.ring` gate. For a field it is
    // still on after a mouse click — `focusRingOnPointer` is set in the constructor — and still off
    // while the field is in `error`, which the skin paints instead.
    if (this.focusVisible && !this.error) {
      paintFocusRing(this.backgroundGraphics, theme, width, height, radius);
    }
  }

  /**
   * Lays out the displayed text, then draws the lines, the clear button and the overlay.
   *
   * Called on every value/caret/scroll change: the widget owns its text layout, so the caret cannot
   * drift away from the glyphs it is supposed to sit between.
   */
  private paintContent(): void {
    if (this.isDestroyed) {
      return;
    }
    const box = this.contentRect();
    const display = this.displayString();
    const lines = layoutTextLines(display, {
      wrap: this.multiline && this.wrapsText,
      maxWidth: box.width,
      measureWidth: this.measureWidth,
    });

    this.displayLines = positionLines(lines, {
      align: this.align,
      width: box.width,
      lineHeight: this.lineHeight,
      measureWidth: this.measureWidth,
    });
    this.contentOffsetY = this.multiline ? 0 : Math.max(0, (box.height - this.lineHeight) / 2);

    this.updateScroll(box);
    this.renderLines(box);
    this.paintOverlay(box);
  }

  private renderLines(box: Rect): void {
    const lineHeight = this.lineHeight;
    const first = this.multiline ? Math.max(0, Math.floor(this.scrollY / lineHeight)) : 0;
    const wanted = this.multiline ? Math.ceil(box.height / lineHeight) + 1 : 1;
    const last = Math.min(this.displayLines.length, first + Math.max(1, wanted));

    let used = 0;
    for (let index = first; index < last; index++) {
      const line = this.displayLines[index];
      if (!line) {
        continue;
      }
      const window = visibleTextWindow(line.text, this.scrollX, box.width, this.measureWidth);
      const object = this.lineObject(used);
      used++;
      if (object.text !== window.text) {
        object.setText(window.text);
      }
      object.setPosition(
        box.x + line.x + window.offset,
        box.y + this.contentOffsetY + line.y - this.scrollY,
      );
      object.setVisible(true);
    }

    for (let index = used; index < this.lineObjects.length; index++) {
      this.lineObjects[index]?.setVisible(false);
    }
  }

  private paintOverlay(box: Rect): void {
    const theme = this.theme;
    const caretWidth = this.caretWidth;
    this.selectionGraphics.clear();
    this.clearGraphics.clear();
    this.caretGraphics.clear();

    const range = selectionRange(this.caret, this.anchor);
    const displayRange = {
      start: displayOffset(this.value, range.start, this.inputType),
      end: displayOffset(this.value, range.end, this.inputType),
    };

    if (this.focused && displayRange.end > displayRange.start) {
      this.selectionGraphics.fillStyle(theme.colors.primary, SELECTION_ALPHA);
      for (const rect of selectionRects(
        this.displayLines,
        displayRange,
        this.lineHeight,
        this.measureWidth,
      )) {
        const top = box.y + this.contentOffsetY + rect.y - this.scrollY;
        if (top + rect.height < box.y || top > box.y + box.height) {
          continue;
        }
        // `selectionRects` works in *content* coordinates, exactly like the line objects
        // (`renderLines` draws them at `box.x + line.x`), so the content-box origin has to be added
        // here too — without it the highlight sits `padding.left` to the left of the glyphs.
        const left = Math.max(box.x, box.x + rect.x - this.scrollX);
        const right = Math.min(box.x + box.width, box.x + rect.x + rect.width - this.scrollX);
        if (right - left <= 0) {
          continue;
        }
        this.selectionGraphics.fillRect(left, top, right - left, rect.height);
      }
    }

    if (this.focused && this.caretVisible && !this.readOnly) {
      const caretDisplay = displayOffset(this.value, this.caret, this.inputType);
      const position = caretRectOf(this.displayLines, caretDisplay, this.measureWidth);
      const left = Math.min(
        Math.max(box.x + position.x - this.scrollX, box.x),
        Math.max(box.x, box.x + box.width - caretWidth),
      );
      const top = box.y + this.contentOffsetY + position.y - this.scrollY;
      this.caretGraphics.fillStyle(theme.colors.text, 1);
      this.caretGraphics.fillRect(left, top, caretWidth, this.lineHeight);
    }

    if (this.showsClearButton()) {
      const size = this.clearButtonSize();
      const centerX = this.rect.width - this.layoutParams.padding.right - size / 2;
      const centerY = this.rect.height / 2;
      const arm = Math.max(2, size / 4);
      this.clearGraphics.lineStyle(Math.max(1, theme.borderWidth), theme.colors.textMuted, 1);
      this.clearGraphics.lineBetween(centerX - arm, centerY - arm, centerX + arm, centerY + arm);
      this.clearGraphics.lineBetween(centerX + arm, centerY - arm, centerX - arm, centerY + arm);
      this.clearHotspot = size + theme.spacing.xs;
    }
  }

  private applyTextStyle(): void {
    const theme = this.theme;
    const color = toCssColor(this.textColor(theme));
    // The baking ratio is part of the key: a field's visible lines are baked textures too, so a display
    // whose ratio changed has to re-bake them (see `Widget#textResolution`).
    const resolution = this.textResolution;
    const key = `${theme.name}|${theme.fontFamily}|${theme.fontSize.md}|${color}|${resolution}`;
    if (key === this.textStyleKey) {
      return;
    }
    this.textStyleKey = key;

    const pad = glyphPadding(theme.fontSize.md);
    for (const object of this.lineObjects) {
      object.setStyle({
        fontFamily: theme.fontFamily,
        fontSize: theme.fontSize.md,
        color,
        resolution,
      });
      // Text fields measure their own line boxes, so the same allowance has to be applied here: a
      // clipped descender in a field is as wrong as one in a label, and the caret geometry follows it.
      object.setPadding(pad, pad, pad, pad);
    }
  }

  private textColor(theme: Theme): number {
    if (!this.enabled) {
      return theme.colors.textDisabled;
    }
    if (this.value.length === 0) {
      return theme.colors.textMuted;
    }
    return theme.colors.text;
  }

  /**
   * The state the background skin is painted in.
   *
   * A focused field is normally painted by the skin itself (`textInputSkinStyles.focused` uses the
   * `focusRing` colour as its border) with the explicit ring drawn on top of it. That is why the host's
   * global gate has to be folded in **here** as well: with `mvvm.configure({ focus: { ring: false } })`
   * suppressing only the `Graphics` ring would still leave a focus-coloured border behind, which is the
   * same information painted twice. Hover/pressed are unaffected — `WidgetState` ranks them above
   * `focused`, so those states never reach this branch while the pointer is on the field.
   */
  private skinState(): WidgetState {
    return this.visualState === 'focused' && !this.focusVisible ? 'normal' : this.visualState;
  }

  /**
   * Background skin of the box; rebuilt when the theme changes **or** `readOnly` flips.
   *
   * The cache is keyed by theme alone, so any other input to `textInputSkinStyles` has to clear it —
   * `setReadOnly()` does exactly that (the same shape as V38's panel variant).
   */
  private skinFor(theme: Theme): ProceduralSkin {
    if (this.skinCache?.theme === theme) {
      return this.skinCache.skin;
    }
    const skin = new ProceduralSkin(
      textInputSkinStyles(theme, Math.max(0, theme.radius.sm), this.readOnly),
    );
    this.skinCache = { theme, skin };
    return skin;
  }

  // ------------------------------------------------------------------ geometry helpers

  /** Content box in the widget's local space. */
  private contentRect(): Rect {
    return contentBox(this.rect.width, this.rect.height, this.layoutParams.padding);
  }

  private get lineHeightInternal(): number {
    return computeLineHeight(this.theme.fontSize.md);
  }

  /** Height of one line box; subclasses derive their default height from it. */
  protected get lineHeight(): number {
    return this.lineHeightInternal;
  }

  private get caretWidth(): number {
    return Math.max(2, Math.round(this.theme.fontSize.md / 8));
  }

  private clearButtonSize(): number {
    return Math.max(10, this.theme.fontSize.sm);
  }

  private showsClearButton(): boolean {
    return this.clearable && this.enabled && !this.readOnly && this.value.length > 0;
  }

  private displayString(): string {
    if (this.value.length === 0) {
      return this.placeholder;
    }
    return displayValue(this.value, this.inputType);
  }

  private localPoint(worldX: number, worldY: number): { x: number; y: number } {
    const stage = stageRectOf(this);
    return { x: worldX - stage.x, y: worldY - stage.y };
  }

  // ------------------------------------------------------------------ text objects

  private probeObject(): Phaser.GameObjects.Text {
    const existing = this.lineObjects[0];
    return existing ?? this.createLineObject();
  }

  private lineObject(index: number): Phaser.GameObjects.Text {
    return this.lineObjects[index] ?? this.createLineObject();
  }

  /** Creates one line object and keeps the pool contiguous, right above the overlay graphics. */
  private createLineObject(): Phaser.GameObjects.Text {
    const object = new Phaser.GameObjects.Text(this.scene, 0, 0, '', {});
    object.setOrigin(0, 0);
    this.applyObjectStyle(object);
    // Index 0 is the background and index 1 the selection highlight; the lines sit between them and
    // the clear button/caret, and a line added later must not land on top of those.
    this.addAt(object, 2 + this.lineObjects.length);
    this.lineObjects.push(object);
    return object;
  }

  private applyObjectStyle(object: Phaser.GameObjects.Text): void {
    const theme = this.theme;
    object.setStyle({
      fontFamily: theme.fontFamily,
      fontSize: theme.fontSize.md,
      color: toCssColor(this.textColor(theme)),
    });
    const pad = glyphPadding(theme.fontSize.md);
    object.setPadding(pad, pad, pad, pad);
  }

  // ------------------------------------------------------------------ focus side effects

  private syncFocusSideEffects(): void {
    const focused = this.focused;
    if (focused === this.lastFocused) {
      return;
    }
    this.lastFocused = focused;
    if (focused) {
      this.handleFocusGained();
    } else {
      this.handleFocusLost();
    }
  }

  private handleFocusGained(): void {
    this.valueAtFocus = this.value;
    this.columnHint = -1;
    this.caretVisible = true;
    this.restartBlink();
    this.installKeyGuard();
    this.placeBridge();

    const bridge = this.bridge;
    if (bridge && this.usingDomBridge) {
      bridge.setValue(this.value);
      bridge.setSelection(this.caret, this.anchor);
      bridge.setEnabled(this.enabled);
      bridge.focus();
    }

    this.notifyFocus();
  }

  private handleFocusLost(): void {
    this.stopBlink();
    this.caretVisible = false;
    this.removeKeyGuard();
    this.bridge?.blur();
    // A field that kept a claim after losing focus would refuse the next drag started elsewhere.
    this.releaseAllDrags();
    this.valueAtFocus = null;
    this.columnHint = -1;
    this.runValidation();
    this.notifyBlur();
  }

  private runValidation(): void {
    if (!this.validateFn) {
      return;
    }
    this.setError(this.validateFn(this.value));
  }

  private restartBlink(): void {
    if (!this.focused) {
      return;
    }
    this.caretVisible = true;
    const clock = this.scene?.time;
    if (!clock) {
      return;
    }
    this.stopBlink();
    this.blinkTimer = clock.addEvent({
      delay: CARET_BLINK_MS,
      loop: true,
      callback: () => {
        this.caretVisible = !this.caretVisible;
        this.paintContent();
      },
    });
  }

  private stopBlink(): void {
    this.blinkTimer?.remove(false);
    this.blinkTimer = null;
  }

  private installKeyGuard(): void {
    if (this.keyGuardInstalled || this.usingDomBridge || typeof window === 'undefined') {
      return;
    }
    window.addEventListener('keydown', this.windowKeyGuard, true);
    this.keyGuardInstalled = true;
  }

  private removeKeyGuard(): void {
    if (!this.keyGuardInstalled || typeof window === 'undefined') {
      return;
    }
    window.removeEventListener('keydown', this.windowKeyGuard, true);
    this.keyGuardInstalled = false;
  }

  // ------------------------------------------------------------------ value plumbing

  private sanitize(value: string): string {
    return sanitizeValue(value, {
      inputType: this.inputType,
      maxLength: this.maxLength,
      multiline: this.multiline,
    });
  }

  /**
   * Single write path for the value, the caret and the selection.
   *
   * `userEdit: false` marks a programmatic write (`setValue`): it still emits the `change` event — the
   * model binding has to hear about it (round 81, V49) — but it does not run the page's `onChange`
   * callback. Both paths share this method so the display, the DOM mirror and the emitted events can
   * never disagree.
   */
  private commit(
    value: string,
    caret: number,
    anchor: number,
    options: { userEdit?: boolean } = {},
  ): void {
    const changed = value !== this.value;
    this.value = value;
    this.caret = clampCaret(value, caret);
    this.anchor = clampCaret(value, anchor);
    this.columnHint = -1;

    if (changed) {
      // Only an auto-width field can change the layout answer; a fixed/`fill` width must not push a
      // relayout on every keystroke (ADR-0008 keeps input out of the layout hot path).
      if (this.layoutParams.width === 'auto') {
        this.markDirty();
      }
      this.emit(TEXT_INPUT_EVENTS.CHANGE, value);
      // The mirror holds the text (or the element does, for a bridged field) and has to hear about a
      // programmatic write too: `field.setValue('')` from a "clear" button is a state change like any
      // other for a screen reader.
      this.notifyA11yChanged();
      if (options.userEdit !== false) {
        this.notifyChange(value);
      }
    }

    this.paintContent();
    this.syncDomValue();
    this.syncDomSelection();
    this.restartBlink();
  }

  private applyEdit(result: EditResult): void {
    // The single funnel for every *edit*, so the permission rule lives here rather than at each
    // caller: `Ctrl+X`/`Ctrl+V` go straight to `cutSelection()`/`pasteClipboard()` instead of through
    // the key switch, which is how a `readOnly` canvas field could be cut to pieces and pasted over
    // while typing, Backspace and Enter were all correctly refused (measured in round 88: a
    // `dom: false, readOnly: true` field went `locked value` → `` → `ZZZ`, V59). The DOM path never
    // showed this because the element's own `readonly` attribute does the work there.
    if (!canEditValue(this)) {
      return;
    }
    const next = this.sanitizedEdit(result);
    this.commit(next.value, next.caret, next.anchor);
  }

  /**
   * Filters an edit's outcome.
   *
   * When filtering removed characters (a letter typed into a number field, a code point past
   * `maxLength`), the caret is placed after the longest prefix the sanitized value still shares with
   * the raw one, so a rejected keystroke does not move the caret and an accepted one lands after the
   * inserted text.
   */
  private sanitizedEdit(result: EditResult): EditResult {
    const next = this.sanitize(result.value);
    if (next === result.value) {
      return result;
    }
    let caret = 0;
    const limit = Math.min(result.caret, next.length);
    while (caret < limit && next[caret] === result.value[caret]) {
      caret++;
    }
    return { value: next, caret, anchor: caret };
  }

  private syncDomValue(): void {
    const element = this.bridge?.element;
    if (!element || !this.usingDomBridge || this.compositionActive) {
      return;
    }
    if (element.value !== this.value) {
      element.value = this.value;
    }
  }

  private syncDomSelection(): void {
    const element = this.bridge?.element;
    if (!element || !this.usingDomBridge || this.compositionActive) {
      return;
    }
    if (element.selectionStart !== this.caret || element.selectionEnd !== this.anchor) {
      this.bridge?.setSelection(this.caret, this.anchor);
    }
  }

  /** Mirrors the element's value and selection into the model. */
  private readFromDom(raw: string): void {
    const element = this.bridge?.element;
    if (!element) {
      return;
    }
    const next = this.sanitize(raw);
    const range = clampSelection(
      element.selectionStart ?? next.length,
      element.selectionEnd ?? next.length,
      next.length,
    );

    if (next !== raw) {
      // `maxlength` and the numeric filter are enforced on the element too, so the browser's own
      // caret arithmetic keeps matching what the widget shows.
      element.value = next;
      element.setSelectionRange(range.start, range.end);
    }

    this.commit(next, range.start, range.end);
  }

  /**
   * Mirrors a caret/selection move that happened inside the element.
   *
   * With a DOM bridge the browser owns keyboard navigation (`Home`, `End`, the arrows), and those
   * keystrokes produce no `input` event — without this the widget would keep drawing the caret where
   * it was before the key was pressed.
   */
  private syncCaretFromDom(): void {
    const element = this.bridge?.element;
    if (!element || !this.usingDomBridge || this.compositionActive) {
      return;
    }
    const range = clampSelection(
      element.selectionStart ?? this.caret,
      element.selectionEnd ?? this.anchor,
      this.value.length,
    );
    if (range.start === this.caret && range.end === this.anchor) {
      return;
    }
    this.caret = range.start;
    this.anchor = range.end;
    this.columnHint = -1;
    this.paintContent();
    this.restartBlink();
  }

  private readonly bridgeHandlers: InputBridgeHandlers = {
    onInput: (value) => {
      this.compositionActive = false;
      this.readFromDom(value);
    },
    onCompositionStart: () => {
      this.compositionActive = true;
    },
    onCompositionUpdate: () => {
      // Nothing to mirror: the display is frozen until the composition commits (ADR-0004 §2).
    },
    onCompositionEnd: (value) => {
      this.compositionActive = false;
      this.readFromDom(value);
    },
    onKeyDown: (event) => {
      this.handleKeyEvent(event);
    },
    onSelectionChange: () => {
      this.syncCaretFromDom();
    },
    onPaste: () => {
      // The element performs the paste; the `input` event that follows carries the result.
    },
    onBlur: () => {
      this.blur();
    },
    onFocus: () => {
      // Framework focus stays the source of truth; a DOM focus alone does not grant it.
    },
  };

  /** Positions the hidden element over the widget (canvas offset, container offset and scale). */
  private placeBridge(): void {
    const bridge = this.bridge;
    if (!bridge || !this.usingDomBridge) {
      return;
    }
    const canvasRect = bridge.canvasRect;
    if (!canvasRect) {
      return;
    }
    const stage = stageRectOf(this);
    bridge.place(
      { x: stage.x, y: stage.y, width: this.rect.width, height: this.rect.height },
      canvasRect,
    );
  }

  // ------------------------------------------------------------------ caret & selection

  private setCaret(caret: number, extend: boolean): void {
    this.caret = clampCaret(this.value, caret);
    if (!extend) {
      this.anchor = this.caret;
    }
    this.columnHint = -1;
    this.paintContent();
    this.syncDomSelection();
    this.restartBlink();
  }

  /**
   * Moves the caret to the point `(localX, localY)`, optionally **extending** a selection instead of
   * collapsing it — the difference between a click and a drag (see `handleScenePointerMove`).
   */
  private placeCaretAt(localX: number, localY: number, extend = false): void {
    const box = this.contentRect();
    const anchor = extend ? this.anchor : -1;
    if (this.multiline) {
      const relativeY = localY - box.y - this.contentOffsetY + this.scrollY;
      const index = Math.max(
        0,
        Math.min(this.displayLines.length - 1, Math.floor(relativeY / this.lineHeight)),
      );
      const line = this.displayLines[index];
      if (line) {
        const offset = caretAtX(
          line.text,
          localX - box.x - line.x + this.scrollX,
          this.measureWidth,
        );
        const valueOffset = valueOffsetFromDisplay(this.value, line.start + offset, this.inputType);
        this.caret = valueOffset;
        this.anchor = anchor >= 0 ? anchor : valueOffset;
      }
    } else {
      const display =
        this.value.length === 0 ? this.placeholder : displayValue(this.value, this.inputType);
      const offset = caretAtX(display, localX - box.x + this.scrollX, this.measureWidth);
      const valueOffset = valueOffsetFromDisplay(this.value, offset, this.inputType);
      this.caret = valueOffset;
      this.anchor = anchor >= 0 ? anchor : valueOffset;
    }
    this.columnHint = -1;
    this.paintContent();
    this.syncDomSelection();
    this.restartBlink();
  }

  private updateScroll(box: Rect): void {
    const contentHeight = Math.max(1, this.displayLines.length) * this.lineHeight;
    this.scrollY = clampScrollY(this.scrollY, contentHeight, box.height);

    // While a drag is held past an edge, the *drag* owns the offset: the caret this repaint was
    // triggered by sits on the edge character by construction (`extendSelectionTo`), so revealing it
    // would only snap the content to the far end of the value — which is exactly the "one jump to the
    // end instead of a scroll" behaviour the per-frame step exists to replace.
    if (this.autoScrolling) {
      return;
    }

    if (this.multiline) {
      const caretDisplay = displayOffset(this.value, this.caret, this.inputType);
      const position = caretRectOf(this.displayLines, caretDisplay, this.measureWidth);
      this.scrollY = computeScrollY(
        position.y,
        position.y + this.lineHeight,
        box.height,
        this.scrollY,
      );
      return;
    }

    const caretX = this.measureWidth(displaySlice(this.value, this.caret, this.inputType));
    this.scrollX = computeScrollX(caretX, box.width, this.scrollX, this.caretWidth);
  }

  // ------------------------------------------------------------------ keyboard & clipboard

  /**
   * The semantic editor: one entry point for both input sources.
   *
   * Returns `true` when the key was consumed by the field. With a DOM bridge the browser already
   * performed the edit, so the handler only *claims* the key (to keep the framework's global
   * navigation away from arrow keys and Backspace) and runs the commands the element cannot know
   * about (submit, revert, select-all through the model).
   */
  protected handleKeyEvent(event: KeyboardEvent): boolean {
    if (!this.focused || !this.enabled) {
      return false;
    }

    const key = event.key;
    const mod = event.ctrlKey || event.metaKey;
    const dom = this.usingDomBridge;

    if (mod && (key === 'a' || key === 'A')) {
      event.preventDefault();
      event.stopPropagation();
      this.selectAll(dom);
      return true;
    }

    if (
      mod &&
      (key === 'c' || key === 'C' || key === 'x' || key === 'X' || key === 'v' || key === 'V')
    ) {
      if (dom) {
        // The browser owns the clipboard for a real input element; only the model path needs code.
        return false;
      }
      event.preventDefault();
      event.stopPropagation();
      if (key === 'c' || key === 'C') {
        void this.copySelection();
      } else if (key === 'x' || key === 'X') {
        void this.cutSelection();
      } else {
        void this.pasteClipboard();
      }
      return true;
    }

    switch (key) {
      case 'ArrowLeft':
      case 'ArrowRight': {
        if (dom) {
          event.stopPropagation();
          return true;
        }
        event.preventDefault();
        this.setCaret(
          moveCaret(this.value, this.caret, key === 'ArrowLeft' ? -1 : 1),
          event.shiftKey,
        );
        return true;
      }
      case 'ArrowUp':
      case 'ArrowDown': {
        if (!this.multiline) {
          // A single-line field has nothing above or below: leave the key to the focus manager.
          return false;
        }
        if (dom) {
          event.stopPropagation();
          return true;
        }
        event.preventDefault();
        const moved = moveCaretVertically(
          this.displayLines,
          displayOffset(this.value, this.caret, this.inputType),
          key === 'ArrowUp' ? 'up' : 'down',
          this.columnHint,
        );
        this.columnHint = moved.columnHint;
        this.setCaret(
          valueOffsetFromDisplay(this.value, moved.caret, this.inputType),
          event.shiftKey,
        );
        return true;
      }
      case 'Home':
      case 'End': {
        if (dom) {
          event.stopPropagation();
          return true;
        }
        event.preventDefault();
        const target =
          key === 'Home'
            ? mod
              ? 0
              : lineStartAt(this.value, this.caret)
            : mod
              ? this.value.length
              : lineEndAt(this.value, this.caret);
        this.setCaret(target, event.shiftKey);
        return true;
      }
      case 'Backspace':
      case 'Delete': {
        if (dom) {
          event.stopPropagation();
          return true;
        }
        event.preventDefault();
        if (this.readOnly) {
          return true;
        }
        this.applyEdit(
          deleteRange(
            this.value,
            this.caret,
            this.anchor,
            key === 'Backspace' ? 'backward' : 'forward',
          ),
        );
        return true;
      }
      case 'Enter': {
        if (this.readOnly) {
          event.preventDefault();
          event.stopPropagation();
          return true;
        }
        if (this.submitsOnEnter(event)) {
          event.preventDefault();
          event.stopPropagation();
          this.submit();
          return true;
        }
        if (this.multiline) {
          if (dom) {
            // A `<textarea>` inserts the line break itself, so the default action must survive; only
            // the framework's global navigation (Enter = `activate`) has to be kept away from the key.
            event.stopPropagation();
            return true;
          }
          event.preventDefault();
          this.applyEdit(insertText(this.value, this.caret, this.anchor, '\n'));
          return true;
        }
        // A single-line field has no line to break: Enter always submits.
        event.preventDefault();
        event.stopPropagation();
        this.submit();
        return true;
      }
      case 'Escape': {
        event.preventDefault();
        event.stopPropagation();
        if (this.valueAtFocus !== null && this.valueAtFocus !== this.value) {
          this.commit(this.valueAtFocus, this.valueAtFocus.length, this.valueAtFocus.length);
        }
        this.blur();
        // `back` is reported **whatever happened above**, because Escape means "go back" everywhere and
        // a focused field must not be the one place where the key disappears. It has to be reported
        // from here at all: `preventDefault()`/`stopPropagation()` keep Phaser's keyboard manager out
        // of the event (V17), so the plugin's own handler never sees it. This is what makes Escape
        // close a modal, pop a page, and reach `mvvm.onBack` even while the caret is in a field.
        this.focusManager?.handleAction?.('back', 'keyboard');
        return true;
      }
      case 'Tab': {
        if (dom) {
          // Keep the browser from moving DOM focus: traversal belongs to the focus manager. It has to
          // be asked *here* rather than left to the scene plugin: `preventDefault()` marks the event
          // as handled, and Phaser's keyboard manager drops every `defaultPrevented` keydown before
          // the plugin ever sees it — which is why `Tab` used to do nothing at all while a bridged
          // field had focus (V17).
          event.preventDefault();
          this.focusManager?.handleAction?.(event.shiftKey ? 'prev' : 'next', 'keyboard');
          return true;
        }
        return false;
      }
      default:
        break;
    }

    // A printable character (`' '` included — the focus manager maps space to `activate`).
    if (!mod && !event.altKey && key.length === 1) {
      if (dom) {
        // The element inserts the character itself, but the key must not reach the scene plugin: it
        // would treat space as an activation and `preventDefault()` the keystroke, which silently
        // swallows every space typed into the field.
        event.stopPropagation();
        return true;
      }
      event.preventDefault();
      if (this.readOnly) {
        return true;
      }
      this.applyEdit(insertText(this.value, this.caret, this.anchor, key));
      return true;
    }

    return false;
  }

  private selectAll(dom: boolean): void {
    this.caret = 0;
    this.anchor = this.value.length;
    this.columnHint = -1;
    if (dom) {
      this.bridge?.element?.select();
    }
    this.paintContent();
  }

  private submit(): void {
    this.emit(TEXT_INPUT_EVENTS.SUBMIT, this.value);
    this.notifySubmit(this.value);
  }

  /** Copies the selected text; a denied clipboard is silently ignored (no permission prompt). */
  private async copySelection(): Promise<boolean> {
    const text = selectedText(this.value, this.caret, this.anchor);
    if (text.length === 0) {
      return false;
    }
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }

  private async cutSelection(): Promise<void> {
    const text = selectedText(this.value, this.caret, this.anchor);
    if (text.length === 0) {
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // A blocked clipboard must not stop the deletion: cut is "copy, then delete".
    }
    this.applyEdit(deleteRange(this.value, this.caret, this.anchor, 'forward'));
  }

  private async pasteClipboard(): Promise<void> {
    try {
      const text = await navigator.clipboard.readText();
      if (text.length > 0) {
        this.applyEdit(insertText(this.value, this.caret, this.anchor, text));
      }
    } catch {
      // Reading the clipboard can be denied; typing still works.
    }
  }
}

/** `undefined`, `NaN` and negative lengths mean "no limit"; `0` allows nothing. */
function normalizeMaxLength(value: number | undefined): number | null {
  if (value === undefined || !Number.isFinite(value)) {
    return null;
  }
  return Math.max(0, Math.floor(value));
}

/** Native `inputmode` for an input flavour: it decides which mobile keyboard is raised. */
function inputModeOf(inputType: TextInputType): string {
  switch (inputType) {
    case 'number':
      return 'numeric';
    case 'email':
      return 'email';
    case 'search':
      return 'search';
    case 'password':
    case 'text':
    default:
      return 'text';
  }
}
