/**
 * `ModalHost` — the overlay layer of a scene: the `Dialog` of this framework (PLAN M8).
 *
 * A modal is *not* a widget: it is a full-stage layer pushed above the page, so it needs three
 * things no single widget can arrange on its own:
 *
 * 1. **A place above everything.** The layer is the root's last child, and in a Phaser container
 *    that is what "drawn on top" means. `mount()` re-raises the open layers, so a page swapped in
 *    while a dialog is open cannot hide it.
 * 2. **A shield.** The layer carries a hit area over the whole stage and is set as the router's
 *    capture (`InputRouter#setCapture`), so a press that misses the dialog cannot reach the page (or
 *    the game objects) underneath. The scrim is the visible half of the same idea: a themed
 *    translucent rectangle that also swallows the click that dismisses the dialog.
 * 3. **A focus trap.** The layer is pushed as a new `FocusManager` scope
 *    (`trap: true`, `focusFirst: true`), so `Tab`, the arrows and pointer focus all stay inside the
 *    dialog, and the widget that had focus on the page gets it back when the dialog closes.
 *
 * ```ts
 * const dialog = this.mvvm.modal.open(() => {
 *   Panel({ width: 420, padding: 20, gap: 12 }, () => {
 *     Text('删除这一项？');
 *     Row({ gap: 8, justifyContent: 'end' }, () => {
 *       Button('取消', { variant: 'ghost', onClick: () => dialog.close() });
 *       Button('删除', { variant: 'danger', onClick: confirm });
 *     });
 *   });
 * });
 * ```
 *
 * The content lambda runs in its own UI scope (`runInUiScope`), so containers inside it nest
 * normally and nothing it builds attaches to the page's tree.
 *
 * Escape is wired through `FocusManager.onBack`, which the plugin points at `handleBack()` before it
 * falls back to the app's own `onBack`: a dialog gets first refusal on `back`, and a dialog that is
 * deliberately not dismissible *swallows* the key rather than letting the page act on it.
 */

import { devLog, isDevMode, warn } from '@phaser-mvvm/core';
import type { MVVMPlugin } from './plugin';
import { StackWidget } from './LayoutWidget';
import { Widget } from './Widget';
import { RectWidget } from './widgets';
import { getTheme, onThemeChange } from './theme';
import { modalTransitionTargets, type TransitionOverride } from './transition';
import { buildUiPage } from './ui-build';

/** How a modal was closed. */
export type ModalCloseReason = 'api' | 'back' | 'backdrop' | 'scene';

export interface ModalOptions {
  /**
   * Whether Escape and a click on the scrim close the modal. Defaults to `true`.
   *
   * A non-dismissible modal still *swallows* Escape, so the page's own `onBack` does not run while
   * it is up: a dialog that must be answered has to be answered.
   */
  dismissible?: boolean;
  /**
   * Scrim opacity, `0`…`1`. Defaults to `0.5`. `0` draws no scrim and lets the layer's own hit area
   * do the blocking; a backdrop click still dismisses when `dismissible`.
   */
  scrim?: number;
  /** Takes keyboard focus on open. Defaults to `true`. */
  autoFocus?: boolean;
  /** Widget to focus on open; defaults to the first focusable widget of the content. */
  initialFocus?: Widget | null;
  /** Debug name of the layer (and of the dev traces). Defaults to `modal#<n>`. */
  name?: string;
  /**
   * Motion for this layer only: `false` to appear and disappear on the spot, or a transition spec to
   * override the plugin's policy for this dialog (a big dialog may want a longer fade than a tooltip).
   * Defaults to the policy from `MVVMPlugin.configure({ transition: … })`.
   */
  transition?: TransitionOverride;
  /**
   * Called once, when the modal leaves the stack.
   *
   * Not "once the layer is gone": with an exit animation the layer is still fading out for another
   * `transition.exit` milliseconds. Closing is immediate (focus, input and the stack are updated in
   * the same call), only the paint is deferred — see `ModalHost#closeEntry`.
   */
  onClose?: (reason: ModalCloseReason) => void;
}

