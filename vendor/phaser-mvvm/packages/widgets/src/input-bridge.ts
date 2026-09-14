/**
 * `DomInputBridge` — the hidden DOM `<input>`/`<textarea>` mirror behind `TextField`/`TextArea`
 * (ADR-0004).
 *
 * A Canvas application cannot have an IME candidate window or a mobile soft keyboard, and both are
 * hard requirements for the project's Chinese form use case. The bridge puts an invisible element
 * over the canvas, at exactly the widget's rect, and lets the browser own *composition and text
 * entry*; the widget keeps drawing the caret, the selection and the text itself, so the visual result
 * never depends on two layout engines agreeing.
 *
 * Everything DOM related happens in `attach()`, never at module scope: importing this file in Node
 * (unit tests, SSR) is free of side effects, and `available` is `false` when the game was not
 * configured with `dom: { createContainer: true }` — the caller then falls back to the pure-Canvas
 * input path.
 */

import type Phaser from 'phaser';

export interface InputBridgeOptions {
  /** Element flavour: a single-line `<input>` (default) or a `<textarea>`. */
  type?: 'text' | 'textarea';
  /** Native `maxlength`; the widget clamps the value as well. */
  maxLength?: number;
  /** Native `inputmode` — what tells a mobile browser which keyboard to raise. */
  inputMode?: string;
  /** Native `autocomplete`; defaults to `off` (a mirrored field is never a real form control). */
  autocomplete?: string;
  /** Accessible name of the element (the widget's `label`, when it has one). */
  ariaLabel?: string;
}

/** Payload handlers; every one of them is optional and called on the element's own events. */
export interface InputBridgeHandlers {
  /** Final value after a user edit. Never called while a composition is in progress. */
  onInput?: (value: string) => void;
  onCompositionStart?: () => void;
  onCompositionUpdate?: (data: string) => void;
  /** Called once the composition finished, with the committed text. */
  onCompositionEnd?: (value: string) => void;
  /** Native `keydown`; the caller decides what to consume. */
  onKeyDown?: (event: KeyboardEvent) => void;
  /**
   * The caret/selection moved inside the element without the value changing (arrow keys, Home/End,
   * a programmatic `select()`), so the widget's own caret overlay has to catch up.
   */
  onSelectionChange?: () => void;
  onPaste?: (event: ClipboardEvent) => void;
  onBlur?: () => void;
  onFocus?: () => void;
}

/** A plain rectangle, structurally compatible with `DOMRect` and with the layout `Rect`. */
export interface BridgeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Printed once when the bridge is asked for without a Phaser DOM container (ADR-0004 §3). */
export const DOM_CONTAINER_WARNING = '[phaser-mvvm] TextField 需要 dom.createContainer: true';

/** The element over the canvas is invisible but must stay focusable, so it gets a huge z-index. */
const BRIDGE_Z_INDEX = '20';

let warned = false;

/**
 * True when an `input` event may be turned into a value change.
 *
 * During a composition (an IME candidate session) the element's value is a *pre-edit* string that
 * the user has not committed yet; writing it back to the model would put half-typed candidates into
 * the bound data. Only `compositionend` releases the guard.
 */
export function shouldEmitInput(composing: boolean): boolean {
  return composing !== true;
}

/**
 * Cuts a value down to `maxLength` characters.
 *
 * Counting is by code point (`Array.from`), so an emoji is either kept or dropped whole — a code
 * unit slice could leave a lone surrogate behind. `undefined`, `NaN` and negative lengths mean "no
 * limit"; `0` really does allow nothing.
 */
export function clampValue(value: string, maxLength?: number | null): string {
  if (maxLength === undefined || maxLength === null || !Number.isFinite(maxLength)) {
    return value;
  }
  const limit = Math.floor(maxLength);
  if (limit < 0) {
    return value;
  }
  const characters = Array.from(value);
  return characters.length <= limit ? value : characters.slice(0, limit).join('');
}

function clampIndex(value: number, length: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(length, Math.floor(value)));
}

