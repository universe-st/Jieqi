/**
 * Bring-into-view: keeping the focused widget inside the visible band of every scroll port above it.
 *
 * Focus moves through the widget tree with no notion of a viewport, so a keyboard or gamepad user can
 * land on a row a `ScrollView` has clipped away: the focus ring is drawn outside the mask, and what
 * the user sees is nothing at all. Measured in round 67 on `#/scroll`: `Tab` reached
 * `row.delete.r012` at stage y=553 while the port's visible band was 92..448, and the offset stayed 0
 * — eleven rows of "the focus vanished" before anyone noticed, because nothing in the framework ever
 * asked a port to scroll.
 *
 * The mechanism is deliberately the browser's, and it is two parts:
 *
 * - a **capability** on the widget (`Widget#revealDescendant`), implemented by the widgets that own a
 *   scrollable viewport (`ScrollView`), so the focus system never has to know what a port is;
 * - a **walk** (`revealInViewports`) from the focused widget up the container chain, innermost port
 *   first.
 *
 * A nested port makes the walk a fixed-point problem: scrolling an inner port changes where the
 * target sits inside the *outer* one. The loop therefore repeats until no port moves, running a
 * layout pass in between (`flushLayout`) — without it the second pass would read the stale rects the
 * first pass was trying to fix (an offset only reaches the tree through the layout engine).
 */

import type { Rect } from '@phaser-mvvm/layout';
import type { Widget } from './Widget';

/** Gap a port keeps between the revealed widget and its own edge, in design pixels. */
export const DEFAULT_REVEAL_MARGIN = 8;

/** How many times the ancestor walk may repeat before giving up (a nested-port chain is 2–3 deep). */
export const DEFAULT_REVEAL_PASSES = 3;

/**
 * Minimal shape needed to read a widget's rect inside another container's coordinate space.
 *
 * A real `Widget` satisfies it (as does a `Container`), and so does an object literal in a test.
 */
/**
 * A node in the container chain — a position and a way further up.
 *
 * Phaser's `Container` satisfies this, and so does a plain object in a test.
 */
export interface PositionedNode {
  readonly x: number;
  readonly y: number;
  readonly parentContainer?: PositionedNode | null;
}

/** The widget whose rect is being located, plus the chain above it. */
export interface ContentRectSource {
  readonly appliedRect: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly parentContainer?: PositionedNode | null;
}

/**
 * `target`'s rect in `contentRoot`'s coordinate space, or `null` when `contentRoot` is not an
 * ancestor.
 *
 * Two deliberate differences from `stageRectOf()`:
 *
 * - the walk stops **at** `contentRoot` instead of running to the top, so the result does not depend
 *   on where the port itself sits on the page;
 * - `contentRoot`'s own position (`x`/`y`) is excluded, which makes the result **offset independent**
 *   — the same widget keeps the same coordinates while the port scrolls. A scroll port moves its
 *   content by placing the holder at the negated offset, so a rect that included the holder's
 *   position would change under the very scroll offset the caller is trying to compute.
 *
 * Scale is not applied: the caller multiplies by the port's zoom (`ScrollView#zoom`) so that this
 * stays a pure tree walk with a definite answer.
 */
export function contentRectOf(
  target: ContentRectSource,
  contentRoot: PositionedNode | null,
): Rect | null {
  if (contentRoot === null) {
    return null;
  }
  const rect = target.appliedRect;
  let x = rect.x;
  let y = rect.y;
  let node = target.parentContainer;
  while (node) {
    if (node === contentRoot) {
      return { x, y, width: rect.width, height: rect.height };
    }
    x += node.x;
    y += node.y;
    node = node.parentContainer;
  }
  return null;
}

/** One axis of a bring-into-view computation, in the port's own units. */
export interface RevealAxis {
  /** Current offset (0 = the content's start edge is aligned with the viewport's start edge). */
  offset: number;
  /** Viewport length on this axis. */
  viewport: number;
  /**
   * Target's start edge **in content space**: its coordinate with the offset at 0. Independent of the
   * current scroll position, which is what makes the answer stable across repeats.
   */
  start: number;
  /** Target's length on this axis. */
  length: number;
  /** Smallest gap to keep between the target and the viewport edge. */
  margin: number;
}

/**
 * The offset that brings the target inside the viewport, or `offset` when it already is.
 *
 * The rules are the ones a browser uses for `element.scrollIntoView({ block: 'nearest' })`:
 *
 * - a target that **fits** in the viewport moves the *shortest* distance — only its violated edge is
 *   aligned, so scrolling never jumps further than it has to;
 * - a target **taller than the viewport** aligns its leading edge, because aligning the trailing one
 *   would hide the start of what the user is reading;
 * - a target that **already covers** the whole visible band is left alone: moving the content would
 *   reveal nothing and look like a random jump.
 *
 * The margin is clamped to half the free space so a large margin in a small viewport cannot make the
 * two edges fight each other (the target would oscillate between "too high" and "too low").
 */
export function revealOffset(axis: RevealAxis): number {
  const { offset, viewport, start, length, margin } = axis;
  if (!(viewport > 0)) {
    return offset;
  }
  const visibleStart = start - offset;
  const visibleEnd = visibleStart + length;
  const free = Math.max(0, viewport - Math.min(length, viewport));
  const m = Math.max(0, Math.min(margin, free / 2));

  if (length <= viewport - 2 * m) {
    if (visibleStart < m) {
      return start - m;
    }
    if (visibleEnd > viewport - m) {
      return start + length + m - viewport;
    }
    return offset;
  }
  if (visibleStart <= m && visibleEnd >= viewport - m) {
    return offset;
  }
  return start - m;
}

// ---------------------------------------------------------------------------- the walk

/** A widget that owns a scrollable viewport and can scroll a descendant into view. */
export interface RevealHost {
  /** See `Widget#revealDescendant`: `true` when the viewport moved. */
  revealDescendant(target: Widget): boolean;
}

export interface RevealOptions {
  /**
   * Runs a layout pass so the next walk sees the offsets the previous one applied.
   *
   * Required for nested ports to converge; a port that scrolled reports the change only through the
   * layout engine, so without this the outer port would still measure the pre-scroll geometry.
   */
  flushLayout?: () => void;
  /** Pass cap. Defaults to {@link DEFAULT_REVEAL_PASSES}; a single-level tree converges in one. */
  maxPasses?: number;
}

function isRevealHost(value: unknown): value is RevealHost {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { revealDescendant?: unknown }).revealDescendant === 'function'
  );
}

/**
 * Asks every scroll port above `target` to bring it into view, innermost first.
 *
 * Returns `true` when at least one port moved. The walk stops early as soon as a pass changes
 * nothing, so the common case (focus moved to something already visible) costs one ancestor walk and
 * no layout.
 */
export function revealInViewports(target: Widget, options: RevealOptions = {}): boolean {
  const maxPasses = Math.max(1, Math.floor(options.maxPasses ?? DEFAULT_REVEAL_PASSES));
  let movedAny = false;

  for (let pass = 0; pass < maxPasses; pass++) {
    let moved = false;
    let node: unknown = target.parentContainer;
    while (node) {
      if (isRevealHost(node) && node.revealDescendant(target)) {
        moved = true;
      }
      node = (node as { parentContainer?: unknown }).parentContainer;
    }
    if (!moved) {
      break;
    }
    movedAny = true;
    // The offsets this pass applied are not in the tree yet: the layout engine puts them there.
    options.flushLayout?.();
  }

  // Each port traces its own move (`reveal: <port> offset a -> b for <widget>`), which names the port
  // and the numbers; a second line here would only repeat it without either.
  return movedAny;
}