/** What `open()` hands back: the layer, its content, and a way to close it. */
export interface ModalHandle {
  /** Creation order, starting at 1. */
  readonly id: number;
  /** The overlay layer (a full-stage container holding the scrim and the content). */
  readonly widget: Widget;
  /** The widget the content lambda built. */
  readonly content: Widget;
  /** `false` once the modal was closed. */
  readonly open: boolean;
  /** Whether Escape / a backdrop click may close it. */
  readonly dismissible: boolean;
  /** Closes this modal (and anything opened on top of it). Returns `false` if already closed. */
  close(reason?: ModalCloseReason): boolean;
}

/** One open modal. The `readonly` fields mirror `ModalHandle` without the methods. */
interface ModalEntry {
  readonly id: number;
  readonly widget: Widget;
  readonly content: Widget;
  /** The translucent rectangle behind the content, when the modal draws one (built just below). */
  scrim: Widget | null;
  readonly options: ModalOptions;
  readonly dismissible: boolean;
  closed: boolean;
}

/**
 * A container that swallows pointer input reaching it.
 *
 * The router recognises `blockPointer` by shape (`collectInteractive`), and the flag means exactly
 * what the layer needs: "this widget is a target, but activating it does nothing". Declaring it here
 * keeps the modal's shielding out of the base widget class.
 */
class ModalLayer extends StackWidget {
  readonly blockPointer = true;
}

export class ModalHost {
  private readonly plugin: MVVMPlugin;
  private readonly stack: ModalEntry[] = [];
  private counter = 0;

  constructor(plugin: MVVMPlugin) {
    this.plugin = plugin;
  }

  /** Number of open modals. */
  get depth(): number {
    return this.stack.length;
  }

  /** The top-most open modal, or `null`. */
  get top(): ModalHandle | null {
    const entry = this.stack[this.stack.length - 1];
    return entry ? this.handleOf(entry) : null;
  }

  /** Every open modal, bottom to top. */
  get handles(): readonly ModalHandle[] {
    return this.stack.map((entry) => this.handleOf(entry));
  }

