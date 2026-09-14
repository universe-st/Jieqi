/**
 * Building a whole view from a content lambda — the one place that defines what a `ui()`-style
 * lambda is allowed to produce.
 *
 * Three callers need exactly the same rule and used to each carry their own copy: the compose DSL
 * (`ui()`), a modal's content (`modal.open()`) and a page (`pages.push()`). The rule is Compose's:
 *
 * - **zero roots is an error.** An empty view is always a mistake (an early `return`, a condition that
 *   swallowed everything), and the message can name the caller and suggest the fix.
 * - **one root is the normal case.**
 * - **more than one root is forgiven** with a warning: the widgets are wrapped in a transparent
 *   vertical container, because a stack or a box still has to decide a flow direction and guessing
 *   silently is worse than saying so.
 *
 * `uiscope.ts` keeps its own strict `buildUiSubtree()` for templates, where a second root is a real
 * bug (the repetition would be laid out on top of itself) rather than a style choice.
 */

import type Phaser from 'phaser';
import { devLog, isDevMode, warn } from '@phaser-mvvm/core';
import { BoxWidget } from './LayoutWidget';
import type { Widget } from './Widget';
import { runInUiScope } from './uiscope';

/** What a view lambda produced. */
export interface BuiltUi {
  /** The single root, or the auto-created wrapper. */
  root: Widget;
  /** Total widgets built, nested containers included. */
  widgets: number;
  /** Deepest nesting level reached. */
  depth: number;
  /** How many roots the lambda emitted (1 for the normal case, 0 never returns). */
  roots: number;
}

/**
 * Runs `content` in its own UI scope and returns its single root.
 *
 * `what` names the caller in the error and the warning (`'ui()'`, `'modal.open()'`, `'pages.push()'`),
 * so a message in the console says which call the lambda belonged to.
 */
export function buildUiPage(
  scene: Phaser.Scene,
  content: () => void,
  what: string,
  options: { wrapOthers?: boolean } = {},
): BuiltUi {
  const { roots, widgets, depth } = runInUiScope(scene, content);

  if (roots.length === 0) {
    throw new Error(
      `${what}: the content built no widget. A view needs exactly one root — wrap the content in ` +
        `Column()/Row()/Panel(), or check for an early return inside the lambda.`,
    );
  }

  const first = roots[0] as Widget;
  if (roots.length === 1) {
    if (isDevMode()) {
      devLog(`${what}: built ${widgets} widget(s), ${depth} level(s) deep`);
    }
    return { root: first, widgets, depth, roots: 1 };
  }

  const others = roots.slice(1) as Widget[];
  if (options.wrapOthers === false) {
    // The caller transports the extra roots somewhere else (a page host that mounts them all); it
    // still gets the warning, because "which one is the page" is never obvious to the reader.
    warn(
      `${what}: the content built ${roots.length} root widgets; the first one is the root of this ` +
        `view and the other ${others.length} were reported separately.`,
    );
    return { root: first, widgets, depth, roots: roots.length };
  }

  warn(
    `${what}: the content built ${roots.length} root widgets; they were wrapped in a vertical Column. ` +
      'Build an explicit Column()/Row()/Panel() to choose the flow yourself.',
  );
  const wrapper = new BoxWidget(
    scene,
    { direction: 'vertical', alignItems: 'stretch' },
    roots as Widget[],
  );
  scene.add.existing(wrapper);
  if (isDevMode()) {
    devLog(
      `${what}: built ${widgets} widget(s), ${depth} level(s) deep, wrapped ${roots.length} roots`,
    );
  }
  return { root: wrapper, widgets, depth, roots: roots.length };
}
