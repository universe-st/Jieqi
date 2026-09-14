/**
 * `UIScene` — a Scene whose whole job is one view. The `setContent { … }` of this framework.
 *
 * A UI scene used to be four lines of ceremony around the view itself:
 *
 * ```ts
 * export class HelloScene extends Phaser.Scene {
 *   constructor() { super('hello'); }
 *   create(): void {
 *     render(this.mvvm, () => { … });
 *   }
 * }
 * ```
 *
 * `UIScene` folds the ceremony into the base class, so the only thing left is the view:
 *
 * ```ts
 * export class HelloScene extends UIScene {
 *   constructor() { super('hello'); }
 *   protected content(): void {
 *     Panel({ padding: 20 }, () => { … });
 *   }
 * }
 * ```
 *
 * Three things it adds beyond the typing:
 *
 * - **`content()` is built and mounted for you** — the same rule as `render()` (`buildUiPage`),
 *   including the "zero roots is an error, several roots get a warning and a wrapper" contract;
 * - **`setContent()` replaces the page**, which is what a view that swaps between genuinely different
 *   shapes needs (a tab strip whose content is a different tree, not the same tree with `visible`
 *   flipped): the old tree is destroyed, the new one is mounted, and focus/pointer/a11y all re-collect
 *   through the plugin's existing structural-change path;
 * - **`onBack()` is first refusal on the `back` action** (Escape / gamepad B) before the app-level
 *   handler runs.
 *
 * Use it when the scene *is* the page. Use a plain `Phaser.Scene` with `render()`/`ui()` when the UI is
 * one part of the scene's work (a HUD pinned over a running world, two independent roots, a subtree
 * handed to `mvvm.modal.open()`).
 */

import Phaser from 'phaser';
import { devLog, isDevMode } from '@phaser-mvvm/core';
import { requireMVVMPlugin } from './require-plugin';
import { buildUiPage, type BuiltUi } from './ui-build';
import type { Widget } from './Widget';

/** What the scene plugin looks for on a `UIScene` when the `back` action reaches the app level. */
export interface UISceneBackHook {
  /**
   * Marker, so the plugin only calls `onBack()` on a scene that opted in. Without it, any scene with
   * an unrelated method of that name would suddenly be consulted on Escape.
   */
  readonly backHook?: boolean;
  onBack?: () => boolean | void;
}

export abstract class UIScene extends Phaser.Scene {
  /** @internal seen by `MVVMPlugin.handleBack()`; see {@link UISceneBackHook}. */
  readonly backHook = true;

  private pageWidget: Widget | null = null;
  private lastBuild: BuiltUi | null = null;

  /**
   * The view. Built and mounted once, when the scene starts; call {@link setContent} to replace it.
   *
   * Runs inside a UI scope, exactly like the lambda of `ui()`/`render()`, so composables can be called
   * directly and nested in any order. Override this rather than `create()` — and if you do need
   * `create()` (to wire something around the view), call `super.create()`, because that is what turns
   * `content()` into a mounted page.
   */
  protected abstract content(): void;

  /** Builds and mounts {@link content}. Call `super.create()` if you override this. */
  create(): void {
    this.setContent(() => this.content());
  }

  /**
   * Replaces the page: the current view is destroyed, the new one is built and mounted.
   *
   * Everything on the page goes with it (widgets, bindings, subscriptions, text textures), so this is
   * the right call for a structural switch and the wrong one for a value change — a `ref`-driven slot
   * (`Text(() => …)`, `visible: () => …`) updates in place and costs nothing.
   *
   * ```ts
   * this.setContent(() =>
   *   this.tab.value === 'settings' ? SettingsView() : ProfileView(),
   * );
   * ```
   *
   * Focus, pointer targets and the accessibility mirror are re-collected by `mount()`, and a widget
   * that no longer exists is released rather than left dangling (`FocusManager.collect()`).
   */
  setContent(content: () => void): Widget {
    const plugin = requireMVVMPlugin(this);
    if (this.pageWidget && this.pageWidget.isDestroyed !== true) {
      this.pageWidget.destroy();
    }
    this.pageWidget = null;

    const built = buildUiPage(this, content, 'UIScene.content()');
    this.pageWidget = built.root;
    this.lastBuild = built;
    const mounted = plugin.mount(built.root);
    if (isDevMode()) {
      devLog(`UIScene: content mounted (${built.widgets} widget(s), ${built.roots} root)`);
    }
    return mounted;
  }

  /** The widget built by the current content lambda, or `null` once it is gone. */
  get page(): Widget | null {
    const page = this.pageWidget;
    return page && page.isDestroyed !== true ? page : null;
  }

  /**
   * What the last content lambda produced — widget count, nesting depth, and how many roots it emitted.
   *
   * `roots > 1` means `buildUiPage()` wrapped them in a container instead of failing (and said so in the
   * development log), which is worth being able to assert: "this view is one tree" is a property of the
   * view, not of the reader.
   */
  get contentInfo(): Readonly<BuiltUi> | null {
    return this.lastBuild;
  }

  /**
   * First refusal on `back` (Escape, gamepad B) for this scene, after the modal and page stacks declined
   * it and before the app-level handler runs.
   *
   * Return `true` to consume the action; return `false`/`undefined` (the default) to let the app-level
   * handler have it — `this.mvvm.onBack`, or the `onBack` given to `MVVMPlugin.configure()`.
   */
  protected onBack(): boolean | void {
    return undefined;
  }
}