  /**
   * Builds `content` in its own UI scope and shows it as a modal.
   *
   * Throws when the lambda builds nothing: an empty dialog is always a mistake, and the message
   * names the alternative (an early `return` inside the lambda) the way `ui()` does.
   */
  open(content: () => void, options: ModalOptions = {}): ModalHandle {
    const plugin = this.plugin;
    const root = plugin.root;
    const scene = root.scene;
    const id = ++this.counter;
    const name = options.name ?? `modal#${id}`;

    // One rule for every view lambda, shared with `ui()` and `pages.push()` (ui-build.ts).
    const body = buildUiPage(scene, content, 'modal.open()').root;

    // Layout params are flat on the layout containers (not nested under `layout`, which only the
    // `WidgetOptions`-style constructors such as `UIRoot` use).
    const layer = new ModalLayer(scene, {
      align: 'center',
      name,
      width: '100%',
      height: '100%',
    });
    scene.add.existing(layer);

    const dismissible = options.dismissible !== false;
    const entry: ModalEntry = {
      id,
      widget: layer,
      content: body,
      scrim: null,
      options,
      dismissible,
      closed: false,
    };
    this.stack.push(entry);

    const scrimAlpha = clamp01(options.scrim ?? 0.5);
    if (scrimAlpha > 0) {
      const scrim = new RectWidget(scene, {
        color: getTheme().colors.overlay,
        alpha: scrimAlpha,
        name: `${name}.scrim`,
        width: '100%',
        height: '100%',
      });
      // The scrim is the one `Rect` in the framework that paints a **theme token** (`overlay`, which is
      // black in the dark theme and a blue-grey in the light one), and `Rect` takes a plain colour
      // literal, so it does not follow a theme change on its own. Without this a dialog opened in the
      // dark kept its black veil over a light page — measured: open in dark → fill `#000000`; switch to
      // light while open → still `#000000` while `theme.colors.overlay` is `#1f2328`; a dialog opened
      // *after* the switch got `#1f2328` (V38, round 71). The subscription rides the scrim's own scope,
      // so closing the dialog (which destroys it) releases it: `themeListenerCount()` stays flat.
      const unsubscribeScrim = onThemeChange((theme) => {
        scrim.setColor(theme.colors.overlay);
      });
      scrim.scope.onScopeDispose(() => unsubscribeScrim());
      scene.add.existing(scrim);
      layer.addWidget(scrim);
      entry.scrim = scrim;

      // The scrim is decoration with one job: a click on it dismisses. It must not take focus or
      // show a hover state of its own.
      scrim.focusable = false;
      if (dismissible) {
        scrim.onActivate = () => {
          this.closeEntry(entry, 'backdrop');
        };
      }
    } else if (dismissible) {
      // No scrim means no rectangle to click, so the layer's own hit area is the backdrop.
      layer.onActivate = () => {
        this.closeEntry(entry, 'backdrop');
      };
    }
    layer.addWidget(body);

    // The layer has to be in the tree *and* laid out before the router can hit-test it:
    // `setCapture` sizes its hit area from the rect the engine just wrote.
    root.addWidget(layer);
    plugin.refreshInteraction();
    plugin.input.setCapture(layer);
    plugin.focus.pushScope(layer, {
      trap: true,
      focusFirst: options.autoFocus !== false && !options.initialFocus,
    });
    if (options.initialFocus) {
      plugin.focus.focus(options.initialFocus);
    }

    // The appear animation runs last, so the layer has already been laid out and the capture sized:
    // nothing below depends on the layer being opaque, and fading in from the first frame means the
    // dialog is never painted fully visible for one frame. The scrim and the body fade together (two
    // targets, one group), while only the body scales — scaling the *layer* would shrink the whole
    // stage towards its top-left corner.
    const motion = plugin.transitionFor(options.transition);
    const entered = plugin.transitions.runGroup(
      modalTransitionTargets(entry, motion.enter),
      undefined,
    );
    if (isDevMode()) {
      devLog(
        `modal.open: ${name} (depth ${this.stack.length}, dismissible ${dismissible})` +
          (entered > 0
            ? ` — entering over ${motion.enter.duration} ms (${motion.enter.easing})`
            : ' — no enter animation'),
      );
    }
    return this.handleOf(entry);
  }

  /**
   * Closes the top-most modal.
   *
   * @returns `false` when nothing was open (so a host can fall through to its own `back` handling).
   */
  closeTop(reason: ModalCloseReason = 'api'): boolean {
    const entry = this.stack[this.stack.length - 1];
    if (!entry) {
      return false;
    }
    return this.closeEntry(entry, reason);
  }

  /** Closes every modal, top down. */
  closeAll(reason: ModalCloseReason = 'api'): void {
    while (this.closeTop(reason)) {
      // `closeTop` removes one entry per pass.
    }
  }

  /**
   * Handles a `back` action (Escape, gamepad B/○).
   *
   * The return value is "the key was consumed", not "a modal closed": a non-dismissible modal
   * consumes Escape without closing, which is what keeps the page underneath from acting on it.
   */
  handleBack(): boolean {
    const entry = this.stack[this.stack.length - 1];
    if (!entry) {
      return false;
    }
    if (!entry.dismissible) {
      if (isDevMode()) {
        devLog(`modal.back: ${entry.widget.name} is not dismissible — the key is swallowed`);
      }
      return true;
    }
    return this.closeEntry(entry, 'back');
  }

  /**
   * Puts the open layers back on top of the root's children.
   *
   * `MVVMPlugin.mount()` calls this: mounting a page appends it to the root, which would otherwise
   * paint a new page over an open dialog.
   */
  raiseLayers(): void {
    if (this.stack.length === 0) {
      return;
    }
    const root = this.plugin.root;
    for (const entry of this.stack) {
      if (entry.widget.isDestroyed === true || entry.widget.parent !== root) {
        continue;
      }
      root.removeWidget(entry.widget, false);
      root.addWidget(entry.widget);
    }
  }