/** Clamps a `[start, end]` selection into `[0, length]` and orders the pair. */
export function clampSelection(
  start: number,
  end: number,
  length: number,
): { start: number; end: number } {
  const size = Number.isFinite(length) && length > 0 ? Math.floor(length) : 0;
  const first = clampIndex(start, size);
  const second = clampIndex(end, size);
  return first <= second ? { start: first, end: second } : { start: second, end: first };
}

/**
 * The hidden element that mirrors one text widget.
 *
 * Life cycle: `attach()` creates the element and hooks its listeners, `detach()` unhooks and removes
 * it, `dispose()` does both and drops the reference. `place()` must be called after every layout
 * change (and on a canvas resize) to keep the element over the widget.
 */
export class DomInputBridge {
  /** The mirrored element, or `null` before `attach()` / after `dispose()`. */
  private domElement: HTMLInputElement | HTMLTextAreaElement | null = null;

  /** Whether a DOM container exists at all; `false` means "use the Canvas fallback". */
  readonly available: boolean;

  private readonly scene: Phaser.Scene;
  private readonly options: InputBridgeOptions;
  private readonly type: 'text' | 'textarea';
  private readonly container: HTMLElement | null;
  private readonly canvas: HTMLCanvasElement | null;

  private handlers: InputBridgeHandlers = {};
  private composing = false;
  private attached = false;

  // Bound once so `detach()` can remove exactly what `attach()` added.
  private readonly onInputEvent = (): void => {
    if (!shouldEmitInput(this.composing)) {
      return;
    }
    this.handlers.onInput?.(this.getValue());
  };
  private readonly onCompositionStartEvent = (): void => {
    this.composing = true;
    this.handlers.onCompositionStart?.();
  };
  private readonly onCompositionUpdateEvent = (event: CompositionEvent): void => {
    this.handlers.onCompositionUpdate?.(event.data ?? '');
  };
  private readonly onCompositionEndEvent = (): void => {
    this.composing = false;
    const value = this.getValue();
    this.handlers.onCompositionEnd?.(value);
    // The committed text is the single value change the model is allowed to see for this session;
    // browsers disagree about whether a trailing `input` event follows `compositionend`, and because
    // the widget's write path is idempotent, emitting here (and possibly again from `input`) is safe.
    this.handlers.onInput?.(value);
  };
  private readonly onKeyDownEvent = (event: KeyboardEvent): void => {
    this.handlers.onKeyDown?.(event);
  };
  private readonly onKeyUpEvent = (): void => {
    this.handlers.onSelectionChange?.();
  };
  private readonly onSelectionChangeEvent = (): void => {
    // `selectionchange` also fires for the document selection elsewhere on the page.
    if (typeof document === 'undefined' || document.activeElement !== this.domElement) {
      return;
    }
    this.handlers.onSelectionChange?.();
  };
  private readonly onPasteEvent = (event: ClipboardEvent): void => {
    this.handlers.onPaste?.(event);
  };
  private readonly onBlurEvent = (): void => {
    this.handlers.onBlur?.();
  };
  private readonly onFocusEvent = (): void => {
    this.handlers.onFocus?.();
  };

  constructor(scene: Phaser.Scene, options: InputBridgeOptions = {}) {
    this.scene = scene;
    this.options = options;
    this.type = options.type === 'textarea' ? 'textarea' : 'text';
    this.container = resolveContainer(scene);
    this.canvas = resolveCanvas(scene);
    this.available = this.container !== null && typeof document !== 'undefined';

    if (!this.available && !warned) {
      warned = true;
      // eslint-disable-next-line no-console
      console.warn(DOM_CONTAINER_WARNING);
    }
  }

  /** The mirrored element; `null` when the bridge is not available or not attached. */
  get element(): HTMLInputElement | HTMLTextAreaElement | null {
    return this.domElement;
  }

  /** True once the element is in the DOM and listening. */
  get isAttached(): boolean {
    return this.attached;
  }

  /** True while an IME composition session is open. */
  get isComposing(): boolean {
    return this.composing;
  }

  /** The element's current value (empty string when there is no element). */
  getValue(): string {
    return this.domElement?.value ?? '';
  }

  /** Replaces the element's value without emitting anything (programmatic writes are silent). */
  setValue(value: string): void {
    if (this.domElement) {
      this.domElement.value = value;
    }
  }

