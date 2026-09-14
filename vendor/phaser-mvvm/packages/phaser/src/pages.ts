/**
 * `PageHost` — the page stack of a scene: `this.mvvm.pages`.
 *
 * A "page" is a whole view (one `ui()`-style lambda) that covers the screen. The host keeps a stack of
 * them under the plugin's UI root, which is what turns three ordinary requirements into a formality:
 *
 * - **Back returns.** `Escape`/gamepad B pops the top page, and the page below comes back exactly as
 *   it was left — its widgets were never destroyed, only hidden, so a scrolled list stays scrolled and
 *   a half-filled form keeps its text;
 * - **Focus follows the page.** Pushing a page is `FocusManager.pushScope()` (the same mechanism a
 *   modal uses), so `Tab` walks the page that is on screen, and popping hands focus back to whatever
 *   was focused on the page underneath;
 * - **Nothing stacks up behind your back.** Pages below the top one are hidden (`visible: false`), so
 *   they are out of the layout flow, unfocusable and unclickable without being thrown away.
 *
 * ```ts
 * this.mvvm.pages.push(() => {
 *   Column({ padding: 20, gap: 12 }, () => {
 *     Text(() => `详情 · ${row.name}`, { size: 'lg' });
 *     Button('返回', { onClick: () => this.mvvm.pages.pop() });
 *   });
 * }, { onResume: () => reload(row.id) });
 * ```
 *
 * Ordering against overlays: the root's children are painted in order, so a page pushed *after* a
 * dialog was opened would cover it. `push()` therefore re-raises the modal layers (`raiseLayers()`),
 * and a dialog always stays on top of every page.
 *
 * What the host deliberately does **not** do: routing/URLs, transitions, or destroying the last page.
 * Popping the base page would leave an empty screen, so `pop()` refuses it and `handleBack()` lets the
 * app's own `onBack` run instead.
 */

import { devLog, isDevMode } from '@phaser-mvvm/core';
import type { PageBackTarget } from './back-plan';
import { planPageMotion, type PageMotionPlan } from './page-motion';
import type { TransitionOverride, TransitionRun } from './transition';
import type { MVVMPlugin } from './plugin';
import type { Widget } from './Widget';
import { buildUiPage } from './ui-build';

export interface PageOptions {
  /** Debug name of the page (also what `pages.names()` reports). Defaults to `page#<n>`. */
  name?: string;
  /**
   * Called when the page becomes the visible one: right after `push()`, and again when a page above
   * it is popped. Refresh data here — the page itself was never rebuilt.
   */
  onResume?: (page: PageHandle) => void;
  /** Called when a page is covered by another one (or removed) and stops being the visible page. */
  onPause?: (page: PageHandle) => void;
  /** Called after the page's widgets are gone (popped or the scene shut down). */
  onDispose?: (page: PageHandle) => void;
  /**
   * First refusal on `back` while this page is on top.
   *
   * Return `true` when the page handled it itself (a confirmation dialog, a dirty-form prompt); the
   * host then neither pops nor forwards the action.
   */
  onBack?: (page: PageHandle) => boolean;
  /**
   * Motion for this page only: `false` to appear and disappear instantly, or a transition spec to
   * override the plugin's policy for it. Defaults to the policy from
   * `MVVMPlugin.configure({ transition: … })`, which is what the modal layers use too.
   */
  transition?: TransitionOverride;
}

/** What `push()` hands back: the page's widgets and its place in the stack. */
export interface PageHandle {
  /** Creation order, starting at 1. */
  readonly id: number;
  /** The page's root widget. */
  readonly widget: Widget;
  /** Name reported by `pages.names()` and used in the dev traces. */
  readonly name: string;
  /** 1 for the base page, 2 for the page above it, … */
  readonly depth: number;
  /** `true` while this page is the visible one. */
  readonly active: boolean;
  /** `false` once the page was popped (or the scene went away). */
  readonly open: boolean;
  /** Pops this page and everything above it. Returns `false` when it was already gone. */
  pop(): boolean;
}

/** One page on the stack. */
interface PageEntry {
  readonly id: number;
  readonly widget: Widget;
  readonly name: string;
  readonly options: PageOptions;
  closed: boolean;
}