  /**
   * Drops every modal without touching the scene.
   *
   * Called from the plugin's teardown, where the widgets are about to be destroyed together with the
   * UI root: the layer must not be removed one by one (the root is going away anyway), but the
   * handles have to stop claiming to be open and the app still gets its `onClose` notifications.
   */
  dispose(): void {
    const entries = this.stack.splice(0, this.stack.length);
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (!entry || entry.closed) {
        continue;
      }
      entry.closed = true;
      entry.options.onClose?.('scene');
    }
  }

  private closeEntry(entry: ModalEntry, reason: ModalCloseReason): boolean {
    if (entry.closed) {
      return false;
    }
    const index = this.stack.indexOf(entry);
    if (index === -1) {
      return false;
    }

    // A modal opened on top of this one is painted above it and traps focus; closing the lower one
    // silently would leave the upper one floating over a page it no longer belongs to.
    for (let i = this.stack.length - 1; i > index; i--) {
      const above = this.stack[i];
      if (above) {
        warn(
          `modal.close: "${entry.widget.name}" was closed while "${above.widget.name}" was open ` +
            `on top of it; the modal above was closed first.`,
        );
        this.closeEntry(above, 'api');
      }
    }

    this.stack.pop();
    entry.closed = true;

    // Focus first (the widgets are still alive, so their rings clear cleanly), then the tree.
    const root = this.plugin.root;
    this.plugin.focus.popScope();
    this.plugin.input.setCapture(this.stack[this.stack.length - 1]?.widget ?? null);
    this.plugin.refreshInteraction();
    root.flushLayout();

    entry.options.onClose?.(reason);

    // The exit animation is the one place where "the modal is closed" and "the layer is gone" come
    // apart, and it is worth being precise about which is which:
    //
    // - *Closing* is immediate and synchronous. The entry left the stack, focus went back to the page,
    //   the capture is the layer below, and `handle.open` is already `false` — so `Esc`, a second
    //   backdrop click and the app's own code all behave exactly as they did before transitions
    //   existed, and `close()` keeps returning `true` on the spot.
    // - *Painting* is deferred: the layer fades out in the tree and is destroyed when the group ends.
    //   Until then it still swallows clicks, which is deliberate — a dialog that has just been
    //   dismissed must not pass the same tap through to the button underneath it.
    //
    // A zero-length exit (the default policy in a `prefers-reduced-motion` page, or `transition: false`)
    // therefore takes the old path exactly: removed and destroyed inside this call.
    const motion = this.plugin.transitionFor(entry.options.transition);
    const destroy = (): void => {
      if (entry.widget.isDestroyed !== true) {
        root.removeWidget(entry.widget, true);
        this.plugin.refreshInteraction();
        root.flushLayout();
      }
      if (isDevMode()) {
        devLog(`modal.close: ${entry.widget.name} freed (${reason})`);
      }
    };

    const leaving = this.plugin.transitions.runGroup(
      modalTransitionTargets(entry, motion.exit),
      destroy,
    );
    if (leaving === 0) {
      destroy();
    }

    if (isDevMode()) {
      devLog(
        `modal.close: ${entry.widget.name} (${reason}, depth ${this.stack.length})` +
          (leaving > 0 ? ` — leaving over ${motion.exit.duration} ms (${motion.exit.easing})` : ''),
      );
    }
    return true;
  }

  private handleOf(entry: ModalEntry): ModalHandle {
    return {
      id: entry.id,
      widget: entry.widget,
      content: entry.content,
      get open(): boolean {
        return !entry.closed;
      },
      dismissible: entry.dismissible,
      close: (reason: ModalCloseReason = 'api'): boolean => this.closeEntry(entry, reason),
    };
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0.5;
  }
  return Math.min(1, Math.max(0, value));
}