  /** Moves the element's selection; the pair is clamped by the element itself. */
  setSelection(start: number, end: number): void {
    const element = this.domElement;
    if (!element) {
      return;
    }
    try {
      element.setSelectionRange(start, end);
    } catch {
      // A password/number input on an old browser can refuse; the widget's own caret still works.
    }
  }

  /** Registers (or replaces) the payload handlers. */
  on(handlers: InputBridgeHandlers): void {
    this.handlers = handlers;
  }

  /** Creates the element, styles it and hooks every event the widgets care about. */
  attach(): void {
    if (this.attached || !this.available || typeof document === 'undefined') {
      return;
    }
    const element =
      this.type === 'textarea'
        ? document.createElement('textarea')
        : document.createElement('input');

    if (isInputElement(element)) {
      element.type = 'text';
    }
    element.setAttribute('tabindex', '-1');
    element.setAttribute('autocomplete', this.options.autocomplete ?? 'off');
    element.setAttribute('autocorrect', 'off');
    element.setAttribute('autocapitalize', 'off');
    element.setAttribute('spellcheck', 'false');
    if (this.options.inputMode !== undefined) {
      element.setAttribute('inputmode', this.options.inputMode);
    }
    if (this.options.ariaLabel !== undefined) {
      element.setAttribute('aria-label', this.options.ariaLabel);
    }
    if (this.options.maxLength !== undefined && this.options.maxLength >= 0) {
      element.setAttribute('maxlength', String(Math.floor(this.options.maxLength)));
    }

    // `opacity: 0` + `pointer-events: none`: invisible and transparent to clicks, yet still a
    // rendered, focusable element (which is all the soft keyboard and the IME need). The font size is
    // deliberately >= 16px, the threshold below which mobile Safari zooms the whole page on focus.
    element.style.cssText = [
      'position: absolute',
      'left: 0',
      'top: 0',
      'width: 1px',
      'height: 1px',
      'opacity: 0',
      'border: 0',
      'padding: 0',
      'margin: 0',
      'outline: none',
      'background: transparent',
      'color: transparent',
      'caret-color: transparent',
      'overflow: hidden',
      'resize: none',
      'box-sizing: border-box',
      `z-index: ${BRIDGE_Z_INDEX}`,
      'pointer-events: none',
      'font-size: 16px',
    ].join('; ');

    element.addEventListener('input', this.onInputEvent);
    element.addEventListener('compositionstart', this.onCompositionStartEvent);
    element.addEventListener('compositionupdate', this.onCompositionUpdateEvent as EventListener);
    element.addEventListener('compositionend', this.onCompositionEndEvent);
    element.addEventListener('keydown', this.onKeyDownEvent as EventListener);
    element.addEventListener('keyup', this.onKeyUpEvent);
    element.addEventListener('paste', this.onPasteEvent as EventListener);
    element.addEventListener('blur', this.onBlurEvent);
    element.addEventListener('focus', this.onFocusEvent);

    // The caret can move without any value change (`ArrowLeft`, `Home`, a `select()`), and the
    // element is where that state lives, so the document's own `selectionchange` is forwarded too.
    document.addEventListener('selectionchange', this.onSelectionChangeEvent);

    this.container?.appendChild(element);
    this.domElement = element;
    this.attached = true;
  }

  /** Removes the element and its listeners; keeps the bridge reusable for a later `attach()`. */
  detach(): void {
    const element = this.domElement;
    if (!element) {
      return;
    }

    element.removeEventListener('input', this.onInputEvent);
    element.removeEventListener('compositionstart', this.onCompositionStartEvent);
    element.removeEventListener(
      'compositionupdate',
      this.onCompositionUpdateEvent as EventListener,
    );
    element.removeEventListener('compositionend', this.onCompositionEndEvent);
    element.removeEventListener('keydown', this.onKeyDownEvent as EventListener);
    element.removeEventListener('keyup', this.onKeyUpEvent);
    element.removeEventListener('paste', this.onPasteEvent as EventListener);
    element.removeEventListener('blur', this.onBlurEvent);
    element.removeEventListener('focus', this.onFocusEvent);

    document.removeEventListener('selectionchange', this.onSelectionChangeEvent);
    element.parentNode?.removeChild(element);
    this.domElement = null;
    this.attached = false;
    this.composing = false;
  }