/**
 * Which layer should handle a `back` action (Escape / gamepad B).
 *
 * The whole rule in one pure function, so it can be tested in Node instead of only through the
 * browser:
 *
 * 1. **a modal owns it first** — including the case where it is deliberately not dismissible, which
 *    *swallows* the action rather than letting the page below act on a question that must be answered;
 * 2. **then the page stack**, but only while there is a page to go back *to*: popping the base page
 *    would leave an empty screen, so a single-page app falls through;
 * 3. **then the app** (`config.onBack` / `focus.onBack`).
 */
export function planBack(state: { modalDepth: number; pageDepth: number }): PageBackTarget {
  if (state.modalDepth > 0) {
    return 'modal';
  }
  return state.pageDepth > 1 ? 'page' : 'app';
}

/** {@link PageBackTarget} lives in `back-plan.ts` (Phaser-free) and is re-exported here for callers. */
export type { PageBackTarget };

export class PageHost {
  private readonly plugin: MVVMPlugin;
  private readonly stack: PageEntry[] = [];
  private counter = 0;
  /**
   * Moves that are still being animated.
   *
   * Each entry knows how to apply its own end state (hide the page that was covered / destroy the page
   * that left). A new stack move **finishes them first**, so fast tapping snaps the previous cross fade
   * to its end instead of leaving a page painted that nothing will ever hide — `TransitionRunner#cancel`
   * deliberately does not call a run's `onDone`, which is exactly why the finaliser has to live here.
   */
  private readonly pending: Array<{ readonly finish: () => void; readonly targets: Widget[] }> = [];
  /** The page a `pop()` is currently fading out, if any (it is already off the stack). */
  private departingEntry: PageEntry | null = null;

  constructor(plugin: MVVMPlugin) {
    this.plugin = plugin;
  }

  /** Number of pages on the stack. */
  get depth(): number {
    return this.stack.length;
  }

  /** The visible page, or `null` before the first `push()`. */
  get top(): PageHandle | null {
    const entry = this.stack[this.stack.length - 1];
    return entry ? this.handleOf(entry) : null;
  }

  /** Every page, bottom to top. */
  get handles(): readonly PageHandle[] {
    return this.stack.map((entry) => this.handleOf(entry));
  }

  /** Names of the pages, bottom to top. */
  names(): string[] {
    return this.stack.map((entry) => entry.name);
  }

  /**
   * The page that is fading out right now, or `null`.
   *
   * A popped page leaves the stack immediately (its handle is closed, focus has already moved on) but is
   * still painted for one `transition.exit`, and this is the only way to name it — for a dev trace, or
   * for a check that wants to read its alpha.
   */
  get departing(): PageHandle | null {
    return this.departingEntry ? this.handleOf(this.departingEntry) : null;
  }

  /**
   * Builds `content` in its own UI scope and shows it as the new top page.
   *
   * The page that was on top is hidden, not destroyed: `pop()` brings it back byte for byte. That is
   * also why pushing is cheap — no widget is rebuilt, only re-shown and re-laid out.
   */
  push(content: () => void, options: PageOptions = {}): PageHandle {
    const plugin = this.plugin;
    const root = plugin.root;
    const scene = root.scene;
    const id = ++this.counter;
    const name = options.name ?? `page#${id}`;

    const built = buildUiPage(scene, content, 'pages.push()');
    const widget = built.root;

    const entry: PageEntry = { id, widget, name, options, closed: false };
    this.stack.push(entry);

    const previous = this.stack[this.stack.length - 2];
    const motion = this.motionFor('forward', entry);
    if (previous && previous.widget.isDestroyed !== true) {
      // The page below stays **painted** while the new one fades in over it: hiding it first would show
      // the background through the fade. It loses its routing instead, so a click during those 160 ms
      // cannot land on a page the user has already left (`Widget#routingEnabled`).
      previous.widget.routingEnabled = motion.incoming === null;
      if (motion.incoming === null) {
        previous.widget.setVisible(false);
      }
      previous.options.onPause?.(this.handleOf(previous));
    }

    root.addWidget(widget);

    // The scope goes in **before** the interaction refresh, and that order is load-bearing:
    // `pushScope()` remembers what the page below had focused by reading the *live* collection of its
    // scope, and `refreshInteraction()` re-collects the current top scope — which is the page we just
    // hid, so its collection (and with it the focused widget) is wiped. Refreshing first therefore
    // suspended *nothing*, and popping a page silently dropped focus instead of handing it back
    // (measured on `#/pages`).
    plugin.focus.pushScope(widget);

    // A dialog opened before this page must stay on top of it (children paint in order).
    plugin.modal.raiseLayers();
    plugin.refreshInteraction();

    options.onResume?.(this.handleOf(entry));

    if (motion.incoming !== null && previous && previous.widget.isDestroyed !== true) {
      // The cross fade: the incoming page goes from alpha 0 to its own value while the page below keeps
      // painting. One target, one run, and the end state is a single `setVisible(false)`.
      this.finishPending();
      const covered = previous;
      this.runMotion([{ target: widget, transition: motion.incoming, props: ['alpha'] }], () => {
        if (covered.widget.isDestroyed !== true) {
          covered.widget.routingEnabled = true;
          // Only hide it while it is still covered. A push that is popped *while its own fade is running*
          // makes the page below the visible one again — and this finaliser is then a leftover from a
          // move that no longer applies. Hiding it anyway left the revealed page invisible, so its focus
          // scope collected nothing and `Tab` had nowhere to go (measured on `#/pages`: `focusables` 18 →
          // 0 after one `open()` + immediate `pop()`, which is exactly what `churn()` does).
          if (this.stack[this.stack.length - 1] !== covered) {
            covered.widget.setVisible(false);
          }
          this.plugin.refreshInteraction();
          this.plugin.root.flushLayout();
        }
        if (isDevMode()) {
          devLog(`pages.push: ${covered.name} settled after the transition`);
        }
      });
    }

    if (isDevMode()) {
      devLog(
        `pages.push: ${name} (depth ${this.stack.length}, ${built.widgets} widget(s))` +
          (motion.incoming === null ? '' : ` — fading in over ${motion.incoming.duration} ms`),
      );
    }
    return this.handleOf(entry);
  }

