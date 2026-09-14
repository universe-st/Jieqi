/**
 * `scroll` arranger: the content box of a scroll port.
 *
 * A port has exactly two jobs in layout:
 *
 * 1. **Measure its content without its own limit on the scroll axis.** Content is allowed to be
 *    longer than the viewport — that is the whole point of a scroll port — so the constraint handed
 *    down has an unbounded maximum on that axis (see `ScrollLayoutOptions`). Everything else (the
 *    cross axis, the containing block percentages resolve against) is left alone: suspending the cap
 *    must not turn into "no idea how wide the page is".
 * 2. **Place it at the port's origin.** The scroll offset itself is not layout: the widget writes the
 *    negation into the child's `left`/`top`, which `arrangeAbsolute` applies, so a scroll never
 *    re-enters the measure pass.
 *
 * Flow children (no `position: 'absolute'`) are placed top-left, like `stack` with `align: 'start'`,
 * which is the natural reading for a port whose content is a single child.
 */

import type { BoxConstraints } from './constraint';
import { UNBOUNDED, cloneConstraints } from './constraint';
import type { Size } from './geom';
import { borderSize } from './internal';
import type { ArrangerContext, ScrollLayoutOptions } from './types';

/** `true` for the axes a port releases. */
function releases(axis: ScrollLayoutOptions['axis'], candidate: 'width' | 'height'): boolean {
  const wanted = axis ?? 'vertical';
  if (wanted === 'both') {
    return true;
  }
  return wanted === (candidate === 'width' ? 'horizontal' : 'vertical');
}

/**
 * The constraint a port hands to its content: same as its own, with the minimums dropped and the
 * scroll axes unbounded.
 */
export function relaxScrollConstraint(
  constraint: BoxConstraints,
  axis: ScrollLayoutOptions['axis'],
): BoxConstraints {
  const relaxed = cloneConstraints(constraint);
  relaxed.minWidth = 0;
  relaxed.minHeight = 0;
  if (releases(axis, 'width')) {
    relaxed.maxWidth = UNBOUNDED;
  }
  if (releases(axis, 'height')) {
    relaxed.maxHeight = UNBOUNDED;
  }
  return relaxed;
}

export function measureScroll(ctx: ArrangerContext, options: ScrollLayoutOptions = {}): Size {
  const released = relaxScrollConstraint(ctx.constraint, options.axis);
  let width = 0;
  let height = 0;

  for (const child of ctx.children) {
    if (!child.node.inFlow) {
      continue;
    }
    const measured = ctx.measureChild(child, released);
    width = Math.max(width, measured.width);
    height = Math.max(height, measured.height);
  }

  return { width, height };
}

export function arrangeScroll(ctx: ArrangerContext, _options: ScrollLayoutOptions = {}): void {
  const content = ctx.rect;

  for (const child of ctx.children) {
    // The scroll port's own content is `position: 'absolute'` (its `left`/`top` carry the offset), so
    // it is placed by `arrangeAbsolute`. This only covers a flow child, which is what a port built
    // without an explicit holder would use.
    if (child.params.position === 'absolute' || !child.node.inFlow) {
      continue;
    }
    const outer = ctx.resolveOuterSize(child);
    const margin = child.params.margin;
    const size = borderSize(outer, margin);
    ctx.placeChild(child, {
      x: content.x + margin.left,
      y: content.y + margin.top,
      width: size.width,
      height: size.height,
    });
  }
}