  /** Focuses the element (which is what raises the soft keyboard and opens the IME). */
  focus(): void {
    this.domElement?.focus({ preventScroll: true });
  }

  /** Blurs the element. */
  blur(): void {
    this.domElement?.blur();
  }

  /** `readonly` on the element, so a mobile browser does not raise a keyboard for a locked field. */
  setReadOnly(value: boolean): void {
    if (this.domElement) {
      this.domElement.readOnly = value;
    }
  }

  /** Enables/disables the element; a disabled element cannot keep the focus. */
  setEnabled(value: boolean): void {
    const element = this.domElement;
    if (!element) {
      return;
    }
    element.disabled = !value;
    if (!value) {
      element.blur();
    }
  }

  /** Reflects `maxlength` after the widget's option changed. */
  setMaxLength(value: number | null): void {
    const element = this.domElement;
    if (!element) {
      return;
    }
    if (value === null || !Number.isFinite(value) || value < 0) {
      element.removeAttribute('maxlength');
    } else {
      element.setAttribute('maxlength', String(Math.floor(value)));
    }
  }

  /**
   * Masks what the element reports to password managers and to the browser's own UI.
   *
   * Only `<input>` has a `password` type; a text area keeps `text` and is masked by the widget alone.
   */
  setSecure(value: boolean): void {
    const element = this.domElement;
    if (isInputElement(element)) {
      element.type = value ? 'password' : 'text';
      // Chrome drops the selection when the type changes; the widget re-applies it right after.
    }
  }

  /** The canvas' page-space rectangle, or `null` when there is no canvas yet. */
  get canvasRect(): BridgeRect | null {
    const canvas = this.canvas;
    if (!canvas || typeof canvas.getBoundingClientRect !== 'function') {
      return null;
    }
    const rect = canvas.getBoundingClientRect();
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
  }

  /**
   * Positions the element over a widget rect expressed in canvas (design) pixels.
   *
   * `canvasRect` is the canvas' page-space rectangle: the canvas is rarely at the page origin
   * (centred layouts, a wrapper with padding, a scrolled page), so the canvas offset is added to the
   * widget offset. The result is container-relative when Phaser created a DOM container, and
   * page-relative otherwise, which is what `position: absolute` resolves against in both cases.
   */
  place(rect: BridgeRect, canvasRect: BridgeRect): void {
    const element = this.domElement;
    if (!element) {
      return;
    }

    const containerRect = this.container?.getBoundingClientRect?.() ?? null;
    const originX = containerRect ? canvasRect.x - containerRect.left : canvasRect.x;
    const originY = containerRect ? canvasRect.y - containerRect.top : canvasRect.y;
    // The element's own coordinates are in design pixels whenever its container is scaled (which
    // Phaser's DOM container always is under `Scale.FIT`), so the display scale is divided by that
    // container factor — otherwise the overlay is scaled twice: see `containerScale()`.
    const displayX = this.displayScale(canvasRect.width, 'width');
    const displayY = this.displayScale(canvasRect.height, 'height');
    const containerX = this.containerScale('x');
    const containerY = this.containerScale('y');

    element.style.left = `${round2((originX + rect.x * displayX) / containerX)}px`;
    element.style.top = `${round2((originY + rect.y * displayY) / containerY)}px`;
    element.style.width = `${round2(Math.max(1, (rect.width * displayX) / containerX))}px`;
    element.style.height = `${round2(Math.max(1, (rect.height * displayY) / containerY))}px`;
  }