  /**
   * Removes the top page and shows the one below it.
   *
   * @returns `false` when there is nothing to pop, or when only the base page is left (popping it
   * would leave an empty screen — let the app's own `back` handling decide what that means).
   */
  pop(): boolean {
    if (this.stack.length <= 1) {
      return false;
    }
    const entry = this.stack.pop();
    if (!entry) {
      return false;
    }
    const next = this.stack[this.stack.length - 1];

    // Order matters. The page coming back has to be **visible before the scope pops**: `popScope()`
    // restores focus by re-collecting that page's widgets, and a hidden page collects to nothing, so
    // popping first dropped focus instead of handing it back (found by the `#/pages` sweep).
    if (next && next.widget.isDestroyed !== true) {
      next.widget.setVisible(true);
      // Routed again, whatever a half-finished transition left behind: it is the page the user is on now.
      next.widget.routingEnabled = true;
      // It was out of flow while hidden, so lay it out again before anything reads its geometry.
      this.plugin.root.flushLayout();
    }

    this.plugin.focus.popScope();

    // The leaving page is the one that fades here (the revealed page is simply there — fading it in would
    // flash the background). It stays painted above the revealed page until its run ends, with routing
    // off, and is destroyed then: "closed" is immediate, "gone" is 120 ms later, exactly like the modal.
    const motion = this.motionFor('back', entry);
    this.finishPending();
    if (motion.outgoing === null) {
      this.departingEntry = null;
      this.destroyPage(entry);
    } else {
      entry.widget.routingEnabled = false;
      const leaving = entry;
      this.departingEntry = leaving;
      this.plugin.refreshInteraction();
      this.runMotion(
        [{ target: leaving.widget, transition: motion.outgoing, props: ['alpha'] }],
        () => {
          if (this.departingEntry === leaving) {
            this.departingEntry = null;
          }
          this.destroyPage(leaving);
        },
      );
    }

    if (next && next.widget.isDestroyed !== true) {
      this.plugin.modal.raiseLayers();
      this.plugin.refreshInteraction();
      next.options.onResume?.(this.handleOf(next));
    }
    if (isDevMode()) {
      devLog(
        `pages.pop: ${entry.name} (depth ${this.stack.length})` +
          (motion.outgoing === null ? '' : ` — fading out over ${motion.outgoing.duration} ms`),
      );
    }
    return true;
  }

  /** Pops everything above the base page. */
  popToRoot(): void {
    while (this.stack.length > 1) {
      if (!this.pop()) {
        break;
      }
    }
  }

