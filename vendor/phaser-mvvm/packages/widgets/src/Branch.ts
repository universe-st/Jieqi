/**
 * `Branch` — a container that shows **one of several views** and rebuilds when the selection changes.
 *
 * The DSL's reactive conditional (`visible: () => …`) keeps every node in the tree and flips a flag, so
 * it is the right tool for "this row appears when the value is set". It is the wrong tool for "this
 * panel is a completely different tree depending on the tab": the alternative views would all exist,
 * all be built, and only one be shown. `Branch` is the structural answer, and it is the same move
 * `UIScene.setContent()` makes at page level, one level down:
 *
 * ```ts
 * Branch(
 *   () => this.tab.value,
 *   {
 *     profile: () => { … },   // built only while the key is 'profile'
 *     settings: () => { … },
 *   },
 * );
 * ```
 *
 * What happens on a switch is deliberately unremarkable: the current branch is **destroyed** (widgets,
 * bindings, subscriptions, text textures) and the new one is built through the same rule a page uses
 * (`buildUiPage`: zero roots is an error, several roots are wrapped with a warning). Focus, pointer
 * targets and the accessibility mirror are re-collected by the plugin's existing structural-change
 * path, so a widget in the branch you just left is released rather than left dangling.
 *
 * A key with no branch is not a crash: the current branch is cleared and one development warning names
 * the key (`branch-plan.ts` explains why the lookup cannot be a plain `branches[key]`).
 */

import Phaser from 'phaser';
import { devLog, isDevMode, warn } from '@phaser-mvvm/core';
import {
  BoxWidget,
  buildUiPage,
  type BoxWidgetOptions,
  type BuiltUi,
  type Widget,
} from '@phaser-mvvm/phaser';
import { planBranch, type BranchBuilder, type BranchKey } from './branch-plan';

export interface BranchOptions extends BoxWidgetOptions {
  /** One builder per key. A key that is missing from this map shows nothing. */
  branches: Readonly<Record<string, BranchBuilder | undefined>>;
  /** Key to build first; switched later with `setBranch()`. */
  key?: BranchKey;
}

/**
 * A single-child vertical box whose child is rebuilt when the key changes.
 *
 * It is a `BoxWidget` on purpose: with one child the layout answer is "the child's size", and the
 * container adds nothing of its own (no background, no padding unless asked for).
 */
export class BranchWidget extends BoxWidget {
  private readonly branches: Readonly<Record<string, BranchBuilder | undefined>>;
  private currentKey: string | null = null;
  private hasSelection = false;
  private buildCount = 0;
  private built: BuiltUi | null = null;
  private replaced: Widget | null = null;

  constructor(scene: Phaser.Scene, options: BranchOptions) {
    const { branches, key, ...rest } = options;
    super(scene, { alignItems: 'stretch', ...rest });
    this.branches = branches;
    if (key !== undefined) {
      this.setBranch(key);
    }
  }

  /** Key of the branch on screen (`null` before the first build or after an unknown key). */
  get activeKey(): string | null {
    return this.currentKey;
  }

  /** How many times a branch has been built — the "did it really rebuild?" number. */
  get builds(): number {
    return this.buildCount;
  }

  /** What the branch on screen produced (`widgets`/`depth`/`roots`), or `null` when it is empty. */
  get lastBuild(): Readonly<BuiltUi> | null {
    return this.built;
  }

  /**
   * The branch widget the last switch destroyed, or `null` before the first switch.
   *
   * Kept because "the view I left is gone" is the whole point of a structural switch, and asserting it
   * from the outside would otherwise need a second reference the application has no reason to hold.
   */
  get lastReplaced(): Widget | null {
    return this.replaced;
  }

  /**
   * Switches to `key`, destroying the branch on screen and building the new one.
   *
   * Idempotent: selecting the key that is already showing does nothing, which is what lets the DSL bind
   * this straight to a `ref` (the binding re-runs whenever its dependencies change, and a rebuild is not
   * always what that means). Returns `true` when something was rebuilt.
   */
  setBranch(key: BranchKey): boolean {
    const plan = planBranch(this.branches, key);
    if (this.hasSelection && plan.key === this.currentKey) {
      return false;
    }
    if (plan.missing) {
      warn(
        `${this.name || 'Branch'}: no branch for key ${JSON.stringify(key)} — the map has ` +
          `${Object.keys(this.branches).join(', ') || 'no keys'}. The branch on screen was cleared.`,
      );
    }

    this.replaced = this.getWidgetChildren()[0] ?? null;
    this.removeAllWidgets(true);
    this.built = null;
    this.currentKey = plan.key;
    this.hasSelection = true;
    this.buildCount += 1;

    if (!plan.builder || !this.scene) {
      if (isDevMode()) {
        devLog(`branch: cleared (no branch for key ${JSON.stringify(key)})`);
      }
      return true;
    }

    const built = buildUiPage(this.scene, plan.builder, `${this.name || 'Branch'}('${plan.key}')`);
    this.built = built;
    this.addWidget(built.root);
    if (isDevMode()) {
      devLog(
        `branch: ${this.name || 'Branch'} -> ${plan.key} (${built.widgets} widget(s), ` +
          `${built.roots} root(s), ${this.buildCount} build(s) so far)`,
      );
    }
    return true;
  }
}

/** The `Branch` DSL composable, next to the widget it builds. */
export function branch(scene: Phaser.Scene, options: BranchOptions): BranchWidget {
  const widget = new BranchWidget(scene, options);
  scene.add.existing(widget);
  return widget;
}