  /**
   * The scale this element's container applies to its children, per axis.
   *
   * Phaser's `game.domContainer` — where this element is mounted (`resolveContainer`) — is not a
   * neutral box: `ScaleManager.refresh()` writes
   * `transform: scale(displaySize / baseSize)` on it for `Scale.FIT`/`ENVELOP`, so a child's `left` and
   * `width` are **design** pixels, not CSS pixels. Measured against the DOM rather than assumed: a
   * container whose rect is larger than its CSS box is scaling its children, and a plain wrapper (or no
   * container at all) reports `1` and keeps the page-relative behaviour.
   *
   * Without this the overlay was scaled **twice** under `Scale.FIT`: a 220×36 field landed as a 35×6
   * element in the wrong place (V39, round 73). Text still reached the model — the bridge only has to be
   * focused — which is why it went unnoticed until the mode itself was tested; the element's box is what
   * the IME candidate window, the soft keyboard's scroll-into-view and mobile Safari's focus zoom
   * follow.
   */
  private containerScale(axis: 'x' | 'y'): number {
    const container = this.container;
    if (!container || typeof getComputedStyle !== 'function') {
      return 1;
    }
    const rect = container.getBoundingClientRect?.();
    if (!rect) {
      return 1;
    }
    const measured = axis === 'x' ? rect.width : rect.height;
    const declared = Number.parseFloat(
      axis === 'x' ? getComputedStyle(container).width : getComputedStyle(container).height,
    );
    if (
      !Number.isFinite(declared) ||
      declared <= 0 ||
      !Number.isFinite(measured) ||
      measured <= 0
    ) {
      return 1;
    }
    return measured / declared;
  }

  /** Unhooks the element and forgets it; the bridge cannot be reused afterwards. */
  dispose(): void {
    this.detach();
    this.handlers = {};
  }

  /**
   * Canvas CSS size ÷ the size the widget rects are expressed in.
   *
   * A `Scale.FIT` canvas is displayed smaller (or larger) than the game's coordinate space, so a
   * design-pixel rect has to be scaled before it becomes a CSS pixel — and that coordinate space is the
   * *layout* space, which is not the game size when the page renders at device resolution (a camera
   * zoomed by `devicePixelRatio` over a game that many times bigger; see
   * `UIRootOptions.designResolution`).
   *
   * The plugin already resolves exactly that ratio in physical pixels per layout unit, so this is it
   * divided by the device pixel ratio — one formula, one place. Falls back to canvas ÷ game size when
   * there is no plugin (an unmagnified game, where the two agree anyway).
   */
  private displayScale(canvasSize: number, axis: 'width' | 'height'): number {
    const gameSize = this.scene?.scale?.gameSize;
    const logical = axis === 'width' ? gameSize?.width : gameSize?.height;
    if (!logical || !Number.isFinite(logical) || logical <= 0 || !Number.isFinite(canvasSize)) {
      return 1;
    }
    const device = (globalThis as { devicePixelRatio?: number }).devicePixelRatio;
    const physical = (this.scene as { mvvm?: { renderScale?: number } } | undefined)?.mvvm
      ?.renderScale;
    if (
      typeof physical === 'number' &&
      Number.isFinite(physical) &&
      physical > 0 &&
      typeof device === 'number' &&
      Number.isFinite(device) &&
      device > 0
    ) {
      return physical / device;
    }
    return canvasSize / logical;
  }
}

/**
 * `instanceof HTMLInputElement` with the global reference guarded.
 *
 * The class body never runs in Node (there is no element at all), but `instanceof` evaluates its
 * right-hand operand even for `null`, and `HTMLInputElement` does not exist in a Node process — which
 * would turn a harmless no-op into a `ReferenceError`.
 */
function isInputElement(
  element: HTMLInputElement | HTMLTextAreaElement | null,
): element is HTMLInputElement {
  return (
    element !== null &&
    typeof HTMLInputElement !== 'undefined' &&
    element instanceof HTMLInputElement
  );
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Phaser creates `game.domContainer` only for `dom: { createContainer: true }` with a `parent`. */
function resolveContainer(scene: Phaser.Scene): HTMLElement | null {
  const game = (scene as { sys?: { game?: { domContainer?: HTMLElement | null } } }).sys?.game;
  const container = game?.domContainer;
  return container ?? null;
}

function resolveCanvas(scene: Phaser.Scene): HTMLCanvasElement | null {
  const game = (scene as { sys?: { game?: { canvas?: HTMLCanvasElement | null } } }).sys?.game;
  return game?.canvas ?? null;
}

/** Test seam: forgets that the "no DOM container" warning was printed. */
export function resetBridgeWarning(): void {
  warned = false;
}