  /**
   * Removes `handle` and every page above it.
   *
   * Used by `PageHandle.pop()`, which is what a page's own "返回" button calls.
   */
  close(handle: PageHandle): boolean {
    const index = this.stack.findIndex((entry) => entry.id === handle.id);
    // `index === 0` is the base page: popping it would leave an empty screen, so a request for it is
    // refused rather than quietly closing whatever happens to be on top.
    if (index <= 0) {
      return false;
    }
    while (this.stack.length > index + 1) {
      if (!this.pop()) {
        break;
      }
    }
    return this.pop();
  }

  /**
   * Handles a `back` action: pops the top page unless it claims the action for itself.
   *
   * @returns `true` when the action was consumed.
   */
  handleBack(): boolean {
    const entry = this.stack[this.stack.length - 1];
    if (!entry || this.stack.length <= 1) {
      return false;
    }
    if (entry.options.onBack?.(this.handleOf(entry)) === true) {
      if (isDevMode()) {
        devLog(`pages.back: ${entry.name} handled the action itself`);
      }
      return true;
    }
    return this.pop();
  }

  /**
   * Drops every page without touching the scene.
   *
   * Called from the plugin's teardown, where the widgets are about to be destroyed with the UI root:
   * the pages must stop claiming to be visible, and the app still gets its `onDispose` notifications.
   */
  dispose(): void {
    // Every page dies with the UI root, so the finalisers must not run: they would touch a root that is
    // being destroyed (and `destroyPage` would tell `onDispose` twice for the same page).
    this.pending.length = 0;
    this.departingEntry = null;
    const entries = this.stack.splice(0, this.stack.length);
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (!entry || entry.closed) {
        continue;
      }
      entry.closed = true;
      entry.options.onDispose?.(this.handleOf(entry));
    }
  }

  /** Tears one page's subtree down and tells its `onDispose`. The scope is popped by the caller. */
  /**
   * The motion a stack move wants, resolved from the plugin policy plus the page's own override.
   *
   * Resolved at the moment of the move (not cached), so `mvvm.configure({ transition: … })` and a
   * `prefers-reduced-motion` change both reach the next navigation.
   */
  private motionFor(direction: 'forward' | 'back', entry: PageEntry): PageMotionPlan {
    return planPageMotion(direction, this.plugin.transitionFor(entry.options.transition));
  }

  /**
   * Starts a move's runs and remembers how to finish it if another move interrupts.
   *
   * The runner's `cancel()` deliberately does not call a run's `onDone` (a scene teardown must not touch
   * a dying tree), so the end state — hide the covered page, destroy the leaving one — is kept here.
   */
  private runMotion(runs: readonly TransitionRun[], finish: () => void): number {
    const started = this.plugin.transitions.runGroup(runs, () => {
      const index = this.pending.findIndex((entry) => entry.finish === finish);
      if (index !== -1) {
        this.pending.splice(index, 1);
      }
      finish();
    });
    if (started > 0) {
      this.pending.push({ finish, targets: runs.map((run) => run.target as Widget) });
    }
    return started;
  }

  /** Applies the end state of every move still in flight — a new navigation snaps them to their end. */
  private finishPending(): void {
    if (this.pending.length === 0) {
      return;
    }
    const moves = this.pending.splice(0, this.pending.length);
    for (const move of moves) {
      for (const target of move.targets) {
        this.plugin.transitions.cancel(target);
      }
      move.finish();
    }
  }

  private destroyPage(entry: PageEntry): void {
    entry.closed = true;
    const root = this.plugin.root;
    if (entry.widget.isDestroyed !== true) {
      root.removeWidget(entry.widget, true);
    }
    this.plugin.refreshInteraction();
    root.flushLayout();
    entry.options.onDispose?.(this.handleOf(entry));
  }

  /**
   * A handle for one page.
   *
   * The position-dependent members are getters that look the entry up in the live stack, because a
   * handle outlives the position it was created at (a page keeps its handle in a closure to implement
   * its own back button, and the stack changes underneath it).
   */
  private handleOf(entry: PageEntry): PageHandle {
    // `host` instead of `this` inside the getters: inside an object literal `this` is the handle.
    const host = this;
    const index = (): number => host.stack.indexOf(entry);
    return {
      id: entry.id,
      widget: entry.widget,
      name: entry.name,
      get depth(): number {
        return index() + 1;
      },
      get active(): boolean {
        return !entry.closed && index() === host.stack.length - 1;
      },
      get open(): boolean {
        return !entry.closed;
      },
      pop: (): boolean => this.close(this.handleOf(entry)),
    };
  }
}
