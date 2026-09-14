/**
 * The widget scope behind the Compose-style DSL.
 *
 * The DSL (`@phaser-mvvm/widgets/compose`) writes a view as nested function calls — no option bag
 * plus children array, no `this.add.` prefix:
 *
 * ```ts
 * const page = ui(this, () => {
 *   Column({ gap: 12, padding: 16 }, () => {
 *     Text('标题');
 *     Row({ gap: 8 }, () => {
 *       Button('取消');
 *       Button('确定', { variant: 'primary', onClick: save });
 *     });
 *   });
 * });
 * ```
 *
 * Nesting is *implicit*: while a container's content lambda runs, that container is the current
 * parent, and every widget created inside it attaches on creation. This module owns that stack.
 *
 * Building a view is synchronous and single-threaded, so one module-level LIFO stack is enough — the
 * same assumption Compose's compiler makes. Frames are always popped in a `finally`, so a throwing
 * content lambda cannot leave a half-open frame behind, and the top-of-stack check turns an
 * unbalanced open/close into a loud error instead of a silently misplaced subtree.
 *
 * Deliberately free of Phaser *runtime* imports: the mechanics are unit-tested in plain Node.
 */

import type Phaser from 'phaser';
import type { Widget } from './Widget';

/** One open level of the DSL: the scene, the container collecting children, and the roots it made. */
export interface UiScopeFrame {
  readonly scene: Phaser.Scene;
  /** Container that adopts widgets created right now; `null` at the root of a scope. */
  readonly parent: Widget | null;
  /** Widgets created directly under this frame when `parent` is `null`; empty otherwise. */
  readonly roots: Widget[];
  /** 1 for the outermost `ui()` call, 2 for a container inside it, … */
  readonly depth: number;
}

/** What {@link runInUiScope} reports back: the lambda's value, its roots and how much it built. */
export interface UiScopeResult<R> {
  result: R;
  /** Widgets emitted at the outermost level (usually exactly one). */
  roots: Widget[];
  /** Total widgets built by the scope, including nested containers and leaves. */
  widgets: number;
  /** Deepest nesting level reached, counting the root as 1. */
  depth: number;
}

interface MutableFrame extends UiScopeFrame {
  parent: Widget | null;
  roots: Widget[];
  widgets: number;
  deepest: number;
}

const frames: MutableFrame[] = [];

const scopeError = (what: string): Error =>
  new Error(
    `${what} needs an open UI scope. Build the view inside ui(scene, () => { … }) ` +
      '(@phaser-mvvm/widgets/compose); a composable cannot create a widget on its own because it ' +
      'has no scene to attach it to.',
  );

/** True while a `ui()` scope (or one of its containers) is open. */
export function inUiScope(): boolean {
  return frames.length > 0;
}

/** Current nesting depth; `0` outside any scope. */
export function uiScopeDepth(): number {
  return frames.length;
}

/** The innermost open frame, counters included. */
function topFrame(): MutableFrame | undefined {
  return frames[frames.length - 1];
}

/** The innermost open frame. Throws when no scope is open. */
export function currentUiScope(): UiScopeFrame {
  const frame = topFrame();
  if (!frame) {
    throw scopeError('currentUiScope()');
  }
  return frame;
}

/** Scene of the innermost open frame. Throws when no scope is open. */
export function currentUiScene(): Phaser.Scene {
  return currentUiScope().scene;
}

/**
 * Opens a scope, runs `content` and closes it again, returning everything the content built.
 *
 * The scope is isolated: widgets created inside attach to the content's own containers, never to a
 * parent of an enclosing scope. `ui()` uses that for the page root, `Repeat` templates use it once
 * per row, and a test can use it to build a subtree without a scene plugin.
 */
export function runInUiScope<R>(scene: Phaser.Scene, content: () => R): UiScopeResult<R> {
  const frame: MutableFrame = {
    scene,
    parent: null,
    roots: [],
    depth: frames.length + 1,
    widgets: 0,
    deepest: frames.length + 1,
  };
  frames.push(frame);

  let result: R;
  try {
    result = content();
  } finally {
    const popped = frames.pop();
    if (popped !== frame) {
      // Only reachable if the DSL itself is unbalanced; popping the frame anyway keeps the stack
      // usable so the error surfaces once instead of corrupting every later build.
      frames.length = 0;
      throw new Error(
        'runInUiScope(): the widget scope stack is unbalanced — a frame was closed out of order.',
      );
    }
    const parent = frames[frames.length - 1];
    if (parent) {
      parent.widgets += frame.widgets;
      parent.deepest = Math.max(parent.deepest, frame.deepest);
    }
  }

  return {
    result,
    roots: frame.roots,
    widgets: frame.widgets,
    depth: frame.deepest - frame.depth + 1,
  };
}

/**
 * Attaches `widget` to the current scope and returns it.
 *
 * Inside a container the widget becomes a child; at the root of a scope it is collected as a root.
 * Emitting is what makes the DSL declarative — the composable itself never has to look at the tree.
 */
export function emitWidget<T extends Widget>(widget: T): T {
  const frame = topFrame();
  if (!frame) {
    throw scopeError('emitWidget()');
  }
  if (frame.parent) {
    frame.parent.addWidget(widget);
  } else {
    frame.roots.push(widget);
  }
  frame.widgets += 1;
  return widget;
}

/**
 * Attaches `parent` to the enclosing scope, then runs `content` with it as the current parent.
 *
 * This is the whole container protocol: emit first (so sibling order follows source order, not the
 * order in which nested containers finish building), then adopt.
 */
export function withUiParent<T extends Widget>(parent: T, content?: () => void): T {
  emitWidget(parent);
  if (!content) {
    return parent;
  }

  const outer = topFrame();
  if (!outer) {
    // `emitWidget` already threw in that case; this keeps the invariant explicit for readers.
    throw scopeError('withUiParent()');
  }
  const frame: MutableFrame = {
    scene: outer.scene,
    parent,
    roots: [],
    depth: outer.depth + 1,
    widgets: 0,
    deepest: outer.depth + 1,
  };
  frames.push(frame);
  try {
    content();
  } finally {
    closeContainerFrame(frame);
  }
  return parent;
}

/**
 * Runs `content` in an isolated child scope and returns the single widget it built.
 *
 * Used where a widget is created lazily, outside the enclosing build pass: a `Repeat` row template
 * and any other "build me one widget" callback. A template must produce exactly one root — anything
 * else is a mistake in user code, so it fails loudly with the count.
 */
export function buildUiSubtree(scene: Phaser.Scene, content: () => void, what: string): Widget {
  const { roots } = runInUiScope(scene, content);
  if (roots.length === 0) {
    throw new Error(`${what}: the template built no widget; return exactly one root widget.`);
  }
  if (roots.length > 1) {
    throw new Error(
      `${what}: the template built ${roots.length} root widgets (${roots
        .map((widget) => widget.name || widget.constructor.name)
        .join(', ')}); wrap them in a Column/Row/Panel so there is exactly one root.`,
    );
  }
  return roots[0] as Widget;
}

/** Pops a container frame and rolls its counts up into the enclosing one. */
function closeContainerFrame(frame: MutableFrame): void {
  const popped = frames.pop();
  if (popped !== frame) {
    frames.length = 0;
    throw new Error(
      'withUiParent(): the widget scope stack is unbalanced — a frame was closed out of order.',
    );
  }
  const outer = frames[frames.length - 1];
  if (outer) {
    outer.widgets += frame.widgets;
    outer.deepest = Math.max(outer.deepest, frame.deepest);
  }
}
