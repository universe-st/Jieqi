/**
 * Geometry helpers shared by the widgets.
 *
 * A widget's own rect (from the layout engine) is expressed in the parent's coordinates, while its
 * internal Game Objects live in the container's local space, where `(0, 0)` is the widget's
 * top-left corner. These helpers turn a rect plus the node's padding into that local content box.
 * No Phaser import, so the maths stays unit-testable in Node.
 */

import type { Insets, Rect } from '@phaser-mvvm/layout';

/** The widget's content box in its own local space (the rect deflated by `layoutParams.padding`). */
export function contentBox(width: number, height: number, insets: Insets): Rect {
  return {
    x: insets.left,
    y: insets.top,
    width: Math.max(0, width - insets.left - insets.right),
    height: Math.max(0, height - insets.top - insets.bottom),
  };
}

/** Offset that centres `inner` inside `outer`; never negative (the caller decides about overflow). */
export function centeredOffset(inner: number, outer: number): number {
  return Math.max(0, (outer - inner) / 2);
}

/** Offset that centres `inner` inside `outer`, allowing negative values (for `cover` overflow). */
export function centeredOffsetOverflow(inner: number, outer: number): number {
  return (outer - inner) / 2;
}

/** The size an icon is allowed to occupy inside the control that owns it. */
export interface IconFit {
  /** Size of the icon as it should be drawn. */
  width: number;
  height: number;
}

/**
 * Caps an icon to the room a control has for it.
 *
 * An icon is decoration inside a control, so the control's box wins: the icon is scaled down
 * (uniformly — an icon keeps its aspect ratio) until it fits, and it is never scaled *up*, because a
 * 16 px glyph in a large button is a choice, not a mistake. `0` means "there is no room left": the
 * caller drops the icon instead of drawing it over the text.
 *
 * The failure this exists for is the obvious one: a 64 px tile icon in a 36 px `md` button was drawn
 * at 64 px, sticking out of the button on all four sides (round 106 — `#/showcase` showed it, and
 * `#/compose` had worked around it by generating a 16 px texture on purpose).
 */
export function fitIcon(
  natural: { width: number; height: number },
  room: { width: number; height: number },
): IconFit {
  if (natural.width <= 0 || natural.height <= 0) {
    return { width: 0, height: 0 };
  }
  if (room.width <= 0 || room.height <= 0) {
    return { width: 0, height: 0 };
  }
  const scale = Math.min(1, room.width / natural.width, room.height / natural.height);
  if (!Number.isFinite(scale) || scale <= 0) {
    return { width: 0, height: 0 };
  }
  return { width: natural.width * scale, height: natural.height * scale };
}
